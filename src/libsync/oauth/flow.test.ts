import { beforeEach, describe, expect, it } from 'vitest'
import { OpenStandDB } from '../../db/db'
import type { OAuthKind, TokenSet } from '../backends/types'
import { putState } from '../state'
import { CALLBACK_PATH, handleOAuthCallback, readPending, writePending } from './callback'
import { availableProviders, completeSignIn, resetProviderCache, SignInError, signInFailure, startSignIn, type FlowDeps } from './flow'
import { challengeS256 } from './pkce'
import { readTokens, storeTokens } from './tokens'
import {
  DROPBOX_ME,
  DROPBOX_TOKEN,
  fakeFetch,
  form,
  GDRIVE_ABOUT,
  GDRIVE_TOKEN,
  json,
  jwt,
  ONEDRIVE_APPROOT,
  ONEDRIVE_TOKEN,
  ORIGIN,
  PROVIDERS_ROUTE,
  type Route,
} from './oauth.test-helper'
import type { SignInIntent } from './types'

let n = 0
const T0 = 1_800_000_000_000
const HOUR = 3_600_000

function harness(routes: Record<string, Route> = {}, o: { clientId?: (k: OAuthKind) => string | null } = {}) {
  const db = new OpenStandDB(`flow-test-${Date.now().toString(36)}-${n++}`)
  const clock = { t: T0 }
  const f = fakeFetch(routes)
  const urls: string[] = []
  const deps: FlowDeps & { db: string } = {
    fetch: f.fetch,
    now: () => clock.t,
    origin: ORIGIN,
    clientId: o.clientId ?? (() => 'cid'),
    navigate: (u) => void urls.push(u),
    openDb: () => ({ db, close() {} }),
    db: db.name,
  }
  /** Start, then come back through the callback page with `query` (default: the right code and state). */
  async function roundTrip(kind: OAuthKind, intent: SignInIntent = { type: 'setup' }, query?: (state: string) => string) {
    await startSignIn(kind, intent, {}, deps)
    const state = readPending()!.state
    history.replaceState(null, '', CALLBACK_PATH + (query ? query(state) : `?code=the-code&state=${state}`))
    handleOAuthCallback(clock.t)
  }
  return { db, clock, f, urls, deps, roundTrip }
}

const signInError = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(SignInError)
  return e as SignInError
}

const dropboxRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [DROPBOX_TOKEN]: () =>
    json({ access_token: 'at', token_type: 'bearer', expires_in: 14400, refresh_token: 'rt', scope: 'account_info.read files.content.read files.content.write files.metadata.read', account_id: 'dbid:1', uid: '1' }),
  [DROPBOX_ME]: () => json({ account_id: 'dbid:AAA', email: 'rod@example.com', name: { display_name: 'Rod' } }),
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  resetProviderCache()
})

describe('startSignIn (SYNC-DRIVES.md §5.2)', () => {
  it('saves the pending slot and goes to the authorize URL with PKCE S256 and state', async () => {
    const h = harness()
    const intent: SignInIntent = { type: 'join', pairing: 'OSJ1.abc' }
    const url = await startSignIn('gdrive', intent, { loginHint: 'rod@example.com' }, h.deps)
    expect(h.urls).toEqual([url])
    const p = readPending()!
    expect(p).toMatchObject({ v: 1, kind: 'gdrive', db: h.db.name, intent, createdAt: T0, redirectUri: ORIGIN + '/oauth/callback' })
    expect(p.ret).toBeUndefined()
    const q = new URL(url).searchParams
    expect(q.get('state')).toBe(p.state)
    expect(q.get('code_challenge')).toBe(await challengeS256(p.verifier))
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('redirect_uri')).toBe(ORIGIN + '/oauth/callback')
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('login_hint')).toBe('rod@example.com')
  })

  it('a new start overwrites the slot', async () => {
    const h = harness()
    await startSignIn('dropbox', { type: 'setup' }, {}, h.deps)
    const first = readPending()!.state
    await startSignIn('onedrive', { type: 'setup' }, {}, h.deps)
    expect(readPending()).toMatchObject({ kind: 'onedrive' })
    expect(readPending()!.state).not.toBe(first)
  })

  it('without a client id: notConfigured, and nothing is saved', async () => {
    const h = harness({}, { clientId: () => null })
    const e = await signInError(startSignIn('dropbox', { type: 'setup' }, {}, h.deps))
    expect(e.code).toBe('notConfigured')
    expect(readPending()).toBeNull()
    expect(h.urls).toEqual([])
  })
})

