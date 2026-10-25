/**
 * Library sync: storage backend contract (docs/SYNC.md §7).
 *
 * CONTRACT. Frozen after step 0: change only by agreement, and only additively.
 * Every backend must pass `backendContract` (contract.test-helper.ts) unchanged.
 */
import type { Json } from '../model'

export type S3Provider = 'r2' | 'b2' | 'aws' | 'minio' | 'other'

export type BackendConfig =
  | {
      kind: 's3'
      provider: S3Provider
      /** e.g. `https://<accountId>.r2.cloudflarestorage.com` (presets in §7.1). */
      endpoint: string
      /** `auto` for R2. */
      region: string
      bucket: string
      /** User prefix under the bucket; default `openstand/`. All keys are relative to bucket + prefix. */
      prefix: string
      accessKeyId: string
      secretAccessKey: string
      /** `endpoint/bucket/key` when true; virtual-hosted (the AWS default) when false. */
      pathStyle: boolean
    }
  /**
   * OAuth backends (docs/SYNC-DRIVES.md). Tokens are per device in `syncState.oauth`, never here.
   * `account` = display hint, usually the email (≤ 320 chars). `accountId` = the provider's stable id:
   * Dropbox `account_id`, Google `about.user.permissionId`, OneDrive `approot.parentReference.driveId`
   * (≤ 200 chars). Both are non-secret hints that let a joining device detect a wrong account (§7.3);
   * neither is ever a credential.
   */
  /** `root`: sub-path inside the app folder; '' = the app folder itself (the UI always uses ''). */
  | { kind: 'dropbox'; root: string; account?: string; accountId?: string }
  /** `folder`: Drive file id of the visible OpenStand folder. Required, non-empty. */
  | { kind: 'gdrive'; folder: string; account?: string; accountId?: string }
  /** `folder`: sub-path inside approot; '' = approot (the UI always uses ''). */
  | { kind: 'onedrive'; folder: string; account?: string; accountId?: string }
  /** Tests (`backends/memory.ts`). */
  | { kind: 'memory'; name: string }

export type BackendKind = BackendConfig['kind']
export type S3Config = Extract<BackendConfig, { kind: 's3' }>

/** The cloud drives signed into with OAuth (docs/SYNC-DRIVES.md). */
export type OAuthKind = 'dropbox' | 'gdrive' | 'onedrive'
export type OAuthConfig = Extract<BackendConfig, { kind: OAuthKind }>
export type DropboxConfig = Extract<BackendConfig, { kind: 'dropbox' }>
export type GDriveConfig = Extract<BackendConfig, { kind: 'gdrive' }>
export type OneDriveConfig = Extract<BackendConfig, { kind: 'onedrive' }>

export const OAUTH_KINDS: readonly OAuthKind[] = ['dropbox', 'gdrive', 'onedrive']
export const isOAuthKind = (k: unknown): k is OAuthKind => k === 'dropbox' || k === 'gdrive' || k === 'onedrive'

export interface ObjectInfo {
  /** Relative to the backend root. */
  key: string
  size: number
  etag?: string
  /** Wall ms. */
  lastModified?: number
}

export interface ListPage {
  /** Sorted by key. */
  items: ObjectInfo[]
  /** Pass back to `list` for the next page; absent on the last page. */
  cursor?: string
}

/** Default body cap of `StorageBackend.get` without a range (an envelope is at most 64 MiB). */
export const GET_MAX = 64 * 1024 * 1024 + 64 * 1024

/** Random-access plaintext/ciphertext source for `upload`. */
export interface ByteSource {
  size: number
  /** `end` is exclusive. */
  read(start: number, end: number): Promise<Uint8Array>
}

/**
 * Persisted resumable-upload progress (stored in `TransferRow.upload`). Opaque to callers except for
 * `done`; pass the last value back to `upload` to resume.
 */
