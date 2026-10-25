// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { OpenStandDB } from '../../db/db'
import { BackendError, type OAuthKind, type TokenSet } from '../backends/types'
import { DROPBOX_REVOKE, DROPBOX_TOKEN, form, fakeFetch, GDRIVE_TOKEN, json, ONEDRIVE_TOKEN, ORIGIN, type Route } from './oauth.test-helper'
import { forgetTokens, readTokens, REFRESH_LEAD, removeTokens, storeTokens, tokenSource, type TokenDeps } from './tokens'

let n = 0
const newDb = () => new OpenStandDB(`tokens-test-${Date.now().toString(36)}-${n++}`)
const T0 = 1_800_000_000_000
const HOUR = 3_600_000

function setup(kind: OAuthKind, routes: Record<string, Route>, over: Partial<TokenSet> = {}) {
  const db = newDb()
  const clock = { t: T0 }
  const f = fakeFetch(routes)
  const deps: TokenDeps = { fetch: f.fetch, now: () => clock.t, origin: ORIGIN, clientId: () => 'cid', locks: null }
  const initial: TokenSet = { accessToken: 'a1', refreshToken: 'r1', expiresAt: T0 + HOUR, account: 'rod@example.com', accountId: 'acc-1', ...over }
  return { db, clock, f, deps, initial, ready: storeTokens(db, kind, initial) }
}

const dropboxRefresh = (token = 'a2', extra: Record<string, unknown> = {}): Route => () => json({ access_token: token, token_type: 'bearer', expires_in: 14400, ...extra })

