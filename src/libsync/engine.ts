/**
 * Library-sync engine (docs/SYNC.md §3, §10): one per library database, in one tab (the service holds a
 * Web Lock). Capture → push, poll/notice → pull → apply, snapshots, pruning, blob GC and repair.
 *
 * Pull, apply and capture run under one async mutex; blob transfers run beside it (`BlobQueue`). Every
 * operation is also callable directly (`sync`, `pull`, `writeSnapshot`, …), which is how the tests drive
 * two or three devices in one process; `start()` adds the timers and triggers.
 */
import Dexie, { liveQuery, type Subscription } from 'dexie'
import { markRemote } from '../db/capture'
import type { OpenStandDB } from '../db/db'
import type { Song } from '../db/schema'
import { createBackend } from './backends'
import { BackendError, type ObjectInfo, type StorageBackend, type UploadState } from './backends/types'
import { BlobQueue, localBlob, LocalQuotaError, queueDownload, queueUpload, referencedBlobs, songPriority } from './blobs'
import { applyOps, capture, isPlainOutbox, mergeApplied, newApplied, OutboxWriter, plainBatch, projectCtx, syncTxTables, type Applied, type Core } from './apply'
import { decodeBatch, decodeDevice, encodeBatch, encodeDevice, objectStream, readSnapshot, readSnapshotHeader, writeSnapshot } from './codec'
import { blobName, bytesEqual, ciphertextSize, deriveLibraryKeys, FIRST_CHUNK_RANGE, FormatError, type LibraryKeys } from './crypto'
import { createClock, HLC_ZERO, hlcWall } from './hlc'
import { compact, dropStale, fromShadow, materialize, project, toShadow } from './merge'
import {
  BLOB_GC_GRACE,
  BLOB_GC_INTERVAL,
  CAPTURE_DEBOUNCE,
  DEAD_FIELDS_TTL,
  ELEMENT_TOMB_TTL,
  LOG_RETENTION,
  POLL,
  SNAPSHOT_TRIGGER,
  type CollectionRows,
  type DeviceRecord,
  type MaintenanceState,
  type RecordDelta,
  type SnapshotHeader,
  type SyncConfig,
} from './model'
import { blobKey, blobsPrefix, deviceKey, devicesPrefix, headKey, headsPrefix, latestHeads, logKey, logPrefix, metaKey, parseKey, snapKey, snapPrefix } from './paths'
import { NoticeChannel, type NoticeChannelOptions, type RelayState } from './relay'
import { realTimers, type Timers } from './timers'
import { getConfig, getState, putState, TABLE_OF } from './state'
import type { LibSyncError, LibSyncErrorCode, LibSyncPhase, TransferProgress } from './api'

const DAY = 24 * 60 * 60_000
const FETCH_PARALLEL = 4
const FETCH_WINDOW = 32
const APPLY_GROUP = 500
const MAINTENANCE_TICK = 60_000
const REPAIR_INTERVAL = 7 * DAY
const RECONCILE_INTERVAL = DAY
const DEVICE_REFRESH = DAY
const MAX_BACKOFF = 5 * 60_000
const NOTICE_DEBOUNCE = 300

/** A sync failure with a `LibSyncErrorCode` (backend and format errors are mapped by `toSyncError`). */
export class SyncError extends Error {
  readonly code: LibSyncErrorCode
  readonly detail?: string
  constructor(code: LibSyncErrorCode, message?: string, detail?: string) {
    super(message ?? code)
    this.name = 'SyncError'
    this.code = code
    this.detail = detail
  }
}

const MESSAGES: Partial<Record<LibSyncErrorCode, string>> = {
  auth: 'Your storage rejected the access key. It may have expired or been revoked.',
  cors: 'Your bucket doesn’t allow this site yet.',
  quota: 'Your storage is full.',
  clock: 'This device’s clock is wrong, so the storage refused the request.',
  wrongSecret: 'This code doesn’t match the data in that storage.',
  libraryGone: 'The synced library was deleted from storage.',
  newerFormat: 'Another device uses a newer OpenStand. Update this one to keep syncing.',
  rejoin: 'This device needs to rejoin the synced library.',
  corrupt: 'This device needs to rejoin the synced library.',
  network: 'Offline. Changes will sync when you’re back online.',
  server: 'Your storage had a problem. Sync will retry.',
}

/** Map any thrown value to a `LibSyncError` code + wording (§12.3). */
export function toSyncError(e: unknown, at = Date.now()): LibSyncError {
  let code: LibSyncErrorCode = 'unknown'
  let detail: string | undefined
  if (e instanceof SyncError) {
    code = e.code
    detail = e.detail
  } else if (e instanceof FormatError) code = e.code
  // `detail` = bytes still needed (the UI formats "needs 1.2 GB more").
  else if (e instanceof LocalQuotaError) return { code: 'localQuota', message: e.message, detail: String(Math.ceil(e.needed)), at }
  else if (e instanceof BackendError) {
    detail = e.providerCode ?? e.message
    code = (
      {
        auth: 'auth',
        forbidden: 'auth',
        tokenExpired: 'auth',
        cors: 'cors',
        quota: 'quota',
        network: 'network',
        rateLimited: 'network',
        clock: 'clock',
        precondition: 'rejoin',
        server: 'server',
        notFound: 'unknown',
        unknown: 'unknown',
      } as const
    )[e.code]
  } else if ((e as Error)?.name === 'QuotaExceededError') code = 'localQuota'
  if (!detail && e instanceof Error && !(e instanceof SyncError)) detail = e.message
  return { code, message: (e instanceof SyncError && e.message !== code ? e.message : MESSAGES[code]) ?? String((e as Error)?.message ?? e), detail, at }
}

