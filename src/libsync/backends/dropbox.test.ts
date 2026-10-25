// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { backendContract, prngBytes } from './contract.test-helper'
import { DropboxBackend, apiArg, dropboxError, freeBytes, type DropboxOptions } from './dropbox'
import { DropboxFake, type DropboxFakeOptions } from './fakes/dropbox.fake'
import type { FakeAuth } from './fakes/harness'
import { BackendError, type ByteSource, type DropboxConfig, type UploadState } from './types'

const KiB = 1024
const CHUNK = 64 * KiB
const SMALL = 128 * KiB
const cfg: DropboxConfig = { kind: 'dropbox', root: '', account: 'rod@example.com', accountId: 'dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc' }
const API = 'https://api.dropboxapi.com/2/'
const CONTENT = 'https://content.dropboxapi.com/2/'
const APPEND = CONTENT + 'files/upload_session/append_v2'
const FINISH = CONTENT + 'files/upload_session/finish'

const fakes: DropboxFake[] = []
afterEach(() => {
  for (const f of fakes.splice(0)) f.verify()
})

function setup(o: { fake?: DropboxFakeOptions; opts?: DropboxOptions; cfg?: Partial<DropboxConfig>; noAuth?: boolean } = {}) {
  const fake = new DropboxFake(o.fake)
  fakes.push(fake)
  const auth = fake.auth()
  const b = new DropboxBackend({ ...cfg, ...o.cfg }, { fetch: fake.fetch, auth: o.noAuth ? undefined : auth, now: o.fake?.now }, { chunk: CHUNK, maxSmallPut: SMALL, ...o.opts })
  return { fake, auth, b }
}

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as BackendError)
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((x, i) => x === b[i])
const callsTo = (fake: DropboxFake, url: string) => fake.calls.filter((c) => c.url === url).length

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

// -------------------------------------------------------------------------------------------------

describe('Dropbox contract', () => {
  const fake = new DropboxFake({ pageSize: 3 })
  backendContract('dropbox (fake)', () => new DropboxBackend(cfg, { fetch: fake.fetch, auth: fake.auth() }, { chunk: CHUNK, maxSmallPut: SMALL }))
  afterEach(() => fake.verify())
})

