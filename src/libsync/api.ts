/**
 * Library sync: public facade for the UI (docs/SYNC.md §12.1).
 *
 * CONTRACT. Step 0 ships stubs: `useLibSync` stays `off`, actions reject with "not implemented", and the
 * hooks/fire-and-forget calls the library and viewer use unconditionally are safe no-ops. WP3 replaces
 * the bodies and keeps every signature (additive changes only).
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { BackendCheck, BackendConfig } from './backends/types'
import type { DeviceRecord, JoinMode, PairingPayload } from './model'

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
  devices: (DeviceRecord & { self: boolean })[]
  error?: LibSyncError
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

const notImplemented = (name: string) => Promise.reject(new Error(`libsync: ${name} not implemented`))

/** Runs the backend's connection test (§7.1). */
export function checkBackend(_cfg: BackendConfig): Promise<BackendCheck> {
  return notImplemented('checkBackend')
}

/** First device: create the synced library from the current one (§10.3 "Enable"). */
export function enableSync(_o: { backend: BackendConfig; relay?: string | null }): Promise<void> {
  return notImplemented('enableSync')
}

/** The `OSJ1.` text code for the current library (also what the QR encodes). */
export function pairingCode(): Promise<string> {
  return notImplemented('pairingCode')
}

/** Accepts the code embedded in pasted text. Rejects with `PairingError('format' | 'version')`. */
export function parsePairingCode(_text: string): Promise<PairingPayload> {
  return notImplemented('parsePairingCode')
}

/**
 * Verifies the code against storage and counts what a join would bring. Rejects with a `LibSyncFailure`
 * (`wrongSecret`, `libraryGone`, `auth`, `cors`, `network`, …).
 */
export function previewJoin(_p: PairingPayload): Promise<JoinPreview> {
  return notImplemented('previewJoin')
}

/** §10.3 "Join". Resolves when the bootstrap is done; downloads continue in the background. */
export function joinSync(_p: PairingPayload, _mode: JoinMode): Promise<void> {
  return notImplemented('joinSync')
}

/** Capture, push and pull now. */
export function syncNow(): Promise<void> {
  return notImplemented('syncNow')
}

export function setPaused(_paused: boolean): Promise<void> {
  return notImplemented('setPaused')
}

/** §10.4 "Stop syncing on this device". Library rows stay. */
export function leaveSync(): Promise<void> {
  return notImplemented('leaveSync')
}

/** §10.5 "Delete synced data from storage…" (the UI confirms by typing the library name first). */
export function deleteRemoteData(): Promise<void> {
  return notImplemented('deleteRemoteData')
}

/** §3.2 repair pass ("Re-check files"). */
export function repair(): Promise<void> {
  return notImplemented('repair')
}

/** New keys after rotation at the provider; same bucket and library. */
export function updateBackend(_cfg: BackendConfig): Promise<void> {
  return notImplemented('updateBackend')
}

const LOCAL: BlobState = { state: 'local' }

/** React hook. Stub: with sync off every blob is local. */
export function useBlobState(_blobId: string | undefined): BlobState {
  return LOCAL
}

/** Calls `cb` once the blob has arrived locally. Returns an unsubscribe function. Stub: never fires. */
export function onBlobReady(_blobId: string, _cb: () => void): () => void {
  return () => {}
}

/** Called when a song or setlist opens: its files jump the download queue (+1000). Stub: no-op. */
export function prioritizeSongs(_ids: string[]): void {}

/**
 * The bucket CORS rule to paste (§7.1), filled with `location.origin`. Pure, so implemented already:
 * B2 gets its own rule format (`b2 bucket update --cors-rules`), every other provider the S3 JSON.
 */
export function corsRule(provider: BackendConfig & { kind: 's3' }): string {
  const origin = typeof location === 'undefined' ? 'https://openstand.rodlabs.dev' : location.origin
  const expose = ['ETag', 'Content-Length', 'Content-Range']
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
