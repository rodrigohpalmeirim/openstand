// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { backendContract, prngBytes } from './contract.test-helper'
import { DRIVE, FOLDER_MIME, GDriveFake, UPLOAD, isList, parseQuery, queryOf, type GDriveFakeOptions } from './fakes/gdrive.fake'
import { GDriveBackend, canonicalOrder, ensureRootFolder, gdriveError, qstr, type GDriveOptions } from './gdrive'
import { BackendError, type ByteSource, type GDriveConfig, type UploadState } from './types'

const KiB = 1024
const CHUNK = 256 * KiB
const OPTS: GDriveOptions = { chunk: CHUNK, maxSmallPut: 512 * KiB }

const fakes: GDriveFake[] = []
afterEach(() => {
  for (const f of fakes) f.verify()
})

/** A fake with the OpenStand folder, and backends on it (each with its own sign-in). */
function setup(o: GDriveFakeOptions = {}, bo: GDriveOptions = OPTS) {
  const fake = new GDriveFake(o)
  fakes.push(fake)
  const folder = fake.createFolder({ appProperties: { openstand: 'root' } })
  const cfg: GDriveConfig = { kind: 'gdrive', folder, account: 'rod@example.com', accountId: fake.user.permissionId }
  const auth = fake.auth()
  const b = new GDriveBackend(cfg, { fetch: fake.fetch, auth }, bo)
  const another = (opts: GDriveOptions = bo) => new GDriveBackend(cfg, { fetch: fake.fetch, auth: fake.auth() }, opts)
  return { fake, folder, cfg, auth, b, another }
}

/** A clock that advances 1 ms per reading, so creation order decides `createdTime`. */
function ticking(start = Date.UTC(2026, 9, 25)) {
  let t = start
  return () => t++
}

const enc = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
/** Byte equality without vitest's slow element-wise diff on large arrays. */
const sameBytes = (a: Uint8Array | null | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i])
const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as BackendError)

function source(data: Uint8Array, failAt?: number) {
  const reads: number[] = []
  const src: ByteSource = {
    size: data.length,
    async read(s, e) {
      reads.push(s)
      if (reads.length === failAt) throw new Error('injected read failure')
      return data.slice(s, e)
    },
  }
  return { src, reads }
}

const LIB = 'os1/01jabcdefghjkmnpqrstvwxyz0'
const sessionPuts = (fake: GDriveFake) => fake.calls.filter((c) => c.method === 'PUT' && c.url.includes('upload_id='))

backendContract('gdrive (fake)', () => setup().b)
backendContract('gdrive (fake; Location hidden, 2-file pages, ticking clock)', () => setup({ hideLocation: true, pageSize: 2, now: ticking() }).b)

describe('gdrive: fake server rules', () => {
  it('parses the q subset with escapes and refuses the rest', () => {
    const f = { id: 'x', name: "it's \\ odd", mimeType: 'a', parents: ['P'], appProperties: { d1: 'os1' }, data: new Uint8Array(0), version: 1, createdTime: 0, modifiedTime: 0, trashed: false, indexedAt: 0 }
    expect(parseQuery(`'P' in parents and name = ${qstr(f.name)} and trashed = false`)(f)).toBe(true)
    expect(parseQuery(`appProperties has { key='d1' and value='os1' }`)(f)).toBe(true)
    expect(parseQuery(`appProperties has { key='d1' and value='os2' }`)(f)).toBe(false)
    expect(() => parseQuery(`name contains 'x'`)).toThrow()
    expect(() => parseQuery(`name = "x"`)).toThrow()
    expect(() => parseQuery(`'P' in parents or trashed = false`)).toThrow()
  })

  it('canonical order: earliest createdTime, then the lowest id', () => {
    const a = { id: 'b', createdTime: '2026-10-25T10:00:00.000Z' }
    const b = { id: 'a', createdTime: '2026-10-25T10:00:00.001Z' }
    const c = { id: 'a', createdTime: '2026-10-25T10:00:00.000Z' }
    expect([b, a, c].sort(canonicalOrder)).toEqual([c, a, b])
  })
})

