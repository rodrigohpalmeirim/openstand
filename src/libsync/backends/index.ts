/** `createBackend(config, ctx)` (docs/SYNC.md §7, docs/SYNC-DRIVES.md). */
import { DropboxBackend } from './dropbox'
import { GDriveBackend } from './gdrive'
import { MemoryBackend } from './memory'
import { OneDriveBackend } from './onedrive'
import { S3Backend } from './s3'
import { BackendError, type BackendConfig, type BackendContext, type StorageBackend } from './types'

export * from './types'
export { MemoryBackend, type MemoryBackendOptions, type MemoryFault, type MemoryOp } from './memory'
export { S3Backend, type S3Options } from './s3'
export { DropboxBackend, type DropboxOptions } from './dropbox'
export { GDriveBackend, ensureRootFolder, type GDriveOptions } from './gdrive'
export { OneDriveBackend, type OneDriveOptions } from './onedrive'

/** OAuth backends get this device's tokens through `ctx.auth`; without it every call throws `reauth`. */
export function createBackend(config: BackendConfig, ctx: BackendContext = {}): StorageBackend {
  switch (config.kind) {
    case 's3':
      return new S3Backend(config, ctx)
    case 'memory':
      return new MemoryBackend(config.name, { now: ctx.now })
    case 'dropbox':
      return new DropboxBackend(config, ctx)
    case 'gdrive':
      return new GDriveBackend(config, ctx)
    case 'onedrive':
      return new OneDriveBackend(config, ctx)
    default:
      throw new BackendError('unknown', `Unknown backend ${(config as { kind?: string }).kind}`)
  }
}
