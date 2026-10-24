// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenStandDB } from '../db/db'
import { MemoryBackend } from './backends/memory'
import { BlobQueue, LocalQuotaError, queueDownload, queueUpload } from './blobs'
import { blobContext, blobSource, bytesEqual, bytesSource, ciphertextSize, deriveLibraryKeys, encryptChunks, sha256Hex, type LibraryKeys } from './crypto'
import { CHUNK } from './model'
import { blobKey } from './paths'

let n = 0
const fresh = (p: string) => `${p}-${Date.now().toString(36)}-${n++}`

function data(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size)
  let x = seed || 1
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 255
  }
  return out
}

async function setup() {
  const keys = await deriveLibraryKeys(crypto.getRandomValues(new Uint8Array(32)))
  const db = new OpenStandDB(fresh('blobs'))
  const backend = new MemoryBackend(fresh('bucket'), { caps: { maxSmallPut: 4 * CHUNK }, partSize: 2 * (CHUNK + 28), partHead: 16 })
  const errors: unknown[] = []
  const q = new BlobQueue({ db, backend, keys, onError: (e) => errors.push(e) })
  return { keys, db, backend, q, errors }
}

/** What a malicious key holder could store: `content` encrypted under the name of another hash. */
async function plant(keys: LibraryKeys, backend: MemoryBackend, claimed: string, content: Uint8Array) {
  const ctx = await blobContext(keys, claimed)
  const src = encryptChunks(keys, bytesSource(content), ctx)
  await backend.upload(blobKey(keys.libraryId, ctx.name), src, {})
}

describe('blob downloads verify the content hash at every size', () => {
  for (const size of [1000, 33 * CHUNK + 5]) {
    it(`rejects mismatching content (${size} bytes) and stores nothing`, async () => {
      const { keys, db, backend, q, errors } = await setup()
      const real = data(size, 3)
      const claimed = await sha256Hex(data(size, 4))
      await plant(keys, backend, claimed, real)
      await db.transaction('rw', db.syncTransfers, () => queueDownload(db, claimed, size, 'application/pdf'))
      await q.start()
      await q.idle()
      q.stop()
      expect(await db.blobs.count()).toBe(0)
      expect(await db.syncChunks.count()).toBe(0)
      const row = await db.syncTransfers.get(['down', claimed])
      expect(row?.state).toBe('failed')
      expect(row?.error).toMatch(/hash mismatch/)
      expect(errors).toHaveLength(1)
    })
  }

  it('stores matching content', async () => {
    const { keys, db, backend, q } = await setup()
    const real = data(3 * CHUNK + 9, 5)
    const hash = await sha256Hex(real)
    await plant(keys, backend, hash, real)
    await db.transaction('rw', db.syncTransfers, () => queueDownload(db, hash, real.length, 'application/pdf'))
    await q.start()
    await q.idle()
    q.stop()
    const rec = await db.blobs.get(hash)
    expect(rec?.size).toBe(real.length)
    expect(await sha256Hex(rec!.data)).toBe(hash)
  })
})

describe('blob uploads', () => {
  it('never upload a local row whose content does not match its hash', async () => {
    const { db, backend, q } = await setup()
    const claimed = await sha256Hex(data(500, 1))
    const body = data(500, 2)
    await db.blobs.put({ id: 'legacy-1', hash: claimed, mime: 'application/pdf', size: body.length, data: new Blob([body]) })
    await db.transaction('rw', db.syncTransfers, () => queueUpload(db, claimed, body.length, 'application/pdf'))
    await q.start()
    await q.idle()
    q.stop()
    expect(backend.calls.some((c) => c.op === 'put' || c.op === 'uploadPart')).toBe(false)
    const row = await db.syncTransfers.get(['up', claimed])
    expect(row?.state).toBe('failed')
    expect(row?.error).toMatch(/does not match its hash/)
  })

  it('skips an identical remote object, and replaces a same-size object with other content', async () => {
    const { keys, db, backend, q } = await setup()
    const body = data(2 * CHUNK + 3, 8)
    const hash = await sha256Hex(body)
    await db.blobs.put({ id: hash, hash, mime: 'application/pdf', size: body.length, data: new Blob([body]) })
    const ctx = await blobContext(keys, hash)
    const key = blobKey(keys.libraryId, ctx.name)
    const ours = encryptChunks(keys, blobSource(new Blob([body])), ctx)
    const run = async () => {
      await db.transaction('rw', db.syncTransfers, () => queueUpload(db, hash, body.length, 'application/pdf'))
      backend.calls.length = 0
      await q.start()
      await q.idle()
      return backend.calls.filter((c) => c.op === 'put' || c.op === 'uploadCreate').length
    }
    // Same size, different bytes (a v1 leftover, or another writer's content): uploaded over.
    await backend.put(key, new Uint8Array(ciphertextSize(body.length)))
    expect(await run()).toBe(1)
    expect(bytesEqual((await backend.get(key))!, await ours.read(0, ours.size))).toBe(true)
    // Now identical: one HEAD and one 28-byte GET, nothing written.
    expect(await run()).toBe(0)
    expect(backend.calls.filter((c) => c.op === 'get')).toHaveLength(1)
    q.stop()
  })
})

describe('local space', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is checked per blob from its real size: inflated claims block nothing, a blob that does not fit fails alone', async () => {
    const { keys, db, backend, q, errors } = await setup()
    const RESERVE = 200 * 1024 * 1024
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: RESERVE + 2 * CHUNK, usage: 0 }) } })
    const small = data(1000, 1)
    const big = data(3 * CHUNK, 2)
    const lying = data(2000, 3)
    const h = await Promise.all([small, big, lying].map((d) => sha256Hex(d)))
    for (const [i, d] of [small, big, lying].entries()) await plant(keys, backend, h[i], d)
    await db.transaction('rw', db.syncTransfers, async () => {
      await queueDownload(db, h[0], small.length, 'application/pdf')
      await queueDownload(db, h[1], big.length, 'application/pdf')
      await queueDownload(db, h[2], 4 * 2 ** 40, 'application/pdf') // claims 4 TiB, really 2000 bytes
    })
    await q.start()
    await q.idle()
    q.stop()
    expect(await db.blobs.get(h[0])).toBeTruthy()
    expect(await db.blobs.get(h[2])).toBeTruthy()
    expect(await db.blobs.get(h[1])).toBeUndefined()
    expect((await db.syncTransfers.get(['down', h[1]]))?.state).toBe('queued')
    expect(errors.some((e) => e instanceof LocalQuotaError)).toBe(true)
  })
})
