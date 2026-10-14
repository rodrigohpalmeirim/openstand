/**
 * Device sync engine: owns the transports, keeps the roster, mirrors viewer activity to the room
 * (leader/peer) and applies what arrives (follower/peer).
 */
import { create } from 'zustand'
import { db } from '../db/db'
import type { Setlist, SetlistEntry, Song } from '../db/schema'
import { registerService } from '../services'
import { settings, useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { ACTIONS, onAction, runAction, type ActionId } from '../viewer/actions'
import { goToPageWhenReady, viewerApi } from '../viewer/api'
import { on } from '../viewer/events'
import {
  MIRRORED_ACTIONS,
  PROTOCOL_VERSION,
  SeenSet,
  obeys,
  parseEnvelope,
  pickMatch,
  resolveQueue,
  rosterExpire,
  rosterReduce,
  sends,
  type Body,
  type Candidate,
  type Envelope,
  type Roster,
  type SetlistItemRef,
  type SongRef,
} from './protocol'
import { LocalTransport, RelayTransport, type Transport, type TransportStatus } from './transports'

export type SyncStatus = 'off' | 'connecting' | 'online' | 'error'

interface SyncStore {
  /** User wants to be connected */
  active: boolean
  status: SyncStatus
  relay: TransportStatus | 'off'
  local: boolean
  error?: string
  peers: Roster
  /** Last thing received from the room, for the status UI */
  lastEvent?: string
}

export const useSync = create<SyncStore>(() => ({ active: false, status: 'off', relay: 'off', local: false, peers: {} }))

const deviceId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2)
export const myDeviceId = () => deviceId

export function defaultDeviceName(): string {
  if (typeof navigator === 'undefined') return 'This device'
  const ua = navigator.userAgent
  const os = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  return br ? `${br} on ${os}` : os
}

const myName = () => settings().sync.deviceName.trim() || defaultDeviceName()

let transports: Transport[] = []
let seq = 0
const seen = new SeenSet()
/** Last time we applied something from the room; local echoes inside this window aren't re-sent. */
let lastRemoteApply = 0
let lastRemoteSongId: string | undefined
const ECHO_MS = 700

function broadcast(body: Body, to?: string) {
  if (!transports.length) return
  const s = settings().sync
  const env: Envelope = { v: PROTOCOL_VERSION, from: deviceId, name: myName(), role: s.role, seq: ++seq, t: Date.now(), body, ...(to ? { to } : {}) }
  const data = JSON.stringify(env)
  for (const t of transports) t.send(data)
}