describe('gdrive: layout', () => {
  it('stores each key as one flat file named with the key, with os and d1..d3 appProperties', async () => {
    const { fake, folder, b } = setup()
    await b.put(`${LIB}/heads/dev1/0000000001`, new Uint8Array(0))
    await b.put(`${LIB}/meta`, enc('m'))
    await b.put('top', enc('t'))
    const [head] = fake.named(`${LIB}/heads/dev1/0000000001`)
    expect(head.parents).toEqual([folder])
    expect(head.appProperties).toEqual({ os: '1', d1: 'os1', d2: LIB, d3: `${LIB}/heads` })
    expect(fake.named(`${LIB}/meta`)[0].appProperties).toEqual({ os: '1', d1: 'os1', d2: LIB })
    expect(fake.named('top')[0].appProperties).toEqual({ os: '1' })
    expect([...fake.files.values()].filter((f) => f.mimeType === FOLDER_MIME)).toHaveLength(1)
  })

  it('polling heads/ is one exact-match query; the root prefix uses the os marker', async () => {
    const { fake, folder, b, another } = setup()
    for (const d of ['dev1', 'dev2', 'dev3']) await b.put(`${LIB}/heads/${d}/0000000007`, new Uint8Array(0))
    await b.put(`${LIB}/log/dev1/0000000007`, enc('x'))
    const reader = another()
    const before = fake.calls.length
    const page = await reader.list(`${LIB}/heads/`)
    expect(page.items.map((i) => i.key)).toEqual(['dev1', 'dev2', 'dev3'].map((d) => `${LIB}/heads/${d}/0000000007`))
    expect(page.cursor).toBeUndefined()
    const calls = fake.calls.slice(before)
    expect(calls).toHaveLength(1)
    expect(queryOf(calls[0].url)).toBe(`'${folder}' in parents and appProperties has { key='d3' and value='${LIB}/heads' } and trashed = false`)
    await reader.list('')
    expect(queryOf(fake.calls[fake.calls.length - 1].url)).toBe(`'${folder}' in parents and appProperties has { key='os' and value='1' } and trashed = false`)
    expect((await reader.list('')).items).toHaveLength(4)
    // Deeper than three segments still lists the depth-3 folder, then filters.
    expect((await reader.list(`${LIB}/heads/dev2/`)).items.map((i) => i.key)).toEqual([`${LIB}/heads/dev2/0000000007`])
  })

  it('follows pageToken and returns one sorted page', async () => {
    const { fake, b, another } = setup({ pageSize: 3 })
    const keys = Array.from({ length: 10 }, (_, i) => `${LIB}/blobs/b${String(9 - i).padStart(2, '0')}`)
    for (const k of keys) await b.put(k, enc(k))
    const before = fake.calls.filter(isList).length
    const page = await another().list(`${LIB}/blobs/`, { startAfter: `${LIB}/blobs/b03` })
    expect(page.items.map((i) => i.key)).toEqual([...keys].sort().filter((k) => k > `${LIB}/blobs/b03`))
    expect(fake.calls.filter(isList).length - before).toBe(4)
    expect(page.items[0]).toMatchObject({ size: page.items[0].key.length, etag: '1' })
  })

  it('refuses keys outside [a-z0-9./-]', async () => {
    const { b } = setup()
    for (const k of ['A/b', 'a//b', '/a', 'a~b', 'a/b.', "a'b"]) {
      expect(await errOf(b.put(k, enc('x')))).toMatchObject({ code: 'unknown', providerCode: 'BadKey' })
      expect(await errOf(b.get(k))).toMatchObject({ providerCode: 'BadKey' })
    }
  })
})