/** Errors that stop sync until the user acts (no automatic retry loop). */
const FATAL: LibSyncErrorCode[] = ['wrongSecret', 'libraryGone', 'newerFormat', 'corrupt', 'rejoin']

export interface EngineEnv {
  visible(): boolean
  online(): boolean
  /** Performing (the viewer is open): transfers pause except prioritised blobs. */
  performing(): boolean
  /** Visible, not performing and no user input for 60 s: maintenance may run. */
  idle(): boolean
}

const ALWAYS: EngineEnv = { visible: () => true, online: () => true, performing: () => false, idle: () => true }

export type EngineTimers = Timers

export interface EngineHooks {
  /** Before applying ops (the annotation store flushes so its three-way merge sees the latest rows). */
  beforeApply?(ops: RecordDelta[]): Promise<void> | void
  /** After a remote apply committed (annotation store reload, thumbnail invalidation, UI events). */
  afterApply?(a: Applied): Promise<void> | void
  /** A blob arrived locally (download finished). */
  blobReady?(hash: string): void
  status?(s: EngineStatus): void
}

export interface EngineStatus {
  phase: LibSyncPhase
  backendLabel: string
  lastSyncAt?: number
  pendingChanges: number
  upload: TransferProgress
  download: TransferProgress
  offlineReady: { have: number; total: number }
  relay: RelayState
  devices: (DeviceRecord & { self: boolean })[]
  error?: LibSyncError
  /** Another device's clock is ahead (§6.1); shown, not fatal. */
  warning?: LibSyncError
}

export interface EngineOptions {
  backend?: StorageBackend
  keys?: LibraryKeys
  now?: () => number
  timers?: EngineTimers
  env?: EngineEnv
  hooks?: EngineHooks
  deviceName?: () => string
  /** Relay transport factory override (tests). */
  relayTransport?: NoticeChannelOptions['transport']
  log?: (msg: string, extra?: unknown) => void
}

interface SnapInfo {
  key: string
  deviceId: string
  n: number
  header: SnapshotHeader
  lastModified?: number
}

const sumVector = (v: Record<string, number>) => Object.values(v).reduce((a, b) => a + b, 0)

/** Largest Σvector, then the newest (§3.1). */
export const bestSnapshot = <T extends { header: SnapshotHeader }>(snaps: T[]): T | undefined =>
  [...snaps].sort((a, b) => sumVector(b.header.vector) - sumVector(a.header.vector) || b.header.t - a.header.t)[0]

export function platformName(): string {
  if (typeof navigator === 'undefined') return 'node'
  const ua = navigator.userAgent ?? ''
  return /iPad|iPhone|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Web'
}
export const APP_VERSION = '0.1.0'

export class Engine {
  readonly core: Core
  readonly db: OpenStandDB
  readonly transfers: BlobQueue
  status: EngineStatus
  private mutexTail: Promise<unknown> = Promise.resolve()
  private timers: EngineTimers
  private env: EngineEnv
  private hooks: EngineHooks
  private o: EngineOptions
  private started = false
  private stopped = false
  private failures = 0
  private captureTimer?: ReturnType<typeof setTimeout>
  private pullTimer?: ReturnType<typeof setTimeout>
  private noticeTimer?: ReturnType<typeof setTimeout>
  private maintTimer?: ReturnType<typeof setInterval>
  private statusTimer?: ReturnType<typeof setTimeout>
  private dirtySub?: Subscription
  private relay?: NoticeChannel
  private streamErrors = new Map<string, LibSyncError>()

  private constructor(core: Core, o: EngineOptions) {
    this.core = core
    this.db = core.db
    this.o = o
    this.timers = o.timers ?? realTimers
    this.env = o.env ?? ALWAYS
    this.hooks = o.hooks ?? {}
    this.status = {
      phase: core.config.paused ? 'paused' : 'idle',
      backendLabel: core.backend.label,
      pendingChanges: 0,
      upload: { files: 0, bytes: 0, doneFiles: 0, doneBytes: 0 },
      download: { files: 0, bytes: 0, doneFiles: 0, doneBytes: 0 },
      offlineReady: { have: 0, total: 0 },
      relay: 'off',
      devices: [],
    }
    this.transfers = new BlobQueue({
      db: core.db,
      backend: core.backend,
      keys: core.keys,
      now: core.now,
      timers: this.timers,
      canRun: ({ prioritized }) =>
        !this.stopped && !this.core.config.paused && this.env.online() && this.env.visible() && (prioritized || !this.env.performing()),
      onUploaded: (hash) => this.blobUploaded(hash),
      onDownloaded: (hash) => {
        this.hooks.blobReady?.(hash)
        this.scheduleStatus()
      },
      onError: (e) => {
        const err = toSyncError(e, this.core.now())
        if (err.code === 'network') this.setStatus({ phase: 'offline' })
        else if (err.code !== 'unknown' && err.code !== 'corrupt') this.setStatus({ phase: 'error', error: err })
        this.core.log?.('transfer failed', e)
      },
      onProgress: () => this.scheduleStatus(),
    })
  }

  /** Open the engine for a configured database. */
  static async open(db: OpenStandDB, o: EngineOptions = {}): Promise<Engine> {
    const config = await getConfig(db)
    if (!config) throw new SyncError('unknown', 'Library sync is not set up for this library')
    return Engine.fromConfig(db, config, o)
  }

  static async fromConfig(db: OpenStandDB, config: SyncConfig, o: EngineOptions = {}): Promise<Engine> {
    const now = o.now ?? Date.now
    const keys = o.keys ?? (await deriveLibraryKeys(config.secret))
    const backend = o.backend ?? createBackend(config.backend, { now })
    let engine: Engine | undefined
    const clock = createClock(config.deviceId, (await getState(db, 'clock')) ?? HLC_ZERO, now, {
      onAhead: (device, ms) => engine?.clockAhead(device, ms),
    })
    engine = new Engine({ db, config, keys, backend, clock, now, log: o.log }, o)
    return engine
  }

