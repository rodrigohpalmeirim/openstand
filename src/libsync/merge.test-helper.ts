/**
 * Test kit for the merge tests: a seeded PRNG and a simulated device that drives `project` / `diff` /
 * `mergeDelta` / `materialize` / `toShadow` / `fromShadow` the way the engine does, with
 * captures running immediately after every local write.
 */
import { emptySong, type PageAnnotations, type Setlist, type Song } from '../db/schema'
import { canonicalJson, hash64 } from './hash'
import { createClock } from './hlc'
import { applyRecord, captureRecord, deltaHlcMax, diff, project } from './merge'
import type { Collection, CollectionRows, HlcClock, RecordDelta, ShadowRecord } from './model'

/** mulberry32 */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    shuffle<T>(xs: T[]): T[] {
      const out = [...xs]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
}
export type Rng = ReturnType<typeof rng>

export const DEV = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'] as const
export const T0 = 1_760_000_000_000
/** A fake SHA-256 hex for a name. */
export const hash = (s: string) => hash64(s).repeat(4)

const rowKey = (c: Collection, id: string) => `${c}/${id}`

export class SimDevice {
  readonly clock: HlcClock
  wall: number
  readonly rows = new Map<string, unknown>()
  readonly shadows = new Map<string, ShadowRecord>()
  /** Ops this device produced, in order. */
  readonly sent: RecordDelta[] = []
  /** Rows as they were just before a local delete (what an undo toast would put back). */
  readonly graveyard = new Map<string, unknown>()

  readonly id: string

  constructor(id: string, skew = 0) {
    this.id = id
    this.wall = T0 + skew
    this.clock = createClock(id, undefined, () => this.wall)
  }

  tick(ms = 1) {
    this.wall += ms
  }

  get<C extends Collection>(c: C, id: string): CollectionRows[C] | undefined {
    return this.rows.get(rowKey(c, id)) as CollectionRows[C] | undefined
  }

  /** A local write (put, or delete with `null`) followed by its capture. Returns the op, if any. */
  write<C extends Collection>(c: C, id: string, row: CollectionRows[C] | null): RecordDelta | null {
    const k = rowKey(c, id)
    const prev = this.rows.get(k)
    if (row) this.rows.set(k, row)
    else {
      if (prev) this.graveyard.set(k, prev)
      this.rows.delete(k)
    }
    this.tick()
    return this.capture(c, id)
  }

  capture(c: Collection, id: string): RecordDelta | null {
    const k = rowKey(c, id)
    const row = (this.rows.get(k) ?? null) as never
    const r = captureRecord(c, row, this.shadows.get(k), this.clock.now(this.wall), this.id)
    if (r.row !== undefined) {
      if (r.row) this.rows.set(k, r.row)
      else this.rows.delete(k)
    }
    if (!r.delta) return null
    this.shadows.set(k, r.shadow!)
    this.sent.push(r.delta)
    return r.delta
  }

  /** Apply a remote op. */
  receive(op: RecordDelta) {
    const k = rowKey(op.c, op.id)
    const r = applyRecord(op.c, (this.rows.get(k) ?? null) as never, this.shadows.get(k), op)
    if (r.row) this.rows.set(k, r.row)
    else this.rows.delete(k)
    this.shadows.set(k, r.shadow)
    this.clock.receive(deltaHlcMax(op), this.wall)
  }

  /** What a capture would emit now without writing anything (must be null once converged). */
  pending(c: Collection, id: string): RecordDelta | null {
    const k = rowKey(c, id)
    const row = this.rows.get(k)
    const proj = row ? project(c, row as never) : null
    return diff(c, proj, this.shadows.get(k), this.clock.now(this.wall), this.id)
  }

  keys(): string[] {
    return [...new Set([...this.rows.keys(), ...this.shadows.keys()])]
  }
}

export function connect(...devs: SimDevice[]) {
  return {
    /** Deliver every op of `from` to all others (idempotent, so re-delivery is harmless). */
    flush(from: SimDevice) {
      for (const d of devs) if (d !== from) for (const op of from.sent) d.receive(op)
    },
    flushAll() {
      for (const d of devs) for (const o of devs) if (o !== d) for (const op of o.sent) d.receive(op)
    },
  }
}

/** A comparable view of a row: canonical JSON of its projection (local-only fields excluded). */
export function view(c: Collection, row: unknown): string {
  return row ? canonicalJson(project(c, row as never)) : 'null'
}

export function song(id: string, p: Partial<Song> = {}): Song {
  return { ...emptySong({ id, title: `Song ${id}` }), createdAt: T0, modifiedAt: T0, ...p }
}

export function setlist(id: string, p: Partial<Setlist> = {}): Setlist {
  return { id, name: `Set ${id}`, entries: [], notes: '', createdAt: T0, modifiedAt: T0, ...p }
}

export function page(songId: string, fileId: string, pageNo: number, items: PageAnnotations['items'] = []): PageAnnotations {
  return { id: `${songId}:${fileId}:${pageNo}`, songId, fileId, page: pageNo, items }
}

export function stroke(id: string, layer = 'default'): PageAnnotations['items'][number] {
  return { id, type: 'pen', layer, color: '#000', opacity: 1, createdAt: T0, width: 0.004, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4, p: 0.5 }] }
}

export const clone = <T>(x: T): T => structuredClone(x)
