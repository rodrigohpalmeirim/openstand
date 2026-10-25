/**
 * The two transactional halves of library sync:
 *
 * - `capture`: dirty records → per-register ops (state-based diff against `syncShadow`) → the open outbox
 *   batch, in one rw transaction, so the shadow, the dirty marks and the outbox move together.
 * - `applyOps`: remote ops → shadow merge → row writes, in one rw transaction marked remote (the capture
 *   middleware skips it; recapturing would diff empty anyway because the shadow is written too).
 *
 * Outbox rows are written as plain JSON inside the transaction (WebCrypto would end an IndexedDB
 * transaction) and sealed right before they are pushed: `isPlainOutbox` tells them apart (a sealed
 * envelope starts with the format byte 0x01, plain JSON with `{`).
 */
import Dexie from 'dexie'
import { markRemote } from '../db/capture'
import type { OpenStandDB } from '../db/db'
import type { Song } from '../db/schema'
import type { StorageBackend } from './backends/types'
import { queueDownload, queueUpload, SHA256, songPriority } from './blobs'
import type { LibraryKeys } from './crypto'
import { isCollection, syncedKv, validateDelta } from './fields'
import { canonicalJson } from './hash'
import { hlcAhead, isDeviceId, maxHlc } from './hlc'
import { captureRecord, deltaHlcMax, fromShadow, materialize, mergeDelta, project, toShadow, type MaterializeCtx, type ProjectCtx } from './merge'
import {
  BATCH_MAX,
  BLOB_CLAIM_MAX,
  CLOCK_AHEAD_MAX,
  DIRTY_DEFER_MAX,
  type Batch,
  type Collection,
  type CollectionRows,
  type DirtyRow,
  type HlcClock,
  type OutboxRow,
  type RecordDelta,
  type ShadowRecord,
  type SyncConfig,
} from './model'
import { getState, parseRecKey, putState, recKey, TABLE_OF } from './state'

/** Everything the sync code needs for one library on one device. */
export interface Core {
  db: OpenStandDB
  config: SyncConfig
  keys: LibraryKeys
  backend: StorageBackend
  clock: HlcClock
  now: () => number
  log?: (msg: string, extra?: unknown) => void
}

/** Tables of a capture or apply transaction. */
export const syncTxTables = (db: OpenStandDB) => [
  db.songs,
  db.setlists,
  db.annotations,
  db.kv,
  db.blobs,
  db.syncShadow,
  db.syncDirty,
  db.syncOutbox,
  db.syncState,
  db.syncTransfers,
]

/** What an apply (or join) changed, for UI refreshes after commit. */
export interface Applied {
  songs: Set<string>
  setlists: Set<string>
  anns: Set<string>
  kv: Set<string>
  ops: number
  skipped: number
}
export const newApplied = (): Applied => ({ songs: new Set(), setlists: new Set(), anns: new Set(), kv: new Set(), ops: 0, skipped: 0 })

const appliedSet = (a: Applied, c: Collection) => (c === 'song' ? a.songs : c === 'setlist' ? a.setlists : c === 'ann' ? a.anns : a.kv)

// ---------------------------------------------------------------------------------------------
// Blob id <-> content hash (never changes for a given id, so it's cached per database)
// ---------------------------------------------------------------------------------------------

const hashCache = new Map<string, Map<string, { hash: string; mime?: string }>>()
const cacheFor = (db: OpenStandDB) => {
  let m = hashCache.get(db.name)
  if (!m) hashCache.set(db.name, (m = new Map()))
  return m
}

function songBlobIds(s: Song | undefined): string[] {
  if (!s) return []
  const ids: string[] = []
  for (const f of s.files ?? []) if (f.blobId) ids.push(f.blobId)
  for (const a of s.audio ?? []) if (a.blobId) ids.push(a.blobId)
  return ids
}

/** Synchronous `ProjectCtx` for a song, prefetched inside the current transaction. */
export async function projectCtx(db: OpenStandDB, song: Song | undefined): Promise<ProjectCtx> {
  const cache = cacheFor(db)
  const info = new Map<string, { hash: string; mime?: string }>()
  for (const id of songBlobIds(song)) {
    let v = cache.get(id)
    if (!v) {
      const rec = await db.blobs.get(id)
      if (rec) {
        v = { hash: rec.hash, mime: rec.mime }
        cache.set(id, v)
      } else if (SHA256.test(id)) {
        // Download pending: the transfer row has the sender's mime.
        v = { hash: id, mime: (await db.syncTransfers.get(['down', id]))?.mime }
      } else v = { hash: '' }
    }
    info.set(id, v)
  }
  return {
    blobHash: (id) => info.get(id)?.hash ?? (SHA256.test(id) ? id : ''),
    blobMime: (id) => info.get(id)?.mime,
  }
}

