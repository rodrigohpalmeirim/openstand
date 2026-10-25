/**
 * Device sync engine: owns the transports, keeps the roster, mirrors viewer activity to the room
 * (leader/peer) and applies what arrives (follower/peer).
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { db } from '../db/db'
import type { Setlist, SetlistEntry, Song } from '../db/schema'
import { terms } from '../library/browse/terms'
import { registerService } from '../services'
import { settings, useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { ACTIONS, onAction, runAction, type ActionId } from '../viewer/actions'
import { goToPageWhenReady, viewerApi } from '../viewer/api'
import { on } from '../viewer/events'
import {
  DepartedSet,
  EchoGuard,
  LEGACY_ROOM,
  MIRRORED_ACTIONS,
  PROTOCOL_VERSION,
  SeenSet,
  followsSong,
  obeys,
  parseEnvelope,
  pickMatch,
  randomRoom,
  resolveQueue,
  rosterExpire,
  rosterReduce,
  sends,
  type Body,
  type Candidate,
  type Envelope,
  type Role,
  type Roster,
  type SetlistItemRef,
  type SongPair,
  type SongRef,
} from './protocol'
import { defaultDeviceName } from './deviceName'
import { LocalTransport, RelayTransport, SAME_SITE_RELAY, type Transport, type TransportStatus } from './transports'

export type SyncStatus = 'off' | 'connecting' | 'online' | 'error'

interface SyncStore {
  /** User wants to be connected */
  active: boolean
  status: SyncStatus
  relay: TransportStatus | 'off'
  local: boolean
  error?: string
  /** The settings can't work (an invalid relay address); unlike `error`, no transport event clears it. */
  configError?: string
  peers: Roster
  /** Last thing received from the room, for the status UI */
  lastEvent?: string
}

export const useSync = create<SyncStore>(() => ({ active: false, status: 'off', relay: 'off', local: false, peers: {} }))

const deviceId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)
export const myDeviceId = () => deviceId

/** The id this tab had before a reload (saved on pagehide): hellos name it so others drop it at once. */
const PREV_ID_KEY = 'openstand-sync-prev-id'
const previousId = (() => {
  try {
    const id = sessionStorage.getItem(PREV_ID_KEY)
    sessionStorage.removeItem(PREV_ID_KEY)
    return id || undefined
  } catch {
    return undefined
  }
})()
const hello = (reply?: boolean): Body => ({ type: 'hello', ...(reply ? { reply } : {}), ...(previousId ? { replaces: previousId } : {}) })

export { defaultDeviceName }

/* ------------------------------------------------- per-window identity */

/**
 * Role and device name are kept per window (sessionStorage), so two windows of one browser can be leader
 * and follower. Settings keep the last choice as the default for new windows.
 */
export const useWindowSync = create<{ role?: Role; deviceName?: string }>()(
  persist(() => ({}), { name: 'openstand-sync-window', storage: createJSONStorage(() => sessionStorage) }),
)

export const myRole = (): Role => useWindowSync.getState().role ?? settings().sync.role
export function useMyRole(): Role {
  const own = useWindowSync((s) => s.role)
  const fallback = useSettings((s) => s.s.sync.role)
  return own ?? fallback
}
/** This window's device name as typed ('' = the default name). */
export const myDeviceName = () => useWindowSync.getState().deviceName ?? settings().sync.deviceName
export function useMyDeviceName(): string {
  const own = useWindowSync((s) => s.deviceName)
  const fallback = useSettings((s) => s.s.sync.deviceName)
  return own ?? fallback
}
export function setMyRole(role: Role) {
  useWindowSync.setState({ role })
  useSettings.getState().setIn('sync', { role })
}
export function setMyDeviceName(deviceName: string) {
  useWindowSync.setState({ deviceName })
  useSettings.getState().setIn('sync', { deviceName })
}

const myName = () => myDeviceName().trim() || defaultDeviceName()