export interface UploadState {
  v: 1
  /** Identifies the backend instance that created the session; another backend must start over. */
  backend: string
  key: string
  size: number
  /** Wall ms; the engine aborts its own sessions older than MULTIPART_STALE. */
  createdAt: number
  /** Bytes confirmed uploaded. */
  done: number
  /** Backend-specific, e.g. S3 `{ uploadId, partSize, parts: [{ n, etag }] }`. */
  session: Json
}

export interface BackendCaps {
  /** `get` honours `range`. */
  rangeGet: boolean
  /** `put` honours `ifNoneMatch` (412 -> `precondition`). Set by `check()` step `conditional`. */
  conditionalPut: boolean
  /** Largest body (bytes) `upload` sends as a single request. */
  maxSmallPut: number
}

export interface StorageBackend {
  readonly kind: BackendKind
  /** Human-readable, e.g. "Cloudflare R2 · my-bucket/openstand". */
  readonly label: string
  /** May be refined by `check()`. */
  caps: BackendCaps
  /** Keys relative to the backend root. `startAfter` is exclusive; backends without it filter client-side. */
  list(prefix: string, o?: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<ListPage>
  /** null on 404. */
  head(key: string, o?: { signal?: AbortSignal }): Promise<ObjectInfo | null>
  /**
   * null on 404. `range` is inclusive `[start, end]`. Bodies are size-capped: with a `range`, at most the
   * range's length; without one, `maxBytes` (default `GET_MAX`). A larger response is aborted, not read,
   * and throws `BackendError('unknown')` with `providerCode` `TooLarge` (or `RangeIgnored` when a server
   * answers a range request with more than the range). (`maxBytes` added with format v2.)
   */
  get(key: string, o?: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number }): Promise<Uint8Array | null>
  /** `ifNoneMatch` sends `If-None-Match: *` (when `caps.conditionalPut`); a 412 throws `BackendError('precondition')`. */
  put(key: string, body: Uint8Array, o?: { ifNoneMatch?: boolean; signal?: AbortSignal }): Promise<void>
  /** 404 counts as success. Callers delete their own keys only (§3.2). */
  delete(key: string, o?: { signal?: AbortSignal }): Promise<void>
  /** Resumable upload of any size. Persists progress through `onState`; pass the last state back to resume. */
  upload(
    key: string,
    src: ByteSource,
    o: {
      state?: UploadState
      onState?: (s: UploadState) => Promise<void>
      onProgress?: (bytes: number) => void
      signal?: AbortSignal
    },
  ): Promise<void>
  /**
   * Cancels a resumable session (and frees its stored parts) so it won't be resumed. Best effort; a
   * missing session counts as success. The engine calls it for its own sessions older than
   * MULTIPART_STALE (§7.1). Optional: backends without server-side sessions omit it. (Added by WP2.)
   */
  abortUpload?(state: UploadState, o?: { signal?: AbortSignal }): Promise<void>
  /** Connection test (§7.1 for the S3 order). Never throws; failures are reported in the result. */
  check(): Promise<BackendCheck>
  /** Who is signed in and where the data lives. OAuth backends implement it; S3/memory omit it. */
  describe?(o?: { signal?: AbortSignal }): Promise<BackendDescription>
}

/** Who a drive account is (SYNC-DRIVES.md §2.1). `id` has the meaning of `BackendConfig.accountId`. */
export interface AccountInfo {
  id: string
  email?: string
  name?: string
}

/** `StorageBackend.describe()` (SYNC-DRIVES.md §2.1). */
export interface BackendDescription {
  account: AccountInfo
  /** For people: "Dropbox › Apps › OpenStand", "Google Drive › OpenStand", "OneDrive › Apps › OpenStand". */
  location: string
  /** Opens the folder in the provider's web UI. */
  openUrl?: string
  freeBytes?: number
}

export type BackendCheckStepId =
  | 'reach'
  | 'auth'
  | 'cors'
  | 'list'
  | 'write'
  | 'read'
  | 'range'
  | 'etag'
  | 'conditional'
  | 'delete'

