/**
 * Device sync protocol (our own design; the original's LAN protocol is not recoverable).
 *
 * Every message is a JSON envelope broadcast to the room: devices identify themselves with a random
 * per-session id, a display name and a role. Leaders send, followers obey, peers do both. Songs are
 * referenced by id with title/artist so devices with different libraries can still match by title.
 * Page turns are mirrored as actions (each device turns its own layout) plus absolute positions for
 * jumps that don't come from an action (page slider, links, scrolling).
 */
import type { ActionId } from '../viewer/actions'

export const PROTOCOL_VERSION = 1

export type Role = 'leader' | 'follower' | 'peer'

export interface SongRef {
  id: string
  title: string
  artist?: string
}

export interface SetlistItemRef {
  title?: string
  artist?: string
  songId?: string
  note?: string
  isBreak?: boolean
  breakLabel?: string
}

export type Body =
  /**
   * Announce/heartbeat. `reply` marks answers so they aren't answered again. `replaces` is the id this
   * tab had before a reload: receivers drop that entry at once, even if its bye never arrived.
   */
  | { type: 'hello'; reply?: boolean; replaces?: string }
  | { type: 'bye' }
  /** A new song is showing (also the answer to requestState). */
  | { type: 'openSong'; song: SongRef; position: number; queue: SongRef[]; index: number; setlistName?: string; page?: number }
  | { type: 'closeSong' }
  /**
   * Absolute position within the current song. `position` is in the sender's display stops; `page`
   * (first visible page) is layout-independent and preferred, since devices may use other layouts.
   */
  | { type: 'page'; songId: string; position: number; page?: number }
  /** Mirrored navigation action. */
  | { type: 'action'; action: ActionId; songId?: string }
  | { type: 'setlist'; name: string; items: SetlistItemRef[] }
  | { type: 'requestState' }

export interface Envelope {
  v: number
  /** sender device id */
  from: string
  name: string
  role: Role
  /** per-sender sequence number (dedupe across transports) */
  seq: number
  t: number
  /** optional target device id */
  to?: string
  body: Body
}

/** Navigation actions mirrored to followers. Song changes travel as openSong instead. */
export const MIRRORED_ACTIONS: ActionId[] = [
  'nextPage',
  'prevPage',
  'nextOnePage',
  'prevOnePage',
  'nextTwoPages',
  'prevTwoPages',
  'nextPageLoop',
  'prevPageLoop',
  'nextHalfPage',
  'prevHalfPage',
  'firstPage',
  'lastPage',
  'scrollDown',
  'scrollUp',
  'followLink',
  'goBack',
  'activateLinkOrTurn',
  'prevBookmark',
  'nextBookmark',
]

export const sends = (role: Role) => role !== 'follower'
/** Do I act on control messages from a device with role `sender`? */
export const obeys = (me: Role, sender: Role) => me !== 'leader' && sender !== 'follower'

export function parseEnvelope(data: unknown): Envelope | null {
  let o: unknown = data
  if (typeof data === 'string') {
    try {
      o = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!o || typeof o !== 'object') return null
  const e = o as Partial<Envelope>
  if (typeof e.v !== 'number' || typeof e.from !== 'string' || typeof e.seq !== 'number' || !e.body || typeof (e.body as Body).type !== 'string') return null
  if (e.role !== 'leader' && e.role !== 'follower' && e.role !== 'peer') return null
  return { v: e.v, from: e.from, name: String(e.name ?? ''), role: e.role, seq: e.seq, t: Number(e.t ?? 0), to: e.to, body: e.body as Body }
}

/* ------------------------------------------------------------------ roster */

export interface Peer {
  id: string
  name: string
  role: Role
  lastSeen: number
  /** Title of the song the peer last announced */
  song?: string
}

export type Roster = Record<string, Peer>

export const PEER_TTL_MS = 25_000

export function rosterReduce(roster: Roster, e: Envelope, now: number): Roster {
  if (e.body.type === 'bye') {
    if (!roster[e.from]) return roster
    const next = { ...roster }
    delete next[e.from]
    return next
  }
  if (e.body.type === 'hello' && typeof e.body.replaces === 'string' && e.body.replaces !== e.from && roster[e.body.replaces]) {
    roster = { ...roster }
    delete roster[e.body.replaces as string]
  }
  const prev = roster[e.from]
  const song = e.body.type === 'openSong' ? e.body.song.title : e.body.type === 'closeSong' ? undefined : prev?.song
  return { ...roster, [e.from]: { id: e.from, name: e.name || prev?.name || 'Device', role: e.role, lastSeen: now, song } }
}

export function rosterExpire(roster: Roster, now: number, ttl = PEER_TTL_MS): Roster {
  const stale = Object.values(roster).filter((p) => now - p.lastSeen > ttl)
  if (!stale.length) return roster
  const next = { ...roster }
  for (const p of stale) delete next[p.id]
  return next
}

/* ----------------------------------------------------------------- dedupe */

/**
 * Senders that said bye, with the bye's seq. Messages travel over two transports, so one sent just
 * before the bye can arrive after it; it must not bring the device back for another PEER_TTL_MS.
 */
export class DepartedSet {
  private gone = new Map<string, number>()
  private max: number
  constructor(max = 200) {
    this.max = max
  }
  /** Feed every accepted message; returns false for one that predates its sender's bye. */
  accept(e: Pick<Envelope, 'from' | 'seq' | 'body'>): boolean {
    const bye = this.gone.get(e.from)
    if (e.body.type === 'bye') {
      this.gone.set(e.from, Math.max(bye ?? 0, e.seq))
      if (this.gone.size > this.max) this.gone.delete(this.gone.keys().next().value!)
      return true
    }
    // A later seq is the same tab back again (restored from the back/forward cache).
    return bye === undefined || e.seq > bye
  }
}

/** Remembers recent (sender, seq) pairs; a device may hear a message over two transports. */
export class SeenSet {
  private seen = new Map<string, number>()
  private max: number
  constructor(max = 2000) {
    this.max = max
  }
  /** Returns true the first time a message is seen. */
  add(e: Pick<Envelope, 'from' | 'seq'>): boolean {
    const k = `${e.from}:${e.seq}`
    if (this.seen.has(k)) return false
    this.seen.set(k, 1)
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!)
    return true
  }
}

