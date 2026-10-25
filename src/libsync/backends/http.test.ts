// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { FakeServer, type FakeReply } from './fakes/harness'
import { ERROR_BODY_MAX, OAuthHttp } from './http'
import { BackendError, type BackendContext } from './types'

const API = 'https://api.example.test'

class EchoFake extends FakeServer {
  constructor() {
    super({ kind: 'gdrive' })
    this.route('GET', `${API}/me`, (req) => ({ json: { token: req.token } }))
    this.route('POST', /^https:\/\/api\.example\.test\/items\/([a-z]+)(\?.*)?$/, (req) => ({ status: 201, json: { id: req.params[0], body: req.text() } }))
    this.route('GET', `${API}/big-error`, () => ({ status: 500, text: 'x'.repeat(ERROR_BODY_MAX * 2) }))
    this.route('GET', `${API}/huge`, () => ({ json: { pad: 'x'.repeat(2048) } }))
    this.route('GET', `${API}/empty`, () => ({ status: 204 }))
    this.route('GET', `${API}/not-json`, () => ({ text: 'hello' }))
    this.route('GET', `${API}/public`, (req) => ({ json: { auth: req.headers.get('authorization') } }), { auth: false })
    this.route('GET', `${API}/missing`, () => ({ status: 404, json: { error: 'itemNotFound' } }))
  }
  protected unauthorized(): FakeReply {
    return { status: 401, json: { error: 'expired' } }
  }
}

const mapError = (res: Response, body: string) => {
  let code: string | undefined
  try {
    code = (JSON.parse(body) as { error?: string }).error
  } catch {
    /* not JSON */
  }
  return new BackendError(res.status >= 500 ? 'server' : res.status === 404 ? 'notFound' : 'unknown', `HTTP ${res.status}`, {
    status: res.status,
    providerCode: code ?? `len:${body.length}`,
  })
}

let fake: EchoFake
afterEach(() => fake?.verify())

function make(ctx: Partial<BackendContext> = {}) {
  fake = new EchoFake()
  const auth = fake.auth()
  const http = new OAuthHttp({ fetch: fake.fetch, auth, ...ctx }, { mapError, label: 'Example' })
  return { http, auth }
}

const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

describe('OAuthHttp', () => {
  it('adds the bearer token, and none when auth is false', async () => {
    const { http, auth } = make()
    expect(auth.kind).toBe('gdrive')
    expect(await http.json(`${API}/me`)).toEqual({ token: 'tok-1' })
    expect(await http.json(`${API}/public`, { auth: false })).toEqual({ auth: null })
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', undefined])
  })

  it('a 401 refreshes once and retries; the body is sent again', async () => {
    const { http, auth } = make()
    auth.expireNow()
    expect(await http.json(`${API}/items/abc`, { method: 'POST', body: 'payload' })).toEqual({ id: 'abc', body: 'payload' })
    expect(auth.refreshes).toBe(1)
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('a second 401 is reauth; a revoked grant is reauth', async () => {
    const { http, auth } = make()
    fake.fail({ path: `${API}/me`, times: 2, respond: { status: 401, json: { error: 'nope' } } })
    const e = (await errOf(http.json(`${API}/me`))) as BackendError
    expect(e).toBeInstanceOf(BackendError)
    expect(e.code).toBe('reauth')
    expect(e.providerCode).toBe('nope')
    expect(auth.refreshes).toBe(1)
    auth.revoke()
    expect(((await errOf(http.json(`${API}/me`))) as BackendError).code).toBe('reauth')
  })

  it('without a token source every authorised call is reauth', async () => {
    const { http } = make({ auth: undefined })
    expect(((await errOf(http.send(`${API}/me`))) as BackendError).code).toBe('reauth')
    expect(fake.calls).toEqual([])
    expect((await http.send(`${API}/public`, { auth: false })).status).toBe(200)
  })

  it('maps errors through mapError with a truncated body; `expect` returns them instead', async () => {
    const { http } = make()
    const e = (await errOf(http.send(`${API}/big-error`))) as BackendError
    expect([e.code, e.providerCode]).toEqual(['server', `len:${ERROR_BODY_MAX}`])
    expect(((await errOf(http.send(`${API}/missing`))) as BackendError).code).toBe('notFound')
    expect((await http.send(`${API}/missing`, { expect: [404] })).status).toBe(404)
  })

  it('a thrown fetch is network; an abort stays an abort', async () => {
    const { http } = make()
    fake.fail({ path: `${API}/me`, network: true })
    expect(((await errOf(http.send(`${API}/me`))) as BackendError).code).toBe('network')
    const ac = new AbortController()
    ac.abort()
    const e = (await errOf(http.send(`${API}/me`, { signal: ac.signal }))) as Error
    expect(e.name).toBe('AbortError')
  })

  it('json: caps the body, empty is null, non-JSON is unknown', async () => {
    const { http } = make()
    expect(((await errOf(http.json(`${API}/huge`, { maxBody: 1024 }))) as BackendError).providerCode).toBe('TooLarge')
    expect(await http.json(`${API}/empty`)).toBeNull()
    expect(((await errOf(http.json(`${API}/not-json`))) as BackendError).providerCode).toBe('BadJson')
  })
})

describe('FakeServer', () => {
  it('logs calls, records unmatched routes, and applies faults before or after the effect', async () => {
    const { http } = make()
    const off = fake.fail({ method: 'POST', path: /\/items\/lost/, after: true, respond: { status: 503 } })
    expect(((await errOf(http.send(`${API}/items/lost`, { method: 'POST' }))) as BackendError).code).toBe('server')
    off()
    expect((await http.send(`${API}/items/lost`, { method: 'POST' })).status).toBe(201)
    fake.fail({ path: `${API}/me`, times: Infinity, respond: { status: 500 } })
    for (let i = 0; i < 3; i++) expect(((await errOf(http.send(`${API}/me`))) as BackendError).code).toBe('server')
    await http.send(`${API}/nowhere`, { expect: [404] })
    expect(fake.unmatched).toEqual([`GET ${API}/nowhere`])
    expect(() => fake.verify()).toThrow(/no route/)
    fake.unmatched.length = 0
  })

  it('two clients refreshing the same rejected token get one refresh', async () => {
    make()
    const auth = fake.auth()
    const first = auth.current
    auth.expireNow()
    const [a, b] = await Promise.all([auth.refreshAfter401(first), auth.refreshAfter401(first)])
    expect(a).toBe(b)
    expect(auth.refreshes).toBe(1)
    expect(await auth.refreshAfter401(first)).toBe(a)
  })
})