/** A second window opened from the settings comes with its role and name in the URL (`?syncRole=&syncName=`). */
function adoptWindowParams() {
  if (typeof location === 'undefined') return
  const q = new URLSearchParams(location.search)
  const role = q.get('syncRole')
  const name = q.get('syncName')
  if (role === null && name === null) return
  if (role === 'leader' || role === 'follower' || role === 'peer') useWindowSync.setState({ role })
  if (name) useWindowSync.setState({ deviceName: name.slice(0, 60) })
  q.delete('syncRole')
  q.delete('syncName')
  const rest = q.toString()
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`)
}

/** URL for a second window of this app with the complementary role (a leader's second window follows…). */
export function secondWindowUrl(): string {
  const u = new URL(location.href)
  const role = myRole()
  u.searchParams.set('syncRole', role === 'leader' ? 'follower' : role === 'follower' ? 'leader' : 'peer')
  u.searchParams.set('syncName', `${myName()} (2)`)
  return u.toString()
}

/* --------------------------------------------------------------- rooms */

/**
 * The room to connect to. Without one, or still on the public room older versions used with this site's
 * relay (where every OpenStand user would land together), a private random room is made and saved.
 */
export function ensureRoom(opts: { quiet?: boolean } = {}): string {
  const s = settings().sync
  const room = s.room.trim()
  const legacy = room === LEGACY_ROOM && s.relayUrl.trim() === SAME_SITE_RELAY
  if (room && !legacy) return room
  const fresh = randomRoom()
  useSettings.getState().setIn('sync', { room: fresh })
  if (legacy && !opts.quiet) toast(`Device sync now uses a private room, “${fresh}”. Use the same room name on your other devices.`, 'info')
  return fresh
}

let transports: Transport[] = []
let seq = 0
const seen = new SeenSet()
const departed = new DepartedSet()
/** Last time we applied a song change from the room; the resulting local events aren't re-sent. */
let lastRemoteApply = 0
/** The leader's current song and what it was matched to here. */
let remoteSong: SongPair | undefined
const ECHO_MS = 700
/** The page change caused by applying a remote turn isn't sent back; the user's own turns are. */
const echo = new EchoGuard(ECHO_MS)

function broadcast(body: Body, to?: string) {
  if (!transports.length) return
  const env: Envelope = { v: PROTOCOL_VERSION, from: deviceId, name: myName(), role: myRole(), seq: ++seq, t: Date.now(), body, ...(to ? { to } : {}) }
  const data = JSON.stringify(env)
  for (const t of transports) t.send(data)
}

function refreshStatus() {
  const relay = transports.find((t) => t.kind === 'relay')
  const local = transports.some((t) => t.kind === 'local' && t.status === 'open')
  const { active, configError } = useSync.getState()
  let status: SyncStatus = 'off'
  if (active) {
    if (configError) status = 'error'
    else if (relay) status = relay.status === 'open' ? 'online' : relay.status === 'error' ? 'error' : 'connecting'
    else status = local ? 'online' : 'error'
  }
  useSync.setState({ status, relay: relay?.status ?? 'off', local })
}

/* ------------------------------------------------------------ sending */

async function songRef(id: string, cache?: Map<string, Song>): Promise<SongRef | undefined> {
  const s = cache?.get(id) ?? (await db.songs.get(id))
  return s ? { id: s.id, title: s.title, artist: s.artists[0] } : undefined
}

async function currentState(): Promise<Extract<Body, { type: 'openSong' }> | null> {
  const v = useViewer.getState()
  const id = v.queue[v.index]
  if (!id) return null
  // Long queues are sent as a window around the current song.
  const start = Math.max(0, v.index - 150)
  const queueIds = v.queue.slice(start, start + 300)
  const songs = new Map(((await db.songs.bulkGet(queueIds)).filter(Boolean) as Song[]).map((s) => [s.id, s]))
  const queue: SongRef[] = []
  let index = 0
  for (let i = 0; i < queueIds.length; i++) {
    const ref = await songRef(queueIds[i], songs)
    if (!ref) continue
    if (start + i === v.index) index = queue.length
    queue.push(ref)
  }
  const song = await songRef(id, songs)
  if (!song) return null
  const setlistName = v.setlistId ? (await db.setlists.get(v.setlistId))?.name : undefined
  const api = viewerApi()
  const page = api?.songId === id ? api.currentPage : undefined
  return { type: 'openSong', song, position: v.position, queue, index, setlistName, ...(page !== undefined ? { page } : {}) }
}

/** Re-announce what this device shows; followers jump to it. */
export async function syncNow() {
  if (!sends(myRole())) return
  const st = await currentState()
  if (st) broadcast(st)
  else broadcast({ type: 'closeSong' })
}

/** Send a setlist (titles only) so followers can save a matching copy. */
export async function shareSetlist(setlistId: string) {
  const sl = await db.setlists.get(setlistId)
  if (!sl) return
  const songs = new Map(((await db.songs.bulkGet(sl.entries.map((e) => e.songId).filter(Boolean))).filter(Boolean) as Song[]).map((s) => [s.id, s]))
  const items: SetlistItemRef[] = sl.entries.map((e) =>
    e.isBreak ? { isBreak: true, breakLabel: e.breakLabel } : { songId: e.songId, title: songs.get(e.songId)?.title, artist: songs.get(e.songId)?.artists[0], note: e.note },
  )
  broadcast({ type: 'setlist', name: sl.name, items })
  toast(`Shared “${sl.name}” with connected devices`, 'ok')
}

/* ------------------------------------------------------------ receiving */

async function candidates(refs: SongRef[]): Promise<Candidate[]> {
  // Exact ids first (cheap), then any title matches.
  const out: Candidate[] = ((await db.songs.bulkGet(refs.map((r) => r.id))).filter(Boolean) as Song[]).map((s) => ({ id: s.id, title: s.title, artists: s.artists }))
  const titles = [...new Set(refs.map((r) => r.title))]
  if (titles.length) {
    const byTitle = await db.songs.where('title').anyOfIgnoreCase(titles).toArray()
    for (const s of byTitle) out.push({ id: s.id, title: s.title, artists: s.artists })
    // Fallback for punctuation/article differences: a full scan, only for titles still missing.
    const have = new Set(out.map((c) => c.id))
    const missing = refs.filter((r) => !pickMatch(r, out))
    if (missing.length) await db.songs.each((s) => void (!have.has(s.id) && out.push({ id: s.id, title: s.title, artists: s.artists })))
  }
  return out
}

async function applyOpenSong(b: Extract<Body, { type: 'openSong' }>, from: string) {
  const v = useViewer.getState()
  const cands = await candidates([b.song, ...b.queue])
  const current = pickMatch(b.song, cands)
  // Until the leader opens a song we have, its page turns must not move the song still showing here.
  remoteSong = { remote: b.song.id, local: current }
  if (!current) {
    toast(`${useSync.getState().peers[from]?.name ?? 'Leader'} opened “${b.song.title}” — not in this library`, 'error')
    return
  }
  lastRemoteApply = Date.now()
  const q = resolveQueue(b.queue, b.index, (r) => pickMatch(r, cands))
  const queue = q.index >= 0 ? q.ids : [current]
  const index = q.index >= 0 ? q.index : 0
  // Keep the setlist context when a setlist of that name exists here too.
  const setlistId = b.setlistName ? (await db.setlists.where('name').equals(b.setlistName).first())?.id : undefined
  if (v.queue[v.index] === current && v.queue.length === queue.length && v.queue.every((id, i) => id === queue[i])) {
    if (setlistId && v.setlistId !== setlistId) useViewer.setState({ setlistId })
    if (b.page !== undefined) goToPageWhenReady(current, b.page)
    else if (v.position !== b.position) v.setPosition(b.position)
    return
  }
  v.open(queue, index, { position: b.page !== undefined ? 0 : b.position, setlistId })
  if (b.page) goToPageWhenReady(current, b.page)
}

/** Following pages but not songs: still learn which local song the leader's song is. */
async function pairSong(b: Extract<Body, { type: 'openSong' }>) {
  remoteSong = { remote: b.song.id, local: pickMatch(b.song, await candidates([b.song])) }
}

async function applySetlist(b: Extract<Body, { type: 'setlist' }>, fromName: string) {
  const refs = b.items.filter((i) => !i.isBreak && i.title).map((i) => ({ id: i.songId ?? '', title: i.title!, artist: i.artist }))
  const cands = await candidates(refs)
  const entries = b.items.flatMap((i): SetlistEntry[] => {
    if (i.isBreak) return [{ key: crypto.randomUUID(), songId: '', isBreak: true, breakLabel: i.breakLabel }]
    const id = i.title ? pickMatch({ id: i.songId ?? '', title: i.title, artist: i.artist }, cands) : undefined
    return id ? [{ key: crypto.randomUUID(), songId: id, note: i.note }] : []
  })
  const found = entries.filter((e) => !e.isBreak).length
  const missing = refs.length - found
  const t = terms(settings())
  toast(`${fromName} shared “${b.name}” (${t.count(found)}${missing ? `, ${missing} missing` : ''})`, 'info', {
    label: 'Save',
    run: async () => {
      const now = Date.now()
      const sl: Setlist = { id: crypto.randomUUID(), name: b.name, entries, notes: missing ? `${missing} ${missing === 1 ? `${t.song} was` : `${t.songs} were`} not found in this library.` : '', createdAt: now, modifiedAt: now }
      await db.setlists.put(sl)
      toast(`Saved setlist “${b.name}”`, 'ok')
    },
  })
}

function handle(data: string) {
  const e = parseEnvelope(data)
  if (!e || e.from === deviceId || (e.to && e.to !== deviceId) || !seen.add(e) || !departed.accept(e)) return
  const wasKnown = !!useSync.getState().peers[e.from]
  useSync.setState((s) => ({ peers: rosterReduce(s.peers, e, Date.now()) }))
  const me = { ...settings().sync, role: myRole() }
  const b = e.body

  if (b.type === 'hello') {
    if (!b.reply) broadcast(hello(true), e.from)
    if (!wasKnown) {
      toast(`${e.name} connected`)
      // A newcomer that can send: if I'm the leader/peer showing a song, tell it where we are.
      if (sends(me.role) && useViewer.getState().queue.length) void currentState().then((st) => st && broadcast(st, e.from))
    }
    return
  }
  if (b.type === 'bye') {
    toast(`${e.name} left`)
    return
  }
  if (b.type === 'requestState') {
    if (sends(me.role)) void currentState().then((st) => st && broadcast(st, e.from))
    return
  }
  if (!obeys(me.role, e.role)) return

  switch (b.type) {
    case 'openSong':
      useSync.setState({ lastEvent: b.song.title })
      if (me.followSongs) void applyOpenSong(b, e.from)
      else if (me.followPages) void pairSong(b)
      return
    case 'closeSong':
      if (me.followSongs && useViewer.getState().queue.length) {
        lastRemoteApply = Date.now()
        useViewer.getState().close()
      }
      return
    case 'action': {
      if (!me.followPages || !MIRRORED_ACTIONS.includes(b.action) || !(b.action in ACTIONS)) return
      const v = useViewer.getState()
      const cur = v.queue[v.index]
      if (!cur || !followsSong(cur, b.songId, remoteSong)) return
      echo.arm(Date.now())
      runAction(b.action, 'remote')
      return
    }
    case 'page': {
      if (!me.followPages) return
      const v = useViewer.getState()
      const cur = v.queue[v.index]
      if (!cur || !followsSong(cur, b.songId, remoteSong)) return
      if (b.page !== undefined) {
        const api = viewerApi()
        if (api?.songId === cur && api.currentPage !== b.page) {
          echo.arm(Date.now(), b.page)
          api.goToPage(b.page)
        }
      } else if (v.position !== b.position) {
        echo.arm(Date.now())
        v.setPosition(b.position)
      }
      return
    }
    case 'setlist':
      if (me.followSongs) void applySetlist(b, e.name)
      return
  }
}

/* ----------------------------------------------------------- lifecycle */

/** Set while connect() runs: ensureRoom() may write the room, which must not trigger a nested reconnect. */
let connecting = false

export function connect() {
  if (connecting) return
  connecting = true
  try {
    const room = ensureRoom()
    disconnectTransports()
    const s = settings().sync
    useSync.setState({ active: true, error: undefined, configError: undefined, peers: {} })
    const onStatus = (st: TransportStatus, detail?: string) => {
      if (st === 'open') broadcast(hello())
      if (st === 'open' && myRole() === 'follower') broadcast({ type: 'requestState' })
      useSync.setState({ error: st === 'error' ? detail : undefined })
      refreshStatus()
    }
    transports.push(new LocalTransport(room, { onMessage: handle, onStatus }))
    if (s.relayUrl.trim()) {
      try {
        transports.push(new RelayTransport(s.relayUrl, room, { onMessage: handle, onStatus }))
      } catch (e) {
        useSync.setState({ configError: `Invalid relay address: ${(e as Error).message}` })
      }
    }
    refreshStatus()
  } finally {
    connecting = false
  }
}

/** Switches to this site's relay, leaving the shared legacy room in the same write (one reconnect, no notice). */
export function switchToSiteRelay() {
  const room = settings().sync.room.trim()
  useSettings.getState().setIn('sync', { relayUrl: SAME_SITE_RELAY, ...(!room || room === LEGACY_ROOM ? { room: randomRoom() } : {}) })
}

function disconnectTransports() {
  if (transports.length) broadcast({ type: 'bye' })
  for (const t of transports) t.close()
  transports = []
}

export function disconnect() {
  disconnectTransports()
  useSync.setState({ active: false, peers: {}, error: undefined, configError: undefined })
  refreshStatus()
}

registerService(() => {
  const stops: (() => void)[] = []
  adoptWindowParams()
  if (settings().sync.autoConnect) connect()

  // Reconnect when the room, relay or role changes while connected.
  stops.push(
    useSettings.subscribe((st, prev) => {
      const a = st.s.sync
      const b = prev.s.sync
      if (!useSync.getState().active || connecting) return
      if (a.room !== b.room || a.relayUrl !== b.relayUrl) connect()
      else if (a.role !== b.role || a.deviceName !== b.deviceName) broadcast(hello())
    }),
    useWindowSync.subscribe((a, b) => {
      if (useSync.getState().active && (a.role !== b.role || a.deviceName !== b.deviceName)) broadcast(hello())
    }),
  )

  // Outgoing: mirrored navigation actions.
  stops.push(
    onAction((a: ActionId, source?: string) => {
      if (source === 'remote' || !transports.length || !sends(myRole()) || !MIRRORED_ACTIONS.includes(a)) return
      const v = useViewer.getState()
      if (!v.queue.length) return
      broadcast({ type: 'action', action: a, songId: v.queue[v.index] })
    }),
  )

  // Outgoing: song changes and non-action jumps.
  stops.push(
    on('songOpened', ({ song }) => {
      if (!transports.length || !sends(myRole())) return
      if (song.id === remoteSong?.local && Date.now() - lastRemoteApply < 3000) return
      void currentState().then((st) => st && broadcast(st))
    }),
    on('pageChanged', ({ songId, page, position }) => {
      if (!transports.length || !sends(myRole())) return
      // Also sent after mirrored actions: receivers with another layout (two pages vs one) land on
      // the same page instead of drifting; with the same layout it is a no-op.
      const now = Date.now()
      if (echo.isEcho(page, now) || (songId === remoteSong?.local && now - lastRemoteApply < ECHO_MS)) return
      broadcast({ type: 'page', songId, position, page })
    }),
    useViewer.subscribe((st, prev) => {
      if (prev.queue.length && !st.queue.length && transports.length && sends(myRole()) && Date.now() - lastRemoteApply > ECHO_MS) broadcast({ type: 'closeSong' })
    }),
  )

  // Heartbeat + roster expiry.
  const hb = setInterval(() => {
    if (!transports.length) return
    broadcast(hello(true))
    useSync.setState((s) => ({ peers: rosterExpire(s.peers, Date.now()) }))
  }, 10_000)
  stops.push(() => clearInterval(hb))

  // Back from the background or the network returned: don't wait out the relay's reconnect backoff,
  // and check that an open socket still works (mobile networks drop them silently).
  const wake = () => {
    if (document.visibilityState === 'visible') for (const t of transports) t.wake?.()
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  stops.push(() => {
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('online', wake)
  })

  const bye = () => {
    if (transports.length) {
      try {
        sessionStorage.setItem(PREV_ID_KEY, deviceId)
      } catch {
        // storage unavailable: others drop this tab on its bye, or after PEER_TTL_MS
      }
    }
    disconnectTransports()
  }
  // Back/forward cache restores the page without a reload: reconnect if we were connected. The id saved
  // on pagehide is still live, so drop it: tabs duplicated from this one would copy it and announce
  // `replaces: <this tab>`, making the others drop and re-add us.
  const back = (e: PageTransitionEvent) => {
    if (!e.persisted) return
    try {
      sessionStorage.removeItem(PREV_ID_KEY)
    } catch {
      // storage unavailable: nothing was saved
    }
    if (useSync.getState().active) connect()
  }
  window.addEventListener('pagehide', bye)
  window.addEventListener('pageshow', back)
  stops.push(() => {
    window.removeEventListener('pagehide', bye)
    window.removeEventListener('pageshow', back)
  })

  return () => {
    stops.forEach((s) => s())
    disconnectTransports()
  }
})
