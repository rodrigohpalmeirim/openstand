// @vitest-environment node
// Step-0 contract guard (docs/SYNC.md §4, §6, §7, §12.1): compile-time shape checks plus the stub defaults.
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as api from './api'
import { BackendError, type BackendConfig, type StorageBackend } from './backends/types'
import { CHUNK, PairingError, type Batch, type RecordDelta, type SyncStateRow, type SyncStateValues } from './model'

describe('libsync contracts', () => {
  it('useLibSync starts off and unconfigured', () => {
    const s = api.useLibSync.getState()
    expect(s).toEqual(api.offStatus())
    expect(s.phase).toBe('off')
    expect(s.configured).toBe(false)
    expect(s.devices).toEqual([])
  })

  it('stub actions reject, passive calls are safe', async () => {
    await expect(api.syncNow()).rejects.toThrow(/not implemented/)
    await expect(api.parsePairingCode('OSJ1.x')).rejects.toThrow(/not implemented/)
    expect(api.useBlobState('b')).toEqual({ state: 'local' })
    expect(() => api.prioritizeSongs(['s'])).not.toThrow()
    const off = api.onBlobReady('b', () => {})
    expect(() => off()).not.toThrow()
  })

  it('corsRule fills the origin and uses the B2 format for B2', () => {
    const s3: BackendConfig & { kind: 's3' } = {
      kind: 's3', provider: 'r2', endpoint: 'https://x.r2.cloudflarestorage.com', region: 'auto', bucket: 'b',
      prefix: 'openstand/', accessKeyId: 'k', secretAccessKey: 's', pathStyle: true,
    }
    expect(JSON.parse(api.corsRule(s3))[0].ExposeHeaders).toContain('ETag')
    expect(JSON.parse(api.corsRule({ ...s3, provider: 'b2' }))[0].corsRuleName).toBe('openstand')
  })

  it('error classes carry codes', () => {
    const e = new BackendError('rateLimited', 'slow', { status: 503, retryAfterMs: 1000 })
    expect([e instanceof Error, e.code, e.status, e.retryAfterMs]).toEqual([true, 'rateLimited', 503, 1000])
    expect(new PairingError('version').code).toBe('version')
    expect(new api.LibSyncFailure('wrongSecret').code).toBe('wrongSecret')
    expect(CHUNK).toBe(1 << 20)
  })

  it('type shapes', () => {
    expectTypeOf<Batch['ops']>().toEqualTypeOf<RecordDelta[]>()
    expectTypeOf<Extract<SyncStateRow, { key: 'cursors' }>['value']>().toEqualTypeOf<SyncStateValues['cursors']>()
    expectTypeOf<StorageBackend['get']>().returns.resolves.toEqualTypeOf<Uint8Array | null>()
    expectTypeOf(api.useLibSync.getState).returns.toEqualTypeOf<api.LibSyncStatus>()
  })
})