/* --------------------------------------------------------- song matching */

export const normTitle = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export interface Candidate {
  id: string
  title: string
  artists: string[]
}

/** Best local match for a remote song: same id, then title + artist, then title alone. */
export function pickMatch(ref: SongRef, candidates: Candidate[]): string | undefined {
  const byId = candidates.find((c) => c.id === ref.id)
  if (byId) return byId.id
  const t = normTitle(ref.title)
  const same = candidates.filter((c) => normTitle(c.title) === t)
  if (!same.length) return undefined
  if (ref.artist) {
    const a = normTitle(ref.artist)
    const withArtist = same.find((c) => c.artists.some((x) => normTitle(x) === a))
    if (withArtist) return withArtist.id
  }
  return same[0].id
}

/** Map a remote queue to local ids, keeping the current song's index pointing at the right entry. */
export function resolveQueue(queue: SongRef[], index: number, match: (r: SongRef) => string | undefined): { ids: string[]; index: number; missing: number } {
  const ids: string[] = []
  let at = -1
  let missing = 0
  queue.forEach((r, i) => {
    const id = match(r)
    if (!id) {
      missing++
      return
    }
    if (i === index) at = ids.length
    ids.push(id)
  })
  return { ids, index: at, missing }
}

/* --------------------------------------------------- following page turns */

/** Which local song a remote song was matched to (`local` undefined: not in this library). */
export interface SongPair {
  remote: string
  local?: string
}

/**
 * Whether a page turn for remote song `remoteId` applies to the local song `cur`: same id, or the song we
 * matched it to. A remote song we couldn't match never drives whatever this device still shows.
 */
export function followsSong(cur: string, remoteId: string | undefined, pair: SongPair | undefined): boolean {
  if (!remoteId || cur === remoteId) return true
  return !!pair && pair.remote === remoteId && pair.local === cur
}

/**
 * Remembers the page change this device is about to make because of a remote message, so only that echo
 * is kept from going back out. A page the user turns at the same moment is still sent (with a time
 * window, two-way sync between different layouts drifted apart).
 */
export class EchoGuard {
  private expect: { page?: number; until: number } | null = null
  private windowMs: number
  constructor(windowMs = 700) {
    this.windowMs = windowMs
  }
  /** A remote message is being applied; `page` when the resulting page is known (else the next change). */
  arm(now: number, page?: number) {
    this.expect = { page, until: now + this.windowMs }
  }
  /** True when this page change is the expected echo (consumed). */
  isEcho(page: number | undefined, now: number): boolean {
    const e = this.expect
    if (!e || now > e.until) return false
    if (e.page !== undefined && page !== undefined && e.page !== page) return false
    this.expect = null
    return true
  }
}

/* ------------------------------------------------------------------ rooms */

/** Room of older versions: one room shared by everyone using the public relay. */
export const LEGACY_ROOM = 'band'
const ROOM_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'

/** An unguessable room name, readable and typeable: 16 characters (~79 bits) like "k7mq-2xpt-9bwr-4hcn". */
export function randomRoom(): string {
  const out: string[] = []
  while (out.length < 16) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      // Rejection sampling keeps every character equally likely.
      if (b < 248 && out.length < 16) out.push(ROOM_CHARS[b % ROOM_CHARS.length])
    }
  }
  return out.join('').replace(/(.{4})(?!$)/g, '$1-')
}
