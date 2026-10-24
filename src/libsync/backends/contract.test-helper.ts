/**
 * Reusable `StorageBackend` contract suite (docs/SYNC.md §7, §13). Every backend must pass it unchanged:
 * `memory.test.ts` runs it in the normal test run, `e2e/minio.e2e.test.ts` against S3 (MinIO).
 *
 *   backendContract('memory', () => new MemoryBackend(...))
 *
 * All keys live under a random prefix, which is emptied afterwards, so it can run in a shared bucket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BackendError, type ByteSource, type StorageBackend, type UploadState } from './types'

export interface ContractOptions {
  /** Size of the multipart uploads; default 2.5 × `caps.maxSmallPut` (40 MiB on S3). */
  largeSize?: number
  /** Per-test timeout in ms (default 10 s; raise it for real networks). */
  timeout?: number
}

/** Seeded PRNG bytes (mulberry32), so failures are reproducible without a dependency. */
export function prngBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let a = seed >>> 0
  for (let i = 0; i < n; i += 4) {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    t = (t ^ (t >>> 14)) >>> 0
    out[i] = t & 255
    if (i + 1 < n) out[i + 1] = (t >>> 8) & 255
    if (i + 2 < n) out[i + 2] = (t >>> 16) & 255
    if (i + 3 < n) out[i + 3] = t >>> 24
  }
  return out
}

async function digest(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))
  return Array.from(h, (x) => x.toString(16).padStart(2, '0')).join('')
}

const INJECTED = 'injected read failure'

/** A source over `data` that records read offsets and throws on read number `failAt` (1-based). */
function source(data: Uint8Array, failAt?: number) {
  const reads: number[] = []
  const src: ByteSource = {
    size: data.length,
    async read(s, e) {
      reads.push(s)
      if (reads.length === failAt) throw new Error(INJECTED)
      return data.slice(s, e)
    },
  }
  return { src, reads }
}

const enc = (s: string) => new TextEncoder().encode(s)

async function listAll(b: StorageBackend, prefix: string, o: { startAfter?: string; limit?: number } = {}): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < 1000; pages++) {
    const page = await b.list(prefix, { ...o, cursor })
    keys.push(...page.items.map((i) => i.key))
    if (!page.cursor) return keys
    cursor = page.cursor
  }
  throw new Error('list did not terminate')
}

