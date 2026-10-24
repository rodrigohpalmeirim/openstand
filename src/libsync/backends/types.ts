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
  /** Phase 2. Tokens are per device in `syncState.oauth`. */
  | { kind: 'dropbox'; root: string }
  /** Phase 3. */
  | { kind: 'gdrive'; folder: string }
  /** Phase 3. */
  | { kind: 'onedrive'; folder: string }
  /** Tests (`backends/memory.ts`). */
  | { kind: 'memory'; name: string }

export type BackendKind = BackendConfig['kind']
export type S3Config = Extract<BackendConfig, { kind: 's3' }>

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
  /** null on 404. `range` is inclusive `[start, end]`. */
  get(key: string, o?: { range?: [number, number]; signal?: AbortSignal }): Promise<Uint8Array | null>
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
  /** Phase 2/3: this device's OAuth tokens (`syncState.oauth`). */
  tokens?: { get(): Promise<TokenSet | undefined>; set(t: TokenSet): Promise<void> }
}

// ---------------------------------------------------------------------------------------------
// §7.2 Phases 2 and 3 (interface only)
// ---------------------------------------------------------------------------------------------

export interface OAuthProvider {
  kind: 'dropbox' | 'gdrive' | 'onedrive'
  authorizeUrl(p: { codeChallenge: string; state: string; redirectUri: string }): string
  /** gdrive/onedrive go through the Worker route `POST /api/oauth/token`. */
  exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet>
  refresh(t: TokenSet): Promise<TokenSet>
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Wall ms. */
  expiresAt: number
  /** Account label for display. */
  account?: string
}