/** A peer's claimed file size, or 0 (unknown) when it isn't a plausible one. */
export const claimedSize = (n: unknown): number => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= BLOB_CLAIM_MAX ? n : 0)

/** Wire hashes of a delta's/state's `files` and `audio` elements. */
function wireHashes(d: RecordDelta): { hash: string; size: number; mime: string }[] {
  const out: { hash: string; size: number; mime: string }[] = []
  for (const field of ['files', 'audio']) {
    for (const r of Object.values(d.l?.[field]?.e ?? {})) {
      const v = r[1] as { blob?: unknown; size?: unknown; mime?: unknown } | null
      if (v && typeof v.blob === 'string' && SHA256.test(v.blob))
        out.push({ hash: v.blob, size: claimedSize(v.size), mime: typeof v.mime === 'string' ? v.mime : '' })
    }
  }
  return out
}

/** Synchronous `MaterializeCtx`: wire hash → existing local blob id (legacy uuid) or the hash itself. */
async function materializeCtx(db: OpenStandDB, state: RecordDelta, pctx: ProjectCtx): Promise<MaterializeCtx> {
  const ids = new Map<string, string>()
  for (const { hash } of wireHashes(state)) {
    if (ids.has(hash)) continue
    const rec = (await db.blobs.get(hash)) ?? (await db.blobs.where('hash').equals(hash).first())
    ids.set(hash, rec?.id ?? hash)
  }
  return { blobHash: pctx.blobHash, blobId: (h) => ids.get(h) ?? h }
}

// ---------------------------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------------------------

const PLAIN = 0x7b // '{'
export const isPlainOutbox = (r: Pick<OutboxRow, 'bytes'>) => r.bytes[0] === PLAIN
const enc = new TextEncoder()
const dec = new TextDecoder()
export const plainBatch = (r: Pick<OutboxRow, 'bytes'>) => JSON.parse(dec.decode(r.bytes)) as Batch

/**
 * Appends ops to the open (still plain) outbox batch, opening a new one — and allocating its seq — when
 * there is none or it's full. Use inside a transaction holding `syncOutbox` and `syncState`.
 */
export class OutboxWriter {
  private open: { batch: Batch; size: number } | null = null
  private touched = new Map<number, Batch>()
  private loaded = false
  private nextSeq = 0
  ops = 0
  private core: Core

  constructor(core: Core) {
    this.core = core
  }

  private async load() {
    if (this.loaded) return
    this.loaded = true
    const { db } = this.core
    this.nextSeq = (await getState(db, 'seq'))?.next ?? 1
    const last = await db.syncOutbox.orderBy('seq').last()
    if (last && isPlainOutbox(last)) {
      const batch = plainBatch(last)
      this.open = { batch, size: last.bytes.length }
    }
  }

  private fresh(): { batch: Batch; size: number } {
    const batch: Batch = { v: 1, d: this.core.config.deviceId, s: this.nextSeq++, t: this.core.now(), hlcMax: '0'.repeat(32), ops: [] }
    this.open = { batch, size: 200 }
    this.touched.set(batch.s, batch)
    return this.open
  }

  async add(op: RecordDelta) {
    await this.load()
    const size = JSON.stringify(op).length + 1
    let o = this.open ?? this.fresh()
    if (o.batch.ops.length && (o.batch.ops.length >= BATCH_MAX.ops || o.size + size > BATCH_MAX.bytes)) o = this.fresh()
    o.batch.ops.push(op)
    o.batch.hlcMax = maxHlc(o.batch.hlcMax, deltaHlcMax(op))
    o.size += size
    this.touched.set(o.batch.s, o.batch)
    this.ops++
  }

  async addReady(hash: string) {
    await this.load()
    const o = this.open ?? this.fresh()
    if (!(o.batch.blobsReady ??= []).includes(hash)) o.batch.blobsReady.push(hash)
    o.size += 70
    this.touched.set(o.batch.s, o.batch)
  }