describe('gdrive: duplicates', () => {
  it('two devices creating the same key at once converge on the earliest copy; the loser deletes its own', async () => {
    const { fake, another } = setup({ now: ticking() })
    const [a, b] = [another(), another()]
    const key = `${LIB}/blobs/abc`
    fake.raceCreates(key)
    await Promise.all([a.put(key, enc('same')), b.put(key, enc('same'))])
    const copies = fake.created.filter((f) => f.name === key)
    expect(copies).toHaveLength(2)
    const [first, second] = copies
    expect(fake.named(key).map((f) => f.id)).toEqual([first.id])
    expect(fake.deleted).toEqual([second.id])
    // Exactly one DELETE, sent by the device whose copy lost.
    const deletes = fake.calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    const creates = fake.calls.filter((c) => c.method === 'POST' && c.url.startsWith(UPLOAD))
    expect(creates.map((c) => c.headers.authorization)).toEqual(['Bearer tok-2', 'Bearer tok-3'])
    expect(deletes[0].headers.authorization).toBe(creates[1].headers.authorization)
    for (const r of [a, b, another()]) {
      expect(text(await r.get(key))).toBe('same')
      expect((await r.head(key))?.etag).toBe(String(first.version))
      expect((await r.list(`${LIB}/blobs/`)).items).toHaveLength(1)
    }
  })

  it('meta with ifNoneMatch under a race: exactly one success, the other gets precondition', async () => {
    const { fake, another } = setup({ now: ticking() })
    const [a, b] = [another(), another()]
    const key = `${LIB}/meta`
    fake.raceCreates(key)
    const res = await Promise.allSettled([a.put(key, enc('from a'), { ifNoneMatch: true }), b.put(key, enc('from b'), { ifNoneMatch: true })])
    expect(res.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = res.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'precondition' })
    const winner = res[0].status === 'fulfilled' ? 'from a' : 'from b'
    expect(fake.named(key)).toHaveLength(1)
    expect(text(fake.named(key)[0].data)).toBe(winner)
    for (const r of [a, b, another()]) expect(text(await r.get(key))).toBe(winner)
  })

  it('a createdTime tie goes to the lowest id', async () => {
    const t = Date.UTC(2026, 9, 25)
    const { fake, another } = setup({ now: () => t })
    const [a, b] = [another(), another()]
    const key = `${LIB}/log/dev1/0000000001`
    fake.raceCreates(key)
    const res = await Promise.allSettled([a.put(key, enc('a'), { ifNoneMatch: true }), b.put(key, enc('b'), { ifNoneMatch: true })])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const ids = fake.created.filter((f) => f.name === key).map((f) => f.id)
    expect(ids).toHaveLength(2)
    expect(fake.named(key).map((f) => f.id)).toEqual([[...ids].sort()[0]])
  })

  it('with a lagging index both copies survive the race, and every reader still picks the same one', async () => {
    const { fake, another } = setup({ now: ticking(), indexLag: 5 })
    const [a, b] = [another(), another()]
    const key = `${LIB}/devices/dev1`
    fake.raceCreates(key)
    await Promise.all([a.put(key, enc('A')), b.put(key, enc('B'))])
    expect(fake.named(key)).toHaveLength(2)
    const want = text(fake.named(key)[0].data)
    fake.indexLag = 0
    for (let i = 0; i < 6; i++) await another().list('')
    for (let i = 0; i < 3; i++) {
      const r = another()
      expect(text(await r.get(key))).toBe(want)
      expect((await r.list(`${LIB}/devices/`)).items).toHaveLength(1)
    }
    // Deleting removes every copy.
    await another().delete(key)
    expect(fake.named(key)).toHaveLength(0)
  })

  it('overwrites update the canonical copy in place and leave later duplicates alone', async () => {
    const { fake, folder, b, another } = setup({ now: ticking() })
    const key = `${LIB}/devices/dev1`
    await b.put(key, enc('v1'))
    const canonical = fake.named(key)[0]
    const dup = fake.addFile({ name: key, parent: folder, data: enc('stray'), appProperties: { os: '1', d1: 'os1', d2: LIB, d3: `${LIB}/devices` } })
    const c = another()
    await c.put(key, enc('v2'))
    expect(fake.named(key).map((f) => f.id)).toEqual([canonical.id, dup.id])
    expect(text(canonical.data)).toBe('v2')
    expect(canonical.version).toBe(2)
    expect(text(dup.data)).toBe('stray')
    expect(text(await b.get(key))).toBe('v2')
    expect(text(await another().get(key))).toBe('v2')
    expect((await another().list(`${LIB}/devices/`)).items).toEqual([expect.objectContaining({ key, size: 2, etag: '2' })])
  })

  it('an earlier duplicate is the canonical one: readers and overwrites use it', async () => {
    const { fake, folder, b, another } = setup({ now: ticking(Date.UTC(2026, 9, 25, 12)) })
    const key = `${LIB}/snap/dev1/0000000001`
    await b.put(key, enc('mine'))
    const early = fake.addFile({ name: key, parent: folder, data: enc('older'), createdTime: Date.UTC(2026, 9, 25, 11), appProperties: { os: '1', d1: 'os1', d2: LIB, d3: `${LIB}/snap` } })
    const c = another()
    expect(text(await c.get(key))).toBe('older')
    expect(await errOf(c.put(key, enc('x'), { ifNoneMatch: true }))).toMatchObject({ code: 'precondition' })
    await c.put(key, enc('new'))
    expect(text(early.data)).toBe('new')
    expect(text(fake.named(key)[1].data)).toBe('mine')
  })

  it('delete removes every copy, including our own not-yet-indexed one', async () => {
    const { fake, folder, b } = setup({ now: ticking() })
    const key = `${LIB}/blobs/dup`
    await b.put(key, enc('1'))
    fake.addFile({ name: key, parent: folder, data: enc('1') })
    fake.addFile({ name: key, parent: folder, data: enc('1') })
    fake.indexLag = 10
    await b.put(`${LIB}/blobs/fresh`, enc('2'))
    await b.delete(key)
    await b.delete(`${LIB}/blobs/fresh`)
    expect(fake.named(key)).toHaveLength(0)
    expect(fake.named(`${LIB}/blobs/fresh`)).toHaveLength(0)
    expect(await b.get(`${LIB}/blobs/fresh`)).toBeNull()
  })
})

