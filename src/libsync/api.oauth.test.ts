import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DROPBOX_ME, DROPBOX_REVOKE, DROPBOX_TOKEN, fakeFetch, json } from './oauth/oauth.test-helper'

const restartEverywhere = vi.fn()
vi.mock('./service', () => ({
  deviceName: () => 'Test device',
  setInitial: () => {},
  withEngineStopped: async (fn: () => Promise<unknown>) => fn(),
  restartEverywhere: () => restartEverywhere(),
}))
vi.mock('./join', () => ({ join: async () => ({ stop() {} }) }))

const api = await import('./api')
const dbm = await import('../db/db')
const { readTokens, storeTokens } = await import('./oauth/tokens')
const { writePending } = await import('./oauth/callback')
const { putState } = await import('./state')

const TOKENS = { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000, account: 'rod@example.com', accountId: 'dbid:AAA' }

beforeEach(async () => {
  localStorage.clear()
  await dbm.db.syncState.clear()
  restartEverywhere.mockClear()
  vi.stubEnv('VITE_DROPBOX_CLIENT_ID', 'cid')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('drive sign-in through the facade', () => {
  it('completeSignIn stores the tokens in the current library; a reauth restarts sync', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        [DROPBOX_TOKEN]: () => json({ access_token: 'at', expires_in: 14400, refresh_token: 'rt' }),
        [DROPBOX_ME]: () => json({ account_id: 'dbid:AAA', email: 'rod@example.com' }),
      }).fetch,
    )
    const pending = { v: 1 as const, kind: 'dropbox' as const, state: 's', verifier: 'v'.repeat(43), redirectUri: location.origin + '/oauth/callback', db: dbm.db.name, createdAt: Date.now(), ret: { code: 'c' } }
    writePending({ ...pending, intent: { type: 'setup' } })
    expect(api.signInReturnPending()).toBe(true)
    expect(await api.completeSignIn()).toEqual({ kind: 'dropbox', intent: { type: 'setup' }, account: { id: 'dbid:AAA', email: 'rod@example.com', name: undefined } })
    expect(restartEverywhere).not.toHaveBeenCalled()
    expect(await readTokens(dbm.db, 'dropbox')).toMatchObject({ accessToken: 'at', accountId: 'dbid:AAA' })
    expect(await api.driveAccount('dropbox')).toEqual({ id: 'dbid:AAA', email: 'rod@example.com' })

    writePending({ ...pending, intent: { type: 'reauth' } })
    await api.completeSignIn()
    expect(restartEverywhere).toHaveBeenCalledTimes(1)
  })

  it('sign-in failures reject with LibSyncFailure codes', async () => {
    writePending({ v: 1, kind: 'dropbox', state: 's', verifier: 'v', redirectUri: 'r', db: dbm.db.name, intent: { type: 'setup' }, createdAt: Date.now(), ret: { error: 'access_denied' } })
    const e = await api.completeSignIn().catch((x) => x)
    expect(e).toBeInstanceOf(api.LibSyncFailure)
    expect([e.code, e.detail, e.message]).toEqual(['unknown', 'denied', 'Sign-in was cancelled.'])
    vi.stubEnv('VITE_DROPBOX_CLIENT_ID', 'off')
    const n = await api.startSignIn('dropbox', { type: 'setup' }).catch((x) => x)
    expect([n.code, n.detail]).toEqual(['unknown', 'notConfigured'])
  })

  it('driveBackendConfig carries the account hints; without a sign-in it asks for one', async () => {
    await expect(api.driveBackendConfig('dropbox')).rejects.toMatchObject({ code: 'reauth' })
    await storeTokens(dbm.db, 'dropbox', TOKENS)
    await storeTokens(dbm.db, 'onedrive', { ...TOKENS, accountId: 'drive-9' })
    expect(await api.driveBackendConfig('dropbox')).toEqual({ kind: 'dropbox', root: '', account: 'rod@example.com', accountId: 'dbid:AAA' })
    expect(await api.driveBackendConfig('onedrive')).toEqual({ kind: 'onedrive', folder: '', account: 'rod@example.com', accountId: 'drive-9' })
  })

  it('discardSignIn forgets (and revokes) a sign-in the setup didn’t use, but never the one sync uses', async () => {
    const f = fakeFetch({ [DROPBOX_REVOKE]: () => new Response(null) })
    vi.stubGlobal('fetch', f.fetch)
    await storeTokens(dbm.db, 'dropbox', TOKENS)
    await api.discardSignIn('dropbox')
    expect(await readTokens(dbm.db, 'dropbox')).toBeUndefined()
    expect(f.calls).toHaveLength(1)

    await storeTokens(dbm.db, 'dropbox', TOKENS)
    await putState(dbm.db, 'config', { v: 1, secret: 's', libraryId: 'l', roomId: 'r', deviceId: 'd', backend: { kind: 'dropbox', root: '' }, relay: null, name: 'n', joinedAt: 0, paused: false })
    await api.discardSignIn('dropbox')
    expect(await readTokens(dbm.db, 'dropbox')).toEqual(TOKENS)
  })

  it('joining as a new library copies this device’s sign-in into it', async () => {
    await storeTokens(dbm.db, 'gdrive', { ...TOKENS, accountId: '0123' })
    const before = dbm.db.name
    await api.joinSync({ v: 1, s: 'x', n: 'Drive library', b: { kind: 'gdrive', folder: 'f'.repeat(20) } }, 'newLibrary')
    const now = dbm.db
    expect(now.name).not.toBe(before)
    expect(await readTokens(now, 'gdrive')).toMatchObject({ accountId: '0123' })
  })

  it('describeBackend refuses non-drive configs', async () => {
    await expect(api.describeBackend({ kind: 'memory', name: 'x' })).rejects.toMatchObject({ code: 'unknown' })
  })
})
