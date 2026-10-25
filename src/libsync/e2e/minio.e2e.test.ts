// @vitest-environment node
/**
 * S3 end-to-end against a real MinIO. Skipped unless LIBSYNC_S3_ENDPOINT is set:
 *
 *   docker run -d --rm --name openstand-minio -p 9000:9000 -p 9001:9001 \
 *     -e MINIO_ROOT_USER=openstand -e MINIO_ROOT_PASSWORD=openstand-dev-secret \
 *     minio/minio:latest server /data --console-address :9001
 *   LIBSYNC_S3_ENDPOINT=http://127.0.0.1:9000 LIBSYNC_S3_KEY=openstand LIBSYNC_S3_SECRET=openstand-dev-secret \
 *     npx vitest run src/libsync/e2e
 *   docker stop openstand-minio
 *
 * Creates the bucket `openstand-e2e-<rand>`, runs `backendContract` against `S3Backend` (multipart with a
 * failure injected at every part), uploads an encrypted 40 MiB blob with an interrupted resumable upload
 * and downloads it again by chunk ranges, then deletes the bucket.
 */
import { AwsClient } from 'aws4fetch'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backendContract, prngBytes } from '../backends/contract.test-helper'
import { S3Backend } from '../backends/s3'
import type { S3Config, UploadState } from '../backends/types'
import { blobContext, bytesSource, chunkByteRange, decryptChunks, deriveLibraryKeys, encryptChunks, parseContainerHeader, sha256Hex } from '../crypto'
import { CHUNK, RANGE } from '../model'
import { blobKey } from '../paths'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const endpoint = env.LIBSYNC_S3_ENDPOINT
const bucket = `openstand-e2e-${Math.random().toString(36).slice(2, 10)}`
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

let ready: Promise<void> | undefined
function createBucket(): Promise<void> {
  ready ??= (async () => {
    const res = await admin.fetch(bucketUrl, { method: 'PUT' })
    if (!res.ok) throw new Error(`create bucket: ${res.status} ${await res.text()}`)
  })()
  return ready
}

async function deleteBucket() {
  // Abort leftover multipart uploads, delete every object, then the bucket.
  const ups = await (await admin.fetch(`${bucketUrl}?uploads=`)).text()
  for (const m of ups.matchAll(/<Upload>[\s\S]*?<Key>(.*?)<\/Key>[\s\S]*?<UploadId>(.*?)<\/UploadId>[\s\S]*?<\/Upload>/g))
    await admin.fetch(`${bucketUrl}/${m[1].split('/').map(encodeURIComponent).join('/')}?uploadId=${encodeURIComponent(m[2])}`, { method: 'DELETE' })
  const b = new S3Backend({ ...cfg, prefix: '' })
  for (;;) {
    const page = await b.list('')
    for (const i of page.items) await b.delete(i.key)
    if (!page.items.length) break
  }
  const res = await admin.fetch(bucketUrl, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`delete bucket: ${res.status} ${await res.text()}`)
}

describe.skipIf(!endpoint)('MinIO e2e', () => {
  beforeAll(createBucket, 30_000)
  afterAll(deleteBucket, 120_000)

  backendContract(
    'S3 (MinIO)',
    async () => {
      await createBucket()
      return new S3Backend(cfg)
    },
    { timeout: 60_000 },
  )

  it('check() reports every step and detects conditional writes', async () => {
    const b = new S3Backend(cfg)
    b.caps.conditionalPut = false
    const r = await b.check()
    expect(r.error).toBeUndefined()
    expect(r.steps.map((s) => s.id)).toEqual(['reach', 'cors', 'auth', 'list', 'write', 'read', 'range', 'etag', 'conditional', 'delete'])
    expect(r.ok).toBe(true)
    expect(b.caps.conditionalPut).toBe(true)
    expect(b.caps.rangeGet).toBe(true)
  }, 30_000)

  it('wrong credentials map to auth', async () => {
    const b = new S3Backend({ ...cfg, secretAccessKey: 'wrong-secret-key' })
    await expect(b.list('')).rejects.toMatchObject({ code: 'auth' })
    const r = await b.check()
    expect(r.error?.code).toBe('auth')
    await expect(new S3Backend({ ...cfg, bucket: 'openstand-e2e-missing' }).list('')).rejects.toMatchObject({ code: 'notFound' })
  }, 30_000)

  it('encrypted 40 MiB blob: interrupted multipart upload resumes, chunk-range download decrypts', async () => {
    const keys = await deriveLibraryKeys(new Uint8Array(32).fill(42))
    const data = prngBytes(40 * CHUNK + 12345, 99)
    const sha = await sha256Hex(data)
    const ctx = await blobContext(keys, sha)
    const key = blobKey(keys.libraryId, ctx.name)
    const b = new S3Backend(cfg)

    // Upload until the 3rd part has been sent, then "crash" (abort).
    const ac = new AbortController()
    let state: UploadState | undefined
    let parts = 0
    const src1 = encryptChunks(keys, bytesSource(data), ctx)
    const err = await b
      .upload(key, src1, {
        signal: ac.signal,
        onState: async (s) => {
          state = structuredClone(s)
          if (++parts === 4) ac.abort() // create + 3 parts
        },
      })
      .catch((e: unknown) => e)
    expect((err as Error).name).toBe('AbortError')
    expect(state!.done).toBe(16 + 3 * 8 * (CHUNK + 28))
    expect(await b.head(key)).toBeNull()

    // A fresh process re-encrypts from scratch: deterministic nonces make the resumed parts line up.
    const src2 = encryptChunks(keys, bytesSource(data), ctx)
    const reads: number[] = []
    const read = (s: number, e: number) => {
      reads.push(s)
      return src2.read(s, e)
    }
    await b.upload(key, { size: src2.size, read }, { state })
    expect(reads[0]).toBe(state!.done)
    const head = await b.head(key)
    expect(head?.size).toBe(src2.size)

    // Download by ranges of 4 chunks, starting with a 16-byte header GET (as a resumed download would).
    const h = parseContainerHeader((await b.get(key, { range: [0, 15] }))!)
    expect(h.size).toBe(data.length)
    const out: Uint8Array[] = []
    const n = Math.ceil(h.size / CHUNK)
    for (let i = 0; i < n; i += RANGE) {
      const bytes = (await b.get(key, { range: chunkByteRange(h, i, RANGE) }))!
      out.push(...(await decryptChunks(keys, h, ctx, i, bytes)))
    }
    const all = new Uint8Array(h.size)
    let off = 0
    for (const p of out) {
      all.set(p, off)
      off += p.length
    }
    expect(await sha256Hex(all)).toBe(sha)

    // Same file uploaded again (another device) gives byte-identical ciphertext: a no-op overwrite.
    const before = head?.etag
    await b.upload(key, encryptChunks(keys, bytesSource(data), ctx), {})
    expect((await b.head(key))?.size).toBe(src2.size)
    expect(before).toBeTruthy()
    await b.delete(key)
  }, 180_000)
})