describe('gdrive: index lag', () => {
  it("our own writes read back at once (cache); another instance's reads hold back, then succeed", async () => {
    const { fake, b, another } = setup({ indexLag: 3 })
    const key = `${LIB}/log/dev1/0000000001`
    await b.put(key, enc('batch'), { ifNoneMatch: true })
    expect(text(await b.get(key))).toBe('batch')
    expect(await b.head(key)).toMatchObject({ key, size: 5 })
    expect(await errOf(b.put(key, enc('again'), { ifNoneMatch: true }))).toMatchObject({ code: 'precondition' })
    const c = another()
    const seen: (string | null)[] = []
    for (let i = 0; i < 5; i++) seen.push(text(await c.get(key)))
    expect(seen[0]).toBeNull()
    expect(seen[seen.length - 1]).toBe('batch')
    expect(fake.named(key)).toHaveLength(1)
  })

  it('a cached id deleted elsewhere: get and head re-resolve; a re-created file is found', async () => {
    const { fake, folder, b } = setup()
    const key = `${LIB}/blobs/x`
    await b.put(key, enc('one'))
    fake.remove(fake.named(key)[0].id)
    expect(await b.get(key)).toBeNull()
    await b.put(key, enc('two'))
    fake.remove(fake.named(key)[0].id)
    expect(await b.head(key)).toBeNull()
    fake.addFile({ name: key, parent: folder, data: enc('three') })
    expect(text(await b.get(key))).toBe('three')
    await b.put(key, enc('four'))
    fake.remove(fake.named(key)[0].id)
    // An overwrite of a vanished file creates it again.
    await b.put(key, enc('five'))
    expect(fake.named(key).map((f) => text(f.data))).toEqual(['five'])
  })
})

