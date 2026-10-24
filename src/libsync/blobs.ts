/**
 * Blob transfers (docs/SYNC.md §10.2): a persistent, resumable upload/download queue in `syncTransfers`.
 *
 * - Uploads encrypt chunks on demand from the stored `Blob` (memory stays bounded) and resume through the
 *   backend's `UploadState`. Blob ciphertext is deterministic, so a re-sent part is byte-identical.
 * - Downloads fetch `RANGE` chunks per GET, decrypt them and keep them in `syncChunks`, so they resume at
 *   chunk granularity. A 404 parks the row as `waiting` until a batch announces the blob (`blobsReady`).
 * - Priority: `prioritize` (+1000), then recently played songs, then smaller files.
 */
import type { OpenStandDB } from '../db/db'
import type { BlobRecord, Song } from '../db/schema'
import { BackendError, type StorageBackend } from './backends/types'
import {
  blobContext,
  blobSource,
  chunkByteRange,
  chunkCount,
  ciphertextSize,
  decryptChunks,
  encryptChunks,
  FormatError,
  HEADER_BYTES,
  parseContainerHeader,
  sha256Hex,
  type ContainerHeader,
  type LibraryKeys,
} from './crypto'
import { MULTIPART_STALE, RANGE, type TransferDir, type TransferRow } from './model'
import { blobKey } from './paths'

export const SHA256 = /^[0-9a-f]{64}$/
const WAIT_RETRY = 10 * 60_000
const VERIFY_MAX = 32 * 1024 * 1024
const RESERVE = 200 * 1024 * 1024
export const POOL = { down: 3, up: 2 } as const
export const PRIORITY_BOOST = 1000

/** Priority of a download for a song: recently played first (a fraction, so `prioritize` always wins). */
export const songPriority = (s: Pick<Song, 'lastPlayedAt'> | undefined) => (s?.lastPlayedAt ? Math.min(0.999, s.lastPlayedAt / 1e13) : 0)

/** Queue an upload. Works inside a transaction that holds `syncTransfers`. */
export async function queueUpload(db: OpenStandDB, hash: string, size: number, mime: string) {
  if (!SHA256.test(hash)) return
  const key: [TransferDir, string] = ['up', hash]
  if (await db.syncTransfers.get(key)) return
  await db.syncTransfers.put({ dir: 'up', hash, size, mime, state: 'queued', priority: 0, attempts: 0, nextAt: 0 })
}

/** Queue a download (or raise its priority). Works inside a transaction that holds `syncTransfers`. */
export async function queueDownload(db: OpenStandDB, hash: string, size: number, mime: string, priority = 0) {
  if (!SHA256.test(hash)) return
  const key: [TransferDir, string] = ['down', hash]
  const row = await db.syncTransfers.get(key)
  if (row) {
    if (priority > row.priority) await db.syncTransfers.update(key, { priority })
    return
  }
  await db.syncTransfers.put({ dir: 'down', hash, size, mime, state: 'queued', priority, attempts: 0, nextAt: 0 })
}

/** The local blob row holding content `hash` (new ids are the hash; legacy rows keep a uuid id). */
export async function localBlob(db: OpenStandDB, hash: string): Promise<BlobRecord | undefined> {
  return (await db.blobs.get(hash)) ?? (await db.blobs.where('hash').equals(hash).first())
}

export interface BlobQueueDeps {
  db: OpenStandDB
  backend: StorageBackend
  keys: LibraryKeys
  now?: () => number
  /** Whether transfers may run now (visible, online, not paused). `prioritized` rows may run while performing. */
  canRun?: (o: { prioritized: boolean }) => boolean
  /** An upload finished: the engine announces it in the next batch (`blobsReady`). */
  onUploaded?: (hash: string) => Promise<void> | void
  onDownloaded?: (hash: string) => void
  onError?: (e: unknown, row: TransferRow) => void
  onProgress?: () => void
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
}

