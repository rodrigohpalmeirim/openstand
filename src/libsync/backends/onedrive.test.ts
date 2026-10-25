// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { backendContract, prngBytes } from './contract.test-helper'
import { GraphFake, GRAPH_UPLOAD_PREFIX, type GraphFakeOptions } from './fakes/graph.fake'
import { deep3, fromDeep3 } from './keymap'
import { APPROOT, FRAGMENT_UNIT, graphError, nextExpected, OneDriveBackend, type OneDriveOptions } from './onedrive'
import { BackendError, type BackendContext, type ByteSource, type OneDriveConfig, type UploadState } from './types'

const UNIT = FRAGMENT_UNIT // 320 KiB
const cfg: OneDriveConfig = { kind: 'onedrive', folder: '', account: 'rod@example.com', accountId: 'drive-0123456789abcdef' }
const small: OneDriveOptions = { chunk: UNIT, maxSmallPut: 2 * UNIT }

const fakes: GraphFake[] = []
afterEach(() => {
  for (const f of fakes) f.verify()
})

function setup(fo: GraphFakeOptions = {}, bo: OneDriveOptions = small, ctx: Partial<BackendContext> = {}, c: OneDriveConfig = cfg) {
  const fake = new GraphFake(fo)
  fakes.push(fake)
  const auth = fake.auth()
  const b = new OneDriveBackend(c, { fetch: fake.fetch, auth, ...ctx }, bo)
  return { fake, auth, b }
}

const enc = (s: string) => new TextEncoder().encode(s)
const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as BackendError)

function source(data: Uint8Array, failAt?: number) {
  const reads: number[] = []
  const src: ByteSource = {
    size: data.length,
    async read(s, e) {
      reads.push(s)
      if (reads.length === failAt) throw new Error('read failed')
      return data.slice(s, e)
    },
  }
  return { src, reads }
}