describe('token source', () => {
  it('returns the stored token while it has more than 5 minutes left, without a request', async () => {
    const s = setup('dropbox', { [DROPBOX_TOKEN]: dropboxRefresh() })
    await s.ready
    const src = tokenSource(s.db, 'dropbox', s.deps)
    expect(src.kind).toBe('dropbox')
    expect(await src.token()).toBe('a1')
    s.clock.t = T0 + HOUR - REFRESH_LEAD - 1
    expect(await src.token()).toBe('a1')
    expect(s.f.calls).toHaveLength(0)
  })

  it('refreshes within 5 minutes of expiry (Dropbox: PKCE client, no secret) and stores the merged set', async () => {
    const s = setup('dropbox', { [DROPBOX_TOKEN]: dropboxRefresh() })
    await s.ready
    s.clock.t = T0 + HOUR - REFRESH_LEAD + 1
    expect(await tokenSource(s.db, 'dropbox', s.deps).token()).toBe('a2')
    expect(s.f.calls).toHaveLength(1)
    expect(s.f.calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(form(s.f.calls[0].body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid' })
    expect(await readTokens(s.db, 'dropbox')).toEqual({ ...s.initial, accessToken: 'a2', expiresAt: s.clock.t + 14400_000 })
  })

  it('coalesces concurrent refreshes in a tab into one request', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const s = setup('dropbox', {
      [DROPBOX_TOKEN]: async () => {
        await gate
        return dropboxRefresh()({} as never)
      },
    })
    await s.ready
    const a = tokenSource(s.db, 'dropbox', s.deps)
    const b = tokenSource(s.db, 'dropbox', s.deps)
    const all = Promise.all([a.refreshAfter401('a1'), a.refreshAfter401('a1'), b.refreshAfter401('a1'), b.refreshAfter401('a1')])
    await new Promise((r) => setTimeout(r, 20))
    release()
    expect(await all).toEqual(['a2', 'a2', 'a2', 'a2'])
    expect(s.f.calls).toHaveLength(1)
  })

  it('another "tab" re-reads storage under the lock and reuses a refresh done meanwhile', async () => {
    const s = setup('dropbox', { [DROPBOX_TOKEN]: dropboxRefresh() })
    await s.ready
    const other = new OpenStandDB(s.db.name) // a second connection, like another tab
    const lockNames: string[] = []
    const locks = { request: vi.fn(async (name: string, fn: () => Promise<unknown>) => (lockNames.push(name), fn())) }
    const tabA = tokenSource(s.db, 'dropbox', { ...s.deps, locks: locks as never })
    const tabB = tokenSource(other, 'dropbox', { ...s.deps, locks: locks as never })
    expect(await tabA.token()).toBe('a1')
    expect(await tabB.token()).toBe('a1')
    expect(await tabA.refreshAfter401('a1')).toBe('a2')
    expect(await tabB.refreshAfter401('a1')).toBe('a2')
    expect(s.f.calls).toHaveLength(1)
    expect(lockNames).toEqual([`openstand-oauth:${s.db.name}:dropbox`, `openstand-oauth:${s.db.name}:dropbox`])
    other.close()
  })

  it('a 401 on a token refreshes even if it looks valid (once per rejected token)', async () => {
    const s = setup('dropbox', { [DROPBOX_TOKEN]: (() => {
      let i = 1
      return () => json({ access_token: `a${++i}`, expires_in: 14400 })
    })() })
    await s.ready
    const src = tokenSource(s.db, 'dropbox', s.deps)
    expect(await src.refreshAfter401('a1')).toBe('a2')
    expect(await src.token()).toBe('a2')
    expect(await src.refreshAfter401('a2')).toBe('a3')
    expect(s.f.calls).toHaveLength(2)
  })

  it('Microsoft rotates refresh tokens: the new one is stored and used next time (through the Worker)', async () => {
    let i = 1
    const s = setup('onedrive', { [ONEDRIVE_TOKEN]: () => (i++, json({ access_token: `a${i}`, refresh_token: `r${i}`, expires_in: 3600, scope: 'Files.ReadWrite.AppFolder openid' })) })
    await s.ready
    const src = tokenSource(s.db, 'onedrive', s.deps)
    await src.refreshAfter401('a1')
    expect((await readTokens(s.db, 'onedrive'))?.refreshToken).toBe('r2')
    await src.refreshAfter401('a2')
    expect(s.f.calls.map((c) => JSON.parse(c.body))).toEqual([
      { grant: 'refresh', refresh_token: 'r1' },
      { grant: 'refresh', refresh_token: 'r2' },
    ])
    expect(s.f.calls[0].headers['content-type']).toBe('application/json')
    expect(await readTokens(s.db, 'onedrive')).toMatchObject({ accessToken: 'a3', refreshToken: 'r3', accountId: 'acc-1' })
  })

  it('Google keeps the old refresh token when none comes back', async () => {
    const s = setup('gdrive', { [GDRIVE_TOKEN]: () => json({ access_token: 'a2', expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file' }) })
    await s.ready
    await tokenSource(s.db, 'gdrive', s.deps).refreshAfter401('a1')
    expect((await readTokens(s.db, 'gdrive'))?.refreshToken).toBe('r1')
  })

  it('invalid_grant → reauth, and the tokens stay (for the same-account check on sign-in)', async () => {
    const s = setup('gdrive', { [GDRIVE_TOKEN]: () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) })
    await s.ready
    const e = await tokenSource(s.db, 'gdrive', s.deps).refreshAfter401('a1').catch((x) => x)
    expect(e).toBeInstanceOf(BackendError)
    expect([e.code, e.providerCode]).toEqual(['reauth', 'invalid_grant'])
    expect(e.message).toContain('Google Drive')
    expect(await readTokens(s.db, 'gdrive')).toEqual(s.initial)
  })

  it('a refresh without the required scope → reauth', async () => {
    const s = setup('gdrive', { [GDRIVE_TOKEN]: () => json({ access_token: 'a2', expires_in: 3599, scope: 'openid' }) })
    await s.ready
    await expect(tokenSource(s.db, 'gdrive', s.deps).refreshAfter401('a1')).rejects.toMatchObject({ code: 'reauth', providerCode: 'scope' })
  })

  it('a misconfigured Worker → unknown/OAuthConfig with the misconfiguration wording; 502 → network; 429 → rateLimited', async () => {
    let answer = json({ error: 'not_configured' }, 503)
    const s = setup('onedrive', { [ONEDRIVE_TOKEN]: () => answer })
    await s.ready
    const src = tokenSource(s.db, 'onedrive', s.deps)
    const cfg = await src.refreshAfter401('a1').catch((x) => x)
    expect([cfg.code, cfg.providerCode, cfg.message]).toEqual(['unknown', 'OAuthConfig', 'Sign-in for OneDrive isn’t set up correctly on this site.'])
    answer = json({ error: 'upstream_unavailable' }, 502)
    await expect(src.refreshAfter401('a1')).rejects.toMatchObject({ code: 'network' })
    answer = json({ error: 'rate_limited' }, 429, { 'retry-after': '60' })
    await expect(src.refreshAfter401('a1')).rejects.toMatchObject({ code: 'rateLimited', retryAfterMs: 60_000 })
  })

  it('offline shortly before expiry: the old token still serves; once expired, network', async () => {
    const s = setup('dropbox', { [DROPBOX_TOKEN]: () => Promise.reject(new TypeError('Failed to fetch')) })
    await s.ready
    const src = tokenSource(s.db, 'dropbox', s.deps)
    s.clock.t = T0 + HOUR - 60_000
    expect(await src.token()).toBe('a1')
    s.clock.t = T0 + HOUR + 1
    await expect(src.token()).rejects.toMatchObject({ code: 'network' })
  })

  it('no tokens, or no refresh token → reauth', async () => {
    const db = newDb()
    await expect(tokenSource(db, 'dropbox', { locks: null }).token()).rejects.toMatchObject({ code: 'reauth', providerCode: 'NoTokens' })
    const s = setup('dropbox', {}, { refreshToken: undefined })
    await s.ready
    await expect(tokenSource(s.db, 'dropbox', s.deps).refreshAfter401('a1')).rejects.toMatchObject({ code: 'reauth', providerCode: 'NoRefreshToken' })
  })

  it('a sign-out during the refresh isn’t undone, and a new sign-in during it wins', async () => {
    let during: () => Promise<void> = async () => {}
    const s = setup('dropbox', {
      [DROPBOX_TOKEN]: async () => {
        await during()
        return dropboxRefresh()({} as never)
      },
    })
    await s.ready
    during = () => removeTokens(s.db, 'dropbox')
    await expect(tokenSource(s.db, 'dropbox', s.deps).refreshAfter401('a1')).rejects.toMatchObject({ code: 'reauth' })
    expect(await readTokens(s.db, 'dropbox')).toBeUndefined()

    await storeTokens(s.db, 'dropbox', s.initial)
    const fresh = { ...s.initial, accessToken: 'new', refreshToken: 'r-new' }
    during = () => storeTokens(s.db, 'dropbox', fresh)
    expect(await tokenSource(s.db, 'dropbox', s.deps).refreshAfter401('a1')).toBe('new')
    expect(await readTokens(s.db, 'dropbox')).toEqual(fresh)
  })

  it('keeps each provider’s tokens separate', async () => {
    const db = newDb()
    await storeTokens(db, 'dropbox', { accessToken: 'd', expiresAt: 1 })
    await storeTokens(db, 'gdrive', { accessToken: 'g', expiresAt: 1 })
    await removeTokens(db, 'dropbox')
    expect(await readTokens(db, 'gdrive')).toEqual({ accessToken: 'g', expiresAt: 1 })
    await removeTokens(db, 'gdrive')
    expect(await db.syncState.get('oauth')).toBeUndefined()
  })
})

describe('forgetting a sign-in', () => {
  it('Dropbox: revokes this device’s token, then deletes it', async () => {
    const s = setup('dropbox', { [DROPBOX_REVOKE]: () => new Response(null, { status: 200 }) })
    await s.ready
    await forgetTokens(s.db, 'dropbox', s.deps)
    expect(s.f.calls).toHaveLength(1)
    expect(s.f.calls[0].headers.authorization).toBe('Bearer a1')
    expect(await readTokens(s.db, 'dropbox')).toBeUndefined()
  })

  it('Google and Microsoft: never revoke (it would sign out every device), only delete', async () => {
    for (const kind of ['gdrive', 'onedrive'] as const) {
      const s = setup(kind, {})
      await s.ready
      await forgetTokens(s.db, kind, s.deps)
      expect(s.f.calls).toHaveLength(0)
      expect(await readTokens(s.db, kind)).toBeUndefined()
    }
  })

  it('a failed revoke still deletes', async () => {
    const s = setup('dropbox', { [DROPBOX_REVOKE]: () => Promise.reject(new TypeError('offline')) })
    await s.ready
    await forgetTokens(s.db, 'dropbox', s.deps)
    expect(await readTokens(s.db, 'dropbox')).toBeUndefined()
  })
})
