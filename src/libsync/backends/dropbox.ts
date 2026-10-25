/**
 * Dropbox API v2 in the app folder (docs/SYNC-DRIVES.md §4.1). Owned by WP-D.
 *
 * STEP-0 STUB: satisfies `StorageBackend` so everything compiles; every operation throws "not implemented".
 */
import { BackendError, type BackendCaps, type BackendCheck, type BackendContext, type BackendDescription, type ByteSource, type ListPage, type ObjectInfo, type DropboxConfig, type StorageBackend, type UploadState } from './types'

const MiB = 1024 * 1024
const NAME = 'Dropbox'

export interface DropboxOptions {
  /** Upload session chunk (default 8 MiB). */
  chunk?: number
  /** Largest single-request upload (default 16 MiB). */
  maxSmallPut?: number
}

const notImplemented = (name: string) => new BackendError('unknown', `The ${name} backend isn't implemented yet`, { providerCode: 'NotImplemented' })

export class DropboxBackend implements StorageBackend {
  readonly kind = 'dropbox' as const
  readonly label: string
  caps: BackendCaps
  protected readonly cfg: DropboxConfig
  protected readonly ctx: BackendContext
  protected readonly opts: DropboxOptions

  constructor(cfg: DropboxConfig, ctx: BackendContext = {}, opts: DropboxOptions = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.opts = opts
    this.label = cfg.account ? `${NAME} · ${cfg.account}` : NAME
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: opts.maxSmallPut ?? 16 * MiB }
  }

  async list(_prefix: string, _o?: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<ListPage> {
    throw notImplemented(NAME)
  }

  async head(_key: string, _o?: { signal?: AbortSignal }): Promise<ObjectInfo | null> {
    throw notImplemented(NAME)
  }

  async get(_key: string, _o?: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number }): Promise<Uint8Array | null> {
    throw notImplemented(NAME)
  }

  async put(_key: string, _body: Uint8Array, _o?: { ifNoneMatch?: boolean; signal?: AbortSignal }): Promise<void> {
    throw notImplemented(NAME)
  }

  async delete(_key: string, _o?: { signal?: AbortSignal }): Promise<void> {
    throw notImplemented(NAME)
  }

  async upload(
    _key: string,
    _src: ByteSource,
    _o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    throw notImplemented(NAME)
  }

  async check(): Promise<BackendCheck> {
    return { ok: false, steps: [], error: notImplemented(NAME) }
  }

  async describe(_o?: { signal?: AbortSignal }): Promise<BackendDescription> {
    throw notImplemented(NAME)
  }
}
