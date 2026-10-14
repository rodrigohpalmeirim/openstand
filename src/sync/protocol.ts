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
  /** Announce/heartbeat. `reply` marks answers so they aren't answered again. */
  | { type: 'hello'; reply?: boolean }
  | { type: 'bye' }
  /** A new song is showing (also the answer to requestState). */
  | { type: 'openSong'; song: SongRef; position: number; queue: SongRef[]; index: number; setlistName?: string }
  | { type: 'closeSong' }
  /** Absolute position within the current song (display stops). */
  | { type: 'page'; songId: string; position: number }
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
