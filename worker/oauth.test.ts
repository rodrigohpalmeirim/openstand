// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleOAuth, MAX_BODY, ONEDRIVE_SCOPE, TOKEN_ENDPOINTS, type OAuthEnv } from './oauth'

const SELF = 'https://openstand.rodlabs.dev'
const OTHER = 'http://localhost:5317'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const SECRET_CODE = 'code-SECRET-4f2a'
const SECRET_REFRESH = 'refresh-SECRET-9c1d'

const env = (over: Partial<OAuthEnv> = {}): OAuthEnv => ({
  ALLOWED_ORIGINS: '',
  GDRIVE_CLIENT_ID: 'g-id.apps.googleusercontent.com',
  GDRIVE_CLIENT_SECRET: 'g-secret',
  ONEDRIVE_CLIENT_ID: 'm-id',
  ONEDRIVE_CLIENT_SECRET: 'm-secret',
  ...over,
})

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** Upstream fake: records each request, answers `reply`. */
function upstream(reply: () => Response | Promise<Response> = () => Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3599 })) {
  const seen: Seen[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() })
    return reply()
  }) as unknown as typeof fetch
  return { fn, seen }
}

function post(path: string, body: unknown, o: { origin?: string | null; headers?: Record<string, string>; raw?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...o.headers }
  if (o.origin !== null) headers.origin = o.origin ?? SELF
  return new Request(SELF + path, { method: o.method ?? 'POST', headers, body: o.raw ?? JSON.stringify(body) })
}

const codeBody = (over: Record<string, unknown> = {}) => ({ grant: 'code', code: SECRET_CODE, code_verifier: VERIFIER, redirect_uri: SELF + '/oauth/callback', ...over })
const refreshBody = { grant: 'refresh', refresh_token: SECRET_REFRESH }

let logs: unknown[][]
beforeEach(() => {
  logs = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a))
})
afterEach(() => {
  vi.restoreAllMocks()
  // Nothing secret is ever logged.
  const text = JSON.stringify(logs)
  for (const s of [SECRET_CODE, SECRET_REFRESH, VERIFIER, 'g-secret', 'm-secret', 'at-secret', 'rt-secret']) expect(text).not.toContain(s)
})

describe('GET /api/oauth/providers', () => {
  it('lists only providers with both the client id and the secret', async () => {
    const r = await handleOAuth(new Request(SELF + '/api/oauth/providers'), env({ ONEDRIVE_CLIENT_SECRET: '' }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ v: 1, providers: { gdrive: { clientId: 'g-id.apps.googleusercontent.com' } } })
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
    const none = await handleOAuth(new Request(SELF + '/api/oauth/providers'), env({ GDRIVE_CLIENT_ID: '', ONEDRIVE_CLIENT_ID: ' ' }))
    expect(await none.json()).toEqual({ v: 1, providers: {} })
  })

  it('answers other methods with 405', async () => {
    const r = await handleOAuth(new Request(SELF + '/api/oauth/providers', { method: 'POST' }), env())
    expect(r.status).toBe(405)
    expect(await r.json()).toEqual({ error: 'method_not_allowed' })
  })
})