function refreshStatus() {
  const relay = transports.find((t) => t.kind === 'relay')
  const local = transports.some((t) => t.kind === 'local' && t.status === 'open')
  const active = useSync.getState().active
  let status: SyncStatus = 'off'
  if (active) {
    if (relay) status = relay.status === 'open' ? 'online' : relay.status === 'error' ? 'error' : 'connecting'
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
  if (!sends(settings().sync.role)) return
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
  if (!current) {
    toast(`${useSync.getState().peers[from]?.name ?? 'Leader'} opened “${b.song.title}” — not in this library`, 'error')
    return
  }
  lastRemoteSongId = current
  lastRemoteApply = Date.now()
  const q = resolveQueue(b.queue, b.index, (r) => pickMatch(r, cands))
  const queue = q.index >= 0 ? q.ids : [current]
  const index = q.index >= 0 ? q.index : 0
  if (v.queue[v.index] === current && v.queue.length === queue.length && v.queue.every((id, i) => id === queue[i])) {
    if (b.page !== undefined) goToPageWhenReady(current, b.page)
    else if (v.position !== b.position) v.setPosition(b.position)
    return
  }
  v.open(queue, index, { position: b.page !== undefined ? 0 : b.position })
  if (b.page) goToPageWhenReady(current, b.page)
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
  toast(`${fromName} shared “${b.name}” (${found} song${found === 1 ? '' : 's'}${missing ? `, ${missing} missing` : ''})`, 'info', {
    label: 'Save',
    run: async () => {
      const now = Date.now()
      const sl: Setlist = { id: crypto.randomUUID(), name: b.name, entries, notes: missing ? `${missing} song(s) were not found in this library.` : '', createdAt: now, modifiedAt: now }
      await db.setlists.put(sl)
      toast(`Saved setlist “${b.name}”`, 'ok')
    },
  })
}

function handle(data: string) {
  const e = parseEnvelope(data)
  if (!e || e.from === deviceId || (e.to && e.to !== deviceId) || !seen.add(e)) return
  const wasKnown = !!useSync.getState().peers[e.from]
  useSync.setState((s) => ({ peers: rosterReduce(s.peers, e, Date.now()) }))
  const me = settings().sync
  const b = e.body

  if (b.type === 'hello') {
    if (!b.reply) broadcast({ type: 'hello', reply: true }, e.from)
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
      if (!cur || (b.songId && cur !== b.songId && cur !== lastRemoteSongId)) return
      lastRemoteApply = Date.now()
      runAction(b.action, 'remote')
      return
    }
    case 'page': {
      if (!me.followPages) return
      const v = useViewer.getState()
      const cur = v.queue[v.index]
      if (!cur || (cur !== b.songId && cur !== lastRemoteSongId)) return
      if (b.page !== undefined) {
        const api = viewerApi()
        if (api?.songId === cur && api.currentPage !== b.page) {
          lastRemoteApply = Date.now()
          api.goToPage(b.page)
        }
      } else if (v.position !== b.position) {
        lastRemoteApply = Date.now()
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

export function connect() {
  disconnectTransports()
  const s = settings().sync
  const room = s.room.trim() || 'band'
  useSync.setState({ active: true, error: undefined, peers: {} })
  const onStatus = (st: TransportStatus, detail?: string) => {
    if (st === 'open') broadcast({ type: 'hello' })
    if (st === 'open' && settings().sync.role === 'follower') broadcast({ type: 'requestState' })
    useSync.setState({ error: st === 'error' ? detail : undefined })
    refreshStatus()
  }
  transports.push(new LocalTransport(room, { onMessage: handle, onStatus }))
  if (s.relayUrl.trim()) {
    try {
      transports.push(new RelayTransport(s.relayUrl, room, { onMessage: handle, onStatus }))
    } catch (e) {
      useSync.setState({ error: `Invalid relay address: ${(e as Error).message}` })
    }
  }
  refreshStatus()
}

function disconnectTransports() {
  if (transports.length) broadcast({ type: 'bye' })
  for (const t of transports) t.close()
  transports = []
}

export function disconnect() {
  disconnectTransports()
  useSync.setState({ active: false, peers: {}, error: undefined })
  refreshStatus()
}

registerService(() => {
  const stops: (() => void)[] = []
  if (settings().sync.autoConnect) connect()

  // Reconnect when the room, relay or role changes while connected.
  stops.push(
    useSettings.subscribe((st, prev) => {
      const a = st.s.sync
      const b = prev.s.sync
      if (!useSync.getState().active) return
      if (a.room !== b.room || a.relayUrl !== b.relayUrl) connect()
      else if (a.role !== b.role || a.deviceName !== b.deviceName) broadcast({ type: 'hello' })
    }),
  )

  // Outgoing: mirrored navigation actions.
  stops.push(
    onAction((a: ActionId, source?: string) => {
      if (source === 'remote' || !transports.length || !sends(settings().sync.role) || !MIRRORED_ACTIONS.includes(a)) return
      const v = useViewer.getState()
      if (!v.queue.length) return
      broadcast({ type: 'action', action: a, songId: v.queue[v.index] })
    }),
  )

  // Outgoing: song changes and non-action jumps.
  stops.push(
    on('songOpened', ({ song }) => {
      if (!transports.length || !sends(settings().sync.role)) return
      if (song.id === lastRemoteSongId && Date.now() - lastRemoteApply < 3000) return
      void currentState().then((st) => st && broadcast(st))
    }),
    on('pageChanged', ({ songId, page, position }) => {
      if (!transports.length || !sends(settings().sync.role)) return
      // Also sent after mirrored actions: receivers with another layout (two pages vs one) land on
      // the same page instead of drifting; with the same layout it is a no-op.
      if (Date.now() - lastRemoteApply < ECHO_MS) return
      broadcast({ type: 'page', songId, position, page })
    }),
    useViewer.subscribe((st, prev) => {
      if (prev.queue.length && !st.queue.length && transports.length && sends(settings().sync.role) && Date.now() - lastRemoteApply > ECHO_MS) broadcast({ type: 'closeSong' })
    }),
  )

  // Heartbeat + roster expiry.
  const hb = setInterval(() => {
    if (!transports.length) return
    broadcast({ type: 'hello', reply: true })
    useSync.setState((s) => ({ peers: rosterExpire(s.peers, Date.now()) }))
  }, 10_000)
  stops.push(() => clearInterval(hb))

  const bye = () => disconnectTransports()
  // Back/forward cache restores the page without a reload: reconnect if we were connected.
  const back = (e: PageTransitionEvent) => e.persisted && useSync.getState().active && connect()
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