export interface BackendCheckStep {
  id: BackendCheckStepId
  ok: boolean
  detail?: string
}

export interface BackendCheck {
  ok: boolean
  /** In the order they ran; the UI renders them as a checklist. */
  steps: BackendCheckStep[]
  /** The error that stopped the check, if any (e.g. `cors` -> show the CORS rule). */
  error?: BackendError
}

export type BackendErrorCode =
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'precondition'
  | 'quota'
  | 'rateLimited'
  | 'network'
  | 'cors'
  | 'clock'
  | 'tokenExpired'
  | 'server'
  | 'unknown'
  /**
   * This device must sign in to its drive again: no tokens, refresh refused (`invalid_grant`), consent
   * revoked, a required scope not granted, or a fresh token still gets 401 (SYNC-DRIVES.md §2.1).
   */
  | 'reauth'

/** Every backend failure is normalised to this (error mapping for S3 in §7.1). */
export class BackendError extends Error {
  code: BackendErrorCode
  /** HTTP status, when there was a response. */
  status?: number
  /** From `Retry-After` (for `rateLimited`). */
  retryAfterMs?: number
  /** Provider's own error code, e.g. S3 `SignatureDoesNotMatch`. */
  providerCode?: string

  constructor(
    code: BackendErrorCode,
    message?: string,
    o: { status?: number; retryAfterMs?: number; providerCode?: string; cause?: unknown } = {},
  ) {
    super(message ?? code, o.cause === undefined ? undefined : { cause: o.cause })
    this.name = 'BackendError'
    this.code = code
    this.status = o.status
    this.retryAfterMs = o.retryAfterMs
    this.providerCode = o.providerCode
  }
}

/**
 * Per-device services passed to `createBackend(config, ctx)` (backends/index.ts). The spec names the
 * parameter but not its shape; every member is optional so tests can omit it. Extend additively.
 */
export interface BackendContext {
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Wall clock; defaults to `Date.now`. */
  now?: () => number
  /** @deprecated never used; OAuth backends take `auth`. */
  tokens?: { get(): Promise<TokenSet | undefined>; set(t: TokenSet): Promise<void> }
  /** Required for dropbox/gdrive/onedrive; a missing one makes every call throw `BackendError('reauth')`. */
  auth?: AccessTokenSource
}

// ---------------------------------------------------------------------------------------------
// OAuth (docs/SYNC-DRIVES.md §2.1)
// ---------------------------------------------------------------------------------------------

/** Per-device OAuth access for one backend (implemented in oauth/tokens.ts, faked in tests). */
export interface AccessTokenSource {
  readonly kind: OAuthKind
  /** A valid access token; refreshes first if it expires within 5 min. Throws `BackendError('reauth' | 'network')`. */
  token(o?: { signal?: AbortSignal }): Promise<string>
  /** `rejected` got a 401: refresh (once per rejected token, across tabs) and return the new token. */
  refreshAfter401(rejected: string, o?: { signal?: AbortSignal }): Promise<string>
}

/** Stored per device and library in `syncState.oauth[kind]`. Never in pairing codes, backups or sync. */
export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Wall ms. */
  expiresAt: number
  /** Display (email). */
  account?: string
  /** Same meaning as `BackendConfig.accountId`. */
  accountId?: string
  /** Granted scopes, as returned by the token endpoint. */
  scope?: string
}

/** @deprecated SYNC.md §7.2 sketch, superseded by `oauth/config.ts` (`PROVIDERS`) and `oauth/providers.ts`. */
export interface OAuthProvider {
  kind: OAuthKind
  authorizeUrl(p: { codeChallenge: string; state: string; redirectUri: string }): string
  /** gdrive/onedrive go through the Worker route `POST /api/oauth/<provider>/token`. */
  exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet>
  refresh(t: TokenSet): Promise<TokenSet>
}