  async flush() {
    if (!this.touched.size) return
    const { db } = this.core
    for (const b of this.touched.values()) {
      b.t = this.core.now()
      await db.syncOutbox.put({ seq: b.s, bytes: enc.encode(JSON.stringify(b)), ops: b.ops.length, hlcMax: b.hlcMax, blobsReady: b.blobsReady ?? [] })
    }
    await putState(db, 'seq', { next: this.nextSeq })
    this.touched.clear()
  }
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

type CaptureResult = 'op' | 'none' | 'deferred'

/** Diff one dirty record into `out`. Must run inside a transaction over `syncTxTables`. */
async function captureOne(core: Core, dirty: DirtyRow, out: OutboxWriter): Promise<CaptureResult> {
  const { db } = core
  const { c, id } = parseRecKey(dirty.id)
  if (!isCollection(c) || (c === 'kv' && !syncedKv(id))) {
    await db.syncDirty.delete(dirty.id)
    return 'none'
  }
  const row = (await db.table(TABLE_OF[c]).get(id)) as CollectionRows[typeof c] | undefined
  if (c === 'ann' && row) {
    // Orphan guard: never publish a page whose song (or file) this device doesn't have (yet).
    const page = row as CollectionRows['ann']
    const song = await db.songs.get(page.songId)
    if (!song?.files.some((f) => f.id === page.fileId)) {
      const since = dirty.deferredSince ?? core.now()
      if (core.now() - since > DIRTY_DEFER_MAX) await db.syncDirty.delete(dirty.id)
      else if (!dirty.deferredSince) await db.syncDirty.put({ ...dirty, deferredSince: since })
      return 'deferred'
    }
  }
  const shadow = await db.syncShadow.get(id)
  const pctx = await projectCtx(db, c === 'song' ? (row as Song | undefined) : undefined)
  const res = captureRecord(c, row ?? null, shadow, core.clock.now(dirty.at), core.config.deviceId, pctx)
  await db.syncDirty.delete(dirty.id)
  // A value no op can publish (a max register lowered locally, an empty page): fix the row instead. The
  // capture transaction is marked remote, so this write isn't captured again.
  if (res.row !== undefined) {
    if (res.row === null) await db.table(TABLE_OF[c]).delete(id)
    else await db.table(TABLE_OF[c]).put(res.row)
  }
  const delta = res.delta
  if (!delta) return 'none'
  await db.syncShadow.put(res.shadow!)
  await out.add(delta)
  // Step 7: files this device holds go up (the upload skips blobs that are already there).
  for (const w of wireHashes(delta)) {
    const rec = (await db.blobs.get(w.hash)) ?? (await db.blobs.where('hash').equals(w.hash).first())
    if (rec) await queueUpload(db, w.hash, rec.size, rec.mime)
  }
  return 'op'
}

export interface CaptureStats {
  ops: number
  deferred: number
  records: number
}

/**
 * Turn dirty records into outbox ops. `keys` limits it to those dirty ids (apply step 1); otherwise all
 * dirty records are processed in transactions of `pageSize`.
 */
export async function capture(core: Core, o: { pageSize?: number } = {}): Promise<CaptureStats> {
  const { db } = core
  const stats: CaptureStats = { ops: 0, deferred: 0, records: 0 }
  const pageSize = o.pageSize ?? 500
  let after = ''
  for (;;) {
    const done = await db.transaction('rw', syncTxTables(db), async () => {
      markRemote(Dexie.currentTransaction)
      const rows = await db.syncDirty.where('id').above(after).limit(pageSize).toArray()
      if (!rows.length) return true
      after = rows[rows.length - 1].id
      const out = new OutboxWriter(core)
      for (const r of rows) {
        const res = await captureOne(core, r, out)
        stats.records++
        if (res === 'op') stats.ops++
        else if (res === 'deferred') stats.deferred++
      }
      await out.flush()
      await putState(db, 'clock', core.clock.last)
      return rows.length < pageSize
    })
    if (done) break
  }
  return stats
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

/**
 * How far (ms) the furthest timestamp among the well-formed `ops` is ahead of `now` (≤ 0: none is). The
 * engine holds a batch back while this is between CLOCK_AHEAD_MAX and CLOCK_AHEAD_STALL.
 */
export function opsAhead(ops: unknown[], now: number): number {
  let ahead = -Infinity
  for (const op of ops) if (!validateDelta(op)) ahead = Math.max(ahead, hlcAhead(deltaHlcMax(op as RecordDelta), now))
  return ahead
}

/**
 * Merge remote ops into shadow and rows. Must run inside a transaction over `syncTxTables` that was
 * passed to `markRemote`. Invalid ops are skipped and logged, never written: malformed ones, ones stamped
 * more than CLOCK_AHEAD_MAX ahead of local time (the clock refuses them), and ones whose id belongs to a
 * record of another collection. Each accepted op advances the clock.
 */
export async function applyOpsInTx(core: Core, ops: RecordDelta[], applied: Applied, o: { out?: OutboxWriter } = {}) {
  const { db } = core
  const out = o.out ?? new OutboxWriter(core)
  const skip = (op: RecordDelta, why: string) => {
    applied.skipped++
    core.log?.(`skipped op ${String(op?.c).slice(0, 20)}/${String(op?.id).slice(0, 80)}: ${why}`)
  }
  for (const op of ops) {
    const bad = validateDelta(op)
    if (bad) {
      skip(op, bad)
      continue
    }
    const h = deltaHlcMax(op)
    if (!core.clock.receive(h, core.now())) {
      skip(op, `stamped ${Math.round(hlcAhead(h, core.now()) / 60_000)} min ahead (over ${CLOCK_AHEAD_MAX / 60_000})`)
      continue
    }
    if (!isCollection(op.c)) {
      // Unknown collection (newer app version): kept opaquely and included in our snapshots.
      const sh = await db.syncShadow.get(op.id)
      if (sh && sh.c !== op.c) {
        skip(op, `id belongs to a ${sh.c} record`)
        continue
      }
      applied.ops++
      const x = mergeDelta(sh?.x as RecordDelta | undefined, op)
      await db.syncShadow.put({ id: op.id, c: op.c, f: {}, m: {}, l: {}, n: {}, x })
      continue
    }
    const c = op.c
    const other = await db.syncShadow.get(op.id)
    if (other && other.c !== c) {
      skip(op, `id belongs to a ${other.c} record`)
      continue
    }
    applied.ops++
    const dirty = await db.syncDirty.get(recKey(c, op.id))
    if (dirty) await captureOne(core, dirty, out)
    const table = db.table(TABLE_OF[c])
    const row = (await table.get(op.id)) as CollectionRows[typeof c] | undefined
    const shadow = await db.syncShadow.get(op.id)
    const pctx = await projectCtx(db, c === 'song' ? (row as Song | undefined) : undefined)
    const proj = row ? project(c, row, pctx) : null
    const base = shadow ? fromShadow(shadow, proj) : undefined
    const state = mergeDelta(base, op)
    const nextShadow: ShadowRecord = toShadow(state)
    if (shadow && sameJson(nextShadow, shadow)) continue
    const mctx = await materializeCtx(db, state, pctx)
    const next = materialize(c, state, row ?? null, mctx)
    if (!next) {
      if (row) await table.delete(op.id)
    } else if (!row || !sameJson(next, row)) await table.put(next)
    await db.syncShadow.put(nextShadow)
    appliedSet(applied, c).add(op.id)
    if (c === 'song' && next) await queueMissing(db, next as Song, state)
  }
  return out
}

/** Downloads for files of `song` this device doesn't hold. */
async function queueMissing(db: OpenStandDB, song: Song, state: RecordDelta) {
  const prio = songPriority(song)
  for (const w of wireHashes(state)) {
    if ((await db.blobs.get(w.hash)) || (await db.blobs.where('hash').equals(w.hash).count())) continue
    await queueDownload(db, w.hash, w.size, w.mime || 'application/octet-stream', prio)
  }
}

const validSeq = (d: unknown, s: unknown): s is number => isDeviceId(d) && typeof s === 'number' && Number.isSafeInteger(s) && s >= 0

/**
 * Apply one remote batch (or snapshot slice) in its own remote-marked transaction, advancing the
 * cursor and the clock with it. The clock moves only by the ops actually accepted (a batch's own
 * `hlcMax` is never trusted). Cursors only move forward, and only for well-formed device ids and seqs:
 * the caller has already clamped them to the observed heads.
 */
export async function applyOps(
  core: Core,
  ops: RecordDelta[],
  o: { cursor?: { device: string; seq: number }; cursors?: Record<string, number> } = {},
): Promise<Applied> {
  const { db } = core
  const applied = newApplied()
  await db.transaction('rw', syncTxTables(db), async () => {
    markRemote(Dexie.currentTransaction)
    const out = await applyOpsInTx(core, ops, applied)
    await out.flush()
    await putState(db, 'clock', core.clock.last)
    const moves: [string, number][] = [...(o.cursor ? [[o.cursor.device, o.cursor.seq] as [string, number]] : []), ...Object.entries(o.cursors ?? {})]
    if (moves.length) {
      const cur: Record<string, number> = { ...((await getState(db, 'cursors')) ?? {}) }
      for (const [d, s] of moves) if (validSeq(d, s) && s > (cur[d] ?? 0)) cur[d] = s
      await putState(db, 'cursors', cur)
    }
  })
  return applied
}

/** Merge `b` into `a`. */
export function mergeApplied(a: Applied, b: Applied) {
  for (const k of ['songs', 'setlists', 'anns', 'kv'] as const) for (const x of b[k]) a[k].add(x)
  a.ops += b.ops
  a.skipped += b.skipped
  return a
}
