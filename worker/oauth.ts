/**
 * Stateless OAuth token route for Google Drive and OneDrive (docs/SYNC-DRIVES.md §6). The Worker holds the
 * client secrets and stores nothing.
 *
 *   GET  /api/oauth/providers                     → { v: 1, providers: { gdrive?: {clientId}, onedrive?: {clientId} } }
 *   POST /api/oauth/{gdrive|onedrive}/token       → code exchange or refresh, proxied to the provider
 *
 * STEP-0 SKELETON: routing, the providers list and the response headers are real; the token exchange
 * answers 501 until WP-O implements §6.1–§6.2 (validation, CORS for other allowed origins, rate limit,
 * upstream call). Never log bodies, tokens, codes or query strings.
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

function clientOf(env: OAuthEnv, kind: OAuthWorkerKind): { id: string; secret: string } | null {
  const id = (kind === 'gdrive' ? env.GDRIVE_CLIENT_ID : env.ONEDRIVE_CLIENT_ID)?.trim()
  const secret = kind === 'gdrive' ? env.GDRIVE_CLIENT_SECRET : env.ONEDRIVE_CLIENT_SECRET
  return id && secret ? { id, secret } : null
}

/** §6.2 rule 4. CORS headers (for allowed cross-origin callers) are added by WP-O. */
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

const fail = (status: number, error: string, extra?: Record<string, string>) => oauthJson({ error }, status, extra)

/**
 * Handles every `/api/oauth/*` request. `upstream` is the fetch used for the provider token endpoints
 * (tests pass a fake).
 */
export async function handleOAuth(request: Request, env: OAuthEnv, upstream: typeof fetch = fetch): Promise<Response> {
  void upstream
  const url = new URL(request.url)
  const rest = url.pathname.slice(OAUTH_PREFIX.length)

  if (rest === 'providers') {
    if (request.method !== 'GET') return fail(405, 'method_not_allowed', { allow: 'GET' })
    const providers: Partial<Record<OAuthWorkerKind, { clientId: string }>> = {}
    for (const k of KINDS) {
      const c = clientOf(env, k)
      if (c) providers[k] = { clientId: c.id }
    }
    return oauthJson({ v: 1, providers })
  }

  const m = /^(gdrive|onedrive)\/token$/.exec(rest)
  if (!m) return fail(404, 'not_found')
  const kind = m[1] as OAuthWorkerKind
  if (request.method !== 'POST' && request.method !== 'OPTIONS') return fail(405, 'method_not_allowed', { allow: 'POST, OPTIONS' })
  if (!clientOf(env, kind)) return fail(503, 'not_configured')
  return fail(501, 'not_implemented')
}