export function backendContract(label: string, make: () => StorageBackend | Promise<StorageBackend>, opts: ContractOptions = {}): void {
  describe(`StorageBackend contract: ${label}`, () => {
    const timeout = opts.timeout ?? 10_000
    let b: StorageBackend
    const root = `contract-${Math.random().toString(36).slice(2, 10)}/`
    const k = (s: string) => root + s

    beforeAll(async () => {
      b = await make()
    }, timeout)

    afterAll(async () => {
      if (!b) return
      for (const key of await listAll(b, root)) await b.delete(key)
    }, timeout * 4)

    it('get and head return null for missing keys; delete is idempotent', async () => {
      expect(await b.get(k('missing'))).toBeNull()
      expect(await b.get(k('missing'), { range: [0, 9] })).toBeNull()
      expect(await b.head(k('missing'))).toBeNull()
      await b.delete(k('missing'))
      await b.put(k('del'), enc('x'))
      await b.delete(k('del'))
      await b.delete(k('del'))
      expect(await b.head(k('del'))).toBeNull()
    }, timeout)

    it('put/get round trip, overwrite, empty bodies, head size and etag', async () => {
      await b.put(k('rt/a'), enc('hello'))
      expect(new TextDecoder().decode((await b.get(k('rt/a')))!)).toBe('hello')
      const h1 = await b.head(k('rt/a'))
      expect(h1).toMatchObject({ key: k('rt/a'), size: 5 })
      expect(h1?.etag).toBeTruthy()
      await b.put(k('rt/a'), enc('bye'))
      expect(new TextDecoder().decode((await b.get(k('rt/a')))!)).toBe('bye')
      expect((await b.head(k('rt/a')))?.size).toBe(3)
      await b.put(k('rt/empty'), new Uint8Array(0))
      expect((await b.get(k('rt/empty')))?.length).toBe(0)
      expect((await b.head(k('rt/empty')))?.size).toBe(0)
      const bin = prngBytes(4099, 7)
      await b.put(k('rt/bin'), bin)
      expect(await digest((await b.get(k('rt/bin')))!)).toBe(await digest(bin))
    }, timeout)

    it('list: key order, prefix, startAfter and pagination', async () => {
      const names = ['0000000010', '0000000002', '0000000001', 'a/x', 'a/y', 'b', 'ab', 'z']
      for (const n of names) await b.put(k(`ls/${n}`), enc(n))
      await b.put(k('ls-sibling'), enc('nope'))
      const sorted = names.map((n) => k(`ls/${n}`)).sort()
      const page = await b.list(k('ls/'), { limit: 1000 })
      expect(page.items.map((i) => i.key)).toEqual(sorted.slice(0, page.items.length))
      expect(page.items.length).toBeGreaterThan(0)
      expect(typeof page.items[0].lastModified).toBe('number')
      expect(await listAll(b, k('ls/'))).toEqual(sorted)
      const b1 = (await b.list(k('ls/b'))).items
      expect(b1.map((i) => [i.key, i.size])).toEqual([[k('ls/b'), 1]])
      expect(await listAll(b, k('ls/'), { limit: 3 })).toEqual(sorted)
      expect(await listAll(b, k('ls/'), { limit: 1 })).toEqual(sorted)
      const after = k('ls/0000000002')
      expect(await listAll(b, k('ls/'), { startAfter: after })).toEqual(sorted.filter((x) => x > after))
      expect(await listAll(b, k('ls/'), { startAfter: after, limit: 2 })).toEqual(sorted.filter((x) => x > after))
      expect(await listAll(b, k('ls/a/'))).toEqual([k('ls/a/x'), k('ls/a/y')])
      expect((await b.list(k('ls/nothing/'))).items).toEqual([])
    }, timeout)

    it('range get is inclusive and clamps at the end', async () => {
      const data = prngBytes(1000, 3)
      await b.put(k('range'), data)
      expect(await b.get(k('range'), { range: [0, 0] })).toEqual(data.slice(0, 1))
      expect(await b.get(k('range'), { range: [10, 19] })).toEqual(data.slice(10, 20))
      expect(await b.get(k('range'), { range: [990, 5000] })).toEqual(data.slice(990))
    }, timeout)

    it('conditional put: 412 -> BackendError("precondition"), object unchanged', async () => {
      await b.put(k('cond'), enc('first'), { ifNoneMatch: true })
      if (!b.caps.conditionalPut) return
      const err = await b.put(k('cond'), enc('second'), { ifNoneMatch: true }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BackendError)
      expect((err as BackendError).code).toBe('precondition')
      expect(new TextDecoder().decode((await b.get(k('cond')))!)).toBe('first')
      await b.put(k('cond'), enc('third'))
      expect(new TextDecoder().decode((await b.get(k('cond')))!)).toBe('third')
    }, timeout)

    it('upload: small sources go up in one piece', async () => {
      const data = prngBytes(777, 5)
      let progress = 0
      await b.upload(k('up/small'), source(data).src, { onProgress: (n) => (progress = n) })
      expect(await b.get(k('up/small'))).toEqual(data)
      expect(progress).toBe(777)
      await b.upload(k('up/zero'), source(new Uint8Array(0)).src, {})
      expect((await b.head(k('up/zero')))?.size).toBe(0)
    }, timeout)

    it('upload: resumes after a failure at every part, without re-sending finished parts', async () => {
      const size = opts.largeSize ?? Math.floor(b.caps.maxSmallPut * 2.5) + 7
      const data = prngBytes(size, 11)
      const want = await digest(data)
      const key = k('up/large')
      let failAt = 1
      for (; ; failAt++) {
        let last: UploadState | undefined
        const onState = async (s: UploadState) => {
          expect(s.key).toBe(key)
          expect(s.size).toBe(size)
          last = structuredClone(s)
        }
        const first = source(data, failAt)
        const err = await b.upload(key, first.src, { onState }).then(() => null, (e: unknown) => e)
        if (err === null) break // failAt is past the last part: every part has been covered
        expect((err as Error).message).toBe(INJECTED)
        expect(last).toBeDefined()
        expect(await b.head(key)).toBeNull()
        const failedAt = first.reads[failAt - 1]
        expect(last!.done).toBe(failedAt)
        const second = source(data)
        let progress = 0
        await b.upload(key, second.src, { state: last, onState, onProgress: (n) => (progress = n) })
        expect(second.reads[0]).toBe(failedAt)
        expect(progress).toBe(size)
        expect(await digest((await b.get(key))!)).toBe(want)
        await b.delete(key)
      }
      expect(failAt - 1).toBeGreaterThanOrEqual(3)
      expect(await digest((await b.get(key))!)).toBe(want)
    }, timeout * 6)

    it('upload: an aborted signal stops it and the upload resumes', async () => {
      const size = opts.largeSize ?? Math.floor(b.caps.maxSmallPut * 2.5) + 7
      const data = prngBytes(size, 13)
      const key = k('up/abort')
      const ac = new AbortController()
      let last: UploadState | undefined
      let states = 0
      const err = await b
        .upload(key, source(data).src, {
          signal: ac.signal,
          onState: async (s) => {
            last = structuredClone(s)
            if (++states === 2) ac.abort()
          },
        })
        .then(() => null, (e: unknown) => e)
      expect(err).toBeTruthy()
      expect(last!.done).toBeGreaterThan(0)
      const again = source(data)
      await b.upload(key, again.src, { state: last })
      expect(again.reads[0]).toBe(last!.done)
      expect(await digest((await b.get(key))!)).toBe(await digest(data))
    }, timeout * 2)

    it('upload: a vanished session (aborted) starts over; a stale state for another key is ignored', async () => {
      const size = opts.largeSize ?? Math.floor(b.caps.maxSmallPut * 2.5) + 7
      const data = prngBytes(size, 17)
      const key = k('up/vanished')
      let last: UploadState | undefined
      const err = await b
        .upload(key, source(data, 2).src, { onState: async (s) => void (last = structuredClone(s)) })
        .then(() => null, (e: unknown) => e)
      expect((err as Error).message).toBe(INJECTED)
      if (b.abortUpload) {
        await b.abortUpload(last!)
        await b.abortUpload(last!) // idempotent
        const fresh = source(data)
        await b.upload(key, fresh.src, { state: last })
        expect(fresh.reads[0]).toBe(0)
        expect(await digest((await b.get(key))!)).toBe(await digest(data))
      }
      const other = source(data)
      await b.upload(k('up/other'), other.src, { state: last })
      expect(other.reads[0]).toBe(0)
      expect(await digest((await b.get(k('up/other')))!)).toBe(await digest(data))
      if (!b.abortUpload) {
        // Finish the first session so nothing is left pending.
        await b.upload(key, source(data).src, { state: last })
      }
    }, timeout * 4)

    it('upload: resuming a session that already completed is a no-op', async () => {
      const size = opts.largeSize ?? Math.floor(b.caps.maxSmallPut * 2.5) + 7
      const data = prngBytes(size, 19)
      const key = k('up/done')
      let last: UploadState | undefined
      await b.upload(key, source(data).src, { onState: async (s) => void (last = structuredClone(s)) })
      const again = source(data)
      await b.upload(key, again.src, { state: last })
      expect(again.reads).toEqual([])
      expect(await digest((await b.get(key))!)).toBe(await digest(data))
    }, timeout * 2)

    it('check() passes and leaves nothing behind', async () => {
      const r = await b.check()
      expect(r.error).toBeUndefined()
      expect(r.ok).toBe(true)
      expect(r.steps.map((s) => s.id)).toEqual(expect.arrayContaining(['list', 'write', 'read', 'range', 'etag', 'conditional', 'delete']))
      expect((await b.list('os1/.check-')).items).toEqual([])
    }, timeout)
  })
}
