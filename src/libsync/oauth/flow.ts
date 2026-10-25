/**
 * Cloud-drive sign-in (docs/SYNC-DRIVES.md §5.2): a full-page redirect with PKCE and `state`, resumed from
 * the pending slot in localStorage (`oauth/callback.ts`), and which providers to offer (§6.4).
 */
import { db as currentDb, OpenStandDB } from '../../db/db'
import type { AccountInfo, OAuthKind, TokenSet } from '../backends/types'
import { getConfig } from '../state'
import { clearPending, PENDING_TTL, readPending, writePending } from './callback'
import { PROVIDERS, oauthClientId, redirectUri as redirectUriFor } from './config'
import { challengeS256, newState, newVerifier } from './pkce'
import { authorizeUrl, clientIdOf, DEFAULT_EXPIRES_IN, exchangeCode, hasRequiredScope, identify, IdentityError, TokenEndpointError, type OAuthDeps } from './providers'
import { readTokens, storeTokens } from './tokens'
import type { PendingSignIn, SignInErrorCode, SignInIntent, SignInResult } from './types'

/** A sign-in failed (§5.5). `want`/`got`: the expected and the signed-in account (`wrongAccount`). */
export class SignInError extends Error {
  readonly code: SignInErrorCode
  readonly kind: OAuthKind
  readonly want?: string
  readonly got?: string
  constructor(code: SignInErrorCode, kind: OAuthKind, o: { want?: string; got?: string; cause?: unknown } = {}) {
    super(signInMessage(code, kind, o), o.cause === undefined ? undefined : { cause: o.cause })
    this.name = 'SignInError'
    this.code = code
    this.kind = kind
    this.want = o.want
    this.got = o.got
  }
}

/** The §5.5 wording. */
export function signInMessage(code: SignInErrorCode, kind: OAuthKind, o: { want?: string; got?: string } = {}): string {
  const name = PROVIDERS[kind].name
  switch (code) {
    case 'denied':
      return 'Sign-in was cancelled.'
    case 'expired':
      return 'That sign-in took too long or was started elsewhere. Please try again.'
    case 'scope':
      return `OpenStand needs access to its own files in ${name}. Sign in again and allow it.`
    case 'wrongAccount':
      return o.got && o.want
        ? `You signed in as ${o.got}, but this library is in ${o.want}.`
        : `You signed in with a different ${name} account than the one this library is in.`
    case 'exchange':
      return `${name} didn’t accept the sign-in. Please try again.`
    case 'notConfigured':
      return `Sign-in with ${name} isn’t available on this site.`
    case 'network':
      return `Can’t reach ${name}. Check your connection.`
  }
}

/**
 * How a sign-in error reaches the UI as a `LibSyncFailure` (§2.3): `denied`, `expired`, `exchange` and
 * `notConfigured` become `unknown`, `scope` becomes `reauth`; `wrongAccount` and `network` stay. `detail` is
 * the `SignInErrorCode`, except for `wrongAccount`, where it's the account the library is in (if known).
 */
export function signInFailure(e: SignInError): { code: 'unknown' | 'reauth' | 'wrongAccount' | 'network'; message: string; detail?: string } {
  const code = e.code === 'scope' ? 'reauth' : e.code === 'wrongAccount' || e.code === 'network' ? e.code : 'unknown'
  return { code, message: e.message, detail: e.code === 'wrongAccount' ? e.want : e.code }
}

