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
import { listAll as listAllBounded } from './backends/util'
import { BlobQueue, localBlob, LocalQuotaError, queueDownload, queueUpload, referencedBlobs, remoteBlobMatches, songPriority } from './blobs'
import { applyOps, capture, claimedSize, isPlainOutbox, mergeApplied, newApplied, opsAhead, OutboxWriter, plainBatch, projectCtx, syncTxTables, type Applied, type Core } from './apply'
import { decodeBatch, decodeDevice, encodeBatch, encodeDevice, objectStream, readSnapshot, readSnapshotHeader, writeSnapshot } from './codec'
import { blobContext, blobName, blobSource, bytesEqual, deriveLibraryKeys, encryptChunks, FIRST_CHUNK_RANGE, FormatError, type LibraryKeys } from './crypto'
import { createClock, HLC_ZERO, hlcAhead, hlcWall, isDeviceId } from './hlc'
import { compact, dropStale, fromShadow, materialize, project, toShadow } from './merge'
import {
  BLOB_GC_GRACE,
  BLOB_GC_INTERVAL,
  CAPTURE_DEBOUNCE,
  CLOCK_AHEAD_MAX,
  CLOCK_AHEAD_STALL,
  DEAD_FIELDS_TTL,
  ELEMENT_TOMB_TTL,
  LOG_RETENTION,
  POLL,
  SNAPSHOT_TRIGGER,
  type Batch,
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
import { defaultDeviceName, thisDevice, uniqueDeviceName } from '../sync/deviceName'
import type { LibSyncError, LibSyncErrorCode, LibSyncPhase, PullTrigger, SyncDiagnostics, TransferProgress } from './api'

const DAY = 24 * 60 * 60_000
const FETCH_PARALLEL = 4
const FETCH_WINDOW = 32
const APPLY_GROUP = 500
const MAINTENANCE_TICK = 60_000
const REPAIR_INTERVAL = 7 * DAY
const RECONCILE_INTERVAL = DAY
const DEVICE_REFRESH = DAY
const MAX_BACKOFF = 5 * 60_000
/** Capture this soon after the last change, but at most once per CAPTURE_DEBOUNCE, so bursts still batch. */
const CAPTURE_FAST = 300
/** Focus (also pageshow, resume) pulls only if the relay is down or the last pull is this old. */
const WAKE_FRESH = 30_000
/** Wake events right after a pull started don't start another. */
const WAKE_COALESCE = 1_000
/** A relay (re)open pulls, since notices sent while it was down are lost; at most this soon after the last pull. */
const RELAY_PULL_GAP = 2_000
/** Pull triggers that run while the page is hidden (a covered or minimised window still gets changes). */
const HIDDEN_OK: ReadonlySet<PullTrigger> = new Set(['notice', 'relay'])
/** Batches one stream may apply per pull; the rest follow in the next round (scheduled at once). */
const STREAM_BUDGET = 2000
/** Retry delays for a stalled stream; the last one repeats (a stream that keeps failing is retried hourly). */
const STALL_RETRY = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000]
/** Unknown device ids (heads without a readable device record) looked up per pull, and how long a miss is cached. */
const DEVICE_CHECKS = 4
const DEVICE_RECHECK = 10 * 60_000
/** Snapshot headers fetched per device per listing (newest first). */
const SNAP_HEADERS = 8
/** Candidate snapshots tried before giving up on bootstrap or gap recovery. */
const SNAP_TRIES = 3
/** How long a blob upload trusts the last check that the library (`meta`) still exists. */
const LIBRARY_CHECK_UPLOADS = 30_000

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
  libraryGone: 'The synced library was reset or deleted from another device.',
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
  } else if (e instanceof FormatError) {
    // `oldFormat` (an authentic pre-v2 object) has no code of its own: the fix is the same as for
    // `rejoin` (reset sync and join again).
    code = e.code === 'corrupt' || e.code === 'newerFormat' ? e.code : 'rejoin'
    detail = e.message
  }
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

/** `listAll` gave up on a flooded or looping listing (`backends/util.ts`). */
const LIST_OVERFLOW = ['TooManyKeys', 'ListLoop']

/**
 * Errors about the whole sync (storage reachability, credentials, local disk), as opposed to one object
 * or one device's stream. Everything else met while pulling a stream (unreadable or tampered objects, data
 * we can't apply, a missing log no snapshot covers) only holds that stream back.
 */
function isGlobalError(e: unknown): boolean {
  if (e instanceof BackendError) return e.code !== 'notFound' && !LIST_OVERFLOW.includes(e.providerCode ?? '')
  if (e instanceof SyncError) return e.code !== 'corrupt'
  if (e instanceof LocalQuotaError) return true
  const name = (e as Error)?.name
  return name === 'QuotaExceededError' || name === 'DatabaseClosedError' || name === 'MissingAPIError'
}

/** One device's stream can't go on at `seq` for now (§10.1 steps 3-4); the other streams carry on. */
class StreamStall extends Error {
  readonly seq: number
  readonly cause: unknown
  /** Earliest retry (clock-ahead stalls wait for this device's clock to catch up). */
  readonly retryAt?: number
  constructor(seq: number, cause: unknown, retryAt?: number) {
    super((cause as Error)?.message ?? String(cause))
    this.name = 'StreamStall'
    this.seq = seq
    this.cause = cause
    this.retryAt = retryAt
  }
}

interface Stall {
  seq: number
  attempts: number
  retryAt: number
  error: LibSyncError
}

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
  /** A relay is set for this library (`config.relay`); without one `relay` stays 'off' and sync polls. */
  relayConfigured: boolean
  devices: (DeviceRecord & { self: boolean })[]
  error?: LibSyncError
  /** Another device's clock is ahead (§6.1), or a device's changes can't be read for now; shown, not fatal. */
  warning?: LibSyncError
  /** Devices whose stream is held back (unreadable entry, clock far ahead, …), by device id. Not fatal. */
  streams?: Record<string, LibSyncError>
  diag: SyncDiagnostics
}

