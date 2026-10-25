/**
 * Per-provider OAuth requests: the authorize URL, the token endpoint (Dropbox
 * directly with PKCE and no secret; Google and Microsoft through our Worker), the granted-scope check,
 * who signed in, and the Dropbox revoke. Never log or put in errors: codes, verifiers or tokens.
 */
import type { AccountInfo, OAuthKind } from '../backends/types'
import { PROVIDERS, oauthClientId } from './config'
import { fromB64url } from './pkce'

export interface OAuthDeps {
  fetch?: typeof fetch
  /** Base for the Worker routes (`/api/oauth/…`); defaults to `location.origin`. */
  origin?: string
  /** Client id lookup (defaults to `oauthClientId`). */
  clientId?: (kind: OAuthKind) => string | null
}

const fetchOf = (d: OAuthDeps): typeof fetch => d.fetch ?? ((i, init) => fetch(i, init))
const originOf = (d: OAuthDeps) => d.origin ?? globalThis.location?.origin ?? ''
export const clientIdOf = (kind: OAuthKind, d: OAuthDeps = {}) => (d.clientId ?? ((k) => oauthClientId(k)))(kind)

// ---------------------------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------------------------

/**
 * Extra authorize parameters on top of `PROVIDERS[kind].authorizeParams`. Google: the new token also covers
 * scopes granted before (incremental authorisation; harmless with one scope, and what Google recommends).
 */
const EXTRA_AUTHORIZE: Partial<Record<OAuthKind, Record<string, string>>> = {
  gdrive: { include_granted_scopes: 'true' },
}

export function authorizeUrl(
  kind: OAuthKind,
  p: { clientId: string; redirectUri: string; codeChallenge: string; state: string; chooseAccount?: boolean; loginHint?: string },
): string {
  const spec = PROVIDERS[kind]
  const q = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, ...spec.authorizeParams, ...EXTRA_AUTHORIZE[kind] })
  if (p.chooseAccount) for (const [k, v] of Object.entries(spec.chooseAccountParams)) q.set(k, v)
  if (p.loginHint && spec.loginHintParam && !p.chooseAccount) q.set(spec.loginHintParam, p.loginHint.slice(0, 320))
  q.set('code_challenge', p.codeChallenge)
  q.set('state', p.state)
  // URLSearchParams writes spaces as '+'; providers accept both, but %20 is what their docs show.
  return `${spec.authorizeUrl}?${q.toString().replace(/\+/g, '%20')}`
}

// ---------------------------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------------------------

/** What the token endpoint (or the Worker, which passes only these fields) answers. */
export interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  id_token?: string
}

/**
 * Why a token request failed, provider-neutral:
 * - `network`: no answer, a provider 5xx or the Worker's 502;
 * - `grant`: the grant is gone (`invalid_grant`, revoked consent, …): sign in again;
 * - `config`: the client or the Worker is misconfigured (`invalid_client`, 503 `not_configured`, …);
 * - `rateLimited`: 429;
 * - `rejected`: any other refusal.
 */
export type TokenFailure = 'network' | 'grant' | 'config' | 'rateLimited' | 'rejected'

export class TokenEndpointError extends Error {
  readonly failure: TokenFailure
  readonly status?: number
  /** The OAuth `error` code (never a description: those may echo request data). */
  readonly error?: string
  readonly retryAfterMs?: number
  constructor(failure: TokenFailure, o: { status?: number; error?: string; retryAfterMs?: number; cause?: unknown } = {}) {
    super(`OAuth token request failed: ${failure}${o.error ? ` (${o.error})` : ''}${o.status ? ` [${o.status}]` : ''}`, o.cause === undefined ? undefined : { cause: o.cause })
    this.name = 'TokenEndpointError'
    this.failure = failure
    this.status = o.status
    this.error = o.error
    this.retryAfterMs = o.retryAfterMs
  }
}

const GRANT_GONE = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required'])
const MISCONFIGURED = new Set([
  'invalid_client',
  'unauthorized_client',
  'not_configured',
  'origin_not_allowed',
  'invalid_redirect_uri',
  'unsupported_media_type',
  'method_not_allowed',
  'not_found',
])

