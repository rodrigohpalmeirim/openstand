/**
 * Library sync: public facade for the UI (docs/SYNC.md §12.1).
 *
 * CONTRACT: signatures change additively only. `useLibSync` is fed by the service (service.ts); actions
 * reject with `LibSyncFailure` (or `PairingError` from `parsePairingCode`). The hooks and fire-and-forget
 * calls the library and viewer use unconditionally are cheap no-ops while sync is off.
 */
import { liveQuery } from 'dexie'
import { useCallback, useSyncExternalStore } from 'react'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { db, type OpenStandDB } from '../db/db'
import type { BackendCheck, BackendConfig, BackendDescription, BackendKind, OAuthKind } from './backends/types'
import { PairingError, type DeviceRecord, type JoinMode, type PairingPayload } from './model'
import type { SignInIntent, SignInResult } from './oauth/types'

export type { AccountInfo, BackendDescription, BackendKind, OAuthKind } from './backends/types'
export type { SignInErrorCode, SignInIntent, SignInResult } from './oauth/types'
export { signInReturnPending } from './oauth/callback'

export type LibSyncPhase = 'off' | 'starting' | 'idle' | 'syncing' | 'offline' | 'paused' | 'error'

/** UI wording and actions per code are fixed in §12.3. `network` is shown as phase `offline`, not an error. */
export type LibSyncErrorCode =
  | 'auth'
  | 'cors'
  | 'quota'
  | 'localQuota'
  | 'network'
  | 'clock'
  | 'clockAhead'
  | 'wrongSecret'
  | 'libraryGone'
  | 'newerFormat'
  | 'corrupt'
  | 'rejoin'
  | 'server'
  | 'unknown'
  /** Cloud drives (SYNC-DRIVES.md §7.4, §8): this device must sign in to its drive again. */
  | 'reauth'
  /** Cloud drives (§7.3): the signed-in account doesn't hold this library. */
  | 'wrongAccount'

export interface LibSyncError {
  code: LibSyncErrorCode
  message: string
  detail?: string
  /** Wall ms. */
  at: number
}

export interface TransferProgress {
  files: number
  bytes: number
  doneFiles: number
  doneBytes: number
}

export interface LibSyncStatus {
  phase: LibSyncPhase
  /** Sync is set up for the current library (even if paused or in error). */
  configured: boolean
  /** `StorageBackend.label`. */
  backendLabel?: string
  /** `StorageBackend.kind` (picks the drive wording and the "Sign in again" action). */
  backendKind?: BackendKind
  /** Wall ms of the last time fully caught up. */
  lastSyncAt?: number
  /** Local changes not yet uploaded (dirty records + outbox ops). */
  pendingChanges: number
  upload: TransferProgress
  download: TransferProgress
  /** Files present locally / referenced. */
  offlineReady: { have: number; total: number }
  /** Initial upload (enable) or join in progress. */
  initial?: { kind: 'upload' | 'join'; step: string; done: number; total: number }
  relay: 'off' | 'connecting' | 'open' | 'error'
  /** A relay is set for this library; when false, `relay` is 'off' because there is none (sync polls). */
  relayConfigured?: boolean
  devices: (DeviceRecord & { self: boolean })[]
  /**
   * Fatal when `phase` is `error`. For compatibility a non-fatal `warning` is also mirrored here while the
   * phase isn't `error`; the UI tells them apart by the phase (see `ui/format.ts` `syncProblem`).
   */
  error?: LibSyncError
  /** Non-fatal: a device's changes are held back for now, or its clock is ahead. Sync carries on and retries. */
  warning?: LibSyncError
  /** Device streams held back (not fatal), by device id. */
  streams?: Record<string, LibSyncError>
  /** What the relay, notices and pulls last did (engine diagnostics; read by tests and when debugging). */
  diag?: SyncDiagnostics
}

/** What started a pull: a relay notice, the poll timer, the page coming back, "Sync now", … */
export type PullTrigger = 'start' | 'notice' | 'poll' | 'focus' | 'online' | 'relay' | 'manual' | 'local' | 'retry'

