/**
 * Stateless OAuth token route for Google Drive and OneDrive (docs/SYNC-DRIVES.md §6). The Worker holds the
 * client secrets and stores nothing.
 *
 *   GET  /api/oauth/providers                     → { v: 1, providers: { gdrive?: {clientId}, onedrive?: {clientId} } }
 *   POST /api/oauth/{gdrive|onedrive}/token       → code exchange or refresh, proxied to the provider
 *
 * Checks run in the §6.2 order: method → provider → configured → Origin → rate limit → content type → size →
 * JSON → fields → redirect URI → upstream. Never log bodies, tokens, codes or query strings: at most the
 * provider, the grant, the upstream status and the OAuth error code.
 */

export type OAuthWorkerKind = 'gdrive' | 'onedrive'

/**
 * What the route reads from the environment. Declared loosely (not `Env`) so tests can pass plain
 * objects, and because the secrets aren't in the generated `Env` (they're set with `wrangler secret put`,
 * not in wrangler.jsonc). `Env` is assignable to it.
 */
export interface OAuthEnv {
  /** Comma-separated extra origins; empty = the Worker's own origin only (§6.2 rule 2). */
  ALLOWED_ORIGINS?: string
  GDRIVE_CLIENT_ID?: string
  ONEDRIVE_CLIENT_ID?: string
  GDRIVE_CLIENT_SECRET?: string
  ONEDRIVE_CLIENT_SECRET?: string
  /** 30 requests / 60 s per `${cf-connecting-ip}:${provider}` (§6.2 rule 6). */
  OAUTH_LIMITER?: RateLimit
}

export const OAUTH_PREFIX = '/api/oauth/'
const KINDS: readonly OAuthWorkerKind[] = ['gdrive', 'onedrive']

/** Upstream token endpoints (§6.2 rule 5). */
export const TOKEN_ENDPOINTS: Record<OAuthWorkerKind, string> = {
  gdrive: 'https://oauth2.googleapis.com/token',
  onedrive: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
}
/** Sent with both OneDrive grants; keep in step with `PROVIDERS.onedrive` in src/libsync/oauth/config.ts. */
export const ONEDRIVE_SCOPE = 'offline_access openid profile email Files.ReadWrite.AppFolder'

export const MAX_BODY = 16 * 1024
export const UPSTREAM_TIMEOUT = 10_000
const MAX_UPSTREAM_ANSWER = 64 * 1024
const CALLBACK_PATH = '/oauth/callback'
/** Fields passed back from a successful upstream answer; nothing else is (§6.1). */
const TOKEN_FIELDS = ['access_token', 'token_type', 'expires_in', 'refresh_token', 'scope', 'id_token'] as const

function clientOf(env: OAuthEnv, kind: OAuthWorkerKind): { id: string; secret: string } | null {
  const id = (kind === 'gdrive' ? env.GDRIVE_CLIENT_ID : env.ONEDRIVE_CLIENT_ID)?.trim()
  const secret = (kind === 'gdrive' ? env.GDRIVE_CLIENT_SECRET : env.ONEDRIVE_CLIENT_SECRET)?.trim()
  return id && secret ? { id, secret } : null
}

/** §6.2 rule 4, plus `extra` (CORS for allowed cross-origin callers, `Allow`, `Retry-After`). */
export function oauthJson(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  })
}

/** The Worker's own origin plus `ALLOWED_ORIGINS`. Unlike the relay, empty means "own origin only". */
function originAllowed(origin: string | null, self: string, env: OAuthEnv): origin is string {
  if (!origin || origin === 'null') return false
  if (origin === self) return true
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin)
}

/** Echo an allowed cross-origin caller (never `*`); same-origin calls need no CORS headers. */
function corsFor(origin: string | null, self: string, env: OAuthEnv): Record<string, string> {
  return originAllowed(origin, self, env) && origin !== self ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}
}

type Fields = { grant: 'code'; code: string; code_verifier: string; redirect_uri: string } | { grant: 'refresh'; refresh_token: string }

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const str = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max

/** §6.1 field rules: exact key sets, lengths, and the verifier alphabet. */
function parseFields(body: unknown): Fields | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const keys = Object.keys(b).sort().join(',')
  if (b.grant === 'code') {
    if (keys !== 'code,code_verifier,grant,redirect_uri') return null
    if (!str(b.code, 1, 4096) || !str(b.code_verifier, 43, 128) || !VERIFIER.test(b.code_verifier) || !str(b.redirect_uri, 1, 2048)) return null
    return { grant: 'code', code: b.code, code_verifier: b.code_verifier, redirect_uri: b.redirect_uri }
  }
  if (b.grant === 'refresh') {
    if (keys !== 'grant,refresh_token' || !str(b.refresh_token, 1, 8192)) return null
    return { grant: 'refresh', refresh_token: b.refresh_token }
  }
  return null
}

/** Reads at most `max` bytes; `null` once the stream passes it (the rest isn't read). */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0)
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