export function classifyTokenError(status: number, error: string | undefined, retryAfter?: string | null): TokenEndpointError {
  if (status === 429) {
    const s = Number(retryAfter)
    return new TokenEndpointError('rateLimited', { status, error, retryAfterMs: Number.isFinite(s) && s > 0 ? Math.min(s, 3600) * 1000 : 60_000 })
  }
  if (error && MISCONFIGURED.has(error)) return new TokenEndpointError('config', { status, error })
  if (error && GRANT_GONE.has(error)) return new TokenEndpointError('grant', { status, error })
  if (status >= 500) return new TokenEndpointError('network', { status, error })
  return new TokenEndpointError('rejected', { status, error })
}

const MAX_ANSWER = 64 * 1024

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text()
    if (text.length > MAX_ANSWER) return null
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function tokenRequest(kind: OAuthKind, grant: { code: string; verifier: string; redirectUri: string } | { refreshToken: string }, d: OAuthDeps): Promise<TokenResponse> {
  const spec = PROVIDERS[kind]
  let url: string
  let init: RequestInit
  if (spec.viaWorker) {
    url = new URL(spec.tokenUrl, originOf(d) || 'http://localhost').toString()
    const body =
      'code' in grant
        ? { grant: 'code', code: grant.code, code_verifier: grant.verifier, redirect_uri: grant.redirectUri }
        : { grant: 'refresh', refresh_token: grant.refreshToken }
    init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }
  } else {
    const clientId = clientIdOf(kind, d)
    if (!clientId) throw new TokenEndpointError('config', { error: 'no_client_id' })
    url = spec.tokenUrl
    const form = new URLSearchParams(
      'code' in grant
        ? { grant_type: 'authorization_code', code: grant.code, code_verifier: grant.verifier, client_id: clientId, redirect_uri: grant.redirectUri }
        : { grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: clientId },
    )
    init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() }
  }
  let res: Response
  try {
    res = await fetchOf(d)(url, { ...init, credentials: 'omit', signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw new TokenEndpointError('network', { cause: e })
  }
  const json = await readJson(res)
  if (!res.ok) {
    const error = typeof json?.error === 'string' ? json.error.slice(0, 100) : undefined
    throw classifyTokenError(res.status, error, res.headers.get('retry-after'))
  }
  if (!json || typeof json.access_token !== 'string' || !json.access_token) throw new TokenEndpointError(res.status >= 500 ? 'network' : 'rejected', { status: res.status, error: 'bad_answer' })
  const str = (k: string) => (typeof json[k] === 'string' && json[k] ? (json[k] as string) : undefined)
  const expires = Number(json.expires_in)
  return {
    access_token: json.access_token,
    token_type: str('token_type'),
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : undefined,
    refresh_token: str('refresh_token'),
    scope: str('scope'),
    id_token: str('id_token'),
  }
}

/** Code → tokens. Throws `TokenEndpointError`. */
export const exchangeCode = (kind: OAuthKind, p: { code: string; verifier: string; redirectUri: string }, d: OAuthDeps = {}) => tokenRequest(kind, p, d)

/** Refresh token → new access token (and, for Microsoft, a new refresh token). Throws `TokenEndpointError`. */
export const refreshGrant = (kind: OAuthKind, refreshToken: string, d: OAuthDeps = {}) => tokenRequest(kind, { refreshToken }, d)

/** Access tokens without `expires_in` are assumed to last this long. */
export const DEFAULT_EXPIRES_IN = 3600

// ---------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------

const GRAPH_PREFIX = 'https://graph.microsoft.com/'

/**
 * Whether `scope` (the space-separated granted scopes) includes the one OpenStand needs. An answer without
 * `scope` passes: the identity call that follows fails instead if access is missing. Microsoft scopes match
 * case-insensitively, with or without the Graph prefix.
 */
export function hasRequiredScope(kind: OAuthKind, scope: string | undefined): boolean {
  if (scope === undefined) return true
  const need = PROVIDERS[kind].requiredScope
  const granted = scope.split(/[\s,]+/).filter(Boolean)
  if (kind !== 'onedrive') return granted.includes(need)
  const norm = (s: string) => (s.toLowerCase().startsWith(GRAPH_PREFIX) ? s.slice(GRAPH_PREFIX.length) : s).toLowerCase()
  return granted.some((g) => norm(g) === norm(need))
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/** Why identifying the account failed: no answer, or the token was refused (`scope`: missing access). */
export class IdentityError extends Error {
  readonly failure: 'network' | 'scope' | 'rejected'
  readonly status?: number
  constructor(failure: 'network' | 'scope' | 'rejected', status?: number, cause?: unknown) {
    super(`Couldn't identify the account: ${failure}${status ? ` [${status}]` : ''}`, cause === undefined ? undefined : { cause })
    this.name = 'IdentityError'
    this.failure = failure
    this.status = status
  }
}

/** Claims of a JWT, decoded but **not verified**: display only (it came over TLS from our Worker). */
export function jwtClaims(jwt: string | undefined): Record<string, unknown> {
  try {
    const part = jwt?.split('.')[1]
    if (!part || part.length > 16384) return {}
    const v: unknown = JSON.parse(new TextDecoder().decode(fromB64url(part)))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const clip = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)

async function identityCall(d: OAuthDeps, url: string, token: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchOf(d)(url, { ...init, credentials: 'omit', headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw new IdentityError('network', undefined, e)
  }
  const json = await readJson(res)
  if (res.ok && json) return json
  if (res.status >= 500 || res.status === 429) throw new IdentityError('network', res.status)
  // Google answers 403 insufficientPermissions when Drive access was unticked; Dropbox 401 missing_scope.
  if (res.status === 401 || res.status === 403) throw new IdentityError('scope', res.status)
  throw new IdentityError('rejected', res.status)
}

/** Who signed in. `id` is the `accountId` of `BackendConfig`. Throws `IdentityError`. */
export async function identify(kind: OAuthKind, t: TokenResponse, d: OAuthDeps = {}): Promise<AccountInfo> {
  if (kind === 'dropbox') {
    const j = await identityCall(d, 'https://api.dropboxapi.com/2/users/get_current_account', t.access_token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    })
    const id = clip(j.account_id, 200)
    if (!id) throw new IdentityError('rejected')
    const name = j.name && typeof j.name === 'object' ? clip((j.name as Record<string, unknown>).display_name, 200) : undefined
    return { id, email: clip(j.email, 320), name }
  }
  if (kind === 'gdrive') {
    const j = await identityCall(d, 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,permissionId)', t.access_token)
    const u = (j.user ?? {}) as Record<string, unknown>
    const id = clip(u.permissionId, 200)
    if (!id) throw new IdentityError('rejected')
    return { id, email: clip(u.emailAddress, 320), name: clip(u.displayName, 200) }
  }
  // Also creates the app folder on first use.
  const j = await identityCall(d, 'https://graph.microsoft.com/v1.0/me/drive/special/approot?$select=parentReference', t.access_token)
  const id = clip((j.parentReference as Record<string, unknown> | undefined)?.driveId, 200)
  if (!id) throw new IdentityError('rejected')
  const c = jwtClaims(t.id_token)
  return { id, email: clip(c.email, 320) ?? clip(c.preferred_username, 320), name: clip(c.name, 200) }
}

// ---------------------------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------------------------

/**
 * "Stop syncing": Dropbox revokes this device's token (and with it the refresh token), nothing else.
 * Google's revoke would remove the app's grant on every device, and Microsoft has none for this flow: those
 * only delete locally. Returns whether a request was made and accepted. Never throws.
 */
export async function revokeRemote(kind: OAuthKind, accessToken: string, d: OAuthDeps = {}): Promise<boolean> {
  if (kind !== 'dropbox') return false
  try {
    const res = await fetchOf(d)('https://api.dropboxapi.com/2/auth/token/revoke', {
      method: 'POST',
      credentials: 'omit',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    })
    await res.body?.cancel().catch(() => {})
    return res.ok
  } catch {
    return false
  }
}
