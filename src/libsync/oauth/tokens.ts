/**
 * This device's OAuth tokens for one library (docs/SYNC-DRIVES.md §5.4). Stored in `syncState.oauth[kind]`
 * of the library DB: per device and per library, the trust domain of the library secret. Never in pairing
 * codes, backups or sync.
 *
 * `tokenSource(db, kind)` is the `AccessTokenSource` the drive backends get through `BackendContext.auth`
 * (`OAuthHttp` calls `token()` per request and `refreshAfter401()` on a 401). Refreshes run one at a time
 * per (library, provider): in this tab through a shared promise, across tabs under the Web Lock
 * `openstand-oauth:<db>:<kind>`, re-reading storage first so a refresh another tab just did is reused.
 */
import type { OpenStandDB } from '../../db/db'
import { BackendError, type AccessTokenSource, type OAuthKind, type TokenSet } from '../backends/types'
import { getState, putState } from '../state'
import { PROVIDERS } from './config'
import { DEFAULT_EXPIRES_IN, hasRequiredScope, refreshGrant, revokeRemote, TokenEndpointError, type OAuthDeps } from './providers'

/** `token()` refreshes when the access token expires within this. */
export const REFRESH_LEAD = 5 * 60_000
/** After a 401, a token another tab stored is reused if it's still valid for this long. */
const FRESH_AFTER_401 = 60_000
/** A refresh that fails for want of a network still returns the old token if it's valid for this long. */
const STILL_USABLE = 30_000

export interface TokenDeps extends OAuthDeps {
  now?: () => number
  /** Web Locks; `null` = in-tab single flight only (Node tests, old Safari). Defaults to `navigator.locks`. */
  locks?: Pick<LockManager, 'request'> | null
}

export async function readTokens(db: OpenStandDB, kind: OAuthKind): Promise<TokenSet | undefined> {
  return (await getState(db, 'oauth'))?.[kind]
}

/** Store (replace) the tokens of `kind`, keeping the other providers' tokens. */
export async function storeTokens(db: OpenStandDB, kind: OAuthKind, t: TokenSet): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    await putState(db, 'oauth', { ...((await getState(db, 'oauth')) ?? {}), [kind]: t })
  })
}

/** Delete the tokens of `kind` (all providers without one). */
export async function removeTokens(db: OpenStandDB, kind?: OAuthKind): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    const cur = (await getState(db, 'oauth')) ?? {}
    if (kind) delete cur[kind]
    if (!kind || !Object.keys(cur).length) await db.syncState.delete('oauth')
    else await putState(db, 'oauth', cur)
  })
}

/**
 * Forget this device's sign-in to `kind` for this library: Dropbox's token is revoked first (best effort,
 * §5.4; Google and Microsoft only delete locally), then the tokens are deleted. `revoke: false` skips the
 * revoke. Never throws for the revoke.
 */
export async function forgetTokens(db: OpenStandDB, kind: OAuthKind, o: TokenDeps & { revoke?: boolean } = {}): Promise<void> {
  if (o.revoke !== false && kind === 'dropbox' && (await readTokens(db, kind))) {
    try {
      const token = await withTimeout(tokenSource(db, kind, o).token(), 8000)
      if (token) await revokeRemote(kind, token, o)
    } catch {
      /* no usable token: nothing to revoke */
    }
  }
  await removeTokens(db, kind)
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])

/** Maps a failed refresh to the error the backends throw (§5.4 "Refresh outcomes"). */
export function refreshError(kind: OAuthKind, e: unknown): BackendError {
  const name = PROVIDERS[kind].name
  if (!(e instanceof TokenEndpointError)) return new BackendError('network', `Can’t reach ${name}`, { cause: e })
  const o = { status: e.status, providerCode: e.error, cause: e }
  switch (e.failure) {
    case 'grant':
      return new BackendError('reauth', `Sign in to ${name} again to keep syncing.`, o)
    case 'config':
      return new BackendError('unknown', `Sign-in for ${name} isn’t set up correctly on this site.`, { ...o, providerCode: 'OAuthConfig' })
    case 'rateLimited':
      return new BackendError('rateLimited', `${name} asked OpenStand to slow down.`, { ...o, retryAfterMs: e.retryAfterMs })
    case 'network':
      return new BackendError('network', `Can’t reach ${name}`, o)
    default:
      // Any other refusal of a refresh token (`invalid_request`, an unknown code) can't fix itself.
      return new BackendError('reauth', `${name} refused the saved sign-in. Sign in again.`, o)
  }
}