describe('gdrive: resumable uploads', () => {
  const SIZE = 5 * CHUNK + 123

  it('persists the session before the first read, sends 256 KiB-multiple chunks with Content-Range and auth', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 1)
    const events: string[] = []
    const src: ByteSource = {
      size: SIZE,
      async read(s, e) {
        events.push(`read ${s}`)
        return data.slice(s, e)
      },
    }
    const states: UploadState[] = []
    await b.upload(`${LIB}/blobs/big`, src, {
      onState: async (s) => {
        events.push(`state ${s.done}`)
        states.push(structuredClone(s))
      },
    })
    expect(events[0]).toBe('state 0')
    expect(states[0]).toMatchObject({ v: 1, backend: b.id, key: `${LIB}/blobs/big`, size: SIZE, done: 0 })
    expect((states[0].session as { uri: string }).uri.startsWith(`${UPLOAD}/files?uploadType=resumable`)).toBe(true)
    expect(states.map((s) => s.done)).toEqual([0, 1, 2, 3, 4, 5].map((i) => i * CHUNK))
    const puts = sessionPuts(fake)
    expect(puts.map((c) => c.headers['content-range'])).toEqual([
      ...[0, 1, 2, 3, 4].map((i) => `bytes ${i * CHUNK}-${(i + 1) * CHUNK - 1}/${SIZE}`),
      `bytes ${5 * CHUNK}-${SIZE - 1}/${SIZE}`,
    ])
    expect(puts.every((c) => c.headers.authorization?.startsWith('Bearer '))).toBe(true)
    expect(sameBytes(fake.named(`${LIB}/blobs/big`)[0].data, data)).toBe(true)
  })

  for (const after of [true, false]) {
    it(`resumes after a dropped chunk at every chunk (${after ? 'response lost after the server stored it' : 'request lost'})`, async () => {
      const { fake, b } = setup()
      const data = prngBytes(SIZE, 2)
      for (let chunk = 1; chunk <= 6; chunk++) {
        const key = `${LIB}/blobs/c${chunk}${after ? 'a' : 'b'}`
        let last: UploadState | undefined
        let n = 0
        const err = await errOf(
          b.upload(key, source(data).src, {
            onState: async (s) => {
              last = structuredClone(s)
              // State n+1 follows chunk n: drop the next chunk.
              if (++n === chunk) fake.fail({ method: 'PUT', path: /upload_id=/, after, network: true })
            },
          }),
        )
        expect(err).toMatchObject({ code: 'network' })
        expect(last!.done).toBe((chunk - 1) * CHUNK)
        const again = source(data)
        let progress = 0
        await b.upload(key, again.src, { state: last, onState: async (s) => void (last = structuredClone(s)), onProgress: (p) => (progress = p) })
        // The server's offset wins: a chunk it stored is never read again.
        const stored = after ? Math.min(chunk * CHUNK, SIZE) : (chunk - 1) * CHUNK
        if (stored === SIZE) expect(again.reads).toEqual([])
        else expect(again.reads[0]).toBe(stored)
        expect(progress).toBe(SIZE)
        expect(fake.named(key)).toHaveLength(1)
        expect(sameBytes(await b.get(key), data)).toBe(true)
      }
    })
  }

  it('a lost session (404 on the session URI) starts over, persisting the new session first', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 3)
    const key = `${LIB}/blobs/lost`
    let last: UploadState | undefined
    await errOf(b.upload(key, source(data, 3).src, { onState: async (s) => void (last = structuredClone(s)) }))
    expect(last!.done).toBe(2 * CHUNK)
    const oldUri = (last!.session as { uri: string }).uri
    fake.expireSessions()
    const states: UploadState[] = []
    const again = source(data)
    await b.upload(key, again.src, { state: last, onState: async (s) => void states.push(structuredClone(s)) })
    expect(again.reads[0]).toBe(0)
    expect(states[0].done).toBe(0)
    expect((states[0].session as { uri: string }).uri).not.toBe(oldUri)
    expect(sameBytes(await b.get(key), data)).toBe(true)
  })

  it('a session that vanishes mid-upload restarts once within the call', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 4)
    const key = `${LIB}/blobs/mid`
    const uris = new Set<string>()
    let n = 0
    const src = source(data)
    await b.upload(key, src.src, {
      onState: async (s) => {
        uris.add((s.session as { uri: string }).uri)
        if (++n === 3) fake.fail({ method: 'PUT', path: /upload_id=/, respond: { status: 404, text: 'Not Found' } })
      },
    })
    expect(uris.size).toBe(2)
    expect(src.reads.slice(0, 4)).toEqual([0, CHUNK, 2 * CHUNK, 0])
    expect(sameBytes(await b.get(key), data)).toBe(true)
    // Two restarts in a row give up rather than loop.
    const err = await errOf(
      b.upload(`${LIB}/blobs/mid2`, source(data).src, {
        onState: async () => void fake.fail({ method: 'PUT', path: /upload_id=/, respond: { status: 404, text: 'Not Found' } }),
      }),
    )
    expect(err).toMatchObject({ code: 'notFound' })
  })

  it('the server keeping fewer bytes than sent: its offset wins', async () => {
    const { fake, b } = setup({}, { chunk: 4 * CHUNK, maxSmallPut: 512 * KiB })
    const size = 10 * CHUNK + 5
    const data = prngBytes(size, 5)
    fake.shortenWrites(2)
    const src = source(data)
    await b.upload(`${LIB}/blobs/short`, src.src, {})
    expect(src.reads).toEqual([0, 2 * CHUNK, 4 * CHUNK, 8 * CHUNK])
    expect(sameBytes(await b.get(`${LIB}/blobs/short`), data)).toBe(true)
  })

  it('without a readable Location it uses X-GUploader-UploadID; with neither it fails clearly', async () => {
    const { fake, b } = setup({ hideLocation: true })
    const data = prngBytes(SIZE, 6)
    let uri = ''
    await b.upload(`${LIB}/blobs/noloc`, source(data).src, { onState: async (s) => void (uri = (s.session as { uri: string }).uri) })
    expect(uri).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable&fields=[^&]+&upload_id=up/)
    expect(sameBytes(await b.get(`${LIB}/blobs/noloc`), data)).toBe(true)
    fake.fail({ method: 'POST', path: /uploadType=resumable/, respond: { status: 200, text: '' } })
    expect(await errOf(b.upload(`${LIB}/blobs/none`, source(data).src, {}))).toMatchObject({ code: 'cors', providerCode: 'NoUploadSession' })
  })

  it("never sends the token to a session URI that isn't Drive's", async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 7)
    const key = `${LIB}/blobs/evil`
    const state: UploadState = { v: 1, backend: b.id, key, size: SIZE, createdAt: Date.now(), done: CHUNK, session: { uri: 'https://evil.example/upload?upload_id=x', chunk: CHUNK, create: true } }
    const src = source(data)
    await b.upload(key, src.src, { state })
    expect(src.reads[0]).toBe(0)
    expect(fake.calls.every((c) => c.url.startsWith('https://www.googleapis.com/'))).toBe(true)
  })

  it('uploading over an existing key updates it in place', async () => {
    const { fake, b, another } = setup()
    const key = `${LIB}/snap/dev1/0000000002`
    await b.put(key, enc('small'))
    const id = fake.named(key)[0].id
    const data = prngBytes(SIZE, 8)
    await another().upload(key, source(data).src, {})
    expect(fake.named(key).map((f) => f.id)).toEqual([id])
    expect(sameBytes(fake.named(key)[0].data, data)).toBe(true)
    expect(fake.calls.some((c) => c.method === 'PATCH' && c.url.startsWith(`${UPLOAD}/files/${id}?uploadType=resumable`))).toBe(true)
  })

  it('puts above the multipart limit go as one-chunk resumable sessions (create and update)', async () => {
    const { fake, b } = setup({}, { ...OPTS, multipartMax: 1000 })
    const key = `${LIB}/log/dev1/0000000009`
    await b.put(key, prngBytes(3000, 9), { ifNoneMatch: true })
    await b.put(key, prngBytes(2500, 10))
    expect(fake.named(key)[0].data).toEqual(prngBytes(2500, 10))
    expect(fake.calls.filter((c) => c.url.includes('uploadType=multipart') || c.url.includes('uploadType=media'))).toEqual([])
    expect(sessionPuts(fake).map((c) => c.headers['content-range'])).toEqual(['bytes 0-2999/3000', 'bytes 0-2499/2500'])
  })

  it('a 401 in the middle refreshes once and carries on', async () => {
    const { fake, b, auth } = setup()
    const data = prngBytes(SIZE, 11)
    let n = 0
    await b.upload(`${LIB}/blobs/refresh`, source(data).src, { onState: async () => void (++n === 3 && auth.expireNow()) })
    expect(auth.refreshes).toBe(1)
    expect(sameBytes(fake.named(`${LIB}/blobs/refresh`)[0].data, data)).toBe(true)
  })
})