describe('Dropbox contract (sub-root, 2000-entry pages)', () => {
  const fake = new DropboxFake()
  backendContract('dropbox (fake, root=sub/dir)', () => new DropboxBackend({ ...cfg, root: 'sub/dir' }, { fetch: fake.fetch, auth: fake.auth() }, { chunk: CHUNK, maxSmallPut: SMALL }))
  afterEach(() => fake.verify())
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox requests', () => {
  it('uses real paths in the app folder, case-insensitively, under the root', async () => {
    const { fake, b } = setup({ cfg: { root: 'lib' } })
    await b.put('os1/abc/meta', enc('m'))
    expect(dec(fake.read('/LIB/OS1/ABC/META')!)).toBe('m')
    const call = fake.calls.find((c) => c.url === CONTENT + 'files/upload')!
    expect(JSON.parse(call.headers['dropbox-api-arg'])).toEqual({ path: '/lib/os1/abc/meta', mode: 'overwrite', autorename: false, mute: true, strict_conflict: true })
    expect(call.headers['content-type']).toBe('application/octet-stream')
    expect(call.headers.authorization).toBe('Bearer tok-1')
    expect((await b.list('os1/')).items.map((i) => i.key)).toEqual(['os1/abc/meta'])
  })

  it('refuses keys that could collide on a case-insensitive drive', async () => {
    const { b } = setup()
    for (const key of ['os1/ABC/meta', 'os1//x', '/os1/x', 'os1/café']) {
      const e = await errOf(b.put(key, enc('x')))
      expect(e?.providerCode).toBe('BadKey')
    }
  })

  it('apiArg escapes non-ASCII so the header stays ASCII', () => {
    const s = apiArg({ path: '/Café/♫', n: 1 })
    expect(/^[\x20-\x7e]*$/.test(s)).toBe(true)
    expect(JSON.parse(s)).toEqual({ path: '/Café/♫', n: 1 })
  })

  it('lists recursively from the deepest complete folder, follows cursors, skips folders and strays', async () => {
    const { fake, b } = setup({ fake: { pageSize: 4 } })
    for (let i = 0; i < 9; i++) await b.put(`os1/lib/heads/dev${i % 3}/000000000${i}`, enc(''))
    await b.put('os1/lib/log/dev0/0000000001', enc('x'))
    fake.seedFile('/Readme.txt', 'stray')
    fake.calls.length = 0
    const page = await b.list('os1/lib/heads/')
    expect(page.cursor).toBeUndefined()
    expect(page.items.map((i) => i.key)).toEqual([...page.items.map((i) => i.key)].sort())
    expect(page.items).toHaveLength(9)
    const lf = fake.calls.filter((c) => c.url === API + 'files/list_folder')
    expect(lf).toHaveLength(1)
    // 9 files + 3 device folders + heads itself = 13 entries at 4 per page.
    expect(callsTo(fake, API + 'files/list_folder/continue')).toBe(3)
    // A deep prefix lists only its own folder; a partial segment lists the parent.
    fake.calls.length = 0
    expect((await b.list('os1/lib/heads/dev1/')).items).toHaveLength(3)
    expect((await b.list('os1/lib/he')).items).toHaveLength(9)
    expect((await b.list('')).items.map((i) => i.key)).toContain('readme.txt')
    expect((await b.list('os1/')).items.map((i) => i.key)).not.toContain('readme.txt')
    expect((await b.list('os1/lib/heads/', { startAfter: 'os1/lib/heads/dev1/0000000007' })).items.map((i) => i.key)).toEqual([
      'os1/lib/heads/dev2/0000000002',
      'os1/lib/heads/dev2/0000000005',
      'os1/lib/heads/dev2/0000000008',
    ])
  })

  it('list sends the root as "" and a missing folder lists empty', async () => {
    const { fake, b } = setup()
    expect((await b.list('nothing/')).items).toEqual([])
    await b.list('')
    const args = fake.calls.filter((c) => c.url === API + 'files/list_folder')
    expect(args).toHaveLength(2)
  })

  it('head maps folders and missing paths to null; etag is the rev', async () => {
    const { b } = setup()
    await b.put('a/b/c', enc('xyz'))
    expect(await b.head('a/b')).toBeNull()
    expect(await b.head('a/b/missing')).toBeNull()
    const h = await b.head('a/b/c')
    expect(h).toMatchObject({ key: 'a/b/c', size: 3 })
    expect(h!.etag).toMatch(/^[0-9a-f]{9,}$/)
    expect(typeof h!.lastModified).toBe('number')
    await b.put('a/b/c', enc('xyzw'))
    expect((await b.head('a/b/c'))!.etag).not.toBe(h!.etag)
  })

  it('get honours Range (206), 416 → empty, and caps bodies', async () => {
    const { b } = setup()
    const data = prngBytes(100, 2)
    await b.put('r', data)
    expect(await b.get('r', { range: [5, 9] })).toEqual(data.slice(5, 10))
    expect(await b.get('r', { range: [100, 120] })).toEqual(new Uint8Array(0))
    expect((await errOf(b.get('r', { maxBytes: 50 })))?.providerCode).toBe('TooLarge')
  })

  it('delete is idempotent and leaves empty folders harmlessly behind', async () => {
    const { fake, b } = setup()
    await b.put('x/y/z', enc('1'))
    await b.delete('x/y/z')
    await b.delete('x/y/z')
    expect(fake.folders.has('/x/y')).toBe(true)
    expect((await b.list('x/')).items).toEqual([])
  })

  it('has no abortUpload (Dropbox sessions expire on their own)', () => {
    const { b } = setup()
    expect('abortUpload' in b).toBe(false)
  })
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox conditional create (strict_conflict)', () => {
  it('a second add of identical content is a precondition failure', async () => {
    const { b } = setup()
    await b.put('os1/l/log/d/0000000001', enc('same'), { ifNoneMatch: true })
    const e = await errOf(b.put('os1/l/log/d/0000000001', enc('same'), { ifNoneMatch: true }))
    expect(e).toBeInstanceOf(BackendError)
    expect(e!.code).toBe('precondition')
    expect(e!.providerCode).toBe('path/conflict/file')
    expect(e!.message).toContain('os1/l/log/d/0000000001')
  })

  it('the fake models the trap: without strict_conflict an identical add silently succeeds', async () => {
    const { fake, auth } = setup()
    const add = (strict: boolean, body: string) =>
      fake.fetch(CONTENT + 'files/upload', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth.current}`,
          'content-type': 'application/octet-stream',
          'dropbox-api-arg': JSON.stringify({ path: '/k', mode: 'add', autorename: false, strict_conflict: strict }),
        },
        body,
      })
    expect((await add(false, 'v')).status).toBe(200)
    expect((await add(false, 'v')).status).toBe(200)
    expect((await add(false, 'w')).status).toBe(409)
    expect((await add(true, 'v')).status).toBe(409)
  })

  it('a conditional put over a folder conflicts too', async () => {
    const { b } = setup()
    await b.put('d/inner', enc('x'))
    expect((await errOf(b.put('d', enc('y'), { ifNoneMatch: true })))?.code).toBe('precondition')
  })
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox upload sessions', () => {
  const SIZE = 5 * CHUNK + 123 // 6 chunks
  const chunks = Math.ceil(SIZE / CHUNK)

  async function run(b: DropboxBackend, key: string, data: Uint8Array, state?: UploadState, failAt?: number) {
    const states: UploadState[] = []
    const s = source(data, failAt)
    const err = await errOf(b.upload(key, s.src, { state, onState: async (x) => void states.push(structuredClone(x)) }))
    return { err, states, reads: s.reads, last: states.at(-1) }
  }

  it('starts the session with an empty body and saves it before the first read', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 1)
    let readsAtFirstState = -1
    const s = source(data)
    await b.upload('big', s.src, {
      onState: async (x) => {
        if (readsAtFirstState < 0) {
          readsAtFirstState = s.reads.length
          expect(x).toMatchObject({ v: 1, backend: `dropbox:${cfg.accountId}:`, key: 'big', size: SIZE, done: 0 })
          expect(x.session).toMatchObject({ sessionId: expect.any(String), chunk: CHUNK })
        }
      },
    })
    expect(readsAtFirstState).toBe(0)
    const start = fake.calls.find((c) => c.url === CONTENT + 'files/upload_session/start')!
    expect(JSON.parse(start.headers['dropbox-api-arg'])).toEqual({ close: false })
    expect(callsTo(fake, APPEND)).toBe(chunks)
    const fin = fake.calls.find((c) => c.url === FINISH)!
    expect(JSON.parse(fin.headers['dropbox-api-arg']).commit).toEqual({ path: '/big', mode: 'overwrite', autorename: false, mute: true })
    expect(same(fake.read('/big'), data)).toBe(true)
  })

  for (const after of [false, true]) {
    it(`resumes after a ${after ? 'lost response (chunk stored)' : 'failed request'} at every chunk; the server offset wins`, async () => {
      for (let i = 0; i < chunks; i++) {
        const { fake, b } = setup()
        const data = prngBytes(SIZE, 10 + i)
        // Inject the fault on the i-th append: installed when the state says i chunks are done.
        let armed = false
        const s = source(data)
        const states: UploadState[] = []
        const err = await errOf(
          b.upload('big', s.src, {
            onState: async (x) => {
              states.push(structuredClone(x))
              if (!armed && x.done === i * CHUNK) {
                armed = true
                fake.fail({ path: APPEND, after, network: true })
              }
            },
          }),
        )
        expect(err?.code).toBe('network')
        const last = states.at(-1)!
        expect(last.done).toBe(i * CHUNK)
        expect(fake.read('/big')).toBeUndefined()
        const again = await run(b, 'big', data, last)
        expect(again.err).toBeNull()
        // A stored chunk is never read again; a lost one is.
        if (after && i === chunks - 1) expect(again.reads).toEqual([])
        else expect(again.reads[0]).toBe(after ? (i + 1) * CHUNK : i * CHUNK)
        expect(same(fake.read('/big'), data)).toBe(true)
        fake.verify()
      }
    })
  }

  it('a lost finish response resumes as a no-op (session closed, file whole)', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 3)
    fake.fail({ path: FINISH, after: true })
    const first = await run(b, 'big', data)
    expect(first.err?.code).toBe('network')
    expect(first.last!.done).toBe(SIZE)
    const again = await run(b, 'big', data, first.last)
    expect(again.err).toBeNull()
    expect(again.reads).toEqual([])
    expect(callsTo(fake, FINISH)).toBe(1)
    expect(same(fake.read('/big'), data)).toBe(true)
  })

  it('a failed finish (not stored) is retried on resume without reads', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 4)
    fake.serverError({ path: FINISH, status: 503 })
    const first = await run(b, 'big', data)
    expect(first.err?.code).toBe('server')
    const again = await run(b, 'big', data, first.last)
    expect(again.err).toBeNull()
    expect(again.reads).toEqual([])
    expect(same(fake.read('/big'), data)).toBe(true)
  })

  it('a lost session starts over (on resume and mid-upload)', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 5)
    const first = await run(b, 'big', data, undefined, 3)
    expect(first.last!.done).toBe(2 * CHUNK)
    fake.loseSessions()
    const again = await run(b, 'big', data, first.last)
    expect(again.err).toBeNull()
    expect(again.reads[0]).toBe(0)
    expect(again.states[0].done).toBe(0)
    expect((again.states[0].session as { sessionId: string }).sessionId).not.toBe((first.last!.session as { sessionId: string }).sessionId)
    expect(same(fake.read('/big'), data)).toBe(true)

    // Mid-upload: the session disappears after two chunks; one new session finishes the job.
    const data2 = prngBytes(SIZE, 6)
    let lost = false
    const s = source(data2)
    await b.upload('big2', s.src, {
      onState: async (x) => {
        if (!lost && x.done === 2 * CHUNK) {
          lost = true
          fake.loseSessions()
        }
      },
    })
    expect(s.reads.filter((r) => r === 0)).toHaveLength(2)
    expect(same(fake.read('/big2'), data2)).toBe(true)
  })

  it('a session older than 7 days has expired: start over', async () => {
    let t = Date.parse('2026-10-25T12:00:00Z')
    const now = () => t
    const { b } = setup({ fake: { now } })
    const data = prngBytes(SIZE, 7)
    const first = await run(b, 'big', data, undefined, 4)
    t += 8 * 24 * 3600 * 1000
    const again = await run(b, 'big', data, first.last)
    expect(again.err).toBeNull()
    expect(again.reads[0]).toBe(0)
  })

  it('incorrect_offset during an upload continues from correct_offset', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 8)
    const first = await run(b, 'big', data, undefined, 3)
    // Resume with a stale state (done one chunk behind the server): the probe corrects it before reading.
    const stale: UploadState = { ...first.last!, done: CHUNK }
    const again = await run(b, 'big', data, stale)
    expect(again.err).toBeNull()
    expect(again.reads[0]).toBe(2 * CHUNK)
    expect(again.states[0].done).toBe(2 * CHUNK)
    expect(same(fake.read('/big'), data)).toBe(true)
  })

  it('falls back to state.done when an empty append is refused (400)', async () => {
    const { fake, b } = setup()
    const data = prngBytes(SIZE, 9)
    const first = await run(b, 'big', data, undefined, 3)
    fake.fail({ path: APPEND, respond: { status: 400, text: 'Error in call to API function' } })
    const again = await run(b, 'big', data, first.last)
    expect(again.err).toBeNull()
    expect(again.reads[0]).toBe(2 * CHUNK)
    expect(same(fake.read('/big'), data)).toBe(true)
  })

  it('a state from another account or root never resumes', async () => {
    const { b } = setup()
    const data = prngBytes(SIZE, 12)
    const first = await run(b, 'big', data, undefined, 3)
    const other = setup({ cfg: { accountId: 'dbid:someone-else' } })
    // A separate fake: the other account's session id would be unknown anyway; what matters is no probe.
    const again = await run(other.b, 'big', data, first.last)
    expect(again.err).toBeNull()
    expect(again.reads[0]).toBe(0)
    expect(callsTo(other.fake, APPEND)).toBe(chunks)
  })

  it('small uploads are one files/upload in overwrite mode', async () => {
    const { fake, b } = setup()
    await b.upload('s', source(prngBytes(SMALL, 1)).src, {})
    expect(callsTo(fake, CONTENT + 'files/upload')).toBe(1)
    expect(callsTo(fake, CONTENT + 'files/upload_session/start')).toBe(0)
  })

  it('a full drive fails the finish with quota', async () => {
    const { b } = setup({ fake: { quota: 2 * CHUNK } })
    const e = await errOf(b.upload('big', source(prngBytes(SIZE, 1)).src, {}))
    expect(e?.code).toBe('quota')
    expect(e?.providerCode).toBe('path/insufficient_space')
  })
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox error mapping', () => {
  const body = (summary: string, error: unknown) => JSON.stringify({ error_summary: summary + '/...', error })

  it('maps statuses and error summaries', () => {
    const cases: [number, string, string, string | undefined][] = [
      [400, 'Error in call to API function "files/upload": bad arg', 'unknown', 'BadRequest'],
      [401, body('expired_access_token', { '.tag': 'expired_access_token' }), 'reauth', 'expired_access_token'],
      [401, body('invalid_access_token', { '.tag': 'invalid_access_token' }), 'reauth', 'invalid_access_token'],
      [401, body('missing_scope', { '.tag': 'missing_scope', required_scope: 'files.content.write' }), 'reauth', 'missing_scope'],
      [403, body('no_permission', { '.tag': 'no_permission' }), 'forbidden', 'no_permission'],
      [409, body('path/not_found', { '.tag': 'path', path: { '.tag': 'not_found' } }), 'notFound', 'path/not_found'],
      [409, body('path_lookup/not_found', {}), 'notFound', 'path_lookup/not_found'],
      [409, body('path/conflict/file', {}), 'precondition', 'path/conflict/file'],
      [409, body('path/insufficient_space', {}), 'quota', 'path/insufficient_space'],
      [409, body('path/malformed_path', {}), 'unknown', 'path/malformed_path'],
      [500, 'oops', 'server', undefined],
      [503, '', 'server', undefined],
      [418, '', 'unknown', undefined],
    ]
    for (const [status, text, code, providerCode] of cases) {
      const e = dropboxError(status, text)
      expect([status, e.code, e.providerCode]).toEqual([status, code, providerCode])
      expect(e.status).toBe(status)
    }
  })

  it('takes retry_after from the body (the header is not exposed to browsers)', () => {
    const e429 = dropboxError(429, body('too_many_requests', { reason: { '.tag': 'too_many_requests' }, retry_after: 7 }))
    expect([e429.code, e429.retryAfterMs]).toEqual(['rateLimited', 7000])
    const w409 = dropboxError(409, body('path/too_many_write_operations', { '.tag': 'path', path: { '.tag': 'too_many_write_operations' } }))
    expect([w409.code, w409.retryAfterMs]).toEqual(['rateLimited', 1000])
    const w429 = dropboxError(429, body('too_many_write_operations', { reason: { '.tag': 'too_many_write_operations' }, retry_after: 0 }))
    expect([w429.code, w429.retryAfterMs]).toEqual(['rateLimited', 0])
    expect(dropboxError(429, 'not json').retryAfterMs).toBe(1000)
    expect(dropboxError(429, 'not json', new Headers({ 'retry-after': '3' })).retryAfterMs).toBe(3000)
  })

  it('end to end: each op maps injected faults', async () => {
    const { fake, b } = setup()
    await b.put('k', enc('v'))
    const ops: [string, () => Promise<unknown>][] = [
      ['list', () => b.list('')],
      ['head', () => b.head('k')],
      ['get', () => b.get('k')],
      ['put', () => b.put('k', enc('w'))],
      ['delete', () => b.delete('nope')],
      ['describe', () => b.describe()],
    ]
    for (const [name, op] of ops) {
      fake.rateLimit({ retryAfter: 2 })
      let e = await errOf(op())
      expect([name, e?.code, e?.retryAfterMs]).toEqual([name, 'rateLimited', 2000])
      fake.serverError({ status: 502 })
      e = await errOf(op())
      expect([name, e?.code]).toEqual([name, 'server'])
      fake.fail({ network: true })
      e = await errOf(op())
      expect([name, e?.code]).toEqual([name, 'network'])
      fake.fail({ respond: { status: 403, json: { error_summary: 'no_permission/..', error: { '.tag': 'no_permission' } } } })
      e = await errOf(op())
      expect([name, e?.code]).toEqual([name, 'forbidden'])
    }
    fake.fail({ path: CONTENT + 'files/upload', respond: { status: 409, json: { error_summary: 'path/too_many_write_operations/..', error: { '.tag': 'path' } } } })
    expect((await errOf(b.put('k', enc('x'))))?.code).toBe('rateLimited')
    fake.quota = 1
    expect((await errOf(b.put('k2', enc('xyz'))))?.code).toBe('quota')
  })

  it('a network error after the write took effect leaves the object written', async () => {
    const { fake, b } = setup()
    fake.fail({ path: CONTENT + 'files/upload', after: true })
    expect((await errOf(b.put('k', enc('v'), { ifNoneMatch: true })))?.code).toBe('network')
    // The retry sees its own write as a conflict; the engine then compares the bytes.
    expect((await errOf(b.put('k', enc('v'), { ifNoneMatch: true })))?.code).toBe('precondition')
  })
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox auth', () => {
  it('an expired access token is refreshed once on 401 and the call retried', async () => {
    const { b, auth, fake } = setup()
    await b.put('k', enc('v'))
    auth.expireNow()
    expect(dec(await b.get('k'))).toBe('v')
    expect(auth.refreshes).toBe(1)
    const two = fake.calls.slice(-2)
    expect(two.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2'])
    // Upload sessions refresh mid-way too.
    const data = prngBytes(3 * CHUNK + 1, 2)
    let expired = false
    await b.upload('big', source(data).src, {
      onState: async (x) => {
        if (!expired && x.done === CHUNK) {
          expired = true
          auth.expireNow()
        }
      },
    })
    expect(auth.refreshes).toBe(2)
    expect(same(fake.read('/big'), data)).toBe(true)
  })

  it('a revoked grant is reauth', async () => {
    const { b, auth } = setup()
    auth.revoke()
    const e = await errOf(b.list(''))
    expect(e?.code).toBe('reauth')
  })

  it('a fresh token that still gets 401 is reauth, after exactly one refresh', async () => {
    const { b, auth, fake } = setup()
    const r401 = { status: 401, json: { error_summary: 'invalid_access_token/..', error: { '.tag': 'invalid_access_token' } } }
    fake.fail({ respond: r401, times: 2 })
    const e = await errOf(b.head('k'))
    expect(e?.code).toBe('reauth')
    expect(e?.providerCode).toBe('invalid_access_token')
    expect((auth as FakeAuth).refreshes).toBe(1)
  })

  it('missing_scope is reauth', async () => {
    const { b, fake } = setup()
    fake.fail({ respond: { status: 401, json: { error_summary: 'missing_scope/..', error: { '.tag': 'missing_scope' } } }, times: 2 })
    expect((await errOf(b.put('k', enc('v'))))?.providerCode).toBe('missing_scope')
  })

  it('without a token source every call is reauth', async () => {
    const { b } = setup({ noAuth: true })
    expect((await errOf(b.head('k')))?.code).toBe('reauth')
    const c = await b.check()
    expect(c.ok).toBe(false)
    expect(c.error?.code).toBe('reauth')
    expect(c.steps).toEqual([
      { id: 'reach', ok: true },
      { id: 'auth', ok: false, detail: expect.any(String) },
    ])
  })
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox check and describe', () => {
  it('check() runs every step and needs a strict conflict on identical content', async () => {
    const { b } = setup()
    const r = await b.check()
    expect(r.ok).toBe(true)
    expect(r.steps.map((s) => s.id)).toEqual(['reach', 'auth', 'list', 'write', 'read', 'range', 'etag', 'conditional', 'delete'])
    expect(b.caps.conditionalPut).toBe(true)
  })

  it('check() reports an unreachable Dropbox as reach', async () => {
    const { b, fake } = setup()
    fake.fail({ network: true })
    const r = await b.check()
    expect(r.steps).toEqual([{ id: 'reach', ok: false, detail: expect.any(String) }])
    expect(r.error?.code).toBe('network')
  })

  it('describe() gives the account, the folder and free space', async () => {
    const { b, fake } = setup({ fake: { quota: 1000 } })
    await b.put('k', enc('0123456789'))
    const d = await b.describe()
    expect(d).toEqual({
      account: { id: fake.account.id, email: 'rod@example.com', name: 'Rod Example' },
      location: 'Dropbox › Apps › OpenStand',
      openUrl: 'https://www.dropbox.com/home/Apps/OpenStand',
      freeBytes: 990,
    })
    const get = fake.calls.find((c) => c.url === API + 'users/get_current_account')!
    expect(get.headers['content-type']).toBe('application/json')
  })

  it('describe() survives a failing space query and shows a sub-root', async () => {
    const { b, fake } = setup({ cfg: { root: 'a b' as string } })
    fake.serverError({ path: API + 'users/get_space_usage' })
    const d = await b.describe()
    expect(d.freeBytes).toBeUndefined()
    expect(d.location).toBe('Dropbox › Apps › OpenStand › a b')
    expect(d.openUrl).toBe('https://www.dropbox.com/home/Apps/OpenStand/a%20b')
  })

  it('freeBytes handles team allocations', () => {
    expect(freeBytes({ used: 10, allocation: { '.tag': 'individual', allocated: 100 } })).toBe(90)
    expect(freeBytes({ used: 10, allocation: { '.tag': 'team', used: 500, allocated: 1000 } })).toBe(500)
    expect(freeBytes({ used: 10, allocation: { '.tag': 'team', used: 500, allocated: 1000, user_within_team_space_allocated: 50 } })).toBe(40)
    expect(freeBytes({ used: 200, allocation: { '.tag': 'individual', allocated: 100 } })).toBe(0)
    expect(freeBytes({})).toBeUndefined()
  })
})

// -------------------------------------------------------------------------------------------------

describe('Dropbox fake', () => {
  it('enforces the wire rules', async () => {
    const { fake, auth } = setup()
    const h = (extra: Record<string, string>) => ({ authorization: `Bearer ${auth.current}`, ...extra })
    // Non-ASCII Dropbox-API-Arg.
    let r = await fake.fetch(CONTENT + 'files/download', { method: 'POST', headers: h({ 'dropbox-api-arg': '{"path":"/café"}' }) })
    expect(r.status).toBe(400)
    // Root as "/".
    r = await fake.fetch(API + 'files/list_folder', { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: '{"path":"/"}' })
    expect(r.status).toBe(400)
    // RPC without JSON content type.
    r = await fake.fetch(API + 'files/get_metadata', { method: 'POST', headers: h({}), body: '{"path":"/x"}' })
    expect(r.status).toBe(400)
    // Upload without octet-stream.
    r = await fake.fetch(CONTENT + 'files/upload', { method: 'POST', headers: h({ 'dropbox-api-arg': '{"path":"/x"}', 'content-type': 'text/plain' }), body: 'x' })
    expect(r.status).toBe(400)
    // No token.
    r = await fake.fetch(API + 'files/get_metadata', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":"/x"}' })
    expect(r.status).toBe(400)
    // An unknown token vs an expired one.
    r = await fake.fetch(API + 'files/get_metadata', { method: 'POST', headers: { authorization: 'Bearer junk', 'content-type': 'application/json' }, body: '{"path":"/x"}' })
    expect(((await r.json()) as { error: { '.tag': string } }).error['.tag']).toBe('invalid_access_token')
    auth.expireNow()
    r = await fake.fetch(API + 'files/get_metadata', { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: '{"path":"/x"}' })
    expect(((await r.json()) as { error: { '.tag': string } }).error['.tag']).toBe('expired_access_token')
  })

  it('pages listings in a shuffled order and supports write lag', async () => {
    const { fake, b, auth } = setup({ fake: { listLag: 2 } })
    await b.put('lag/a', enc('1'))
    expect((await b.list('lag/')).items).toEqual([])
    expect((await b.list('lag/')).items).toEqual([])
    expect((await b.list('lag/')).items.map((i) => i.key)).toEqual(['lag/a'])
    fake.listLag = 0
    for (let i = 0; i < 20; i++) await b.put(`s/${String(i).padStart(2, '0')}`, enc(''))
    const res = await fake.fetch(API + 'files/list_folder', {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.current}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/s', recursive: true }),
    })
    const names = ((await res.json()) as { entries: { path_lower: string }[] }).entries.map((e) => e.path_lower).filter((p) => p !== '/s')
    expect(names).toHaveLength(20)
    expect(names).not.toEqual([...names].sort())
  })
})