export interface SyncDiagnostics {
  /** Wall ms since the relay has been in its current state. */
  relaySince?: number
  /** Last notice this device sent (its head seq). */
  noticeSent?: { seq: number; at: number }
  /** Last notice received from another device (device id); `hidden`: this page was hidden then. */
  noticeReceived?: { device: string; seq: number; at: number; hidden?: boolean }
  /** Last pull: when it started, what started it, how long it took, whether the page was hidden. */
  lastPull?: { at: number; trigger: PullTrigger; ms: number; ok: boolean; hidden?: boolean }
  /** Poll interval in effect (ms). */
  pollMs: number
}

export type BlobStateKind = 'local' | 'queued' | 'downloading' | 'waiting' | 'offline' | 'missing'

/** `progress` is 0..1 while `downloading`. */
export interface BlobState {
  state: BlobStateKind
  progress?: number
}

export interface JoinPreview {
  remoteSongs: number
  remoteBytes: number
  localSongs: number
  /** Local songs that `planJoin` would combine with remote ones (merge mode). */
  matches: number
  suggested: 'here' | 'newLibrary'
}

const noTransfer = (): TransferProgress => ({ files: 0, bytes: 0, doneFiles: 0, doneBytes: 0 })

/** The status when sync isn't configured for the current library. Fresh object each call. */
export function offStatus(): LibSyncStatus {
  return {
    phase: 'off',
    configured: false,
    pendingChanges: 0,
    upload: noTransfer(),
    download: noTransfer(),
    offlineReady: { have: 0, total: 0 },
    relay: 'off',
    devices: [],
  }
}

export const useLibSync: UseBoundStore<StoreApi<LibSyncStatus>> = create<LibSyncStatus>(() => offStatus())

/**
 * What the facade's actions reject with (other than `PairingError` from `parsePairingCode`), so the UI can
 * pick the §12.3 wording by `code`. The spec doesn't name this; added in step 0.
 */