describe('gdrive: errors', () => {
  const R = (status: number, reason?: string, headers: Record<string, string> = {}) =>
    new Response(reason ? JSON.stringify({ error: { code: status, message: 'm', errors: [{ domain: 'usageLimits', reason, message: 'm' }] } }) : 'oops', { status, headers })
  const map = async (res: Response) => gdriveError(res, await res.text())

  it('maps Drive answers to backend errors', async () => {
    const table: [Response, string, string?][] = [
      [R(403, 'userRateLimitExceeded'), 'rateLimited', 'userRateLimitExceeded'],
      [R(403, 'rateLimitExceeded'), 'rateLimited', 'rateLimitExceeded'],
      [R(429, 'rateLimitExceeded'), 'rateLimited'],
      [R(429), 'rateLimited'],
      [R(403, 'storageQuotaExceeded'), 'quota', 'storageQuotaExceeded'],
      [R(403, 'quotaExceeded'), 'quota'],
      [R(403, 'insufficientScopes'), 'reauth', 'insufficientScopes'],
      [R(403, 'insufficientPermissions'), 'reauth'],
      [R(401, 'authError'), 'reauth'],
      [R(403, 'appNotAuthorizedToFile'), 'forbidden', 'appNotAuthorizedToFile'],
      [R(403, 'somethingElse'), 'forbidden'],
      [R(404, 'notFound'), 'notFound'],
      [R(500, 'backendError'), 'server'],
      [R(502), 'server'],
      [R(503, 'backendError'), 'server'],
      [R(400, 'invalid'), 'unknown'],
    ]
    for (const [res, code, providerCode] of table) {
      const e = await map(res)
      expect([res.status, e.code]).toEqual([res.status, code])
      expect(e.status).toBe(res.status)
      if (providerCode) expect(e.providerCode).toBe(providerCode)
      expect(e.message).not.toMatch(/https?:/)
    }
    expect(await map(R(503, 'backendError', { 'retry-after': '7' }))).toMatchObject({ code: 'rateLimited', retryAfterMs: 7000 })
    expect((await map(R(403, 'userRateLimitExceeded'))).retryAfterMs).toBeUndefined()
  })

  type Op = [string, (b: GDriveBackend) => Promise<unknown>, RegExp]
  const KEY = `${LIB}/devices/dev1`
  const ops: Op[] = [
    ['list', (b) => b.list(`${LIB}/`), /\/drive\/v3\/files\?/],
    ['head', (b) => b.head(KEY), /\/drive\/v3\/files/],
    ['get', (b) => b.get(KEY), /\/drive\/v3\/files\/[^?]+\?alt=media/],
    ['put', (b) => b.put(KEY, enc('new')), /\/upload\/drive\/v3\/files/],
    ['delete', (b) => b.delete(KEY), /\/drive\/v3\/files\/[A-Za-z0-9_-]+$/],
    ['upload', (b) => b.upload(KEY, source(prngBytes(3 * CHUNK, 1)).src, {}), /upload_id=/],
  ]

  for (const [name, op, path] of ops) {
    it(`${name}: network, 401 → one refresh, revoked → reauth, rate limits, 5xx, quota`, async () => {
      const { fake, b, auth } = setup()
      await b.put(KEY, enc('old'))
      const expectCode = async (respond: Parameters<GDriveFake['fail']>[0]['respond'] | undefined, code: string, more: object = {}) => {
        fake.fail({ path, ...(respond ? { respond } : { network: true }) })
        expect(await errOf(op(b))).toMatchObject({ code, ...more })
        await b.put(KEY, enc('old'))
      }
      await expectCode(undefined, 'network')
      await expectCode(GDriveFake.error(403, 'userRateLimitExceeded'), 'rateLimited')
      await expectCode(GDriveFake.error(403, 'rateLimitExceeded'), 'rateLimited')
      await expectCode(GDriveFake.error(429, 'rateLimitExceeded'), 'rateLimited')
      await expectCode(GDriveFake.error(500, 'backendError'), 'server')
      await expectCode(GDriveFake.error(503, 'backendError'), 'server')
      await expectCode(GDriveFake.error(403, 'storageQuotaExceeded'), 'quota')
      await expectCode(GDriveFake.error(403, 'insufficientScopes'), 'reauth')
      await expectCode(GDriveFake.error(403, 'appNotAuthorizedToFile'), 'forbidden')
      auth.expireNow()
      await op(b)
      expect(auth.refreshes).toBe(1)
      await b.put(KEY, enc('old'))
      auth.revoke()
      expect(await errOf(op(b))).toMatchObject({ code: 'reauth' })
    })
  }

  it('a lost response after the server acted: retrying converges', async () => {
    const { fake, b } = setup()
    const key = `${LIB}/log/dev1/0000000003`
    fake.fail({ method: 'POST', path: /uploadType=multipart/, after: true })
    expect(await errOf(b.put(key, enc('batch'), { ifNoneMatch: true }))).toMatchObject({ code: 'network' })
    // The engine's retry gets precondition, then compares the bytes.
    expect(await errOf(b.put(key, enc('batch'), { ifNoneMatch: true }))).toMatchObject({ code: 'precondition' })
    expect(text(await b.get(key))).toBe('batch')
    const dev = `${LIB}/devices/dev9`
    fake.fail({ method: 'POST', path: /uploadType=multipart/, after: true })
    await errOf(b.put(dev, enc('v1')))
    await b.put(dev, enc('v1'))
    expect(fake.named(dev)).toHaveLength(1)
    fake.fail({ method: 'DELETE', after: true })
    await errOf(b.delete(dev))
    await b.delete(dev)
    expect(fake.named(dev)).toHaveLength(0)
  })

  it('a real storage quota gives quota for puts and uploads', async () => {
    const { b } = setup({ quotaBytes: 1000 })
    expect(await errOf(b.put(`${LIB}/blobs/q`, prngBytes(2000, 1)))).toMatchObject({ code: 'quota', providerCode: 'storageQuotaExceeded' })
    expect(await errOf(b.upload(`${LIB}/blobs/q`, source(prngBytes(SIZE_BIG, 1)).src, {}))).toMatchObject({ code: 'quota' })
  })

  it('no sign-in → reauth; a deleted folder → notFound FolderGone', async () => {
    const { fake, cfg, b } = setup()
    const anon = new GDriveBackend(cfg, { fetch: fake.fetch }, OPTS)
    expect(await errOf(anon.list(''))).toMatchObject({ code: 'reauth', providerCode: 'NoTokens' })
    fake.remove(cfg.folder)
    expect(await errOf(b.put(`${LIB}/meta`, enc('m')))).toMatchObject({ code: 'notFound', providerCode: 'FolderGone' })
    expect(await errOf(b.upload(`${LIB}/blobs/x`, source(prngBytes(SIZE_BIG, 1)).src, {}))).toMatchObject({ code: 'notFound', providerCode: 'FolderGone' })
    expect(await errOf(b.describe())).toMatchObject({ code: 'notFound', providerCode: 'FolderGone' })
    const r = await b.check()
    expect(r.ok).toBe(false)
    expect(r.error).toMatchObject({ providerCode: 'FolderGone' })
    expect(r.steps).toEqual([{ id: 'reach', ok: true }, { id: 'auth', ok: true }, expect.objectContaining({ id: 'list', ok: false })])
  })
})