export interface QueueStats {
  upload: { files: number; bytes: number; doneFiles: number; doneBytes: number }
  download: { files: number; bytes: number; doneFiles: number; doneBytes: number }
}

const rowKey = (r: Pick<TransferRow, 'dir' | 'hash'>): [TransferDir, string] => [r.dir, r.hash]

export class LocalQuotaError extends Error {
  readonly needed: number
  constructor(needed: number) {
    super(`This device is out of space (needs ${Math.ceil(needed / 1e6)} MB more).`)
    this.name = 'LocalQuotaError'
    this.needed = needed
  }
}

/** Runs the transfer queue for one library. Not tied to the engine's mutex. */
export class BlobQueue {
  private readonly d: Required<Pick<BlobQueueDeps, 'now'>> & BlobQueueDeps
  private active = new Map<string, AbortController>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private pumping: Promise<void> | null = null
  private again = false
  /** Bytes transferred of in-flight rows (for progress). */
  private live = new Map<string, number>()
  private done = { up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } }
  private idleWaiters: (() => void)[] = []

  constructor(deps: BlobQueueDeps) {
    this.d = { now: Date.now, ...deps }
  }

  get db() {
    return this.d.db
  }

  private running = false

  /** Rows that were `active` when the app stopped go back to the queue. */
  async start() {
    this.stopped = false
    if (!this.running) {
      this.running = true
      await this.db.syncTransfers.where('state').equals('active').modify({ state: 'queued' })
    }
    this.kick()
  }

  stop() {
    this.stopped = true
    this.running = false
    if (this.timer) (this.d.timers?.clearTimeout ?? clearTimeout)(this.timer)
    for (const a of this.active.values()) a.abort()
    this.active.clear()
  }

  /** Re-evaluate the queue now (new rows, visibility or connectivity changed). */
  kick() {
    if (this.stopped) return
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = this.pump()
      .catch((e) => console.warn('[libsync] transfer queue', e))
      .finally(() => {
        this.pumping = null
        if (this.again) {
          this.again = false
          this.kick()
        } else this.settle()
      })
  }

  /** Raise the priority of these content hashes (a song or setlist opened). */
  async prioritize(hashes: string[]) {
    await this.db.transaction('rw', this.db.syncTransfers, async () => {
      for (const h of hashes) {
        const k: [TransferDir, string] = ['down', h]
        const row = await this.db.syncTransfers.get(k)
        if (row && row.priority < PRIORITY_BOOST) await this.db.syncTransfers.update(k, { priority: row.priority + PRIORITY_BOOST, nextAt: 0 })
      }
    })
    this.kick()
  }

  /** `waiting` downloads of these hashes are retried now (another device announced them). */
  async wake(hashes: string[]) {
    if (!hashes.length) return
    await this.db.syncTransfers
      .where('[dir+hash]')
      .anyOf(hashes.map((h) => ['down', h]))
      .modify((r) => {
        if (r.state === 'waiting' || r.state === 'failed') Object.assign(r, { state: 'queued', nextAt: 0 })
      })
    this.kick()
  }

  /** Bytes still to download, for the quota check. */
  private async neededBytes() {
    let n = 0
    await this.db.syncTransfers.where('[dir+hash]').between(['down', ''], ['down', '￿']).each((r) => (n += r.size))
    return n
  }

  stats(rows: TransferRow[]): QueueStats {
    const s: QueueStats = {
      upload: { files: this.done.up.files, bytes: this.done.up.bytes, doneFiles: this.done.up.files, doneBytes: this.done.up.bytes },
      download: { files: this.done.down.files, bytes: this.done.down.bytes, doneFiles: this.done.down.files, doneBytes: this.done.down.bytes },
    }
    for (const r of rows) {
      const p = r.dir === 'up' ? s.upload : s.download
      p.files++
      p.bytes += r.size
      p.doneBytes += this.live.get(r.dir + r.hash) ?? 0
    }
    if (!rows.some((r) => r.dir === 'up')) this.done.up = { files: 0, bytes: 0 }
    if (!rows.some((r) => r.dir === 'down')) this.done.down = { files: 0, bytes: 0 }
    return s
  }

  /** Download progress 0..1 of one hash, if it's in flight. */
  progress(hash: string, size: number): number | undefined {
    const b = this.live.get('down' + hash)
    return b === undefined || !size ? undefined : Math.min(1, b / size)
  }

  /** Resolves when nothing runnable is left (tests, leave). */
  idle(): Promise<void> {
    if (!this.pumping && !this.active.size) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private settle() {
    if (this.pumping || this.active.size) return
    const w = this.idleWaiters
    this.idleWaiters = []
    w.forEach((f) => f())
  }

  private async pump() {
    if (this.stopped) return
    const now = this.d.now()
    const rows = await this.db.syncTransfers.toArray()
    const runnable = rows
      .filter((r) => !this.active.has(r.dir + r.hash) && (r.state === 'queued' || r.state === 'waiting' || r.state === 'failed') && r.nextAt <= now)
      .filter((r) => this.d.canRun?.({ prioritized: r.priority >= PRIORITY_BOOST }) ?? true)
      .sort((a, b) => b.priority - a.priority || a.size - b.size)
    let downs = [...this.active.keys()].filter((k) => k.startsWith('down')).length
    let ups = this.active.size - downs
    if (runnable.some((r) => r.dir === 'down') && downs < POOL.down) {
      const ok = await this.checkQuota().catch((e) => {
        this.d.onError?.(e, runnable.find((r) => r.dir === 'down')!)
        return false
      })
      if (!ok) for (let i = runnable.length - 1; i >= 0; i--) if (runnable[i].dir === 'down') runnable.splice(i, 1)
    }
    for (const r of runnable) {
      if (r.dir === 'down' ? downs >= POOL.down : ups >= POOL.up) continue
      if (r.dir === 'down') downs++
      else ups++
      this.run(r)
    }
    // Wake up for the earliest deferred row.
    const next = rows.filter((r) => r.nextAt > now && !this.active.has(r.dir + r.hash)).reduce((m, r) => Math.min(m, r.nextAt), Infinity)
    if (this.timer) (this.d.timers?.clearTimeout ?? clearTimeout)(this.timer)
    this.timer = undefined
    if (next < Infinity && !this.stopped) this.timer = (this.d.timers?.setTimeout ?? setTimeout)(() => this.kick(), Math.max(50, next - now))
  }

  private async checkQuota(): Promise<boolean> {
    const est = typeof navigator !== 'undefined' ? await navigator.storage?.estimate?.().catch(() => undefined) : undefined
    if (!est?.quota) return true
    const free = est.quota - (est.usage ?? 0)
    const need = await this.neededBytes()
    if (free < need + RESERVE) throw new LocalQuotaError(need + RESERVE - free)
    return true
  }

  private run(r: TransferRow) {
    const id = r.dir + r.hash
    const ac = new AbortController()
    this.active.set(id, ac)
    const job = r.dir === 'up' ? this.upload(r, ac.signal) : this.download(r, ac.signal)
    void job
      .catch((e) => this.failed(r, e, ac.signal))
      .finally(() => {
        this.active.delete(id)
        this.live.delete(id)
        this.d.onProgress?.()
        this.kick()
        queueMicrotask(() => this.settle())
      })
  }

  private async failed(r: TransferRow, e: unknown, signal: AbortSignal) {
    if (signal.aborted || this.stopped) {
      await this.db.syncTransfers.update(rowKey(r), { state: 'queued' }).catch(() => {})
      return
    }
    const attempts = r.attempts + 1
    const fatal = e instanceof FormatError || (e instanceof BackendError && (e.code === 'forbidden' || e.code === 'auth'))
    const retryAfter = e instanceof BackendError && e.retryAfterMs ? e.retryAfterMs : 0
    const backoff = Math.max(retryAfter, Math.min(WAIT_RETRY, 2000 * 2 ** Math.min(attempts, 10)))
    await this.db.syncTransfers
      .update(rowKey(r), {
        state: fatal ? 'failed' : 'queued',
        attempts,
        nextAt: this.d.now() + (fatal ? 60 * 60_000 : backoff),
        error: String((e as Error)?.message ?? e),
      })
      .catch(() => {})
    this.d.onError?.(e, r)
  }

  private async blobKeyOf(hash: string) {
    const ctx = await blobContext(this.d.keys, hash)
    return { ctx, key: blobKey(this.d.keys.libraryId, (ctx as { name: string }).name) }
  }

  private async upload(r: TransferRow, signal: AbortSignal) {
    const { db, backend, keys } = this.d
    await db.syncTransfers.update(rowKey(r), { state: 'active' })
    const rec = await localBlob(db, r.hash)
    if (!rec) {
      // Nothing to upload (deleted or never had the data).
      await db.syncTransfers.delete(rowKey(r))
      return
    }
    const { ctx, key } = await this.blobKeyOf(r.hash)
    const expected = ciphertextSize(rec.size)
    const info = await backend.head(key, { signal })
    if (!info || info.size !== expected) {
      const src = encryptChunks(keys, blobSource(rec.data), ctx)
      const fresh = r.upload && r.upload.createdAt > this.d.now() - MULTIPART_STALE ? r.upload : undefined
      // Our own session that is too old to trust: abort it at the provider and start over.
      if (r.upload && !fresh) await backend.abortUpload?.(r.upload, { signal }).catch(() => {})
      await backend.upload(key, src, {
        state: fresh,
        signal,
        onState: async (s) => {
          await db.syncTransfers.update(rowKey(r), { upload: s })
        },
        onProgress: (b) => {
          this.live.set('up' + r.hash, Math.min(rec.size, b))
          this.d.onProgress?.()
        },
      })
    }
    this.done.up.files++
    this.done.up.bytes += rec.size
    await db.syncTransfers.delete(rowKey(r))
    await this.d.onUploaded?.(r.hash)
  }

  private async download(r: TransferRow, signal: AbortSignal) {
    const { db, backend, keys } = this.d
    if (await localBlob(db, r.hash)) {
      await db.transaction('rw', db.syncTransfers, db.syncChunks, async () => {
        await db.syncTransfers.delete(rowKey(r))
        await db.syncChunks.where('[hash+index]').between([r.hash, 0], [r.hash, Infinity]).delete()
      })
      this.d.onDownloaded?.(r.hash)
      return
    }
    await db.syncTransfers.update(rowKey(r), { state: 'active' })
    const { ctx, key } = await this.blobKeyOf(r.hash)
    let header: ContainerHeader
    let next = r.doneChunks ?? 0
    const store = async (first: number, parts: Uint8Array[]) => {
      await db.transaction('rw', db.syncChunks, db.syncTransfers, async () => {
        await db.syncChunks.bulkPut(parts.map((p, i) => ({ hash: r.hash, index: first + i, data: new Blob([p as Uint8Array<ArrayBuffer>]) })))
        await db.syncTransfers.update(rowKey(r), { doneChunks: first + parts.length })
      })
      next = first + parts.length
      this.live.set('down' + r.hash, Math.min(header.size, next * 2 ** header.log2Chunk))
      this.d.onProgress?.()
    }
    const span = HEADER_BYTES + RANGE * (2 ** 20 + 28) - 1
    if (!backend.caps.rangeGet) {
      const all = await backend.get(key, { signal })
      if (!all) return this.waiting(r)
      header = parseContainerHeader(all)
      if (all.length !== ciphertextSize(header.size, 2 ** header.log2Chunk)) throw new FormatError('corrupt', 'blob has the wrong length')
      next = 0
      await store(0, await decryptChunks(keys, header, ctx, 0, all.subarray(HEADER_BYTES)))
    } else {
      const first = await backend.get(key, { range: next === 0 ? [0, span] : [0, HEADER_BYTES - 1], signal })
      if (!first) return this.waiting(r)
      header = parseContainerHeader(first)
      const n = chunkCount(header.size, 2 ** header.log2Chunk)
      if (next === 0) {
        // The first range covers whole chunks only up to its end; decrypt the complete ones.
        const [, end] = chunkByteRange(header, 0, RANGE)
        const usable = first.subarray(HEADER_BYTES, Math.min(first.length, end + 1))
        await store(0, await decryptChunks(keys, header, ctx, 0, usable))
      }
      while (next < n) {
        signal.throwIfAborted()
        const range = chunkByteRange(header, next, RANGE)
        const bytes = await backend.get(key, { range, signal })
        if (!bytes) return this.waiting(r)
        await store(next, await decryptChunks(keys, header, ctx, next, bytes))
      }
    }
    // Assemble, verify, store.
    const rows = await db.syncChunks.where('[hash+index]').between([r.hash, 0], [r.hash, Infinity]).sortBy('index')
    const n = chunkCount(header.size, 2 ** header.log2Chunk)
    if (rows.length < n) {
      await db.syncTransfers.update(rowKey(r), { doneChunks: 0 })
      throw new FormatError('corrupt', 'chunks missing after download')
    }
    const data = new Blob(
      rows.slice(0, n).map((c) => c.data),
      { type: r.mime },
    )
    if (data.size !== header.size) throw new FormatError('corrupt', 'blob size mismatch')
    if (data.size <= VERIFY_MAX && (await sha256Hex(data)) !== r.hash) {
      await db.transaction('rw', db.syncChunks, db.syncTransfers, async () => {
        await db.syncChunks.where('[hash+index]').between([r.hash, 0], [r.hash, Infinity]).delete()
        await db.syncTransfers.update(rowKey(r), { doneChunks: 0 })
      })
      throw new FormatError('corrupt', 'blob hash mismatch')
    }
    await db.transaction('rw', db.blobs, db.syncChunks, db.syncTransfers, async () => {
      if (!(await db.blobs.where('hash').equals(r.hash).count())) await db.blobs.put({ id: r.hash, hash: r.hash, mime: r.mime, size: data.size, data })
      await db.syncChunks.where('[hash+index]').between([r.hash, 0], [r.hash, Infinity]).delete()
      await db.syncTransfers.delete(rowKey(r))
    })
    this.done.down.files++
    this.done.down.bytes += data.size
    this.d.onDownloaded?.(r.hash)
  }

  private async waiting(r: TransferRow) {
    await this.db.syncTransfers.update(rowKey(r), { state: 'waiting', nextAt: this.d.now() + WAIT_RETRY })
  }
}

/** Every content hash referenced by alive songs, with size and mime (repair, GC, offline-ready counts). */
export async function referencedBlobs(db: OpenStandDB): Promise<Map<string, { blobId: string; size: number; mime: string }>> {
  const out = new Map<string, { blobId: string; size: number; mime: string }>()
  const ids = new Set<string>()
  await db.songs.each((s) => {
    for (const f of s.files) ids.add(f.blobId)
    for (const a of s.audio) if (a.blobId) ids.add(a.blobId)
  })
  const legacy = [...ids].filter((id) => !SHA256.test(id))
  const rows = legacy.length ? await db.blobs.bulkGet(legacy) : []
  const hashOf = new Map(legacy.map((id, i) => [id, rows[i]?.hash]))
  for (const id of ids) {
    const hash = SHA256.test(id) ? id : hashOf.get(id)
    if (hash) out.set(hash, { blobId: id, size: 0, mime: '' })
  }
  return out
}
