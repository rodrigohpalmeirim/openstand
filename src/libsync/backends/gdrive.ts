/**
 * Google Drive v3, flat layout in the visible OpenStand folder (docs/SYNC-DRIVES.md §4.3). Owned by WP-G.
 *
 * STEP-0 STUB: satisfies `StorageBackend` so everything compiles; every operation throws "not implemented".
 */
import { BackendError, type BackendCaps, type BackendCheck, type BackendContext, type BackendDescription, type ByteSource, type ListPage, type ObjectInfo, type GDriveConfig, type StorageBackend, type UploadState } from './types'

const MiB = 1024 * 1024
const NAME = 'Google Drive'

export interface GDriveOptions {
  /** Resumable chunk, a multiple of 256 KiB (default 8 MiB). */
  chunk?: number
  /** Largest single-request upload (default 5 MiB). */
  maxSmallPut?: number
}

const notImplemented = (name: string) => new BackendError('unknown', `The ${name} backend isn't implemented yet`, { providerCode: 'NotImplemented' })

export class GDriveBackend implements StorageBackend {
  readonly kind = 'gdrive' as const
  readonly label: string
  caps: BackendCaps
  protected readonly cfg: GDriveConfig
  protected readonly ctx: BackendContext
  protected readonly opts: GDriveOptions

  constructor(cfg: GDriveConfig, ctx: BackendContext = {}, opts: GDriveOptions = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.opts = opts
    this.label = cfg.account ? `${NAME} · ${cfg.account}` : NAME
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: opts.maxSmallPut ?? 5 * MiB }
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

/**
 * Finds the OpenStand root folder by its `appProperties` marker, or creates it in My Drive (§4.3 "Root
 * folder"); returns its file id for `BackendConfig.folder`. Used only by `driveBackendConfig` at setup.
 */
export async function ensureRootFolder(ctx: BackendContext, o: { signal?: AbortSignal } = {}): Promise<string> {
  void ctx
  void o
  throw notImplemented('Google Drive')
}