export class LibSyncFailure extends Error {
  readonly code: LibSyncErrorCode
  readonly detail?: string
  constructor(code: LibSyncErrorCode, message?: string, detail?: string) {
    super(message ?? code)
    this.name = 'LibSyncFailure'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------------------------
// Implementation. The engine, flows and backends load lazily: users who never sync don't pay for them.
// ---------------------------------------------------------------------------------------------

const service = () => import('./service')
const flows = () => import('./join')
const libraries = () => import('../library/browse/libraries')

/** Rejections carry a `LibSyncFailure` code (§12.3 wording) unless they're already one / a PairingError. */
async function failure(e: unknown): Promise<never> {
  if (e instanceof LibSyncFailure || e instanceof PairingError) throw e
  const { toSyncError } = await import('./engine')
  const err = toSyncError(e)
  throw new LibSyncFailure(err.code, err.message, err.detail)
}

const guarded =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
  (...a: A): Promise<R> =>
    fn(...a).catch(failure)

/** Runs the backend's connection test (§7.1). */
export const checkBackend = guarded(async (cfg: BackendConfig): Promise<BackendCheck> => {
  const { createBackend } = await import('./backends')
  return createBackend(cfg).check()
})

/** First device: create the synced library from the current one (§10.3 "Enable"). */
export const enableSync = guarded(async (o: { backend: BackendConfig; relay?: string | null }): Promise<void> => {
  const svc = await service()
  const { enable, initialUpload } = await flows()
  const { activeLibraryName } = await libraries()
  let relay = o.relay
  if (relay === undefined) {
    const { sameSiteRelayAvailable, SAME_SITE_RELAY } = await import('../sync/transports')
    relay = (await sameSiteRelayAvailable()) ? SAME_SITE_RELAY : null
  }
  void navigator.storage?.persist?.().catch(() => {})
  await svc.withEngineStopped(async () => {
    const e = await enable(db, { backendConfig: o.backend, relay, name: activeLibraryName(), deviceName: svc.deviceName })
    e.stop()
  })
  // withEngineStopped restarted the engine; publish everything and write the first snapshot once it runs.
  await svc.restart({
    afterStart: async (e) => {
      svc.setInitial({ kind: 'upload', step: 'publish', done: 0, total: 1 })
      try {
        await initialUpload(e, { onProgress: (step, done, total) => svc.setInitial({ kind: 'upload', step, done, total }) })
      } finally {
        svc.setInitial(undefined)
      }
    },
  })
})

/** The `OSJ1.` text code for the current library (also what the QR encodes). */
export const pairingCode = guarded(async (): Promise<string> => {
  const { getConfig } = await import('./state')
  const config = await getConfig(db)
  if (!config) throw new LibSyncFailure('unknown', 'Library sync is not set up for this library')
  const { encodePairing } = await import('./pairing')
  return encodePairing({ v: 1, s: config.secret, n: config.name, b: config.backend, r: config.relay })
})

/** Accepts the code embedded in pasted text. Rejects with `PairingError('format' | 'version')`. */
export async function parsePairingCode(text: string): Promise<PairingPayload> {
  const { decodePairing } = await import('./pairing')
  return decodePairing(text)
}

/**
 * Verifies the code against storage and counts what a join would bring. Rejects with a `LibSyncFailure`
 * (`wrongSecret`, `libraryGone`, `auth`, `cors`, `network`, …).
 */
export const previewJoin = guarded(async (p: PairingPayload): Promise<JoinPreview> => (await flows()).previewJoin(db, p))

/** §10.3 "Join". Resolves when the bootstrap is done; downloads continue in the background. */
export const joinSync = guarded(async (p: PairingPayload, mode: JoinMode): Promise<void> => {
  const svc = await service()
  const { join } = await flows()
  if (mode === 'newLibrary') {
    const { createLibrary, switchLibrary, useLibraries } = await libraries()
    const { useNav } = await import('../state/nav')
    const name = p.n?.trim() || 'Synced library'
    const taken = useLibraries.getState().list.some((l) => l.name === name)
    const { route } = useNav.getState()
    switchLibrary(createLibrary(taken ? `${name} (synced)` : name))
    // Switching resets navigation to the library; stay on the screen that started the join (in the same
    // tick, so it doesn't unmount) so its progress and "Done" stay visible.
    if (route.name === 'settings') useNav.getState().go(route)
  }
  const progress = (step: string, done: number, total: number) => svc.setInitial({ kind: 'join', step, done, total })
  progress('verify', 0, 1)
  try {
    await svc.withEngineStopped(async () => {
      const e = await join(db, p, mode === 'newLibrary' ? 'here' : mode, { deviceName: svc.deviceName, onProgress: progress })
      e.stop()
    })
  } finally {
    svc.setInitial(undefined)
  }
})

/** Capture, push and pull now. */
export const syncNow = guarded(async (): Promise<void> => {
  const svc = await service()
  const e = svc.currentEngine()
  if (e) await e.sync()
  else svc.requestSyncNow()
})

export const setPaused = guarded(async (paused: boolean): Promise<void> => {
  const { getConfig, putState } = await import('./state')
  const config = await getConfig(db)
  if (!config) return
  await putState(db, 'config', { ...config, paused })
  const e = (await service()).currentEngine()
  if (e) e.setPaused(paused)
  else useLibSync.setState({ phase: paused ? 'paused' : 'starting' })
})

/** §10.4 "Stop syncing on this device". Library rows stay. */
export const leaveSync = guarded(async (): Promise<void> => {
  const svc = await service()
  const e = svc.currentEngine()
  await svc.withEngineStopped(async () => (await flows()).leave(db, e ?? undefined))
})

/** §10.5 "Delete synced data from storage…" (the UI confirms by typing the library name first). */
export const deleteRemoteData = guarded(async (): Promise<void> => {
  const svc = await service()
  await svc.withEngineStopped(async () => (await flows()).deleteRemote(db))
})

/** Rename this device ('' = back to its default name). The device record is overwritten at once (§2). */
export const renameDevice = guarded(async (name: string): Promise<void> => (await service()).renameDevice(name))

/** §3.2 repair pass ("Re-check files"). */
export const repair = guarded(async (): Promise<void> => {
  const e = (await service()).currentEngine()
  if (!e) throw new LibSyncFailure('unknown', 'Library sync is not running')
  await e.repair()
})

/** New keys after rotation at the provider; same bucket and library. */
export const updateBackend = guarded(async (cfg: BackendConfig): Promise<void> => {
  const { getConfig, putState } = await import('./state')
  const config = await getConfig(db)
  if (!config) throw new LibSyncFailure('unknown', 'Library sync is not set up for this library')
  // Prove the new credentials reach the same library before saving them.
  await (await flows()).openPairing({ v: 1, s: config.secret, b: cfg })
  const svc = await service()
  await svc.withEngineStopped(() => putState(db, 'config', { ...config, backend: cfg }))
})

// ---------------------------------------------------------------------------------------------
// Cloud-drive sign-in (docs/SYNC-DRIVES.md §2.2). STEP-0 STUBS: WP-O replaces the bodies (oauth/flow.ts,
// oauth/tokens.ts); the signatures are the contract WP-U builds against. `signInReturnPending` is real
// (re-exported from oauth/callback.ts above).
// ---------------------------------------------------------------------------------------------

const notYet = (what: string) => new LibSyncFailure('unknown', `${what} isn't available yet.`)

/**
 * OAuth providers usable here: a client id is configured, and for gdrive/onedrive the Worker route answers
 * with the same client id (§6.4). Stub: none yet, so the wizard offers S3 only.
 */
export async function oauthProviders(): Promise<OAuthKind[]> {
  return []
}

/** Saves the pending sign-in (§5.2) and navigates away. Never resolves when it works. */
export const startSignIn = guarded(
  async (kind: OAuthKind, intent: SignInIntent, o?: { chooseAccount?: boolean; loginHint?: string }): Promise<void> => {
    void [kind, intent, o]
    throw notYet('Signing in to a cloud drive')
  },
)

/** Exchanges the code, stores the tokens in `syncState.oauth` of the pending library DB, identifies the account. */
export const completeSignIn = guarded(async (): Promise<SignInResult> => {
  throw notYet('Signing in to a cloud drive')
})

/** After sign-in: the BackendConfig for setup. gdrive finds or creates the OpenStand folder (§4.3). */
export const driveBackendConfig = guarded(async (kind: OAuthKind): Promise<BackendConfig> => {
  void kind
  throw notYet('Syncing through a cloud drive')
})

/** `backend.describe()` with this device's tokens (wizard and settings). */
export const describeBackend = guarded(async (cfg: BackendConfig): Promise<BackendDescription> => {
  void cfg
  throw notYet('Syncing through a cloud drive')
})

const LOCAL: BlobState = { state: 'local' }
const SHA256_HEX = /^[0-9a-f]{64}$/

/** Where a blob is: local, or (with sync on) queued / downloading / waiting for its uploader / missing. */
export function blobStateOf(d: OpenStandDB, blobId: string): Promise<BlobState> {
  // One read transaction: a download that completes in between must not look `missing`.
  return d.transaction('r', d.blobs, d.syncTransfers, () => readBlobState(d, blobId))
}

async function readBlobState(d: OpenStandDB, blobId: string): Promise<BlobState> {
  if ((await d.blobs.get(blobId)) || (SHA256_HEX.test(blobId) && (await d.blobs.where('hash').equals(blobId).count()))) return LOCAL
  const t = SHA256_HEX.test(blobId) ? await d.syncTransfers.get(['down', blobId]) : undefined
  if (!t) return { state: 'missing' }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { state: 'offline' }
  if (t.state === 'waiting') return { state: 'waiting' }
  if (t.state === 'active' || t.doneChunks) {
    const chunks = Math.max(1, Math.ceil(t.size / (1 << 20)))
    return { state: 'downloading', progress: Math.min(1, (t.doneChunks ?? 0) / chunks) }
  }
  return { state: 'queued' }
}

/**
 * One live query per (library, blob), shared by every component showing that blob (a song row's caption and
 * its thumbnail, say), and dropped with its last subscriber.
 */
interface BlobWatch {
  value?: BlobState
  listeners: Set<() => void>
  sub: { unsubscribe(): void }
}
const blobWatches = new Map<string, BlobWatch>()

function watchBlob(key: string, d: OpenStandDB, blobId: string, cb: () => void): () => void {
  let w = blobWatches.get(key)
  if (!w) {
    const watch: BlobWatch = { listeners: new Set(), sub: { unsubscribe() {} } }
    blobWatches.set(key, (w = watch))
    watch.sub = liveQuery(() => blobStateOf(d, blobId)).subscribe({
      next: (v) => {
        const prev = watch.value
        if (prev && prev.state === v.state && prev.progress === v.progress) return
        watch.value = v
        for (const l of watch.listeners) l()
      },
      error: (e) => console.warn('[libsync] blob state', e),
    })
  }
  const watch = w
  watch.listeners.add(cb)
  return () => {
    watch.listeners.delete(cb)
    if (watch.listeners.size) return
    watch.sub.unsubscribe()
    if (blobWatches.get(key) === watch) blobWatches.delete(key)
  }
}

/** Like `useBlobState`, but `undefined` until the first answer (callers that must tell "not known yet" from local). */
export function useBlobStateRaw(blobId: string | undefined): BlobState | undefined {
  const configured = useLibSync((s) => s.configured)
  const d = db
  const key = blobId ? `${d.name}\n${configured ? 1 : 0}\n${blobId}` : ''
  const subscribe = useCallback((cb: () => void) => (key ? watchBlob(key, d, blobId!, cb) : () => {}), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const snapshot = useCallback(() => (key ? blobWatches.get(key)?.value : LOCAL), [key])
  return useSyncExternalStore(subscribe, snapshot)
}

/** React hook: the blob's local/download state, live. `local` while loading or when `blobId` is unset. */
export function useBlobState(blobId: string | undefined): BlobState {
  return useBlobStateRaw(blobId) ?? LOCAL
}

const readyListeners = new Map<string, Set<() => void>>()

/** Calls `cb` once the blob has arrived locally. Returns an unsubscribe function. */
export function onBlobReady(blobId: string, cb: () => void): () => void {
  let set = readyListeners.get(blobId)
  if (!set) readyListeners.set(blobId, (set = new Set()))
  set.add(cb)
  return () => {
    set.delete(cb)
    if (!set.size && readyListeners.get(blobId) === set) readyListeners.delete(blobId)
  }
}

/** The engine reports a finished download (blob id = content hash). */
export function emitBlobReady(hash: string) {
  const set = readyListeners.get(hash)
  if (!set) return
  readyListeners.delete(hash)
  for (const cb of set) {
    try {
      cb()
    } catch (e) {
      console.error(e)
    }
  }
}

/** Called when a song or setlist opens: its files jump the download queue (+1000). */
export function prioritizeSongs(ids: string[]): void {
  if (!ids.length || !useLibSync.getState().configured) return
  void service()
    .then((m) => m.prioritizeSongs(ids))
    .catch(() => {})
}

/**
 * The bucket CORS rule to paste (§7.1), filled with `location.origin`. Pure, so implemented already:
 * B2 gets its own rule format (`b2 bucket update --cors-rules`), every other provider the S3 JSON.
 */
export function corsRule(provider: BackendConfig & { kind: 's3' }): string {
  const origin = typeof location === 'undefined' ? 'https://openstand.rodlabs.dev' : location.origin
  // `Date` lets the S3 backend correct clock skew (§7.1).
  const expose = ['ETag', 'Content-Length', 'Content-Range', 'Date']
  const rule =
    provider.provider === 'b2'
      ? [
          {
            corsRuleName: 'openstand',
            allowedOrigins: [origin],
            allowedOperations: ['s3_get', 's3_head', 's3_put', 's3_post', 's3_delete'],
            allowedHeaders: ['*'],
            exposeHeaders: expose,
            maxAgeSeconds: 86400,
          },
        ]
      : [
          {
            AllowedOrigins: [origin],
            AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: expose,
            MaxAgeSeconds: 86400,
          },
        ]
  return JSON.stringify(rule, null, 2)
}

// Dev-only hook for WP4 (§14): `?libsyncMock=<phase>` drives `useLibSync` through the UI states.
// WP4 creates `./ui/mock.ts` exporting `applyLibSyncMock(phase: string): void` (typically calling
// `useLibSync.setState`). The glob is empty until that file exists, and the whole block is dropped from
// production builds. WP3: keep this block when replacing the stubs.
if (import.meta.env.DEV && typeof location !== 'undefined') {
  const mock = new URLSearchParams(location.search).get('libsyncMock')
  const load = import.meta.glob<{ applyLibSyncMock(phase: string): void }>('./ui/mock.ts')['./ui/mock.ts']
  if (mock && load) void load().then((m) => m.applyLibSyncMock(mock))
}