/** Byte equality without vitest's slow deep diff of megabyte arrays. */
const same = (a: Uint8Array | undefined, b: Uint8Array) => {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const isUpload = (url: string) => url.startsWith(GRAPH_UPLOAD_PREFIX)

// The shared suite: 320 KiB fragments, 640 KiB simple-upload limit, so large uploads have 6 fragments.
backendContract('onedrive (fake)', () => setup().b)
// A hostile Graph: no automatic parents, no permanentDelete, 2-item pages, single-use download links.
backendContract('onedrive (fake: no auto parents, no permanentDelete, tiny pages, one-shot links)', () =>
  setup({ autoCreateParents: false, permanentDelete: 501, pageSize: 2, downloadUrlUses: 1 }).b,
)

describe('OneDrive key mapping (deep3)', () => {
  it('round-trips keys of every depth', () => {
    const keys = ['meta', 'os1/meta', 'os1/abc/meta', 'os1/abc/heads/dev1/0000000001', 'os1/abc/log/dev1/0000000042', 'os1/abc/blobs/xyz', 'a/b/c/d/e/f']
    for (const k of keys) {
      const { folder, leaf } = deep3(k)
      expect(folder.length).toBeLessThanOrEqual(3)
      expect(fromDeep3(folder, leaf)).toBe(k)
    }
    expect(deep3('os1/abc/heads/dev1/0000000001')).toEqual({ folder: ['os1', 'abc', 'heads'], leaf: 'dev1~0000000001' })
  })

  it('stores deep keys as real folders to depth 3 and joins the rest with ~', async () => {
    const { fake, b } = setup()
    await b.put('os1/lib/heads/dev1/0000000001', new Uint8Array(0))
    await b.put('os1/lib/meta', enc('m'))
    await b.put('os1/lib/blobs/abc', enc('b'))
    await b.put('os1/lib/log/dev1/0000000007', enc('l'))
    expect(fake.paths()).toEqual(['os1/lib/blobs/abc', 'os1/lib/heads/dev1~0000000001', 'os1/lib/log/dev1~0000000007', 'os1/lib/meta'])
    expect(fake.folders()).toEqual(['os1', 'os1/lib', 'os1/lib/blobs', 'os1/lib/heads', 'os1/lib/log'])
    expect((await b.head('os1/lib/heads/dev1/0000000001'))?.size).toBe(0)
  })

  it('polls heads/ and log/<dev>/ with one request each; list("os1/") walks the subfolders', async () => {
    const { fake, b } = setup()
    for (const d of ['dev1', 'dev2', 'dev3']) for (const s of [1, 2]) await b.put(`os1/lib/heads/${d}/000000000${s}`, new Uint8Array(0))
    await b.put('os1/lib/log/dev2/0000000001', enc('x'))
    await b.put('os1/lib/meta', enc('m'))
    const n = fake.calls.length
    const heads = await b.list('os1/lib/heads/')
    expect(fake.calls.length - n).toBe(1)
    expect(heads.items.map((i) => i.key)).toEqual(['dev1', 'dev2', 'dev3'].flatMap((d) => [1, 2].map((s) => `os1/lib/heads/${d}/000000000${s}`)))
    const m = fake.calls.length
    expect((await b.list('os1/lib/heads/dev2/')).items.map((i) => i.key)).toEqual(['os1/lib/heads/dev2/0000000001', 'os1/lib/heads/dev2/0000000002'])
    expect((await b.list('os1/lib/log/dev2/')).items.map((i) => i.key)).toEqual(['os1/lib/log/dev2/0000000001'])
    expect(fake.calls.length - m).toBe(2)
    const all = (await b.list('os1/')).items.map((i) => i.key)
    expect(all).toHaveLength(8)
    expect(all).toEqual([...all].sort())
    expect((await b.list('os1/lib/h')).items).toHaveLength(6)
    expect((await b.list('os2/')).items).toEqual([])
  })

  it('follows @odata.nextLink and returns one sorted page', async () => {
    const { fake, b } = setup({ pageSize: 3 })
    const keys = Array.from({ length: 10 }, (_, i) => `os1/lib/blobs/${String(i).padStart(4, '0')}`)
    for (const k of [...keys].reverse()) await b.put(k, enc(k))
    const n = fake.calls.length
    const page = await b.list('os1/lib/blobs/', { limit: 2 })
    expect(page.cursor).toBeUndefined()
    expect(page.items.map((i) => i.key)).toEqual(keys)
    expect(fake.calls.length - n).toBe(4)
    expect((await b.list('os1/lib/blobs/', { startAfter: keys[6] })).items.map((i) => i.key)).toEqual(keys.slice(7))
  })

  it('skips files deep3 cannot have produced', async () => {
    const { b, fake } = setup()
    await b.put('os1/lib/meta', enc('m'))
    fake.seed('os1/lib/Notes.txt', enc('by hand'))
    fake.seed('os1/a~b', enc('stray ~ at depth 1'))
    fake.seed('os1/lib/heads/x/y/z', enc('too deep'))
    expect((await b.list('os1/')).items.map((i) => i.key)).toEqual(['os1/lib/meta'])
  })

  it('refuses keys outside [a-z0-9./-]', async () => {
    const { b } = setup()
    for (const k of ['A', 'a~b', 'a//b', '/a', 'é']) expect((await errOf(b.put(k, enc('x'))))?.providerCode).toBe('BadKey')
  })

  it('keeps a configured sub-folder under approot', async () => {
    const { fake, b } = setup({}, small, {}, { ...cfg, folder: 'Test Lib' })
    await b.put('os1/lib/heads/d/1', new Uint8Array(0))
    expect(fake.paths()).toEqual(['Test Lib/os1/lib/heads/d~1'])
    expect((await b.list('os1/')).items.map((i) => i.key)).toEqual(['os1/lib/heads/d/1'])
    expect((await b.describe()).location).toBe('OneDrive › Apps › OpenStand › Test Lib')
  })
})

describe('OneDrive requests', () => {
  it('uses conflictBehavior=fail for conditional creates and replace otherwise', async () => {
    const { fake, b } = setup()
    await b.put('os1/a', enc('1'), { ifNoneMatch: true })
    await b.put('os1/a', enc('2'))
    const puts = fake.calls.filter((c) => c.method === 'PUT').map((c) => new URL(c.url).searchParams.get('@microsoft.graph.conflictBehavior'))
    expect(puts).toEqual(['fail', 'replace'])
    const e = await errOf(b.put('os1/a', enc('3'), { ifNoneMatch: true }))
    expect(e).toMatchObject({ code: 'precondition', status: 409, providerCode: 'nameAlreadyExists' })
    expect(new TextDecoder().decode(fake.file('os1/a'))).toBe('2')
  })

  it('reads through downloadUrl without Authorization, with Range, and reuses the link', async () => {
    const { fake, b } = setup()
    const data = prngBytes(5000, 1)
    await b.put('os1/f', data)
    const n = fake.calls.length
    expect(await b.get('os1/f', { range: [100, 199] })).toEqual(data.slice(100, 200))
    expect(await b.get('os1/f', { range: [4990, 9999] })).toEqual(data.slice(4990))
    expect(await b.get('os1/f', { range: [5000, 5001] })).toEqual(new Uint8Array(0))
    const calls = fake.calls.slice(n)
    expect(calls.filter((c) => c.url.startsWith(APPROOT))).toHaveLength(1) // one metadata call, link cached
    const dl = calls.filter((c) => !c.url.startsWith(APPROOT))
    expect(dl).toHaveLength(3)
    expect(dl.every((c) => c.headers.authorization === undefined)).toBe(true)
    expect(dl.map((c) => c.headers.range)).toEqual(['bytes=100-199', 'bytes=4990-9999', 'bytes=5000-5001'])
    expect(new URL(calls[0].url).searchParams.get('$select')).toContain('@microsoft.graph.downloadUrl')
  })

  it('an expired downloadUrl is replaced once; our own writes drop the cached link', async () => {
    const { fake, b } = setup()
    await b.put('os1/f', enc('one'))
    expect(new TextDecoder().decode((await b.get('os1/f'))!)).toBe('one')
    fake.expireDownloadUrls()
    expect(new TextDecoder().decode((await b.get('os1/f'))!)).toBe('one')
    await b.put('os1/f', enc('two'))
    const n = fake.calls.length
    expect(new TextDecoder().decode((await b.get('os1/f'))!)).toBe('two')
    expect(fake.calls.slice(n).filter((c) => c.url.startsWith(APPROOT))).toHaveLength(1)
  })

  it('a link that keeps failing surfaces as an error, not as reauth', async () => {
    const { fake, b } = setup({ downloadUrlUses: 0 })
    await b.put('os1/f', enc('x'))
    const e = await errOf(b.get('os1/f'))
    expect(e).toBeInstanceOf(BackendError)
    expect(e!.code).toBe('unknown')
    expect(e!.status).toBe(401)
    expect(fake.calls.filter((c) => c.url.includes('downloadUrl'))).toHaveLength(2)
  })

  it('get honours maxBytes and the range cap', async () => {
    const { b } = setup()
    await b.put('os1/f', prngBytes(2000, 2))
    expect((await errOf(b.get('os1/f', { maxBytes: 1000 })))?.providerCode).toBe('TooLarge')
    expect(await b.get('os1/f', { maxBytes: 2000 })).toHaveLength(2000)
    expect(await b.get('os1/nope')).toBeNull()
  })

  it('creates missing parent folders when Graph does not (POST children, 409 is fine)', async () => {
    const { fake, b } = setup({ autoCreateParents: false })
    await b.put('os1/lib/heads/d/1', new Uint8Array(0))
    const posts = fake.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    expect(posts).toEqual([`${APPROOT}/children`, `${APPROOT}:/os1:/children`, `${APPROOT}:/os1/lib:/children`])
    expect(fake.paths()).toEqual(['os1/lib/heads/d~1'])
    // A sibling folder: the existing levels answer 409 and that is fine.
    await b.put('os1/lib/log/d/1', enc('x'))
    expect(fake.paths()).toEqual(['os1/lib/heads/d~1', 'os1/lib/log/d~1'])
    // Large uploads too (createUploadSession).
    const data = prngBytes(3 * UNIT + 5, 4)
    await b.upload('os1/lib/blobs/big', source(data).src, {})
    expect(same(fake.file('os1/lib/blobs/big'), data)).toBe(true)
  })

  it('delete uses permanentDelete; falls back to DELETE and remembers only when the item existed', async () => {
    const ok = setup()
    await ok.b.put('os1/a', enc('x'))
    await ok.b.delete('os1/a')
    expect(ok.fake.permanentDeletes).toBe(1)
    expect(ok.fake.recycled).toBe(0)

    const { fake, b } = setup({ permanentDelete: false })
    await b.delete('os1/missing') // 403 then 404: nothing learnt
    await b.put('os1/a', enc('x'))
    await b.delete('os1/a') // 403 then 204: fall back from now on
    await b.put('os1/b', enc('x'))
    const n = fake.calls.length
    await b.delete('os1/b')
    expect(fake.calls.slice(n).map((c) => c.method)).toEqual(['DELETE'])
    expect(fake.recycled).toBe(2)
    expect(fake.paths()).toEqual([])
  })

  it('describe(): drive id, email hint, location and folder link', async () => {
    const { b, fake } = setup()
    const d = await b.describe()
    expect(d).toEqual({
      account: { id: 'drive-0123456789abcdef', email: 'rod@example.com' },
      location: 'OneDrive › Apps › OpenStand',
      openUrl: expect.stringMatching(/^https:\/\//),
    })
    expect(new URL(fake.calls[0].url).searchParams.get('$select')).toBe('id,name,webUrl,parentReference')
  })

  it('label and id', () => {
    const { b } = setup()
    expect(b.label).toBe('OneDrive · rod@example.com')
    expect(b.id).toBe('onedrive:drive-0123456789abcdef:')
  })
})

describe('OneDrive upload sessions', () => {
  const size = 5 * UNIT + 1234 // 6 fragments
  const fragments = Math.ceil(size / UNIT)

  it('fragments are multiples of 320 KiB except the last, without Authorization; state is saved before the first read', async () => {
    const { fake, b } = setup()
    const data = prngBytes(size, 3)
    const events: string[] = []
    const src: ByteSource = {
      size,
      async read(s, e) {
        events.push(`read ${s}`)
        return data.slice(s, e)
      },
    }
    await b.upload('os1/lib/blobs/x', src, { onState: async (s) => void events.push(`state ${s.done}`) })
    expect(events[0]).toBe('state 0')
    expect(events[1]).toBe('read 0')
    expect(events.filter((e) => e.startsWith('state'))).toHaveLength(fragments + 1)
    const frags = fake.calls.filter((c) => c.method === 'PUT' && isUpload(c.url))
    expect(frags).toHaveLength(fragments)
    for (const [i, c] of frags.entries()) {
      expect(c.headers.authorization).toBeUndefined()
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(c.headers['content-range'])!
      const len = Number(m[2]) - Number(m[1]) + 1
      expect(Number(m[3])).toBe(size)
      if (i < frags.length - 1) expect(len % UNIT).toBe(0)
    }
    const create = fake.calls.find((c) => c.url.endsWith(':/createUploadSession'))!
    expect(create.headers.authorization).toMatch(/^Bearer /)
    expect(same(fake.file('os1/lib/blobs/x'), data)).toBe(true)
  })

  it('the default fragment is 10 MiB (32 × 320 KiB); other sizes are refused', () => {
    expect(() => new OneDriveBackend(cfg, {}, { chunk: 300_000 })).toThrow(BackendError)
    expect(() => new OneDriveBackend(cfg, {}, { chunk: 0 })).toThrow(BackendError)
    expect(() => new OneDriveBackend(cfg, {}, { chunk: 192 * UNIT })).toThrow(BackendError) // 60 MiB: must be less
    expect(() => new OneDriveBackend(cfg, {}, { chunk: 191 * UNIT })).not.toThrow()
    expect(() => new OneDriveBackend(cfg, {}, { chunk: 3 * UNIT })).not.toThrow()
    const b = new OneDriveBackend(cfg)
    expect(b.caps.maxSmallPut).toBe(10 * 1024 * 1024)
  })

  it('the fake enforces the fragment rules and refuses Authorization on the upload URL', async () => {
    const { fake, b } = setup()
    let st: UploadState | undefined
    await errOf(b.upload('os1/x', source(prngBytes(size, 1), 1).src, { onState: async (s) => void (st = s) }))
    const url = (st!.session as { uploadUrl: string }).uploadUrl
    const put = (body: Uint8Array, range: string, headers: Record<string, string> = {}) =>
      fake.fetch(url, { method: 'PUT', body: body as Uint8Array<ArrayBuffer>, headers: { 'content-range': range, ...headers } })
    expect((await put(new Uint8Array(1000), `bytes 0-999/${size}`)).status).toBe(400) // not a multiple
    expect((await put(new Uint8Array(UNIT), `bytes 0-${UNIT - 1}/${size}`, { authorization: `Bearer ${fake.auth().current}` })).status).toBe(401)
    expect((await put(new Uint8Array(UNIT), `bytes ${UNIT}-${2 * UNIT - 1}/${size}`)).status).toBe(416) // out of order
    expect((await put(new Uint8Array(UNIT), `bytes 0-${UNIT}/${size}`)).status).toBe(400) // length mismatch
    expect((await put(new Uint8Array(UNIT), `bytes 0-${UNIT - 1}/${size}`)).status).toBe(202)
    expect((await put(new Uint8Array(UNIT), `bytes 0-${UNIT - 1}/${size}`)).status).toBe(416) // repeated
  })

  /** A fetch that loses fragment PUT number `nth`: before it reaches the server, or after (response lost). */
  function losing(fake: GraphFake, nth: number, after: boolean): typeof fetch {
    let n = 0
    return async (input, init) => {
      if (init?.method === 'PUT' && isUpload(String(input)) && ++n === nth) {
        if (after) await fake.fetch(input, init)
        throw new TypeError('Failed to fetch (injected)')
      }
      return fake.fetch(input, init)
    }
  }

  for (let i = 1; i <= fragments; i++) {
    for (const after of [false, true]) {
      it(`resumes after fragment ${i} is lost ${after ? 'after the server stored it' : 'before it arrived'}`, async () => {
        const { fake } = setup()
        const b = new OneDriveBackend(cfg, { fetch: losing(fake, i, after), auth: fake.auth() }, small)
        const data = prngBytes(size, 100 + i)
        const key = 'os1/lib/blobs/r'
        let last: UploadState | undefined
        const onState = async (s: UploadState) => void (last = structuredClone(s))
        const err = await errOf(b.upload(key, source(data).src, { onState }))
        expect(err).toMatchObject({ code: 'network' })
        expect(last!.done).toBe((i - 1) * UNIT)
        // The last fragment completes the file even though its response was lost.
        if (after && i === fragments) expect((await b.head(key))?.size).toBe(size)
        else expect(await b.head(key)).toBeNull()
        const second = source(data)
        let progress = 0
        await b.upload(key, second.src, { state: last, onState, onProgress: (p) => (progress = p) })
        const landed = after ? Math.min(i * UNIT, size) : (i - 1) * UNIT
        // The server's offset wins over the saved state: a stored fragment is not read again.
        if (landed < size) {
          expect(second.reads[0]).toBe(landed)
          expect(last!.done).toBe(size)
        } else expect(second.reads).toEqual([]) // the session is gone and the file is whole
        expect(progress).toBe(size)
        expect(same(fake.file(key), data)).toBe(true)
      })
    }
  }

  it('a lost response answered by 416 on the next fragment asks the server and continues', async () => {
    const { fake } = setup()
    const data = prngBytes(size, 9)
    // Fragment 2 lands but the client sees 416 (as if it had been sent twice).
    let n = 0
    const wrapped: typeof fetch = async (input, init) => {
      const url = String(input)
      const res = await fake.fetch(input, init)
      if (init?.method === 'PUT' && isUpload(url) && ++n === 2) return new Response(null, { status: 416 })
      return res
    }
    const b = new OneDriveBackend(cfg, { fetch: wrapped, auth: fake.auth() }, small)
    const s = source(data)
    await b.upload('os1/x', s.src, {})
    expect(s.reads).toEqual(Array.from({ length: fragments }, (_, i) => i * UNIT))
    expect(same(fake.file('os1/x'), data)).toBe(true)
  })

  it('an expired session on resume starts over; mid-upload it restarts once', async () => {
    const { fake, b } = setup()
    const data = prngBytes(size, 10)
    let last: UploadState | undefined
    await errOf(b.upload('os1/x', source(data, 3).src, { onState: async (s) => void (last = structuredClone(s)) }))
    fake.expireUploadSessions()
    const again = source(data)
    await b.upload('os1/x', again.src, { state: last })
    expect(again.reads[0]).toBe(0)
    expect(same(fake.file('os1/x'), data)).toBe(true)

    // Mid-upload: the session vanishes after fragment 2.
    let k = 0
    const src: ByteSource = {
      size,
      async read(s, e) {
        if (++k === 3) fake.expireUploadSessions()
        return data.slice(s, e)
      },
    }
    const states: number[] = []
    await b.upload('os1/y', src, { onState: async (s) => void states.push(s.done) })
    expect(same(fake.file('os1/y'), data)).toBe(true)
    expect(states.filter((d) => d === 0)).toHaveLength(2) // a second session was created
    expect(fake.calls.filter((c) => c.url.endsWith('/y:/createUploadSession'))).toHaveLength(2)
  })

  it('a state from another account or folder is not resumed', async () => {
    const { fake, b } = setup()
    const data = prngBytes(size, 12)
    let last: UploadState | undefined
    await errOf(b.upload('os1/x', source(data, 3).src, { onState: async (s) => void (last = structuredClone(s)) }))
    expect(last!.backend).toBe('onedrive:drive-0123456789abcdef:')
    const other = new OneDriveBackend({ ...cfg, accountId: 'drive-other' }, { fetch: fake.fetch, auth: fake.auth() }, small)
    const s = source(data)
    await other.upload('os1/x', s.src, { state: last })
    expect(s.reads[0]).toBe(0)
  })

  it('abortUpload deletes the session without Authorization; idempotent; ignores junk', async () => {
    const { fake, b } = setup()
    let last: UploadState | undefined
    await errOf(b.upload('os1/x', source(prngBytes(size, 5), 3).src, { onState: async (s) => void (last = structuredClone(s)) }))
    expect(fake.sessions.size).toBe(1)
    await b.abortUpload(last!)
    expect(fake.sessions.size).toBe(0)
    await b.abortUpload(last!)
    const dels = fake.calls.filter((c) => c.method === 'DELETE' && isUpload(c.url))
    expect(dels).toHaveLength(2)
    expect(dels.every((c) => c.headers.authorization === undefined)).toBe(true)
    await b.abortUpload({ ...last!, session: null })
    await b.abortUpload({ ...last!, session: { uploadUrl: 'http://evil.example/x' } })
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2)
  })
})

describe('OneDrive error mapping', () => {
  const graph = (status: number, code?: string, headers: Record<string, string> = {}) => ({
    status,
    json: code ? { error: { code, message: 'secret https://x.example/up?token=1' } } : undefined,
    headers,
  })

  it('maps statuses and codes', () => {
    const m = (status: number, code?: string, h?: Record<string, string>, preauth = false) =>
      graphError(status, code ? JSON.stringify({ error: { code, message: 'SECRET-MSG' } }) : '', new Headers(h), { preauth, now: 0 })
    expect(m(429, 'activityLimitReached', { 'retry-after': '7' })).toMatchObject({ code: 'rateLimited', retryAfterMs: 7000 })
    expect(m(503, 'serviceNotAvailable', { 'retry-after': '3' })).toMatchObject({ code: 'rateLimited', retryAfterMs: 3000 })
    expect(m(503).code).toBe('server')
    expect(m(507, 'insufficientStorage').code).toBe('quota')
    expect(m(403, 'quotaLimitReached').code).toBe('quota')
    expect(m(403, 'accessDenied')).toMatchObject({ code: 'forbidden', providerCode: 'accessDenied' })
    expect(m(404, 'itemNotFound').code).toBe('notFound')
    expect(m(409, 'nameAlreadyExists').code).toBe('precondition')
    expect(m(412).code).toBe('precondition')
    expect(m(423, 'resourceLocked').code).toBe('server')
    expect(m(500).code).toBe('server')
    expect(m(400, 'invalidRequest').code).toBe('unknown')
    expect(m(401).code).toBe('reauth')
    expect(m(401, undefined, {}, true).code).toBe('unknown')
    expect(m(500, 'x', {}).message).not.toContain('SECRET-MSG')
    expect(nextExpected(['12-'])).toBe(12)
    expect(nextExpected(['5-9', '20-'])).toBe(5)
    expect(nextExpected([])).toBeNull()
  })

  it('429 and 503 with Retry-After become rateLimited, from every op', async () => {
    const { fake, b } = setup()
    await b.put('os1/a', enc('x'))
    const ops: [string, () => Promise<unknown>][] = [
      ['list', () => b.list('os1/')],
      ['head', () => b.head('os1/a')],
      ['get', () => b.get('os1/a')],
      ['put', () => b.put('os1/a', enc('y'))],
      ['delete', () => b.delete('os1/a')],
      ['upload', () => b.upload('os1/big', source(prngBytes(3 * UNIT, 1)).src, {})],
    ]
    for (const [name, op] of ops) {
      fake.fail({ path: new RegExp('^' + APPROOT.replace(/\./g, '\\.')), respond: graph(429, 'activityLimitReached', { 'retry-after': '7' }) })
      expect(await errOf(op()), name).toMatchObject({ code: 'rateLimited', retryAfterMs: 7000, status: 429 })
      fake.fail({ path: new RegExp('^' + APPROOT.replace(/\./g, '\\.')), respond: graph(503, 'serviceNotAvailable', { 'retry-after': '2' }) })
      expect(await errOf(op()), name).toMatchObject({ code: 'rateLimited', retryAfterMs: 2000 })
    }
  })

  it('5xx → server, 507 → quota, network → network', async () => {
    const { fake, b } = setup({ quota: 10_000 })
    fake.fail({ respond: graph(500, 'generalException') })
    expect((await errOf(b.head('os1/a')))?.code).toBe('server')
    fake.fail({ respond: graph(502) })
    expect((await errOf(b.list('os1/')))?.code).toBe('server')
    expect((await errOf(b.put('os1/a', new Uint8Array(20_000))))).toMatchObject({ code: 'quota', providerCode: 'quotaLimitReached' })
    expect((await errOf(b.upload('os1/b', source(new Uint8Array(3 * UNIT)).src, {}))))?.toMatchObject({ code: 'quota' })
    fake.fail({ network: true })
    expect((await errOf(b.get('os1/a')))?.code).toBe('network')
    // A fragment that fails on the server side.
    fake.fail({ method: 'PUT', path: new RegExp('^' + GRAPH_UPLOAD_PREFIX.replace(/\./g, '\\.')), respond: graph(500) })
    expect((await errOf(b.upload('os1/c', source(new Uint8Array(3 * UNIT)).src, {}))))?.toMatchObject({ code: 'server' })
  })

  it('401 refreshes once and retries; revoked → reauth; no token source → reauth', async () => {
    const { fake, auth, b } = setup()
    await b.put('os1/a', enc('x'))
    auth.expireNow()
    expect(await b.head('os1/a')).toMatchObject({ size: 1 })
    expect(auth.refreshes).toBe(1)
    auth.expireNow()
    expect(new TextDecoder().decode((await b.get('os1/a'))!)).toBe('x')
    expect(auth.refreshes).toBe(2)
    auth.revoke()
    expect((await errOf(b.list('os1/')))?.code).toBe('reauth')
    const none = new OneDriveBackend(cfg, { fetch: fake.fetch }, small)
    expect((await errOf(none.head('os1/a')))).toMatchObject({ code: 'reauth', providerCode: 'NoTokens' })
  })

  it('a 401 on a fragment (no token involved) is not reauth', async () => {
    const { fake, b } = setup()
    fake.fail({ method: 'PUT', path: new RegExp('^' + GRAPH_UPLOAD_PREFIX.replace(/\./g, '\\.')), respond: graph(401, 'unauthenticated') })
    expect((await errOf(b.upload('os1/c', source(new Uint8Array(3 * UNIT)).src, {}))))?.toMatchObject({ code: 'unknown', status: 401 })
  })

  it('never sends the token to a nextLink off Graph', async () => {
    const { fake, b } = setup()
    fake.fail({ method: 'GET', path: /children/, respond: { json: { value: [], '@odata.nextLink': 'https://evil.example/next' } } })
    expect((await errOf(b.list('os1/')))?.providerCode).toBe('BadNextLink')
    expect(fake.calls.some((c) => c.url.startsWith('https://evil'))).toBe(false)
  })

  it('check() reports the failing step', async () => {
    const { auth, b } = setup()
    auth.revoke()
    const r = await b.check()
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('reauth')
    expect(r.steps).toEqual([{ id: 'reach', ok: true }, expect.objectContaining({ id: 'auth', ok: false })])
    const offline = setup()
    offline.fake.fail({ network: true })
    expect((await offline.b.check()).steps).toEqual([expect.objectContaining({ id: 'reach', ok: false })])
  })
})