const SIZE_BIG = 3 * CHUNK

describe('gdrive: check, describe, root folder', () => {
  it('check() reports the emulated conditional create and leaves nothing behind', async () => {
    const { fake, b } = setup()
    const r = await b.check()
    expect(r.ok).toBe(true)
    expect(r.steps.map((s) => s.id)).toEqual(['reach', 'auth', 'list', 'write', 'read', 'range', 'etag', 'conditional', 'delete'])
    expect(r.steps.find((s) => s.id === 'conditional')).toEqual({ id: 'conditional', ok: true, detail: 'emulated (not atomic)' })
    expect(fake.files.size).toBe(1)
  })

  it('check() says which step failed', async () => {
    const { fake, auth, b } = setup()
    fake.fail({ path: /\/drive\/v3\/files\//, network: true })
    expect((await b.check()).steps).toEqual([expect.objectContaining({ id: 'reach', ok: false })])
    auth.revoke()
    const r = await b.check()
    expect(r.steps).toEqual([{ id: 'reach', ok: true }, expect.objectContaining({ id: 'auth', ok: false })])
    expect(r.error?.code).toBe('reauth')
  })

  it('describe() gives the account, the folder link and free space', async () => {
    const { b, fake, cfg } = setup({ quotaBytes: 10_000 })
    await b.put(`${LIB}/meta`, prngBytes(1000, 1))
    expect(await b.describe()).toEqual({
      account: { id: fake.user.permissionId, email: 'rod@example.com', name: 'Rod Example' },
      location: 'Google Drive › OpenStand',
      openUrl: `https://drive.google.com/drive/folders/${cfg.folder}`,
      freeBytes: 9000,
    })
    const about = fake.calls.find((c) => c.url.startsWith(`${DRIVE}/about`))!
    expect(new URL(about.url).searchParams.get('fields')).toBe('user(displayName,emailAddress,permissionId),storageQuota(limit,usage)')
    const unlimited = setup()
    expect((await unlimited.b.describe()).freeBytes).toBeUndefined()
  })

  it('ensureRootFolder creates the marked folder once, then finds it; several → the earliest', async () => {
    const fake = new GDriveFake({ now: ticking() })
    fakes.push(fake)
    const ctx = { fetch: fake.fetch, auth: fake.auth() }
    // A hand-made "OpenStand" folder has no marker and is ignored.
    fake.createFolder({ name: 'OpenStand' })
    const id = await ensureRootFolder(ctx)
    const f = fake.files.get(id)!
    expect(f).toMatchObject({ name: 'OpenStand', mimeType: FOLDER_MIME, parents: ['root'], appProperties: { openstand: 'root' } })
    expect(f.description).toMatch(/End-to-end encrypted/)
    expect(await ensureRootFolder(ctx)).toBe(id)
    expect([...fake.files.values()].filter((x) => x.mimeType === FOLDER_MIME)).toHaveLength(2)
    const older = fake.createFolder({ appProperties: { openstand: 'root' }, createdTime: Date.UTC(2020, 0, 1) })
    expect(await ensureRootFolder(ctx)).toBe(older)
    // The id is accepted by the pairing code's folder rule.
    expect(id).toMatch(/^[A-Za-z0-9_-]{10,200}$/)
  })

  it('ensureRootFolder maps errors', async () => {
    const fake = new GDriveFake()
    fakes.push(fake)
    expect(await errOf(ensureRootFolder({ fetch: fake.fetch }))).toMatchObject({ code: 'reauth' })
    fake.fail({ respond: GDriveFake.error(403, 'insufficientScopes') })
    expect(await errOf(ensureRootFolder({ fetch: fake.fetch, auth: fake.auth() }))).toMatchObject({ code: 'reauth' })
  })
})