/** In-tab single flight: one refresh per `${db.name}:${kind}`. */
const flights = new Map<string, Promise<TokenSet>>()

class StoredTokenSource implements AccessTokenSource {
  readonly kind: OAuthKind
  private readonly db: OpenStandDB
  private readonly d: TokenDeps
  private mem?: TokenSet

  constructor(db: OpenStandDB, kind: OAuthKind, d: TokenDeps) {
    this.db = db
    this.kind = kind
    this.d = d
  }

  private now() {
    return (this.d.now ?? Date.now)()
  }

  private noTokens() {
    return new BackendError('reauth', `Not signed in to ${PROVIDERS[this.kind].name}`, { providerCode: 'NoTokens' })
  }

  async token(o: { signal?: AbortSignal } = {}): Promise<string> {
    o.signal?.throwIfAborted()
    const t = this.mem ?? (this.mem = await readTokens(this.db, this.kind))
    if (!t) throw this.noTokens()
    if (t.expiresAt - this.now() > REFRESH_LEAD) return t.accessToken
    try {
      return await this.refresh(t.accessToken, REFRESH_LEAD, o.signal)
    } catch (e) {
      // Offline a few minutes before expiry: the old token still works for now.
      if (e instanceof BackendError && e.code === 'network' && t.expiresAt - this.now() > STILL_USABLE) return t.accessToken
      throw e
    }
  }

  async refreshAfter401(rejected: string, o: { signal?: AbortSignal } = {}): Promise<string> {
    o.signal?.throwIfAborted()
    return this.refresh(rejected, FRESH_AFTER_401, o.signal)
  }

  private async refresh(prev: string, minLeft: number, signal?: AbortSignal): Promise<string> {
    const key = `${this.db.name}:${this.kind}`
    let flight = flights.get(key)
    if (!flight) {
      flight = this.locked(key, () => this.refreshLocked(prev, minLeft)).finally(() => {
        if (flights.get(key) === flight) flights.delete(key)
      })
      flights.set(key, flight)
    }
    const t = await abortable(flight, signal)
    this.mem = t
    return t.accessToken
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const locks = this.d.locks === undefined ? globalThis.navigator?.locks : this.d.locks
    if (!locks) return fn()
    return locks.request(`openstand-oauth:${key}`, fn) as Promise<T>
  }

  /** Inside the lock: reuse what another tab stored, else refresh and store the merged set. */
  private async refreshLocked(prev: string, minLeft: number): Promise<TokenSet> {
    const stored = await readTokens(this.db, this.kind)
    if (!stored) throw this.noTokens()
    if (stored.accessToken !== prev && stored.expiresAt - this.now() > minLeft) return stored
    if (!stored.refreshToken) throw new BackendError('reauth', `Sign in to ${PROVIDERS[this.kind].name} again to keep syncing.`, { providerCode: 'NoRefreshToken' })
    let r
    try {
      r = await refreshGrant(this.kind, stored.refreshToken, this.d)
    } catch (e) {
      throw refreshError(this.kind, e)
    }
    // Access to the folder was taken back (Google's granular consent, a changed app registration).
    if (!hasRequiredScope(this.kind, r.scope))
      throw new BackendError('reauth', `${PROVIDERS[this.kind].name} no longer gives OpenStand access to its folder. Sign in again.`, { providerCode: 'scope' })
    const next: TokenSet = {
      ...stored,
      accessToken: r.access_token,
      expiresAt: this.now() + (r.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
      // Microsoft rotates refresh tokens: always keep the newest. The others keep the old one.
      refreshToken: r.refresh_token ?? stored.refreshToken,
      scope: r.scope ?? stored.scope,
    }
    const db = this.db
    return db.transaction('rw', db.syncState, async () => {
      const cur = (await getState(db, 'oauth')) ?? {}
      const now = cur[this.kind]
      // Signed out meanwhile ("Stop syncing"): don't bring the tokens back.
      if (!now) throw this.noTokens()
      // A new sign-in replaced the tokens while we refreshed: those win.
      if (now.refreshToken !== stored.refreshToken) return now
      await putState(db, 'oauth', { ...cur, [this.kind]: next })
      return next
    })
  }
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** The `AccessTokenSource` for `kind` in library `db` (§5.4). Cheap: make one per backend. */
export function tokenSource(db: OpenStandDB, kind: OAuthKind, deps: TokenDeps = {}): AccessTokenSource {
  return new StoredTokenSource(db, kind, deps)
}