  get config() {
    return this.core.config
  }

  // -------------------------------------------------------------------------------------------
  // Mutex and status
  // -------------------------------------------------------------------------------------------

  /** Run `fn` exclusively with capture, push, pull and maintenance. */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutexTail.then(fn, fn)
    this.mutexTail = run.catch(() => {})
    return run
  }

  private setStatus(p: Partial<EngineStatus>) {
    this.status = { ...this.status, ...p }
    this.hooks.status?.(this.status)
  }

  private scheduleStatus() {
    if (this.statusTimer) return
    this.statusTimer = this.timers.setTimeout(() => {
      this.statusTimer = undefined
      void this.refreshStatus().catch(() => {})
    }, 250)
  }

  /** Recount pending changes, transfers and offline readiness. */
  async refreshStatus() {
    const { db } = this
    let pending = await db.syncDirty.count()
    await db.syncOutbox.each((r) => (pending += r.ops))
    const rows = await db.syncTransfers.toArray()
    const stats = this.transfers.stats(rows)
    const refs = await referencedBlobs(db)
    const missing = new Set(rows.filter((r) => r.dir === 'down').map((r) => r.hash))
    let have = 0
    for (const h of refs.keys()) if (!missing.has(h) && (await localBlob(db, h))) have++
    const devices = ((await getState(db, 'devices')) ?? []).map((d) => ({ ...d, self: d.id === this.config.deviceId }))
    const lastSync = await getState(db, 'lastSync')
    const busy = stats.upload.files > stats.upload.doneFiles || stats.download.files > stats.download.doneFiles || pending > 0
    let phase = this.status.phase
    if (phase === 'idle' || phase === 'syncing') phase = busy ? 'syncing' : 'idle'
    this.setStatus({ pendingChanges: pending, upload: stats.upload, download: stats.download, offlineReady: { have, total: refs.size }, devices, lastSyncAt: lastSync?.at, phase })
  }

  private clockAhead(device: string, ms: number) {
    const name = this.status.devices.find((d) => d.id === device)?.name ?? 'Another device'
    const h = ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 60_000)} min`
    this.setStatus({
      warning: { code: 'clockAhead', message: `“${name}” has its clock set ${h} ahead. Edits from it may win over newer ones.`, at: this.core.now() },
    })
  }

  // -------------------------------------------------------------------------------------------
  // Capture and push
  // -------------------------------------------------------------------------------------------

  /** §8.2: dirty records → outbox. */
  captureNow() {
    return this.locked(() => capture(this.core))
  }

  /** An upload finished: announce it in the next batch (`blobsReady`). */
  private async blobUploaded(hash: string) {
    const { db } = this
    await db.transaction('rw', db.syncOutbox, db.syncState, async () => {
      const w = new OutboxWriter(this.core)
      await w.addReady(hash)
      await w.flush()
    })
    this.schedulePush()
  }

  /** Push sealed batches strictly in seq order: log → head → drop older head → notice → outbox row. */
  push() {
    return this.locked(() => this.pushInner())
  }

  private async pushInner(): Promise<number> {
    const { db, backend, keys, config } = this.core
    const lib = keys.libraryId
    const me = config.deviceId
    let pushed = 0
    for (;;) {
      const row = await db.syncOutbox.orderBy('seq').first()
      if (!row) break
      let bytes = row.bytes
      if (isPlainOutbox(row)) {
        const sealed = await encodeBatch(keys, plainBatch(row))
        const ok = await db.transaction('rw', db.syncOutbox, async () => {
          const cur = await db.syncOutbox.get(row.seq)
          if (!cur || !bytesEqual(cur.bytes, row.bytes)) return false
          await db.syncOutbox.update(row.seq, { bytes: sealed })
          return true
        })
        if (!ok) continue // appended to meanwhile: seal again
        bytes = sealed
      }
      const key = logKey(lib, me, row.seq)
      try {
        await backend.put(key, bytes, { ifNoneMatch: true })
      } catch (e) {
        if (!(e instanceof BackendError && e.code === 'precondition')) throw e
        // Our own earlier attempt may have landed before a crash: identical bytes are fine.
        const there = await backend.get(key)
        if (!there || !bytesEqual(there, bytes)) throw new SyncError('rejoin', undefined, `log ${row.seq} exists with other content (cloned device?)`)
      }
      await backend.put(headKey(lib, me, row.seq), new Uint8Array(0))
      if (row.seq > 1) await backend.delete(headKey(lib, me, row.seq - 1)).catch(() => {})
      void this.relay?.post(row.seq).catch(() => {})
      await db.transaction('rw', db.syncOutbox, db.syncState, async () => {
        await db.syncOutbox.delete(row.seq)
        const cur = (await getState(db, 'cursors')) ?? {}
        await putState(db, 'cursors', { ...cur, [me]: Math.max(cur[me] ?? 0, row.seq) })
      })
      pushed++
    }
    return pushed
  }

  // -------------------------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------------------------

  async listAll(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = []
    let cursor: string | undefined
    do {
      const page = await this.core.backend.list(prefix, { cursor })
      out.push(...page.items)
      cursor = page.cursor
    } while (cursor)
    return out
  }

  /** Each device's latest seq (one LIST, §3). */
  async heads(): Promise<Record<string, number>> {
    const lib = this.core.keys.libraryId
    return latestHeads(lib, (await this.listAll(headsPrefix(lib))).map((i) => i.key))
  }

  pull() {
    return this.locked(() => this.pullInner())
  }

  private async pullInner(): Promise<Applied> {
    const { db, backend, keys, config } = this.core
    const lib = keys.libraryId
    const total = newApplied()
    const heads = await this.heads()
    if (!Object.keys(heads).length && !(await backend.head(metaKey(lib)))) throw new SyncError('libraryGone')
    this.streamErrors.clear()
    for (const [d, head] of Object.entries(heads)) {
      if (d === config.deviceId) continue
      try {
        let cur = (await getState(db, 'cursors'))?.[d] ?? 0
        while (cur < head) {
          const seqs: number[] = []
          for (let s = cur + 1; s <= Math.min(head, cur + FETCH_WINDOW); s++) seqs.push(s)
          const bodies = await this.fetchLogs(d, seqs)
          let gap = false
          for (let i = 0; i < seqs.length; i++) {
            const bytes = bodies[i]
            if (!bytes) {
              gap = true
              mergeApplied(total, await this.recoverGap(d, seqs[i], head))
              break
            }
            const batch = await decodeBatch(keys, bytes, { deviceId: d, seq: seqs[i] })
            mergeApplied(total, await this.applyBatch(batch))
          }
          const next = (await getState(db, 'cursors'))?.[d] ?? 0
          if (gap && next <= cur) throw new SyncError('corrupt', undefined, `log ${d}/${cur + 1} is missing and no snapshot covers it`)
          cur = next
        }
      } catch (e) {
        if (!(e instanceof FormatError) && !(e instanceof SyncError && e.code === 'corrupt')) throw e
        // A stream that can't be read stops (never skipped: devices would diverge); the others go on.
        this.streamErrors.set(d, toSyncError(e, this.core.now()))
        this.core.log?.(`stream ${d} stopped`, e)
      }
    }
    // A device we haven't seen yet (or our own first batch): refresh the list now rather than at the next
    // idle maintenance, so "Devices" isn't empty right after setting up or pairing.
    const known = new Set(((await getState(db, 'devices')) ?? []).map((x) => x.id))
    if (Object.keys(heads).some((d) => !known.has(d))) await this.refreshDevicesInner().catch((e) => this.core.log?.('devices refresh failed', e))
    if (this.streamErrors.size) throw new SyncError([...this.streamErrors.values()][0].code)
    if (!(await db.syncDirty.count()) && !(await db.syncOutbox.count()))
      await putState(db, 'lastSync', { at: this.core.now(), hlc: this.core.clock.last })
    return total
  }

  private async fetchLogs(d: string, seqs: number[]): Promise<(Uint8Array | null)[]> {
    const lib = this.core.keys.libraryId
    const out: (Uint8Array | null)[] = new Array(seqs.length)
    let i = 0
    const worker = async () => {
      while (i < seqs.length) {
        const k = i++
        out[k] = await this.core.backend.get(logKey(lib, d, seqs[k]))
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, seqs.length) }, worker))
    return out
  }

  private async applyBatch(batch: { d: string; s: number; ops: RecordDelta[]; hlcMax: string; blobsReady?: string[] }): Promise<Applied> {
    if (batch.ops.length) await this.hooks.beforeApply?.(batch.ops)
    const a = await applyOps(this.core, batch.ops, { cursor: { device: batch.d, seq: batch.s }, hlcMax: batch.ops.length ? batch.hlcMax : undefined })
    if (batch.blobsReady?.length) await this.transfers.wake(batch.blobsReady)
    await this.afterApply(a)
    return a
  }

  private async afterApply(a: Applied) {
    if (a.songs.size || a.setlists.size || a.anns.size || a.kv.size) await this.hooks.afterApply?.(a)
    this.transfers.kick()
    this.scheduleStatus()
  }

  /** §3.2 gap recovery: the log we need was pruned; merge the snapshot that covers it. */
  private async recoverGap(d: string, missing: number, head: number): Promise<Applied> {
    const lib = this.core.keys.libraryId
    const seqs = (await this.listAll(logPrefix(lib, d))).map((o) => parseKey(o.key)).flatMap((p) => (p?.type === 'log' ? [p.seq] : []))
    const lowest = seqs.filter((s) => s >= missing).reduce((m, s) => Math.min(m, s), head + 1)
    const snap = bestSnapshot((await this.listSnapshots()).filter((s) => (s.header.vector[d] ?? 0) >= lowest - 1))
    if (!snap) throw new SyncError('corrupt', undefined, `log ${d}/${missing} is missing and no snapshot covers it`)
    return this.applySnapshot(snap)
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots (§3.1)
  // -------------------------------------------------------------------------------------------

  /** All snapshots in storage with their headers (cached in `syncState.snapshots`). */
  async listSnapshots(): Promise<SnapInfo[]> {
    const { db, keys, backend } = this.core
    const lib = keys.libraryId
    const cache = { ...((await getState(db, 'snapshots')) ?? {}) }
    const out: SnapInfo[] = []
    const seen = new Set<string>()
    for (const o of await this.listAll(snapPrefix(lib))) {
      const p = parseKey(o.key)
      if (p?.type !== 'snap') continue
      seen.add(o.key)
      let header = cache[o.key]
      if (!header) {
        const bytes = await backend.get(o.key, { range: FIRST_CHUNK_RANGE })
        if (!bytes) continue
        try {
          header = await readSnapshotHeader(keys, { deviceId: p.deviceId, n: p.seq }, bytes)
        } catch (e) {
          this.core.log?.(`unreadable snapshot ${o.key}`, e)
          continue
        }
        cache[o.key] = header
      }
      out.push({ key: o.key, deviceId: p.deviceId, n: p.seq, header, lastModified: o.lastModified })
    }
    for (const k of Object.keys(cache)) if (!seen.has(k)) delete cache[k]
    await putState(db, 'snapshots', cache)
    return out
  }

  /**
   * Merge a whole snapshot (idempotent), then advance cursors to its vector. A device that was away
   * longer than the snapshot's tombstone horizon drops what the network deleted meanwhile (§3.2).
   */
  async applySnapshot(snap: SnapInfo, o: { onProgress?: (done: number, total: number) => void } = {}): Promise<Applied> {
    const { db, keys, backend } = this.core
    const total = newApplied()
    const lastSync = await getState(db, 'lastSync')
    const stale = !!lastSync && hlcWall(lastSync.hlc) < snap.header.horizon.elementTombs
    const seen = stale ? new Map<string, RecordDelta>() : null
    const reader = await readSnapshot(keys, { deviceId: snap.deviceId, n: snap.n }, objectStream(backend, snap.key))
    let group: RecordDelta[] = []
    let done = 0
    const flush = async () => {
      if (!group.length) return
      await this.hooks.beforeApply?.(group)
      const a = await applyOps(this.core, group)
      mergeApplied(total, a)
      done += group.length
      o.onProgress?.(done, snap.header.records)
      group = []
    }
    for await (const r of reader.records) {
      seen?.set(r.id, r)
      group.push(r)
      if (group.length >= APPLY_GROUP) await flush()
    }
    await flush()
    if (seen && lastSync) mergeApplied(total, await this.dropStale(seen, lastSync.hlc))
    await applyOps(this.core, [], { cursors: snap.header.vector })
    await this.afterApply(total)
    return total
  }

  /** Locally delete what the network deleted while this device was away past the tombstone horizon. */
  private async dropStale(snap: Map<string, RecordDelta>, lastSync: string): Promise<Applied> {
    const { db } = this.core
    const applied = newApplied()
    await db.transaction('rw', syncTxTables(db), async () => {
      markRemote(Dexie.currentTransaction)
      for (const shadow of await db.syncShadow.toArray()) {
        if (!(shadow.c in TABLE_OF)) continue
        const c = shadow.c
        const table = db.table(TABLE_OF[c])
        const row = (await table.get(shadow.id)) as CollectionRows[typeof c] | undefined
        const pctx = await projectCtx(db, c === 'song' ? (row as Song | undefined) : undefined)
        const local = fromShadow(shadow, row ? project(c, row, pctx) : null)
        const kept = dropStale(local, snap.get(shadow.id), lastSync)
        if (kept === local) continue
        const next = kept ? materialize(c, kept, row ?? null) : null
        if (!next) {
          if (row) await table.delete(shadow.id)
          await db.syncShadow.delete(shadow.id)
        } else {
          await table.put(next)
          await db.syncShadow.put(toShadow(kept!))
        }
        ;(c === 'song' ? applied.songs : c === 'setlist' ? applied.setlists : c === 'ann' ? applied.anns : applied.kv).add(shadow.id)
      }
    })
    return applied
  }

  /** Bootstrap from the best snapshot, if any (join). Returns false when there is none. */
  async bootstrap(o: { onProgress?: (done: number, total: number) => void } = {}): Promise<boolean> {
    return this.locked(async () => {
      const best = bestSnapshot(await this.listSnapshots())
      if (!best) return false
      await this.applySnapshot(best, o)
      return true
    })
  }

  writeSnapshot() {
    return this.locked(() => this.writeSnapshotInner())
  }

  /**
   * Upload this device's full merged state (§3.1). Only with nothing local pending: rows are joined with
   * shadow hlcs, which is valid only while no record is dirty.
   */
  private async writeSnapshotInner(): Promise<SnapshotHeader | null> {
    const { db, keys, backend, config } = this.core
    const lib = keys.libraryId
    const me = config.deviceId
    await capture(this.core)
    await this.pushInner()
    const blocking = async () => (await db.syncDirty.filter((r) => !r.deferredSince).count()) > 0 || (await db.syncOutbox.count()) > 0
    if (await blocking()) return null
    const now = this.core.now()
    const cursors = (await getState(db, 'cursors')) ?? {}
    const own = (await this.listAll(snapPrefix(lib, me))).map((o) => parseKey(o.key)).flatMap((p) => (p?.type === 'snap' ? [p.seq] : []))
    const n = own.reduce((m, s) => Math.max(m, s), 0) + 1
    const horizon = { deadFields: now - DEAD_FIELDS_TTL, elementTombs: now - ELEMENT_TOMB_TTL }
    const count = await db.syncShadow.count()
    const hlcMax = this.core.clock.last
    async function* records(): AsyncGenerator<RecordDelta> {
      let after = ''
      for (;;) {
        const page = await db.transaction('r', syncTxTables(db), async () => {
          if (await blocking()) throw new SyncError('unknown', 'snapshot aborted: local changes are pending')
          const shadows = await db.syncShadow.where('id').above(after).limit(APPLY_GROUP).toArray()
          const out: RecordDelta[] = []
          for (const s of shadows) {
            if (!(s.c in TABLE_OF)) {
              out.push(fromShadow(s, null))
              continue
            }
            const c = s.c
            const row = (await db.table(TABLE_OF[c]).get(s.id)) as CollectionRows[typeof c] | undefined
            const pctx = await projectCtx(db, c === 'song' ? (row as Song | undefined) : undefined)
            out.push(compact(fromShadow(s, row ? project(c, row, pctx) : null), horizon))
          }
          return { out, last: shadows[shadows.length - 1]?.id }
        })
        yield* page.out
        if (!page.last || page.out.length < APPLY_GROUP) return
        after = page.last
      }
    }
    const { body, header } = await writeSnapshot(
      keys,
      { d: me, n, t: now, vector: { ...cursors, [me]: cursors[me] ?? 0 }, records: count, hlcMax, horizon },
      records(),
    )
    const key = snapKey(lib, me, n)
    // Snapshot nonces are random: a rebuilt snapshot must never resume an old upload, so a failed one is
    // aborted at once (the next attempt builds and uploads afresh).
    let session: UploadState | undefined
    try {
      await backend.upload(key, body, { onState: async (s) => void (session = s) })
    } catch (e) {
      if (session) await backend.abortUpload?.(session).catch(() => {})
      throw e
    }
    const cache = (await getState(db, 'snapshots')) ?? {}
    await putState(db, 'snapshots', { ...cache, [key]: header })
    await this.setMaintenance({ snapshotAt: now })
    return header
  }

  /** §3.1 trigger: ≥ 500 uncovered log entries (or ≥ 8 MiB), at most daily; or no snapshot exists yet. */
  async snapshotDue(): Promise<boolean> {
    const m = await this.maintenanceState()
    const now = this.core.now()
    const snaps = await this.listSnapshots()
    const heads = await this.heads()
    if (!snaps.length) return (heads[this.config.deviceId] ?? 0) > 0
    if (now - m.snapshotAt < SNAPSHOT_TRIGGER.minInterval) return false
    const newest = snaps.reduce((a, b) => (b.header.t > a.header.t ? b : a))
    let uncovered = 0
    for (const [d, h] of Object.entries(heads)) uncovered += Math.max(0, h - (newest.header.vector[d] ?? 0))
    if (uncovered >= SNAPSHOT_TRIGGER.batches) return true
    if (!uncovered) return false
    let bytes = 0
    for (const o of await this.listAll(logPrefix(this.core.keys.libraryId))) {
      const p = parseKey(o.key)
      if (p?.type === 'log' && p.seq > (newest.header.vector[p.deviceId] ?? 0)) bytes += o.size
    }
    return bytes >= SNAPSHOT_TRIGGER.bytes
  }

  // -------------------------------------------------------------------------------------------
  // Pruning (§3.2)
  // -------------------------------------------------------------------------------------------

  prune() {
    return this.locked(() => this.pruneInner())
  }

  private async pruneInner(): Promise<number> {
    const { backend, keys, config } = this.core
    const lib = keys.libraryId
    const now = this.core.now()
    const snaps = await this.listSnapshots()
    const old = snaps.filter((s) => now - s.header.t >= LOG_RETENTION.snapshotAge)
    const devices = await this.refreshDevicesInner()
    const retired = new Set(devices.filter((d) => d.retired && d.id !== config.deviceId).map((d) => d.id))
    let deleted = 0
    const del = async (key: string) => {
      await backend.delete(key)
      deleted++
    }
    for (const x of [config.deviceId, ...retired]) {
      const covered = old.reduce((m, s) => Math.max(m, s.header.vector[x] ?? 0), 0)
      for (const o of await this.listAll(logPrefix(lib, x))) {
        const p = parseKey(o.key)
        if (p?.type === 'log' && p.seq <= covered && (o.lastModified ?? now) <= now - LOG_RETENTION.age) await del(o.key)
      }
      const heads = (await this.listAll(headsPrefix(lib, x))).map((o) => parseKey(o.key)).flatMap((p) => (p?.type === 'head' ? [p.seq] : []))
      const max = heads.reduce((m, s) => Math.max(m, s), 0)
      for (const s of heads) if (s < max || (retired.has(x) && s <= covered)) await del(headKey(lib, x, s))
      const mine = snaps.filter((s) => s.deviceId === x).sort((a, b) => b.n - a.n)
      if (x === config.deviceId) {
        if (mine.length > 2 && now - mine[0].header.t >= LOG_RETENTION.snapshotAge) for (const s of mine.slice(2)) await del(s.key)
      } else {
        // A retired device's snapshot goes once a live device's old-enough snapshot covers all of it.
        const live = old.filter((s) => !retired.has(s.deviceId))
        for (const s of mine) if (live.some((l) => Object.entries(s.header.vector).every(([d, v]) => (l.header.vector[d] ?? 0) >= v))) await del(s.key)
      }
    }
    await this.setMaintenance({ pruneAt: now })
    return deleted
  }

  // -------------------------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------------------------

  async putDevice(o: { retired?: boolean } = {}) {
    const { backend, keys, config } = this.core
    const rec: DeviceRecord = {
      v: 1,
      id: config.deviceId,
      name: this.o.deviceName?.() || config.name || 'Device',
      platform: platformName(),
      appVersion: APP_VERSION,
      createdAt: config.joinedAt,
      lastSeenAt: this.core.now(),
      ...(o.retired ? { retired: true } : {}),
    }
    await backend.put(deviceKey(keys.libraryId, config.deviceId), await encodeDevice(keys, rec))
    // Keep the cached list in step, so this device shows under "Devices" at once (enable, join).
    const cached = (await getState(this.core.db, 'devices')) ?? []
    const devices = [...cached.filter((d) => d.id !== rec.id), rec]
    await putState(this.core.db, 'devices', devices)
    this.setStatus({ devices: devices.map((d) => ({ ...d, self: d.id === config.deviceId })) })
    return rec
  }

  refreshDevices() {
    return this.locked(() => this.refreshDevicesInner())
  }

  private async refreshDevicesInner(): Promise<DeviceRecord[]> {
    const { backend, keys, db } = this.core
    const out: DeviceRecord[] = []
    for (const o of await this.listAll(devicesPrefix(keys.libraryId))) {
      const p = parseKey(o.key)
      if (p?.type !== 'device') continue
      const bytes = await backend.get(o.key)
      if (!bytes) continue
      try {
        out.push(await decodeDevice(keys, bytes, p.deviceId))
      } catch (e) {
        this.core.log?.(`unreadable device record ${o.key}`, e)
      }
    }
    await putState(db, 'devices', out)
    this.setStatus({ devices: out.map((d) => ({ ...d, self: d.id === this.config.deviceId })) })
    return out
  }

  // -------------------------------------------------------------------------------------------
  // Blobs: GC and repair (§3.2)
  // -------------------------------------------------------------------------------------------

  gcBlobs() {
    return this.locked(() => this.gcBlobsInner())
  }

  /**
   * Delete remote blobs no alive song references whose objects are older than the grace window. The spec
   * also keeps blobs of songs that died < 30 days ago; shadows only hold value hashes, so instead every
   * blob this device still holds locally (deleted songs' files stay until local GC) and every pending
   * transfer counts as referenced. The repair pass heals the rest.
   */
  private async gcBlobsInner(): Promise<number> {
    const { db, backend, keys } = this.core
    await capture(this.core)
    await this.pushInner()
    await this.pullInner()
    if ((await db.syncDirty.count()) || (await db.syncOutbox.count())) return 0
    const now = this.core.now()
    const keep = new Set<string>()
    for (const h of (await referencedBlobs(db)).keys()) keep.add(await blobName(keys, h))
    for (const b of await db.blobs.toArray()) keep.add(await blobName(keys, b.hash))
    for (const t of await db.syncTransfers.toArray()) keep.add(await blobName(keys, t.hash))
    let deleted = 0
    for (const o of await this.listAll(blobsPrefix(keys.libraryId))) {
      const p = parseKey(o.key)
      if (p?.type !== 'blob' || keep.has(p.name)) continue
      if ((o.lastModified ?? now) > now - BLOB_GC_GRACE) continue
      await backend.delete(o.key)
      deleted++
    }
    await this.setMaintenance({ gcAt: now })
    return deleted
  }

  repair() {
    return this.locked(() => this.repairInner())
  }

  /** HEAD every referenced blob this device holds and re-upload missing ones; re-queue missing downloads. */
  private async repairInner(): Promise<{ uploads: number; downloads: number }> {
    const { db, backend, keys } = this.core
    let uploads = 0
    let downloads = 0
    const songs = await db.songs.toArray()
    const prio = new Map<string, number>()
    for (const s of songs) for (const f of [...s.files, ...s.audio]) if (f.blobId) prio.set(f.blobId, Math.max(prio.get(f.blobId) ?? 0, songPriority(s)))
    for (const [hash, ref] of await referencedBlobs(db)) {
      const rec = await localBlob(db, hash)
      if (rec) {
        const info = await backend.head(blobKey(keys.libraryId, await blobName(keys, hash)))
        if (!info || info.size !== ciphertextSize(rec.size)) {
          await db.syncTransfers.delete(['up', hash])
          await queueUpload(db, hash, rec.size, rec.mime)
          uploads++
        }
      } else if (!(await db.syncTransfers.get(['down', hash]))) {
        const song = songs.find((s) => s.files.some((f) => f.blobId === ref.blobId) || s.audio.some((a) => a.blobId === ref.blobId))
        const file = song?.files.find((f) => f.blobId === ref.blobId)
        await queueDownload(db, hash, file?.size ?? 0, 'application/octet-stream', prio.get(ref.blobId) ?? 0)
        downloads++
      }
    }
    await this.setMaintenance({ repairAt: this.core.now() })
    this.transfers.kick()
    return { uploads, downloads }
  }

  /** Daily self-heal (§8.1): mark everything dirty; the diff only emits real differences. */
  async reconcile() {
    const { db } = this.core
    const { syncedKv } = await import('./fields')
    const { allRecordKeys, markDirty } = await import('./state')
    await markDirty(db, await allRecordKeys(db, syncedKv))
    await this.captureNow()
  }

  // -------------------------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------------------------

  async maintenanceState(): Promise<MaintenanceState> {
    return (await getState(this.core.db, 'maintenance')) ?? { snapshotAt: 0, pruneAt: 0, gcAt: 0, repairAt: 0 }
  }

  private async setMaintenance(p: Partial<MaintenanceState>) {
    await putState(this.core.db, 'maintenance', { ...(await this.maintenanceState()), ...p })
  }

  private reconcileAt = 0
  private devicesAt = 0

  /** Run whatever maintenance is due. Called on idle ticks; `force` runs everything. */
  async maintenance(force = false) {
    if (!force && (!this.env.idle() || this.config.paused)) return
    const now = this.core.now()
    const m = await this.maintenanceState()
    if (force || now - this.devicesAt > DEVICE_REFRESH) {
      this.devicesAt = now
      await this.putDevice()
      await this.refreshDevices()
    }
    if (force || (await this.snapshotDue())) await this.writeSnapshot()
    if (force || now - m.pruneAt > DAY) await this.prune()
    if (force || now - m.gcAt > BLOB_GC_INTERVAL) await this.gcBlobs()
    if (force || now - m.repairAt > REPAIR_INTERVAL) await this.repair()
    if (now - this.reconcileAt > RECONCILE_INTERVAL) {
      this.reconcileAt = now
      if (!force) await this.reconcile()
    }
  }

  // -------------------------------------------------------------------------------------------
  // The sync cycle and scheduling
  // -------------------------------------------------------------------------------------------

  /** Capture, push and pull now ("Sync now"). Throws on failure (and sets the status). */
  async sync(): Promise<Applied> {
    if (this.config.paused) return newApplied()
    this.setStatus({ phase: 'syncing' })
    try {
      const applied = await this.locked(async () => {
        await capture(this.core)
        await this.pushInner()
        const a = await this.pullInner()
        // Applying may have rebased dirty records into new ops.
        await capture(this.core)
        await this.pushInner()
        return a
      })
      this.failures = 0
      this.setStatus({ phase: 'idle', error: undefined })
      this.transfers.kick()
      await this.refreshStatus()
      return applied
    } catch (e) {
      const err = toSyncError(e, this.core.now())
      this.failures++
      this.setStatus(err.code === 'network' ? { phase: 'offline' } : { phase: 'error', error: err })
      throw e
    }
  }

  /** Backoff after consecutive failures: 5 s, 10 s, 20 s … up to 5 min. */
  get backoff() {
    return this.failures ? Math.min(MAX_BACKOFF, 5000 * 2 ** (this.failures - 1)) : 0
  }

  private fatal() {
    return !!this.status.error && FATAL.includes(this.status.error.code)
  }

  /** Sync soon; errors are reported through the status and retried with backoff. */
  private runSoon(delay = 0) {
    if (this.stopped || this.fatal()) return
    if (this.pullTimer) this.timers.clearTimeout(this.pullTimer)
    this.pullTimer = this.timers.setTimeout(() => {
      this.pullTimer = undefined
      if (!this.env.visible() || this.config.paused) return this.schedulePoll()
      void this.sync()
        .catch(() => {})
        .finally(() => this.schedulePoll())
    }, Math.max(delay, this.backoff))
  }

  private schedulePoll() {
    if (this.stopped || this.pullTimer || this.fatal()) return
    const every = this.relay?.state === 'open' ? POLL.relay : POLL.visible
    this.pullTimer = this.timers.setTimeout(() => {
      this.pullTimer = undefined
      this.runSoon()
    }, Math.max(every, this.backoff))
  }

  /** Dirty marks changed: capture after the debounce, then push. */
  scheduleCapture(delay = CAPTURE_DEBOUNCE) {
    if (this.stopped || this.config.paused) return
    if (this.captureTimer) this.timers.clearTimeout(this.captureTimer)
    this.captureTimer = this.timers.setTimeout(() => {
      this.captureTimer = undefined
      void this.locked(async () => {
        await capture(this.core)
        await this.pushInner()
      })
        .then(() => this.scheduleStatus())
        .catch(() => this.runSoon(this.backoff || 5000))
    }, delay)
  }

  private schedulePush() {
    this.scheduleCapture(CAPTURE_DEBOUNCE)
  }

  /** Visibility changed: capture at once when hidden, pull when visible (§10.1). */
  onVisibility(visible: boolean) {
    if (!this.started) return
    if (visible) {
      this.connectRelay()
      this.runSoon()
    } else {
      this.scheduleCapture(0)
      this.relay?.close()
      this.relay = undefined
      this.setStatus({ relay: 'off' })
    }
    this.transfers.kick()
  }

  onOnline() {
    this.failures = 0
    this.runSoon()
    this.transfers.kick()
  }

  /** The viewer closed a song: capture now and pull. */
  onSongClosed() {
    this.scheduleCapture(0)
    this.runSoon(500)
  }

  private connectRelay() {
    if (this.relay || !this.config.relay || this.config.paused || !this.env.visible()) return
    try {
      this.relay = new NoticeChannel({
        base: this.config.relay,
        keys: this.core.keys,
        deviceId: this.config.deviceId,
        transport: this.o.relayTransport,
        onState: (s) => this.setStatus({ relay: s }),
        onNotice: (p) => void this.onNotice(p),
      })
    } catch (e) {
      this.core.log?.('relay failed', e)
      this.setStatus({ relay: 'error' })
    }
  }

  private async onNotice(p: { d: string; s: number }) {
    const cur = (await getState(this.core.db, 'cursors'))?.[p.d] ?? 0
    if (p.s <= cur) return
    if (this.noticeTimer) this.timers.clearTimeout(this.noticeTimer)
    this.noticeTimer = this.timers.setTimeout(() => {
      this.noticeTimer = undefined
      this.runSoon()
    }, NOTICE_DEBOUNCE)
  }

  /** Start timers, triggers, transfers and the relay. */
  async start() {
    if (this.started) return
    this.started = true
    this.stopped = false
    await this.transfers.start()
    this.dirtySub = liveQuery(() => this.db.syncDirty.count()).subscribe({
      next: (n) => n > 0 && this.scheduleCapture(),
      error: () => {},
    })
    this.maintTimer = this.timers.setInterval(() => {
      if (!this.env.idle() || this.fatal()) return
      void this.maintenance().catch((e) => this.core.log?.('maintenance failed', e))
    }, MAINTENANCE_TICK)
    this.connectRelay()
    await this.refreshStatus().catch(() => {})
    this.runSoon()
  }

  stop() {
    this.stopped = true
    this.started = false
    for (const t of [this.captureTimer, this.pullTimer, this.noticeTimer, this.statusTimer]) if (t) this.timers.clearTimeout(t)
    this.captureTimer = this.pullTimer = this.noticeTimer = this.statusTimer = undefined
    if (this.maintTimer) this.timers.clearInterval(this.maintTimer)
    this.dirtySub?.unsubscribe()
    this.relay?.close()
    this.relay = undefined
    this.transfers.stop()
  }

  /** Pause or resume (config persisted by the caller). */
  setPaused(paused: boolean) {
    this.core.config = { ...this.core.config, paused }
    this.setStatus({ phase: paused ? 'paused' : 'idle' })
    if (paused) {
      this.relay?.close()
      this.relay = undefined
    } else {
      this.connectRelay()
      this.runSoon()
    }
    this.transfers.kick()
  }
}
