// @vitest-environment node
/**
 * Two devices syncing through a real S3 (MinIO), end to end through the engine (docs/SYNC.md §13).
 * Skipped unless LIBSYNC_S3_ENDPOINT is set (same env vars as minio.e2e.test.ts). Creates the bucket
 * `openstand-e2e-eng-<rand>` and deletes it afterwards.
 */
import 'fake-indexeddb/auto'
import { AwsClient } from 'aws4fetch'
import { afterAll, describe, expect, it } from 'vitest'
import { S3Backend } from '../backends/s3'
import type { S3Config } from '../backends/types'
import { enable, initialUpload, join } from '../join'
import { addSong, bytes, converge, page, pairing, settle, stroke, view, world } from '../sync.test-helper'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const endpoint = env.LIBSYNC_S3_ENDPOINT
const bucket = `openstand-e2e-eng-${Math.random().toString(36).slice(2, 10)}`
const cfg: S3Config = {
  kind: 's3',
  provider: 'minio',
  endpoint: endpoint ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket,
  prefix: 'openstand/',
  accessKeyId: env.LIBSYNC_S3_KEY ?? 'openstand',
  secretAccessKey: env.LIBSYNC_S3_SECRET ?? 'openstand-dev-secret',
  pathStyle: true,
}
const admin = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: cfg.region, retries: 0 })
const bucketUrl = `${cfg.endpoint.replace(/\/+$/, '')}/${bucket}`
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

describe.skipIf(!endpoint)('engine through MinIO', () => {
  afterAll(async () => {
    const b = new S3Backend({ ...cfg, prefix: '' })
    for (;;) {
      const p = await b.list('')
      for (const i of p.items) await b.delete(i.key)
      if (!p.items.length) break
    }
    await admin.fetch(bucketUrl, { method: 'DELETE' })
  })

  it('first device uploads (with a multipart blob), second joins, concurrent edits converge', { timeout: 120_000 }, async () => {
    const res = await admin.fetch(bucketUrl, { method: 'PUT' })
    expect(res.ok).toBe(true)
    const w = world()
    const opts = { now: w.now, isUntouchedDemo: async () => false }
    const A = w.db('A')
    const big = bytes(3, 20 * 1024 * 1024 + 7) // > 16 MiB ciphertext: multipart
    await addSong(A, 's1', 'Big score', { files: [{ id: 'f1', data: big }] })
    await addSong(A, 's2', 'Small', { files: [{ id: 'f2', data: bytes(4, 1000) }] })
    await A.annotations.put(page('s1', 'f1', [stroke('a')]))
    const eA = await enable(A, { ...opts, backendConfig: cfg, relay: null, name: 'E2E' })
    await initialUpload(eA)

    const B = w.db('B')
    const eB = await join(B, await pairing(A), 'here', opts)
    await settle(eB)
    const hash = (await B.songs.get('s1'))!.files[0].blobId
    expect(same(new Uint8Array(await (await B.blobs.get(hash))!.data.arrayBuffer()), big)).toBe(true)

    await A.table('songs').update('s2', { title: 'Small (A)' })
    await B.table('songs').update('s2', { rating: 3 })
    await B.annotations.put(page('s1', 'f1', [stroke('a'), stroke('b')]))
    await converge(eA, eB)
    expect(await view(B)).toEqual(await view(A))
    const s2 = (await A.songs.get('s2'))!
    expect([s2.title, s2.rating]).toEqual(['Small (A)', 3])
  })
})