/** The form body for the provider (§6.2 rule 5 table). */
function upstreamForm(kind: OAuthWorkerKind, f: Fields, client: { id: string; secret: string }): URLSearchParams {
  const form = new URLSearchParams()
  if (f.grant === 'code') {
    form.set('grant_type', 'authorization_code')
    form.set('code', f.code)
    form.set('code_verifier', f.code_verifier)
    form.set('redirect_uri', f.redirect_uri)
  } else {
    form.set('grant_type', 'refresh_token')
    form.set('refresh_token', f.refresh_token)
  }
  form.set('client_id', client.id)
  form.set('client_secret', client.secret)
  if (kind === 'onedrive') form.set('scope', ONEDRIVE_SCOPE)
  return form
}

/** An OAuth `error` code is a short token; anything else from upstream isn't passed on. */
const errorCode = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : undefined)

/**
 * Handles every `/api/oauth/*` request. `upstream` is the fetch used for the provider token endpoints
 * (tests pass a fake).
 */
export async function handleOAuth(request: Request, env: OAuthEnv, upstream: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url)
  const self = url.origin
  const origin = request.headers.get('origin')
  const cors = corsFor(origin, self, env)
  const fail = (status: number, error: string, extra?: Record<string, string>) => oauthJson({ error }, status, { ...cors, ...extra })
  const rest = url.pathname.slice(OAUTH_PREFIX.length)

  if (rest === 'providers') {
    if (request.method !== 'GET') return fail(405, 'method_not_allowed', { allow: 'GET' })
    const providers: Partial<Record<OAuthWorkerKind, { clientId: string }>> = {}
    for (const k of KINDS) {
      const c = clientOf(env, k)
      if (c) providers[k] = { clientId: c.id }
    }
    return oauthJson({ v: 1, providers }, 200, cors)
  }

  const m = /^([^/]+)\/token$/.exec(rest)
  if (!m) return fail(404, 'not_found')
  if (request.method !== 'POST' && request.method !== 'OPTIONS') return fail(405, 'method_not_allowed', { allow: 'POST, OPTIONS' })
  if (!(KINDS as readonly string[]).includes(m[1])) return fail(404, 'not_found')
  const kind = m[1] as OAuthWorkerKind
  const client = clientOf(env, kind)
  if (!client) return fail(503, 'not_configured')
  if (!originAllowed(origin, self, env)) return fail(403, 'origin_not_allowed')

  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      },
    })

  if (env.OAUTH_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const { success } = await env.OAUTH_LIMITER.limit({ key: `${ip}:${kind}` })
    if (!success) return fail(429, 'rate_limited', { 'retry-after': '60' })
  }

  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return fail(415, 'unsupported_media_type')
  const declared = request.headers.get('content-length')
  if (declared !== null && !(Number(declared) <= MAX_BODY)) return fail(413, 'too_large')
  const raw = await readCapped(request.body, MAX_BODY)
  if (!raw) return fail(413, 'too_large')

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw))
  } catch {
    return fail(400, 'invalid_request')
  }
  const fields = parseFields(body)
  if (!fields) return fail(400, 'invalid_request')
  if (fields.grant === 'code' && fields.redirect_uri !== origin + CALLBACK_PATH) return fail(400, 'invalid_redirect_uri')

  // A fresh request: only these two headers. Never Origin, cookies or anything else from the client —
  // Microsoft refuses Web-platform codes redeemed with an Origin header (§6.2 rule 5).
  let res: Response
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('upstream timeout')), UPSTREAM_TIMEOUT)
  try {
    res = await upstream(
      new Request(TOKEN_ENDPOINTS[kind], {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: upstreamForm(kind, fields, client).toString(),
        redirect: 'manual',
        signal: ac.signal,
      }),
    )
  } catch {
    clearTimeout(timer)
    log(kind, fields.grant, 0, 'unreachable')
    return fail(502, 'upstream_unavailable')
  }

  let answer: Record<string, unknown> | null = null
  try {
    const bytes = await readCapped(res.body, MAX_UPSTREAM_ANSWER)
    const v: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null
    if (v && typeof v === 'object' && !Array.isArray(v)) answer = v as Record<string, unknown>
  } catch {
    answer = null
  } finally {
    clearTimeout(timer)
  }

  if (res.status >= 500 || !answer) {
    log(kind, fields.grant, res.status, answer ? errorCode(answer.error) : 'not_json')
    return fail(502, 'upstream_unavailable')
  }
  if (res.status >= 400) {
    const error = errorCode(answer.error) ?? 'invalid_request'
    log(kind, fields.grant, res.status, error)
    const out: { error: string; error_description?: string } = { error }
    if (typeof answer.error_description === 'string' && answer.error_description) out.error_description = answer.error_description.slice(0, 300)
    return oauthJson(out, res.status, cors)
  }
  if (res.status !== 200 || typeof answer.access_token !== 'string' || !answer.access_token) {
    log(kind, fields.grant, res.status, 'bad_answer')
    return fail(502, 'upstream_unavailable')
  }
  const out: Record<string, unknown> = {}
  for (const k of TOKEN_FIELDS) if (answer[k] !== undefined) out[k] = answer[k]
  log(kind, fields.grant, res.status)
  return oauthJson(out, 200, cors)
}

/** §6.2 rule 7: provider, grant, upstream status and error code. Never more. */
function log(kind: OAuthWorkerKind, grant: string, status: number, error?: string) {
  console.log('oauth', kind, grant, status, error ?? '')
}