describe('POST /api/oauth/<provider>/token', () => {
  it('redeems a Google code with exactly the documented form, and returns only the token fields', async () => {
    const up = upstream(() =>
      Response.json({ access_token: 'at-secret', token_type: 'Bearer', expires_in: 3599, refresh_token: 'rt-secret', scope: 'https://www.googleapis.com/auth/drive.file', id_token: 'x.y.z', extra: 'dropped', refresh_token_expires_in: 604799 }),
    )
    const r = await handleOAuth(post('/api/oauth/gdrive/token', codeBody()), env(), up.fn)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ access_token: 'at-secret', token_type: 'Bearer', expires_in: 3599, refresh_token: 'rt-secret', scope: 'https://www.googleapis.com/auth/drive.file', id_token: 'x.y.z' })
    expect(up.seen).toHaveLength(1)
    const s = up.seen[0]
    expect(s.url).toBe(TOKEN_ENDPOINTS.gdrive)
    expect(s.method).toBe('POST')
    expect(s.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
    expect(Object.fromEntries(new URLSearchParams(s.body))).toEqual({
      grant_type: 'authorization_code',
      code: SECRET_CODE,
      code_verifier: VERIFIER,
      redirect_uri: SELF + '/oauth/callback',
      client_id: 'g-id.apps.googleusercontent.com',
      client_secret: 'g-secret',
    })
  })

  it('redeems a Microsoft refresh token with the scope, and never forwards Origin or cookies', async () => {
    const up = upstream()
    const r = await handleOAuth(post('/api/oauth/onedrive/token', refreshBody, { headers: { cookie: 'a=b', 'user-agent': 'x', referer: SELF + '/' } }), env(), up.fn)
    expect(r.status).toBe(200)
    const s = up.seen[0]
    expect(s.url).toBe(TOKEN_ENDPOINTS.onedrive)
    expect(s.headers.origin).toBeUndefined()
    expect(s.headers.cookie).toBeUndefined()
    expect(s.headers.referer).toBeUndefined()
    expect(Object.keys(s.headers).sort()).toEqual(['accept', 'content-type'])
    expect(Object.fromEntries(new URLSearchParams(s.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: SECRET_REFRESH,
      client_id: 'm-id',
      client_secret: 'm-secret',
      scope: ONEDRIVE_SCOPE,
    })
  })

  it('logs at most provider, grant, upstream status and error code', async () => {
    const up = upstream(() => Response.json({ error: 'invalid_grant', error_description: `AADSTS70000: bad code ${SECRET_CODE.slice(0, 4)}` }, { status: 400 }))
    await handleOAuth(post('/api/oauth/onedrive/token', codeBody()), env(), up.fn)
    expect(logs).toEqual([['oauth', 'onedrive', 'code', 400, 'invalid_grant']])
  })

  it('passes provider 4xx through with the error and a clipped description', async () => {
    const up = upstream(() => Response.json({ error: 'invalid_grant', error_description: 'x'.repeat(1000), trace_id: 't' }, { status: 400 }))
    const r = await handleOAuth(post('/api/oauth/gdrive/token', refreshBody), env(), up.fn)
    expect(r.status).toBe(400)
    const j = (await r.json()) as { error: string; error_description: string }
    expect(Object.keys(j).sort()).toEqual(['error', 'error_description'])
    expect(j.error).toBe('invalid_grant')
    expect(j.error_description).toHaveLength(300)
    const r401 = await handleOAuth(post('/api/oauth/gdrive/token', refreshBody), env(), upstream(() => Response.json({ error: 'invalid_client' }, { status: 401 })).fn)
    expect(r401.status).toBe(401)
    expect(await r401.json()).toEqual({ error: 'invalid_client' })
  })

  it.each([
    ['a provider 5xx', () => Response.json({ error: 'server_error' }, { status: 503 })],
    ['a non-JSON answer', () => new Response('<html>oops</html>', { status: 200 })],
    ['a 200 without an access token', () => Response.json({ token_type: 'Bearer' })],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://example.com' } })],
    ['no answer', () => Promise.reject(new TypeError('fetch failed'))],
  ])('maps %s to 502 upstream_unavailable', async (_, reply) => {
    const r = await handleOAuth(post('/api/oauth/gdrive/token', refreshBody), env(), upstream(reply).fn)
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'upstream_unavailable' })
  })

  it('gives up on an upstream that takes longer than 10 s', async () => {
    vi.useFakeTimers()
    try {
      const slow = (async (input: Request) =>
        new Promise<Response>((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason)))) as unknown as typeof fetch
      const p = handleOAuth(post('/api/oauth/gdrive/token', refreshBody), env(), slow)
      await vi.advanceTimersByTimeAsync(10_001)
      expect((await p).status).toBe(502)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('route errors (§6.1 table)', () => {
    const cases: [string, () => Request, Partial<OAuthEnv>, number, string][] = [
      ['unknown provider', () => post('/api/oauth/dropbox/token', refreshBody), {}, 404, 'not_found'],
      ['unknown path', () => post('/api/oauth/gdrive/tokens', refreshBody), {}, 404, 'not_found'],
      ['GET on /token', () => new Request(SELF + '/api/oauth/gdrive/token', { headers: { origin: SELF } }), {}, 405, 'method_not_allowed'],
      ['PUT on /token', () => post('/api/oauth/gdrive/token', refreshBody, { method: 'PUT' }), {}, 405, 'method_not_allowed'],
      ['no client id', () => post('/api/oauth/gdrive/token', refreshBody), { GDRIVE_CLIENT_ID: '' }, 503, 'not_configured'],
      ['no secret', () => post('/api/oauth/onedrive/token', refreshBody), { ONEDRIVE_CLIENT_SECRET: undefined }, 503, 'not_configured'],
      ['no Origin', () => post('/api/oauth/gdrive/token', refreshBody, { origin: null }), {}, 403, 'origin_not_allowed'],
      ['a foreign Origin', () => post('/api/oauth/gdrive/token', refreshBody, { origin: 'https://evil.example' }), {}, 403, 'origin_not_allowed'],
      ['another origin while ALLOWED_ORIGINS is empty', () => post('/api/oauth/gdrive/token', refreshBody, { origin: OTHER }), {}, 403, 'origin_not_allowed'],
      ['Origin "null"', () => post('/api/oauth/gdrive/token', refreshBody, { origin: 'null' }), {}, 403, 'origin_not_allowed'],
      ['a form body', () => post('/api/oauth/gdrive/token', null, { raw: 'grant=refresh', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), {}, 415, 'unsupported_media_type'],
      ['a declared length over 16 KiB', () => post('/api/oauth/gdrive/token', null, { raw: '{}', headers: { 'content-length': String(MAX_BODY + 1) } }), {}, 413, 'too_large'],
      ['a body over 16 KiB', () => post('/api/oauth/gdrive/token', { grant: 'refresh', refresh_token: 'r'.repeat(MAX_BODY) }), {}, 413, 'too_large'],
      ['bad JSON', () => post('/api/oauth/gdrive/token', null, { raw: '{"grant":' }), {}, 400, 'invalid_request'],
      ['a JSON array', () => post('/api/oauth/gdrive/token', [1]), {}, 400, 'invalid_request'],
      ['an unknown grant', () => post('/api/oauth/gdrive/token', { grant: 'password', refresh_token: 'x' }), {}, 400, 'invalid_request'],
      ['a missing field', () => post('/api/oauth/gdrive/token', { grant: 'code', code: 'c', code_verifier: VERIFIER }), {}, 400, 'invalid_request'],
      ['an extra field', () => post('/api/oauth/gdrive/token', { ...refreshBody, client_secret: 'x' }), {}, 400, 'invalid_request'],
      ['an empty code', () => post('/api/oauth/gdrive/token', codeBody({ code: '' })), {}, 400, 'invalid_request'],
      ['a code over 4096 chars', () => post('/api/oauth/gdrive/token', codeBody({ code: 'c'.repeat(4097) })), {}, 400, 'invalid_request'],
      ['a short verifier', () => post('/api/oauth/gdrive/token', codeBody({ code_verifier: 'a'.repeat(42) })), {}, 400, 'invalid_request'],
      ['a long verifier', () => post('/api/oauth/gdrive/token', codeBody({ code_verifier: 'a'.repeat(129) })), {}, 400, 'invalid_request'],
      ['a verifier outside the alphabet', () => post('/api/oauth/gdrive/token', codeBody({ code_verifier: 'a'.repeat(42) + '+' })), {}, 400, 'invalid_request'],
      ['a refresh token over 8192 chars', () => post('/api/oauth/gdrive/token', { grant: 'refresh', refresh_token: 'r'.repeat(8193) }), {}, 400, 'invalid_request'],
      ['a number for a field', () => post('/api/oauth/gdrive/token', { grant: 'refresh', refresh_token: 5 }), {}, 400, 'invalid_request'],
      ['a redirect URI on another origin', () => post('/api/oauth/gdrive/token', codeBody({ redirect_uri: 'https://evil.example/oauth/callback' })), {}, 400, 'invalid_redirect_uri'],
      ['a redirect URI on another path', () => post('/api/oauth/gdrive/token', codeBody({ redirect_uri: SELF + '/oauth/callback2' })), {}, 400, 'invalid_redirect_uri'],
    ]
    it.each(cases)('%s → %i', async (_, req, over, status, error) => {
      const up = upstream()
      const r = await handleOAuth(req(), env(over), up.fn)
      expect(r.status).toBe(status)
      expect(await r.json()).toEqual({ error })
      expect(r.headers.get('content-type')).toBe('application/json')
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(up.seen).toHaveLength(0)
    })
  })

  describe('origins and CORS', () => {
    it('allows ALLOWED_ORIGINS, echoes it (never *), and checks the redirect against that origin', async () => {
      const e = env({ ALLOWED_ORIGINS: ` ${OTHER} , https://x.example` })
      const ok = await handleOAuth(post('/api/oauth/gdrive/token', codeBody({ redirect_uri: OTHER + '/oauth/callback' }), { origin: OTHER }), e, upstream().fn)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('access-control-allow-origin')).toBe(OTHER)
      expect(ok.headers.get('vary')).toBe('Origin')
      const wrong = await handleOAuth(post('/api/oauth/gdrive/token', codeBody(), { origin: OTHER }), e, upstream().fn)
      expect(wrong.status).toBe(400)
      expect(await wrong.json()).toEqual({ error: 'invalid_redirect_uri' })
      expect(wrong.headers.get('access-control-allow-origin')).toBe(OTHER)
    })

    it('needs no CORS headers on its own origin', async () => {
      const r = await handleOAuth(post('/api/oauth/gdrive/token', refreshBody), env({ ALLOWED_ORIGINS: OTHER }), upstream().fn)
      expect(r.status).toBe(200)
      expect(r.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('answers the preflight for an allowed origin and refuses it for others', async () => {
      const pre = (origin: string) =>
        new Request(SELF + '/api/oauth/onedrive/token', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
      const up = upstream()
      const ok = await handleOAuth(pre(OTHER), env({ ALLOWED_ORIGINS: OTHER }), up.fn)
      expect(ok.status).toBe(204)
      expect(ok.headers.get('access-control-allow-origin')).toBe(OTHER)
      expect(ok.headers.get('access-control-allow-methods')).toBe('POST')
      expect(ok.headers.get('access-control-allow-headers')).toBe('content-type')
      expect(ok.headers.get('access-control-max-age')).toBe('600')
      const no = await handleOAuth(pre('https://evil.example'), env({ ALLOWED_ORIGINS: OTHER }), up.fn)
      expect(no.status).toBe(403)
      expect(no.headers.get('access-control-allow-origin')).toBeNull()
      expect(up.seen).toHaveLength(0)
    })
  })

  describe('rate limit', () => {
    it('limits per IP and provider, with Retry-After: 60, before reading the body', async () => {
      const counts = new Map<string, number>()
      const OAUTH_LIMITER = {
        limit: vi.fn(async ({ key }: { key: string }) => {
          counts.set(key, (counts.get(key) ?? 0) + 1)
          return { success: counts.get(key)! <= 30 }
        }),
      } as unknown as RateLimit
      const e = env({ OAUTH_LIMITER })
      const up = upstream()
      for (let i = 0; i < 30; i++) expect((await handleOAuth(post('/api/oauth/gdrive/token', refreshBody), e, up.fn)).status).toBe(200)
      const r = await handleOAuth(post('/api/oauth/gdrive/token', null, { raw: 'not json' }), e, up.fn)
      expect(r.status).toBe(429)
      expect(r.headers.get('retry-after')).toBe('60')
      expect(await r.json()).toEqual({ error: 'rate_limited' })
      // Another provider and another IP have their own budget.
      expect((await handleOAuth(post('/api/oauth/onedrive/token', refreshBody), e, up.fn)).status).toBe(200)
      expect((await handleOAuth(post('/api/oauth/gdrive/token', refreshBody, { headers: { 'cf-connecting-ip': '198.51.100.1' } }), e, up.fn)).status).toBe(200)
      expect([...counts.keys()].sort()).toEqual(['198.51.100.1:gdrive', '203.0.113.7:gdrive', '203.0.113.7:onedrive'])
      expect(up.seen).toHaveLength(32)
    })

    it('is checked after the origin', async () => {
      const OAUTH_LIMITER = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit
      const r = await handleOAuth(post('/api/oauth/gdrive/token', refreshBody, { origin: 'https://evil.example' }), env({ OAUTH_LIMITER }), upstream().fn)
      expect(r.status).toBe(403)
      expect(OAUTH_LIMITER.limit).not.toHaveBeenCalled()
    })
  })
})