export interface FlowDeps extends OAuthDeps {
  now?: () => number
  /** Leaves the page (default `location.assign`). */
  navigate?: (url: string) => void
  /** The library DB the tokens go to (default: the current one, or a connection opened by name). */
  openDb?: (name: string) => { db: OpenStandDB; close(): void }
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

/**
 * Saves the pending sign-in (one slot, overwritten by a new start) and leaves for the provider. Resolves only
 * where `navigate` returns (tests); in the browser the page goes away. Throws `SignInError('notConfigured')`.
 */
export async function startSignIn(
  kind: OAuthKind,
  intent: SignInIntent,
  o: { chooseAccount?: boolean; loginHint?: string } = {},
  d: FlowDeps & { db?: string } = {},
): Promise<string> {
  const clientId = clientIdOf(kind, d)
  if (!clientId) throw new SignInError('notConfigured', kind)
  const verifier = newVerifier()
  const state = newState()
  const redirectUri = redirectUriFor(d.origin ?? globalThis.location?.origin ?? '')
  const pending: PendingSignIn = { v: 1, kind, state, verifier, redirectUri, db: d.db ?? currentDb.name, intent, createdAt: (d.now ?? Date.now)() }
  writePending(pending)
  const url = authorizeUrl(kind, { clientId, redirectUri, codeChallenge: await challengeS256(verifier), state, ...o })
  ;(d.navigate ?? ((u) => location.assign(u)))(url)
  return url
}

// ---------------------------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------------------------

const DENIED = new Set(['access_denied', 'user_cancelled', 'consent_required', 'interaction_required'])

/** The account a re-sign-in must come back as: the intent's, else the library's, else the stored tokens'. */
async function expectedAccount(db: OpenStandDB, kind: OAuthKind, intent: SignInIntent, old: TokenSet | undefined) {
  if (intent.type !== 'reauth') return undefined
  const cfg = (await getConfig(db))?.backend
  const fromCfg = cfg && cfg.kind === kind ? cfg : undefined
  return {
    id: intent.accountId ?? fromCfg?.accountId ?? old?.accountId,
    email: fromCfg?.account ?? old?.account,
  }
}

function defaultOpenDb(name: string) {
  if (name === currentDb.name) return { db: currentDb, close() {} }
  const d = new OpenStandDB(name)
  return { db: d, close: () => d.close() }
}

/**
 * Completes the sign-in waiting in the pending slot (§5.2): deletes the slot first (single use), exchanges
 * the code, checks the granted scope, identifies the account, enforces the same account for `reauth`
 * (keeping the old tokens otherwise), and stores the tokens in `syncState.oauth[kind]` of the pending DB.
 * Throws `SignInError`.
 */
export async function completeSignIn(d: FlowDeps = {}): Promise<SignInResult & { db: string }> {
  const p = readPending()
  clearPending()
  if (!p?.ret) throw new SignInError('expired', p?.kind ?? 'dropbox')
  const { kind } = p
  const now = d.now ?? Date.now
  if (now() - p.createdAt > PENDING_TTL) throw new SignInError('expired', kind)
  if ('error' in p.ret) throw new SignInError(p.ret.error === 'expired' ? 'expired' : DENIED.has(p.ret.error) ? 'denied' : 'exchange', kind)
  if (!clientIdOf(kind, d)) throw new SignInError('notConfigured', kind)

  let t
  try {
    t = await exchangeCode(kind, { code: p.ret.code, verifier: p.verifier, redirectUri: p.redirectUri }, d)
  } catch (e) {
    const f = e instanceof TokenEndpointError ? e.failure : 'network'
    throw new SignInError(f === 'network' ? 'network' : f === 'config' ? 'notConfigured' : 'exchange', kind, { cause: e })
  }
  if (!hasRequiredScope(kind, t.scope)) throw new SignInError('scope', kind)
  let account: AccountInfo
  try {
    account = await identify(kind, t, d)
  } catch (e) {
    const f = e instanceof IdentityError ? e.failure : 'network'
    throw new SignInError(f === 'network' ? 'network' : f === 'scope' ? 'scope' : 'exchange', kind, { cause: e })
  }

  const { db, close } = (d.openDb ?? defaultOpenDb)(p.db)
  try {
    const old = await readTokens(db, kind)
    const want = await expectedAccount(db, kind, p.intent, old)
    if (want?.id && want.id !== account.id) throw new SignInError('wrongAccount', kind, { want: want.email ?? want.id, got: account.email ?? account.name ?? account.id })
    await storeTokens(db, kind, {
      accessToken: t.access_token,
      // A provider that sent none (shouldn't happen with offline access) keeps the old one for the same account.
      refreshToken: t.refresh_token ?? (old?.accountId === account.id ? old?.refreshToken : undefined),
      expiresAt: now() + (t.expires_in ?? DEFAULT_EXPIRES_IN) * 1000,
      account: account.email ?? account.name,
      accountId: account.id,
      scope: t.scope,
    })
  } finally {
    close()
  }
  return { kind, intent: p.intent, account, db: p.db }
}

// ---------------------------------------------------------------------------------------------
// Which providers to offer (§6.4)
// ---------------------------------------------------------------------------------------------

interface WorkerProviders {
  v: 1
  providers: Partial<Record<'gdrive' | 'onedrive', { clientId: string }>>
}

let workerList: Promise<WorkerProviders['providers'] | null> | undefined

async function fetchWorkerProviders(d: OAuthDeps): Promise<WorkerProviders['providers'] | null> {
  const origin = d.origin ?? globalThis.location?.origin ?? ''
  const res = await (d.fetch ?? ((i, init) => fetch(i, init)))(new URL('/api/oauth/providers', origin || 'http://localhost').toString(), {
    credentials: 'omit',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return null
  const j = (await res.json()) as Partial<WorkerProviders>
  return j?.v === 1 && j.providers && typeof j.providers === 'object' ? j.providers : null
}

/**
 * The providers to offer here: Dropbox when its client id is set; Google Drive and OneDrive when theirs is
 * set **and** the Worker lists them with the same client id (cached for the session once it answers; a
 * failed check is tried again next time).
 */
export async function availableProviders(d: OAuthDeps & { fresh?: boolean } = {}): Promise<OAuthKind[]> {
  const id = (k: OAuthKind) => (d.clientId ?? ((kk) => oauthClientId(kk)))(k)
  const out: OAuthKind[] = []
  if (id('dropbox')) out.push('dropbox')
  const viaWorker = (['gdrive', 'onedrive'] as const).filter((k) => id(k))
  if (!viaWorker.length) return out
  if (d.fresh || !workerList) {
    const run = fetchWorkerProviders(d).catch(() => null)
    workerList = run
    void run.then((v) => {
      if (!v && workerList === run) workerList = undefined
    })
  }
  const listed = await workerList
  for (const k of viaWorker) if (listed?.[k]?.clientId === id(k)) out.push(k)
  return out
}

/** Tests: forget the cached Worker answer. */
export function resetProviderCache() {
  workerList = undefined
}
