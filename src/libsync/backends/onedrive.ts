/**
 * Microsoft Graph, OneDrive app folder (`special/approot`), keys mapped with `deep3` (docs/SYNC-DRIVES.md §4.2). Owned by WP-M.
 *
 * STEP-0 STUB: satisfies `StorageBackend` so everything compiles; every operation throws "not implemented".
 */
import { BackendError, type BackendCaps, type BackendCheck, type BackendContext, type BackendDescription, type ByteSource, type ListPage, type ObjectInfo, type OneDriveConfig, type StorageBackend, type UploadState } from './types'

const MiB = 1024 * 1024
const NAME = 'OneDrive'

export interface OneDriveOptions {
  /** Upload fragment, a multiple of 327,680 B (default 10 MiB). */
  chunk?: number
  /** Largest single-request upload (default 10 MiB). */
  maxSmallPut?: number
}

const notImplemented = (name: string) => new BackendError('unknown', `The ${name} backend isn't implemented yet`, { providerCode: 'NotImplemented' })

export class OneDriveBackend implements StorageBackend {
  readonly kind = 'onedrive' as const
  readonly label: string
  caps: BackendCaps
  protected readonly cfg: OneDriveConfig
  protected readonly ctx: BackendContext
  protected readonly opts: OneDriveOptions

  constructor(cfg: OneDriveConfig, ctx: BackendContext = {}, opts: OneDriveOptions = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.opts = opts
    this.label = cfg.account ? `${NAME} · ${cfg.account}` : NAME
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: opts.maxSmallPut ?? 10 * MiB }
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

  async abortUpload(_state: UploadState, _o?: { signal?: AbortSignal }): Promise<void> {
    throw notImplemented(NAME)
  }

  async check(): Promise<BackendCheck> {
    return { ok: false, steps: [], error: notImplemented(NAME) }
  }

  async describe(_o?: { signal?: AbortSignal }): Promise<BackendDescription> {
    throw notImplemented(NAME)
  }
}