describe('completeSignIn', () => {
  it('Dropbox: exchanges the code in the browser (PKCE, no secret), identifies the account, stores tokens', async () => {
    const h = harness(dropboxRoutes())
    await h.roundTrip('dropbox')
    const verifier = readPending()!.verifier
    h.clock.t += 60_000
    const r = await completeSignIn(h.deps)
    expect(r).toEqual({ kind: 'dropbox', intent: { type: 'setup' }, account: { id: 'dbid:AAA', email: 'rod@example.com', name: 'Rod' }, db: h.db.name })
    expect(form(h.f.calls[0].body)).toEqual({ grant_type: 'authorization_code', code: 'the-code', code_verifier: verifier, client_id: 'cid', redirect_uri: ORIGIN + '/oauth/callback' })
    expect(h.f.calls[1]).toMatchObject({ body: 'null', headers: { authorization: 'Bearer at', 'content-type': 'application/json' } })
    expect(await readTokens(h.db, 'dropbox')).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: h.clock.t + 14400_000,
      account: 'rod@example.com',
      accountId: 'dbid:AAA',
      scope: 'account_info.read files.content.read files.content.write files.metadata.read',
    })
    // Single use: the slot is gone.
    expect(readPending()).toBeNull()
    expect((await signInError(completeSignIn(h.deps))).code).toBe('expired')
  })

  it('Google: exchanges through the Worker and identifies with Drive about', async () => {
    const h = harness({
      [GDRIVE_TOKEN]: () => json({ access_token: 'gat', expires_in: 3599, refresh_token: 'grt', scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' }),
      [GDRIVE_ABOUT]: () => json({ user: { displayName: 'Rod', emailAddress: 'rod@gmail.com', permissionId: '0123' } }),
    })
    await h.roundTrip('gdrive')
    const verifier = readPending()!.verifier
    const r = await completeSignIn(h.deps)
    expect(r.account).toEqual({ id: '0123', email: 'rod@gmail.com', name: 'Rod' })
    expect(JSON.parse(h.f.calls[0].body)).toEqual({ grant: 'code', code: 'the-code', code_verifier: verifier, redirect_uri: ORIGIN + '/oauth/callback' })
    expect(h.f.calls[0].url).toBe(ORIGIN + '/api/oauth/gdrive/token')
    expect(new URL(h.f.calls[1].url).searchParams.get('fields')).toBe('user(displayName,emailAddress,permissionId)')
    expect(await readTokens(h.db, 'gdrive')).toMatchObject({ accessToken: 'gat', refreshToken: 'grt', accountId: '0123', account: 'rod@gmail.com' })
  })

  it('OneDrive: drive id from approot, email and name from the id_token', async () => {
    const h = harness({
      [ONEDRIVE_TOKEN]: () =>
        json({ access_token: 'mat', expires_in: 3600, refresh_token: 'mrt', scope: 'https://graph.microsoft.com/Files.ReadWrite.AppFolder openid profile email', id_token: jwt({ preferred_username: 'rod@outlook.com', name: 'Rod P' }) }),
      [ONEDRIVE_APPROOT]: () => json({ parentReference: { driveId: 'drive-9', driveType: 'personal' } }),
    })
    await h.roundTrip('onedrive')
    const r = await completeSignIn(h.deps)
    expect(r.account).toEqual({ id: 'drive-9', email: 'rod@outlook.com', name: 'Rod P' })
    expect(h.f.calls[1].url).toContain('$select=parentReference')
    expect(await readTokens(h.db, 'onedrive')).toMatchObject({ accountId: 'drive-9', account: 'rod@outlook.com' })
  })

  it('a state mismatch on the callback → expired, and nothing is exchanged', async () => {
    const h = harness(dropboxRoutes())
    await h.roundTrip('dropbox', { type: 'setup' }, () => '?code=c&state=forged')
    expect((await signInError(completeSignIn(h.deps))).code).toBe('expired')
    expect(h.f.calls).toHaveLength(0)
  })

  it('more than 15 minutes → expired (at the callback, or before completing)', async () => {
    const h = harness(dropboxRoutes())
    await startSignIn('dropbox', { type: 'setup' }, {}, h.deps)
    const state = readPending()!.state
    history.replaceState(null, '', `${CALLBACK_PATH}?code=c&state=${state}`)
    handleOAuthCallback(T0 + 15 * 60_000 + 1)
    expect((await signInError(completeSignIn(h.deps))).code).toBe('expired')

    await h.roundTrip('dropbox')
    h.clock.t += 16 * 60_000
    expect((await signInError(completeSignIn(h.deps))).code).toBe('expired')
    expect(h.f.calls).toHaveLength(0)
  })

  it('the user cancelled → denied; another provider error → exchange', async () => {
    const h = harness(dropboxRoutes())
    await h.roundTrip('dropbox', { type: 'setup' }, (s) => `?error=access_denied&state=${s}`)
    expect((await signInError(completeSignIn(h.deps))).code).toBe('denied')
    await h.roundTrip('dropbox', { type: 'setup' }, (s) => `?error=server_error&state=${s}`)
    expect((await signInError(completeSignIn(h.deps))).code).toBe('exchange')
  })

  it('maps exchange failures: invalid_grant → exchange, Worker not configured → notConfigured, no answer → network', async () => {
    let answer: () => Response | Promise<Response> = () => json({ error: 'invalid_grant' }, 400)
    const h = harness({ [GDRIVE_TOKEN]: () => answer() })
    await h.roundTrip('gdrive')
    expect((await signInError(completeSignIn(h.deps))).code).toBe('exchange')
    answer = () => json({ error: 'not_configured' }, 503)
    await h.roundTrip('gdrive')
    expect((await signInError(completeSignIn(h.deps))).code).toBe('notConfigured')
    answer = () => Promise.reject(new TypeError('Failed to fetch'))
    await h.roundTrip('gdrive')
    expect((await signInError(completeSignIn(h.deps))).code).toBe('network')
    expect(await readTokens(h.db, 'gdrive')).toBeUndefined()
  })

  it('Drive access unticked on Google’s consent screen → scope, nothing stored', async () => {
    const h = harness({ [GDRIVE_TOKEN]: () => json({ access_token: 'x', expires_in: 3599, refresh_token: 'y', scope: 'openid' }) })
    await h.roundTrip('gdrive')
    const e = await signInError(completeSignIn(h.deps))
    expect(e.code).toBe('scope')
    expect(e.message).toBe('OpenStand needs access to its own files in Google Drive. Sign in again and allow it.')
    expect(await readTokens(h.db, 'gdrive')).toBeUndefined()
    expect(h.f.calls).toHaveLength(1)
  })

  it('re-sign-in must be the same account: wrongAccount keeps the old tokens; the same account replaces them', async () => {
    let me = { account_id: 'dbid:OTHER', email: 'other@example.com', name: { display_name: 'O' } }
    const h = harness(dropboxRoutes({ [DROPBOX_ME]: () => json(me) }))
    const old: TokenSet = { accessToken: 'old', refreshToken: 'old-r', expiresAt: T0 - HOUR, account: 'rod@example.com', accountId: 'dbid:AAA' }
    await storeTokens(h.db, 'dropbox', old)
    await h.roundTrip('dropbox', { type: 'reauth' })
    const e = await signInError(completeSignIn(h.deps))
    expect([e.code, e.want, e.got]).toEqual(['wrongAccount', 'rod@example.com', 'other@example.com'])
    expect(e.message).toBe('You signed in as other@example.com, but this library is in rod@example.com.')
    expect(await readTokens(h.db, 'dropbox')).toEqual(old)

    me = { account_id: 'dbid:AAA', email: 'rod@example.com', name: { display_name: 'Rod' } }
    await h.roundTrip('dropbox', { type: 'reauth' })
    await completeSignIn(h.deps)
    expect(await readTokens(h.db, 'dropbox')).toMatchObject({ accessToken: 'at', refreshToken: 'rt', accountId: 'dbid:AAA' })
  })

  it('re-sign-in checks against the library config, and the intent’s account id wins', async () => {
    const h = harness(dropboxRoutes())
    await putState(h.db, 'config', {
      v: 1,
      secret: 's',
      libraryId: 'l',
      roomId: 'r',
      deviceId: 'd',
      backend: { kind: 'dropbox', root: '', account: 'band@example.com', accountId: 'dbid:BAND' },
      relay: null,
      name: 'n',
      joinedAt: 0,
      paused: false,
    })
    await h.roundTrip('dropbox', { type: 'reauth' })
    expect((await signInError(completeSignIn(h.deps))).want).toBe('band@example.com')
    await h.roundTrip('dropbox', { type: 'reauth', accountId: 'dbid:AAA' })
    expect((await completeSignIn(h.deps)).account.id).toBe('dbid:AAA')
  })

  it('setup and join sign-ins accept any account', async () => {
    const h = harness(dropboxRoutes())
    await storeTokens(h.db, 'dropbox', { accessToken: 'x', expiresAt: 0, accountId: 'dbid:ELSE' })
    await h.roundTrip('dropbox', { type: 'join', pairing: 'OSJ1.x' })
    expect((await completeSignIn(h.deps)).intent).toEqual({ type: 'join', pairing: 'OSJ1.x' })
    expect((await readTokens(h.db, 'dropbox'))?.accountId).toBe('dbid:AAA')
  })

  it('without a callback waiting → expired', async () => {
    const h = harness()
    await startSignIn('dropbox', { type: 'setup' }, {}, h.deps)
    expect((await signInError(completeSignIn(h.deps))).code).toBe('expired')
    expect(readPending()).toBeNull()
  })

  it('maps sign-in errors to LibSyncFailure codes (§2.3)', () => {
    const f = (code: SignInError['code']) => signInFailure(new SignInError(code, 'gdrive', { want: 'w@x', got: 'g@x' }))
    expect(f('denied')).toEqual({ code: 'unknown', message: 'Sign-in was cancelled.', detail: 'denied' })
    expect(f('expired').code).toBe('unknown')
    expect(f('exchange')).toEqual({ code: 'unknown', message: 'Google Drive didn’t accept the sign-in. Please try again.', detail: 'exchange' })
    expect(f('notConfigured')).toEqual({ code: 'unknown', message: 'Sign-in with Google Drive isn’t available on this site.', detail: 'notConfigured' })
    expect(f('scope')).toMatchObject({ code: 'reauth', detail: 'scope' })
    expect(f('wrongAccount')).toEqual({ code: 'wrongAccount', message: 'You signed in as g@x, but this library is in w@x.', detail: 'w@x' })
    expect(f('network')).toEqual({ code: 'network', message: 'Can’t reach Google Drive. Check your connection.', detail: 'network' })
  })
})