export interface EngineOptions {
  backend?: StorageBackend
  keys?: LibraryKeys
  now?: () => number
  timers?: EngineTimers
  env?: EngineEnv
  hooks?: EngineHooks
  /**
   * This device's name: the user's own, or a default made unique against `taken` (names of devices that
   * joined earlier). Without it the engine uses `defaultDeviceName()`.
   */
  deviceName?: (ctx: { taken: string[] }) => string | Promise<string>
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

/**
 * Why a snapshot header can't be trusted against what storage shows, or null. Its vector may only name
 * well-formed device ids and seqs, and may not claim more of a device than that device's observed head: a
 * vector past the head would move cursors over data that exists and hide it for good. Snapshots written
 * or stamped further ahead than CLOCK_AHEAD_MAX are refused too.
 */
export function snapshotProblem(h: SnapshotHeader, heads: Record<string, number>, now: number): string | null {
  const v = h?.vector as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'malformed vector'
  for (const [d, s] of Object.entries(v)) {
    if (!isDeviceId(d)) return 'bad device id in vector'
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return `bad seq for ${d}`
    if (Object.hasOwn(heads, d) && s > heads[d]) return `claims ${d} up to ${s}, past its head ${heads[d]}`
  }
  if (typeof h.t !== 'number' || !(h.t - now <= CLOCK_AHEAD_MAX)) return 'written in the future'
  if (!(hlcAhead(h.hlcMax, now) <= CLOCK_AHEAD_MAX)) return 'stamped in the future'
  const z = h.horizon as Partial<SnapshotHeader['horizon']> | undefined
  if (!z || typeof z.elementTombs !== 'number' || typeof z.deadFields !== 'number') return 'malformed horizon'
  return null
}

/** Σ of the vector entries storage vouches for (devices with an observed head, capped at it). */
const coveredSum = (v: Record<string, number>, heads: Record<string, number>) =>
  Object.entries(v).reduce((a, [d, s]) => a + (Object.hasOwn(heads, d) ? Math.min(s, heads[d]) : 0), 0)

/**
 * Snapshots fit to bootstrap or recover from, best first (§3.1 plus trust rules): consistent with the
 * observed heads (`snapshotProblem`) and written by a device with a valid record; live authors before
 * retired ones, then the largest Σvector (counting only entries storage vouches for), then the newest.
 */
export function rankSnapshots<T extends { deviceId: string; header: SnapshotHeader }>(
  snaps: T[],
  ctx: { heads: Record<string, number>; devices: ReadonlyMap<string, { retired?: boolean }>; now: number; log?: (msg: string) => void },
): T[] {
  const ok = snaps.filter((s) => {
    const why = !ctx.devices.has(s.deviceId) ? 'author has no device record' : snapshotProblem(s.header, ctx.heads, ctx.now)
    if (why) ctx.log?.(`ignoring snapshot ${s.deviceId}/${(s as { n?: number }).n ?? '?'}: ${why}`)
    return !why
  })
  const rank = (s: T) => (ctx.devices.get(s.deviceId)?.retired ? 1 : 0)
  return ok.sort(
    (a, b) => rank(a) - rank(b) || coveredSum(b.header.vector, ctx.heads) - coveredSum(a.header.vector, ctx.heads) || b.header.t - a.header.t,
  )
}

function fmtAhead(ms: number) {
  if (ms >= 2 * DAY) return `${Math.round(ms / DAY).toLocaleString('en')} days`
  return ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 60_000)} min`
}

export const platformName = (): string => thisDevice().platform
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
  /** The pull started by `pullNow`, and a request that arrived while it ran (it may have listed too early). */
  private inflight?: Promise<void>
  private again?: PullTrigger
  /** When the pending `pullTimer` fires, and what it's for. */
  private pullDue = 0
  private pullTrigger: PullTrigger = 'start'
  private lastPullStart = -Infinity
  private lastCaptureAt = -Infinity
  private maintTimer?: ReturnType<typeof setInterval>
  private statusTimer?: ReturnType<typeof setTimeout>
  private dirtySub?: Subscription
  private relay?: NoticeChannel
  /** Held-back device streams (in memory: a restart retries at once). */
  private stalls = new Map<string, Stall>()
  /** Device ids whose record was missing or unreadable -> when to look again. */
  private deviceMiss = new Map<string, number>()
  /** Snapshot keys whose header couldn't be read. */
  private badSnaps = new Set<string>()
  private aheadWarning?: LibSyncError
  /** A stream hit its per-pull budget: pull again soon. */
  private more = false
  /** When `meta` was last seen (undefined: not yet in this write cycle; every locked run starts a new one). */
  private libraryOkAt?: number

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
      relayConfigured: !!core.config.relay,
      devices: [],
      diag: { pollMs: POLL.visible },
    }
    this.transfers = new BlobQueue({
      db: core.db,
      backend: core.backend,
      keys: core.keys,
      now: core.now,
      timers: this.timers,
      canRun: ({ prioritized }) =>
        !this.stopped && !this.fatal() && !this.core.config.paused && this.env.online() && this.env.visible() && (prioritized || !this.env.performing()),
      onUploaded: (hash) => this.blobUploaded(hash),
      onDownloaded: (hash) => {
        this.hooks.blobReady?.(hash)
        this.scheduleStatus()
      },
      onError: (e) => {
        const err = toSyncError(e, this.core.now())
        if (err.code === 'network') this.setStatus({ phase: 'offline' })
        // A bad object (tampered blob, unknown container version) is that blob's problem, never fatal.
        else if (!(e instanceof FormatError) && err.code !== 'unknown' && err.code !== 'corrupt') this.setStatus({ phase: 'error', error: err })
        this.core.log?.('transfer failed', e)
      },
      onProgress: () => this.scheduleStatus(),
      beforeUpload: () => this.ensureLibrary(LIBRARY_CHECK_UPLOADS),
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
    const go = () => {
      this.libraryOkAt = undefined
      return fn()
    }
    const run = this.mutexTail.then(go, go)
    this.mutexTail = run.catch(() => {})
    return run
  }

  private setStatus(p: Partial<EngineStatus>) {
    this.status = { ...this.status, ...p }
    this.hooks.status?.(this.status)
  }

  /**
   * Writes go only into a library that still exists: another device may have reset or deleted it (meta goes
   * first, §10.5), and a write into the old prefix would leave an orphan nothing cleans up. One HEAD on
   * `meta` per write cycle (`maxAge` lets blob uploads share a recent answer). When it's gone, sync stops
   * with `libraryGone` instead of writing.
   */
  private async ensureLibrary(maxAge = Infinity) {
    const now = this.core.now()
    if (this.libraryOkAt !== undefined && now - this.libraryOkAt <= maxAge) return
    if (await this.core.backend.head(metaKey(this.core.keys.libraryId))) {
      this.libraryOkAt = now
      return
    }
    this.libraryOkAt = undefined
    const err = toSyncError(new SyncError('libraryGone'), now)
    if (this.status.error?.code !== 'libraryGone') this.setStatus({ phase: 'error', error: err })
    throw new SyncError('libraryGone')
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

  private deviceName(device: string) {
    return this.status.devices.find((d) => d.id === device)?.name ?? 'Another device'
  }

  private clockAhead(device: string, ms: number) {
    const message =
      ms > CLOCK_AHEAD_MAX
        ? `“${this.deviceName(device)}” has its clock set ${fmtAhead(ms)} ahead. Its changes will sync once its clock is right.`
        : `“${this.deviceName(device)}” has its clock set ${fmtAhead(ms)} ahead. Edits from it may win over newer ones.`
    if (this.aheadWarning?.message === message) return
    this.aheadWarning = { code: 'clockAhead', message, at: this.core.now() }
    if (!this.status.streams || !Object.keys(this.status.streams).length) this.setStatus({ warning: this.aheadWarning })
  }

  /** Publish held-back streams: the first one is the warning (a clock warning otherwise). */
  private publishStreams() {
    const streams = Object.fromEntries([...this.stalls].map(([d, s]) => [d, s.error]))
    this.setStatus({ streams, warning: Object.values(streams)[0] ?? this.aheadWarning })
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
      await this.ensureLibrary()
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
        // Our own earlier attempt may have landed before a crash: identical bytes are fine. Something that
        // isn't a batch of ours at all was planted by someone without the key: overwrite it. Only a real
        // batch of ours with other content means a clone (or restored state).
        const there = await backend.get(key)
        if (!there || !bytesEqual(there, bytes)) {
          const ours = there ? await decodeBatch(keys, there, { deviceId: me, seq: row.seq }).then(() => true, () => false) : false
          if (ours) throw new SyncError('rejoin', undefined, `log ${row.seq} exists with other content (cloned device?)`)
          await backend.put(key, bytes)
        }
      }
      await backend.put(headKey(lib, me, row.seq), new Uint8Array(0))
      // Announce before the housekeeping delete: readers take the highest head, so two are harmless.
      void this.relay?.post(row.seq).catch(() => {})
      if (row.seq > 1) await backend.delete(headKey(lib, me, row.seq - 1)).catch(() => {})
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

  /**
   * Every object under `prefix`, bounded (`backends/util.listAll`): a listing past LIST_MAX_KEYS or one that
   * doesn't advance throws `BackendError('unknown')` (`TooManyKeys` / `ListLoop`). That fails the operation
   * like any storage error (retried with backoff, never fatal); under one device's prefix it only holds
   * back that device's stream.
   */
  listAll(prefix: string): Promise<ObjectInfo[]> {
    return listAllBounded(this.core.backend, prefix)
  }

  /** Each device's latest seq (one LIST, §3). Unverified: anyone with bucket access can write heads. */
  async heads(): Promise<Record<string, number>> {
    const lib = this.core.keys.libraryId
    return latestHeads(lib, (await this.listAll(headsPrefix(lib))).map((i) => i.key))
  }

  /** Cached device records by id. */
  private async knownDevices(): Promise<Map<string, DeviceRecord>> {
    return new Map(((await getState(this.core.db, 'devices')) ?? []).map((d) => [d.id, d]))
  }

  /**
   * Fetch and verify one device's record (it must decrypt under the library key); cached on success.
   * Misses are remembered for DEVICE_RECHECK, so a fake head costs one GET now and then.
   */
  private async verifyDevice(d: string): Promise<DeviceRecord | null> {
    const { backend, keys, db } = this.core
    const now = this.core.now()
    if ((this.deviceMiss.get(d) ?? 0) > now) return null
    let rec: DeviceRecord | null = null
    const bytes = await backend.get(deviceKey(keys.libraryId, d))
    if (bytes) {
      try {
        rec = await decodeDevice(keys, bytes, d)
      } catch (e) {
        this.core.log?.(`unreadable device record ${d}`, e)
      }
    }
    if (!rec) {
      this.deviceMiss.set(d, now + DEVICE_RECHECK)
      this.core.log?.(`ignoring heads of ${d}: no valid device record`)
      return null
    }
    this.deviceMiss.delete(d)
    const cached = (await getState(db, 'devices')) ?? []
    await putState(db, 'devices', [...cached.filter((x) => x.id !== d), rec])
    return rec
  }

  /**
   * Heads of devices with a valid (decryptable) record, and our own. Heads of anything else are ignored:
   * an empty object under `heads/` proves nothing. `added`: a device was verified just now.
   */
  private async trustedHeads(raw?: Record<string, number>): Promise<{ heads: Record<string, number>; added: boolean }> {
    raw ??= await this.heads()
    const me = this.config.deviceId
    const known = await this.knownDevices()
    const heads: Record<string, number> = {}
    let checks = 0
    let added = false
    for (const [d, h] of Object.entries(raw)) {
      if (d === me || known.has(d)) heads[d] = h
      else if ((this.deviceMiss.get(d) ?? 0) <= this.core.now() && checks++ < DEVICE_CHECKS && (await this.verifyDevice(d))) {
        heads[d] = h
        added = true
      }
    }
    return { heads, added }
  }

  pull() {
    return this.locked(() => this.pullInner())
  }

  /**
   * §10.1 pull. Each device's stream is independent: anything wrong with one device's objects (unreadable,
   * tampered, unappliable, a gap no snapshot covers, a clock far ahead) holds back that stream only. It is
   * reported in `status.streams`/`warning`, retried with backoff, and never stops the other streams, local
   * capture or pushing. Only storage-wide failures (network, auth, …) fail the pull.
   */
  private async pullInner(): Promise<Applied> {
    const { db, backend, keys, config } = this.core
    const lib = keys.libraryId
    const total = newApplied()
    const raw = await this.heads()
    if (!Object.keys(raw).length && !(await backend.head(metaKey(lib)))) throw new SyncError('libraryGone')
    const { heads, added } = await this.trustedHeads(raw)
    for (const d of this.stalls.keys()) if (!Object.hasOwn(heads, d)) this.stalls.delete(d)
    this.more = false
    for (const [d, head] of Object.entries(heads)) {
      if (d === config.deviceId) continue
      const stall = this.stalls.get(d)
      if (stall) {
        const cur = (await getState(db, 'cursors'))?.[d] ?? 0
        if (cur >= stall.seq) this.stalls.delete(d)
        else if (this.core.now() < stall.retryAt) continue
      }
      try {
        await this.pullStream(d, head, heads, total)
        this.stalls.delete(d)
      } catch (e) {
        if (!(e instanceof StreamStall)) throw e
        this.stall(d, e)
      }
    }
    this.publishStreams()
    // A device we haven't seen yet: refresh the list now rather than at the next idle maintenance, so
    // "Devices" isn't empty right after setting up or pairing.
    if (added) await this.refreshDevicesInner().catch((e) => this.core.log?.('devices refresh failed', e))
    if (!(await db.syncDirty.count()) && !(await db.syncOutbox.count()))
      await putState(db, 'lastSync', { at: this.core.now(), hlc: this.core.clock.last, seq: (await getState(db, 'cursors'))?.[config.deviceId] ?? 0 })
    return total
  }

  private stall(d: string, e: StreamStall) {
    const now = this.core.now()
    const prev = this.stalls.get(d)
    const attempts = prev?.seq === e.seq ? prev.attempts + 1 : 1
    const retryAt = Math.max(now + STALL_RETRY[Math.min(attempts, STALL_RETRY.length) - 1], e.retryAt ?? 0)
    const cause = toSyncError(e.cause, now)
    const name = this.deviceName(d)
    const error: LibSyncError =
      cause.code === 'clockAhead'
        ? cause
        : cause.code === 'newerFormat'
          ? { code: 'newerFormat', message: `“${name}” uses a newer OpenStand. Update this one to get its changes.`, detail: cause.detail, at: now }
          : e.cause instanceof FormatError && e.cause.code === 'oldFormat'
            ? { code: 'rejoin', message: `Changes from “${name}” were written by an older OpenStand. Reset sync to go on.`, detail: cause.detail, at: now }
          : { code: 'unknown', message: `Changes from “${name}” can’t be read right now. Other devices keep syncing.`, detail: `${d}/${e.seq}: ${cause.detail ?? cause.message}`, at: now }
    this.stalls.set(d, { seq: e.seq, attempts, retryAt, error })
    this.core.log?.(`stream ${d} held at ${e.seq} (attempt ${attempts})`, e.cause)
  }

  /** Pull one device's stream up to `head` (at most STREAM_BUDGET batches). Throws `StreamStall`. */
  private async pullStream(d: string, head: number, heads: Record<string, number>, total: Applied) {
    const { db, keys } = this.core
    let cur = (await getState(db, 'cursors'))?.[d] ?? 0
    let at = cur + 1
    let budget = STREAM_BUDGET
    try {
      while (cur < head && budget > 0) {
        const seqs: number[] = []
        for (let s = cur + 1; s <= Math.min(head, cur + FETCH_WINDOW, cur + budget); s++) seqs.push(s)
        const bodies = await this.fetchLogs(d, seqs)
        for (let i = 0; i < seqs.length; i++) {
          at = seqs[i]
          const bytes = bodies[i]
          if (!bytes) {
            mergeApplied(total, await this.recoverGap(d, at, head, heads))
            break
          }
          let batch: Batch
          try {
            batch = await decodeBatch(keys, bytes, { deviceId: d, seq: at })
          } catch (e) {
            if (isGlobalError(e)) throw e
            // Unreadable (tampered, truncated, a format we don't know): a snapshot covering it heals the
            // stream; it is never skipped otherwise, or devices would diverge.
            const healed = await this.applyCovering(d, at, heads)
            if (!healed) throw new StreamStall(at, e)
            mergeApplied(total, healed)
            break
          }
          const now = this.core.now()
          const ahead = opsAhead(batch.ops, now)
          if (ahead > CLOCK_AHEAD_MAX && ahead <= CLOCK_AHEAD_STALL) {
            // A clock somewhat ahead: wait until ours catches up rather than drop its edits. (Further
            // ahead than that the ops are bogus: applyOps skips them and the stream goes on.)
            const err = new SyncError('clockAhead', `“${this.deviceName(d)}” has its clock set ${fmtAhead(ahead)} ahead. Its changes will sync once its clock is right.`)
            throw new StreamStall(at, err, now + ahead - CLOCK_AHEAD_MAX + 1000)
          }
          mergeApplied(total, await this.applyBatch(batch))
          budget--
        }
        const next = (await getState(db, 'cursors'))?.[d] ?? 0
        if (next <= cur) throw new StreamStall(cur + 1, new SyncError('corrupt', undefined, `log ${d}/${cur + 1} is missing and no snapshot covers it`))
        cur = next
        at = cur + 1
      }
    } catch (e) {
      if (e instanceof StreamStall || isGlobalError(e)) throw e
      throw new StreamStall(at, e)
    }
    if (cur < head) this.more = true
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

  private async applyBatch(batch: Batch): Promise<Applied> {
    if (batch.ops.length) await this.hooks.beforeApply?.(batch.ops)
    const a = await applyOps(this.core, batch.ops, { cursor: { device: batch.d, seq: batch.s } })
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
  private async recoverGap(d: string, missing: number, head: number, heads: Record<string, number>): Promise<Applied> {
    const lib = this.core.keys.libraryId
    const seqs = (await this.listAll(logPrefix(lib, d))).map((o) => parseKey(o.key)).flatMap((p) => (p?.type === 'log' ? [p.seq] : []))
    const lowest = seqs.filter((s) => s >= missing).reduce((m, s) => Math.min(m, s), head + 1)
    const a = await this.applyCovering(d, lowest - 1, heads)
    if (!a) throw new StreamStall(missing, new SyncError('corrupt', undefined, `log ${d}/${missing} is missing and no snapshot covers it`))
    return a
  }

  /** Merge the best trusted snapshot with `vector[d] ≥ need` (trying a few); null when none works. */
  private async applyCovering(d: string, need: number, heads: Record<string, number>): Promise<Applied | null> {
    const ranked = rankSnapshots(await this.listSnapshots(), { heads, devices: await this.knownDevices(), now: this.core.now(), log: this.core.log })
    for (const snap of ranked.filter((s) => (s.header.vector[d] ?? 0) >= need).slice(0, SNAP_TRIES)) {
      try {
        return await this.applySnapshot(snap, { heads })
      } catch (e) {
        if (isGlobalError(e)) throw e
        this.core.log?.(`snapshot ${snap.key} failed`, e)
      }
    }
    return null
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots (§3.1)
  // -------------------------------------------------------------------------------------------

  /**
   * Snapshots in storage with their headers (cached in `syncState.snapshots`). Only those of devices with
   * a known record (and ours) are read, newest first and at most SNAP_HEADERS per device; unreadable
   * headers are remembered and skipped.
   */
  async listSnapshots(): Promise<SnapInfo[]> {
    const { db, keys, backend } = this.core
    const lib = keys.libraryId
    const known = await this.knownDevices()
    const cache = { ...((await getState(db, 'snapshots')) ?? {}) }
    const out: SnapInfo[] = []
    const seen = new Set<string>()
    const fetched = new Map<string, number>()
    const listed = (await this.listAll(snapPrefix(lib)))
      .map((o) => ({ o, p: parseKey(o.key) }))
      .flatMap(({ o, p }) => (p?.type === 'snap' ? [{ o, deviceId: p.deviceId, n: p.seq }] : []))
      .sort((a, b) => b.n - a.n)
    for (const { o, deviceId, n } of listed) {
      if (deviceId !== this.config.deviceId && !known.has(deviceId)) continue
      seen.add(o.key)
      let header = cache[o.key]
      if (!header) {
        if (this.badSnaps.has(o.key) || (fetched.get(deviceId) ?? 0) >= SNAP_HEADERS) continue
        fetched.set(deviceId, (fetched.get(deviceId) ?? 0) + 1)
        const bytes = await backend.get(o.key, { range: FIRST_CHUNK_RANGE })
        if (!bytes) continue
        try {
          header = await readSnapshotHeader(keys, { deviceId, n }, bytes, { now: this.core.now() })
        } catch (e) {
          this.badSnaps.add(o.key)
          this.core.log?.(`unreadable snapshot ${o.key}`, e)
          continue
        }
        cache[o.key] = header
      }
      out.push({ key: o.key, deviceId, n, header, lastModified: o.lastModified })
    }
    for (const k of Object.keys(cache)) if (!seen.has(k)) delete cache[k]
    await putState(db, 'snapshots', cache)
    return out
  }

  /**
   * Merge a whole snapshot (idempotent), then advance cursors to its vector, clamped to the observed heads
   * (entries for devices without a trusted head move nothing). A device that was away longer than the
   * snapshot's tombstone horizon drops what the network deleted meanwhile (§3.2), but only when the
   * snapshot provably covers everything this device has merged (else absence proves nothing).
   */
  async applySnapshot(snap: SnapInfo, o: { onProgress?: (done: number, total: number) => void; heads?: Record<string, number> } = {}): Promise<Applied> {
    const { db, keys, backend } = this.core
    const now = this.core.now()
    const heads = o.heads ?? (await this.trustedHeads()).heads
    const problem = snapshotProblem(snap.header, heads, now)
    if (problem) throw new SyncError('corrupt', undefined, `snapshot ${snap.key}: ${problem}`)
    const vector = snap.header.vector
    const total = newApplied()
    const lastSync = await getState(db, 'lastSync')
    const cursors = (await getState(db, 'cursors')) ?? {}
    const me = this.config.deviceId
    // Never trust a horizon beyond what the snapshot's own age (or ours) allows.
    const horizon = Math.min(snap.header.horizon.elementTombs, snap.header.t - ELEMENT_TOMB_TTL, now - ELEMENT_TOMB_TTL)
    const covers =
      Object.entries(cursors).every(([d, s]) => d === me || (vector[d] ?? 0) >= s) && (vector[me] ?? 0) >= (lastSync?.seq ?? cursors[me] ?? 0)
    const stale = !!lastSync && covers && hlcWall(lastSync.hlc) < horizon
    const seen = stale ? new Map<string, RecordDelta>() : null
    const reader = await readSnapshot(keys, { deviceId: snap.deviceId, n: snap.n }, objectStream(backend, snap.key), { now })
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
      if (seen && typeof r?.id === 'string') seen.set(r.id, r)
      group.push(r)
      if (group.length >= APPLY_GROUP) await flush()
    }
    await flush()
    if (seen && lastSync) mergeApplied(total, await this.dropStale(seen, lastSync.hlc))
    const moves: Record<string, number> = {}
    for (const [d, s] of Object.entries(vector)) if (Object.hasOwn(heads, d)) moves[d] = Math.min(s, heads[d])
    await applyOps(this.core, [], { cursors: moves })
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
        if (!Object.hasOwn(TABLE_OF, shadow.c)) continue
        const c = shadow.c
        const table = db.table(TABLE_OF[c])
        const row = (await table.get(shadow.id)) as CollectionRows[typeof c] | undefined
        const pctx = await projectCtx(db, c === 'song' ? (row as Song | undefined) : undefined)
        const local = fromShadow(shadow, row ? project(c, row, pctx) : null)
        const s = snap.get(shadow.id)
        const kept = dropStale(local, s && s.c === c ? s : undefined, lastSync)
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

  /**
   * Bootstrap from the best trusted snapshot, if any (join). Returns false when there is none. A snapshot
   * that fails to read is skipped for the next best (what it merged is genuine and stays).
   */
  async bootstrap(o: { onProgress?: (done: number, total: number) => void } = {}): Promise<boolean> {
    return this.locked(async () => {
      await this.refreshDevicesInner()
      const { heads } = await this.trustedHeads()
      const ranked = rankSnapshots(await this.listSnapshots(), { heads, devices: await this.knownDevices(), now: this.core.now(), log: this.core.log })
      for (const snap of ranked.slice(0, SNAP_TRIES)) {
        try {
          await this.applySnapshot(snap, { ...o, heads })
          return true
        } catch (e) {
          if (isGlobalError(e)) throw e
          this.core.log?.(`bootstrap from ${snap.key} failed`, e)
        }
      }
      return false
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
    await this.ensureLibrary()
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
            if (!Object.hasOwn(TABLE_OF, s.c)) {
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

  /** A listing (maintenance) shows another device ahead of our cursor: a notice was missed, pull now. */
  private async pullIfBehind(heads: Record<string, number>) {
    const cur = (await getState(this.core.db, 'cursors')) ?? {}
    const behind = Object.entries(heads).some(([d, h]) => d !== this.config.deviceId && !this.stalls.has(d) && h > (cur[d] ?? 0))
    if (behind && this.started) this.runSoon(0, 'poll')
  }

  /** §3.1 trigger: ≥ 500 uncovered log entries (or ≥ 8 MiB), at most daily; or no snapshot exists yet. */
  async snapshotDue(): Promise<boolean> {
    const m = await this.maintenanceState()
    const now = this.core.now()
    const { heads } = await this.trustedHeads()
    await this.pullIfBehind(heads)
    const snaps = (await this.listSnapshots()).filter((s) => !snapshotProblem(s.header, heads, now))
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
    const devices = await this.refreshDevicesInner()
    const { heads } = await this.trustedHeads()
    const snaps = await this.listSnapshots()
    // Coverage only counts from snapshots that are consistent with storage (a lying vector would prune
    // logs nothing else holds).
    const trusted = new Set(rankSnapshots(snaps, { heads, devices: new Map(devices.map((d) => [d.id, d])), now }))
    const old = snaps.filter((s) => trusted.has(s) && now - s.header.t >= LOG_RETENTION.snapshotAge)
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

  /** This device's name for its record: the user's own, else the default made unique (see `deviceName`). */
  private async ownName(): Promise<string> {
    const { config, db } = this.core
    const me = config.deviceId
    const earlier = ((await getState(db, 'devices')) ?? []).filter(
      (d) => d.id !== me && (d.createdAt < config.joinedAt || (d.createdAt === config.joinedAt && d.id < me)),
    )
    const taken = earlier.map((d) => d.name)
    const name = this.o.deviceName ? await this.o.deviceName({ taken }) : uniqueDeviceName(defaultDeviceName(), taken)
    return name.trim() || 'Device'
  }

  /**
   * Write this device's record (§2: the owner overwrites it on a name change, at most daily, on retire). The
   * library must still exist (a fresh HEAD on `meta`): a device that hasn't noticed a reset would otherwise
   * leave an orphan record in the old prefix.
   */
  async putDevice(o: { retired?: boolean } = {}) {
    const { backend, keys, config } = this.core
    this.libraryOkAt = undefined
    await this.ensureLibrary()
    const rec: DeviceRecord = {
      v: 1,
      id: config.deviceId,
      name: await this.ownName(),
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

  /** The user renamed this device: overwrite its record now. */
  rename() {
    return this.locked(() => this.putDevice())
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
        // Same check as the upload path: size and the 28-byte fingerprint (header + chunk 0's nonce), so a
        // stale, v1 or planted object of the right size is replaced too.
        const ctx = await blobContext(keys, hash)
        const there = await remoteBlobMatches(backend, blobKey(keys.libraryId, ctx.name), encryptChunks(keys, blobSource(rec.data), ctx))
        if (!there) {
          await db.syncTransfers.delete(['up', hash])
          await queueUpload(db, hash, rec.size, rec.mime)
          uploads++
        }
      } else if (!(await db.syncTransfers.get(['down', hash]))) {
        const song = songs.find((s) => s.files.some((f) => f.blobId === ref.blobId) || s.audio.some((a) => a.blobId === ref.blobId))
        const file = song?.files.find((f) => f.blobId === ref.blobId)
        await queueDownload(db, hash, claimedSize(file?.size), 'application/octet-stream', prio.get(ref.blobId) ?? 0)
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
  async sync(trigger: PullTrigger = 'manual'): Promise<Applied> {
    if (this.config.paused) return newApplied()
    this.setStatus({ phase: 'syncing' })
    let started = this.core.now()
    const hidden = !this.env.visible()
    const done = (ok: boolean) => this.setDiag({ lastPull: { at: started, trigger, ms: Math.max(0, this.core.now() - started), ok, hidden } })
    try {
      const applied = await this.locked(async () => {
        started = this.lastPullStart = this.core.now()
        await capture(this.core)
        await this.pushInner()
        const a = await this.pullInner()
        done(true)
        // Applying may have rebased dirty records into new ops.
        await capture(this.core)
        await this.pushInner()
        return a
      })
      this.failures = 0
      this.setStatus({ phase: 'idle', error: undefined })
      this.transfers.kick()
      await this.refreshStatus()
      if (this.more && this.started) this.runSoon(1000, 'poll')
      return applied
    } catch (e) {
      const err = toSyncError(e, this.core.now())
      if (this.status.diag.lastPull?.at !== started) done(false)
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

  /**
   * Pull now, without a timer: hidden pages get their timers throttled (to once a minute after 5 min in
   * Chrome), but WebSocket messages and visibility events still arrive at once, and these call this directly.
   * A request while a pull runs queues one more (the running one may have listed before the new head).
   * After failures the backoff still applies.
   */
  private pullNow(trigger: PullTrigger) {
    if (this.stopped || this.fatal() || this.config.paused) return
    if (this.failures) return this.runSoon(0, trigger)
    if (this.inflight) {
      this.again ??= trigger
      return
    }
    if (this.pullTimer) this.timers.clearTimeout(this.pullTimer)
    this.pullTimer = undefined
    this.startPull(trigger)
  }

  private startPull(trigger: PullTrigger) {
    this.lastPullStart = this.core.now()
    this.inflight = this.sync(trigger)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.inflight = undefined
        const next = this.again
        this.again = undefined
        if (next && !this.failures) this.pullNow(next)
        else this.schedulePoll()
      })
  }

  /** Sync soon; errors are reported through the status and retried with backoff. An earlier pending run is kept. */
  private runSoon(delay = 0, trigger: PullTrigger = 'poll') {
    if (this.stopped || this.fatal()) return
    const due = this.core.now() + Math.max(delay, this.backoff)
    if (this.pullTimer) {
      if (this.pullDue <= due) return
      this.timers.clearTimeout(this.pullTimer)
    }
    this.pullDue = due
    this.pullTrigger = trigger
    this.pullTimer = this.timers.setTimeout(() => {
      this.pullTimer = undefined
      const t = this.pullTrigger
      if (this.config.paused || (!this.env.visible() && !HIDDEN_OK.has(t))) return this.schedulePoll()
      if (this.inflight) this.again ??= t
      else this.startPull(t)
    }, Math.max(delay, this.backoff))
  }

  /** Poll interval in effect: shorter without the relay. */
  private get pollEvery() {
    return this.relay?.state === 'open' ? POLL.relay : POLL.visible
  }

  private schedulePoll() {
    if (this.stopped || this.pullTimer || this.fatal()) return
    const wait = Math.max(this.pollEvery, this.backoff)
    this.pullDue = this.core.now() + wait
    this.pullTrigger = 'poll'
    this.pullTimer = this.timers.setTimeout(() => {
      this.pullTimer = undefined
      this.runSoon(0, 'poll')
    }, wait)
  }

  /**
   * Dirty marks changed: capture CAPTURE_FAST after the last change, but no sooner than CAPTURE_DEBOUNCE after
   * the previous capture, then push. A single edit goes out at once; a burst becomes one batch per 1.5 s.
   */
  scheduleCapture(delay?: number) {
    if (this.stopped || this.config.paused) return
    delay ??= Math.max(CAPTURE_FAST, this.lastCaptureAt + CAPTURE_DEBOUNCE - this.core.now())
    if (this.captureTimer) this.timers.clearTimeout(this.captureTimer)
    this.captureTimer = this.timers.setTimeout(() => {
      this.captureTimer = undefined
      this.lastCaptureAt = this.core.now()
      void this.capturePush()
        .then(() => this.scheduleStatus())
        .catch(() => this.runSoon(this.backoff || 5000, 'retry'))
    }, delay)
  }

  private capturePush() {
    return this.locked(async () => {
      await capture(this.core)
      await this.pushInner()
    })
  }

  private schedulePush() {
    this.scheduleCapture(CAPTURE_DEBOUNCE)
  }

  /**
   * Visibility changed: push at once when hidden, check the relay and pull at once when visible (§10.1). The
   * relay stays connected while hidden: a covered, minimised or background window still gets notices and
   * pulls (mobile browsers may drop the socket; it's checked when the page comes back).
   */
  onVisibility(visible: boolean) {
    if (!this.started) return
    if (visible) this.wake('visible')
    else {
      if (this.captureTimer) this.timers.clearTimeout(this.captureTimer)
      this.captureTimer = undefined
      void this.capturePush()
        .then(() => this.scheduleStatus())
        .catch(() => {})
    }
    this.transfers.kick()
  }

  /**
   * The page was shown, focused (pageshow, resume) or the network came back: reconnect the relay now rather
   * than after its backoff, check an open socket is still alive, and pull at once. Focus doesn't pull while
   * the relay is up and a pull ran recently, so switching windows doesn't cost a request each time.
   */
  wake(trigger: 'visible' | 'focus' | 'online') {
    if (!this.started || this.stopped || this.config.paused || !this.env.visible()) return
    if (this.relay) this.relay.wake()
    else this.connectRelay()
    const since = this.core.now() - this.lastPullStart
    if (this.inflight && since < WAKE_COALESCE) return
    if (trigger === 'focus' && this.relay?.state === 'open' && since < WAKE_FRESH) return
    this.pullNow('focus')
  }

  /** User input after a quiet spell: check the relay socket is alive (a dead one reconnects, then catches up). */
  checkRelay() {
    if (this.started && !this.config.paused && this.env.visible()) this.relay?.wake()
  }

  onOnline() {
    this.failures = 0
    this.wake('online')
    this.transfers.kick()
  }

  /** The viewer closed a song: capture now and pull. */
  onSongClosed() {
    this.scheduleCapture(0)
    this.runSoon(500, 'local')
  }

  private setDiag(p: Partial<SyncDiagnostics>) {
    this.setStatus({ diag: { ...this.status.diag, ...p } })
  }

  private dropRelay() {
    this.relay?.close()
    this.relay = undefined
    this.setStatus({ relay: 'off', diag: { ...this.status.diag, relaySince: this.core.now(), pollMs: POLL.visible } })
  }

  /** This device's last pushed seq. */
  private async ownHead() {
    return (await getState(this.core.db, 'cursors'))?.[this.config.deviceId] ?? 0
  }

  private connectRelay() {
    if (this.relay || !this.config.relay || this.config.paused) return
    let relay: NoticeChannel | undefined
    try {
      relay = new NoticeChannel({
        base: this.config.relay,
        keys: this.core.keys,
        deviceId: this.config.deviceId,
        transport: this.o.relayTransport,
        timers: this.timers,
        head: () => this.ownHead(),
        log: (m) => this.core.log?.(m),
        // (The transport reports 'connecting' from inside the constructor, before `relay` is set.)
        onState: (s) => relay && this.relay === relay && this.onRelayState(relay, s),
        onSent: (seq) => this.setDiag({ noticeSent: { seq, at: this.core.now() } }),
        onNotice: (p) => void this.onNotice(p),
      })
      this.relay = relay
      this.setStatus({ relay: relay.state, diag: { ...this.status.diag, relaySince: relay.since } })
    } catch (e) {
      this.core.log?.('relay failed', e)
      this.setStatus({ relay: 'error' })
    }
  }

  private onRelayState(relay: NoticeChannel, s: RelayState) {
    const pollMs = s === 'open' ? POLL.relay : POLL.visible
    this.setStatus({ relay: s, diag: { ...this.status.diag, relaySince: relay.since, pollMs } })
    if (s !== 'open') return
    // Announce our head (a notice we posted while disconnected never went out) and pull: notices other
    // devices sent while we were disconnected are lost. Receivers ignore seqs they already have.
    void this.ownHead()
      .then((h) => {
        if (h > 0) void relay.post(h)
      })
      .catch(() => {})
    const wait = this.lastPullStart + RELAY_PULL_GAP - this.core.now()
    if (wait <= 0) this.pullNow('relay')
    else this.runSoon(wait, 'relay')
  }

  /** Straight from the socket's message handler to the pull: no timer in between (see `pullNow`). */
  private async onNotice(p: { d: string; s: number; k?: 'ping' | 'pong' }) {
    if (!p.k) this.setDiag({ noticeReceived: { device: p.d, seq: p.s, at: this.core.now(), hidden: !this.env.visible() } })
    const cur = (await getState(this.core.db, 'cursors'))?.[p.d] ?? 0
    if (p.s > cur) this.pullNow('notice')
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
    this.runSoon(0, 'start')
    void this.refreshOwnRecord().catch((e) => this.core.log?.('device record refresh failed', e))
  }

  /**
   * This device's record names it by default (no name of the user's own) or its platform changed, e.g. a
   * newer version detects the device better: rewrite it now rather than at the next daily refresh.
   */
  private async refreshOwnRecord() {
    const own = this.status.devices.find((d) => d.self)
    if (!own || this.config.paused) return
    if (own.name === (await this.ownName()) && own.platform === platformName()) return
    await this.locked(async () => {
      if (!this.stopped) await this.putDevice()
    })
  }

  stop() {
    this.stopped = true
    this.started = false
    for (const t of [this.captureTimer, this.pullTimer, this.statusTimer]) if (t) this.timers.clearTimeout(t)
    this.captureTimer = this.pullTimer = this.statusTimer = undefined
    if (this.maintTimer) this.timers.clearInterval(this.maintTimer)
    this.dirtySub?.unsubscribe()
    this.relay?.close()
    this.relay = undefined
    this.transfers.stop()
  }

  /**
   * Use this relay from now on (config persisted by the caller): a library set up without one (the site's
   * relay check failed then) adopts the site's relay once it answers.
   */
  adoptRelay(base: string) {
    if (this.config.relay === base) return
    this.relay?.close()
    this.relay = undefined
    this.core.config = { ...this.core.config, relay: base }
    this.setStatus({ relay: 'off', relayConfigured: true })
    if (this.started && !this.stopped) this.connectRelay()
  }

  /** Pause or resume (config persisted by the caller). */
  setPaused(paused: boolean) {
    this.core.config = { ...this.core.config, paused }
    this.setStatus({ phase: paused ? 'paused' : 'idle' })
    if (paused) this.dropRelay()
    else {
      this.connectRelay()
      this.runSoon(0, 'manual')
    }
    this.transfers.kick()
  }
}
