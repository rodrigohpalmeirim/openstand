/** `createBackend(config, ctx)` (docs/SYNC.md §7). Phase 2/3 backends plug in here. */
import { MemoryBackend } from './memory'
import { S3Backend } from './s3'
import { BackendError, type BackendConfig, type BackendContext, type StorageBackend } from './types'

export * from './types'
export { MemoryBackend, type MemoryBackendOptions, type MemoryFault, type MemoryOp } from './memory'
export { S3Backend, type S3Options } from './s3'

export function createBackend(config: BackendConfig, ctx: BackendContext = {}): StorageBackend {
  switch (config.kind) {
    case 's3':
      return new S3Backend(config, ctx)
    case 'memory':
      return new MemoryBackend(config.name, { now: ctx.now })
    case 'dropbox':
    case 'gdrive':
    case 'onedrive':
      throw new BackendError('unknown', `The ${config.kind} backend isn't available yet`)
    default:
      throw new BackendError('unknown', `Unknown backend ${(config as { kind?: string }).kind}`)
  }
}