describe('which providers to offer (§6.4)', () => {
  it('Dropbox by its client id; Drive and OneDrive only when the Worker lists the same client id', async () => {
    const h = harness({ [PROVIDERS_ROUTE]: () => json({ v: 1, providers: { gdrive: { clientId: 'cid' }, onedrive: { clientId: 'another' } } }) })
    expect(await availableProviders(h.deps)).toEqual(['dropbox', 'gdrive'])
    // Cached for the session.
    expect(await availableProviders(h.deps)).toEqual(['dropbox', 'gdrive'])
    expect(h.f.count('/api/oauth/providers')).toBe(1)
  })

  it('no Worker (static hosting): only Dropbox, and the check runs again next time', async () => {
    let up = false
    const h = harness({ [PROVIDERS_ROUTE]: () => (up ? json({ v: 1, providers: { onedrive: { clientId: 'cid' } } }) : new Response('Not found', { status: 404 })) })
    expect(await availableProviders(h.deps)).toEqual(['dropbox'])
    await new Promise((r) => setTimeout(r, 0))
    up = true
    expect(await availableProviders(h.deps)).toEqual(['dropbox', 'onedrive'])
  })

  it('no client ids: nothing, without asking the Worker', async () => {
    const h = harness({}, { clientId: () => null })
    expect(await availableProviders(h.deps)).toEqual([])
    expect(h.f.calls).toHaveLength(0)
  })
})

describe('the pending slot', () => {
  it('is only read through readPending (malformed slots are ignored)', () => {
    writePending({ v: 1, kind: 'dropbox', state: 's', verifier: 'v', redirectUri: 'r', db: 'd', intent: { type: 'setup' }, createdAt: 1 })
    expect(readPending()?.kind).toBe('dropbox')
    localStorage.setItem('openstand-oauth:pending', '{"v":2}')
    expect(readPending()).toBeNull()
  })
})
