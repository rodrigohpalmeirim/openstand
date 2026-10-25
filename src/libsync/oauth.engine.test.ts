// @vitest-environment node
/**
 * The engine on a drive-like backend: requests go through `OAuthHttp` with the real
 * token store, against a fake API that accepts one access token at a time.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthHttp } from './backends/http'
import { BackendError, type BackendCheck, type ByteSource, type StorageBackend, type TokenSet, type UploadState } from './backends/types'
import type { MemoryBackend } from './backends/memory'
import { Engine, SyncError } from './engine'
import { enable, initialUpload, leave, openPairing } from './join'
import { DROPBOX_REVOKE, DROPBOX_TOKEN, fakeFetch, form, json, type Route } from './oauth/oauth.test-helper'
import { readTokens, storeTokens, tokenSource } from './oauth/tokens'
import { getConfig } from './state'
import { addSong, bytes, world, type World } from './sync.test-helper'
import type { OpenStandDB } from '../db/db'

const GATE = 'POST https://api.drive.test/gate'

/** The fake drive API: one valid access token; `rateLimit` answers the next request with 429. */
function driveApi(w: World) {
  const api = { valid: 'a1', rateLimit: 0, refresh: (() => json({ access_token: 'a2', expires_in: 14400 })) as Route }
  const routes: Record<string, Route> = {
    [GATE]: (c) => {
      if (api.rateLimit) {
        api.rateLimit--
        return json({ error: 'too_many_requests' }, 429, { 'retry-after': '120' })
      }
      return c.headers.authorization === `Bearer ${api.valid}` ? json({}) : json({ error: 'expired_access_token' }, 401)
    },
    [DROPBOX_TOKEN]: (c) => api.refresh(c),
  }
  const f = fakeFetch(routes)
  const http = (db: OpenStandDB) =>
    new OAuthHttp(
      { fetch: f.fetch, auth: tokenSource(db, 'dropbox', { fetch: f.fetch, now: w.now, clientId: () => 'cid', locks: null }) },
      {
        label: 'Drive',
        mapError: (res) =>
          res.status === 429
            ? new BackendError('rateLimited', 'slow down', { status: 429, retryAfterMs: Number(res.headers.get('retry-after')) * 1000 })
            : new BackendError(res.status === 401 ? 'reauth' : 'server', 'refused', { status: res.status }),
      },
    )
  return { api, f, http }
}

/** A MemoryBackend whose every call first passes the fake API's token check. */
class GatedBackend implements StorageBackend {
  readonly kind = 'memory' as const
  readonly label = 'Gated drive'
  caps
  private inner: MemoryBackend
  private http: OAuthHttp
  constructor(inner: MemoryBackend, http: OAuthHttp) {
    this.inner = inner
    this.http = http
    this.caps = inner.caps
  }
  private gate(signal?: AbortSignal) {
    return this.http.send('https://api.drive.test/gate', { method: 'POST', signal })
  }
  async list(p: string, o?: Parameters<StorageBackend['list']>[1]) {
    await this.gate(o?.signal)
    return this.inner.list(p, o)
  }
  async head(k: string, o?: { signal?: AbortSignal }) {
    await this.gate(o?.signal)
    return this.inner.head(k, o)
  }
  async get(k: string, o?: Parameters<StorageBackend['get']>[1]) {
    await this.gate(o?.signal)
    return this.inner.get(k, o)
  }
  async put(k: string, b: Uint8Array, o?: Parameters<StorageBackend['put']>[2]) {
    await this.gate(o?.signal)
    return this.inner.put(k, b, o)
  }
  async delete(k: string, o?: { signal?: AbortSignal }) {
    await this.gate(o?.signal)
    return this.inner.delete(k, o)
  }
  async upload(k: string, src: ByteSource, o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (n: number) => void; signal?: AbortSignal }) {
    await this.gate(o.signal)
    return this.inner.upload(k, src, o)
  }
  async check(): Promise<BackendCheck> {
    return { ok: true, steps: [] }
  }
}

const TOKENS = (w: World): TokenSet => ({ accessToken: 'a1', refreshToken: 'r1', expiresAt: w.now() + 3_600_000, account: 'rod@example.com', accountId: 'dbid:AAA' })

async function signedInDevice() {
  const w = world()
  const d = driveApi(w)
  const db = w.db('A')
  await storeTokens(db, 'dropbox', TOKENS(w))
  await addSong(db, 's1', 'Autumn Leaves', { files: [{ id: 'f1', data: bytes(1, 2000) }] })
  const backend = new GatedBackend(w.backend(), d.http(db))
  const e = await enable(db, { ...w.opts({ backend }), backendConfig: w.cfg, relay: null, name: 'Band', skipCheck: true })
  await initialUpload(e)
  return { w, d, db, e }
}

afterEach(() => vi.unstubAllGlobals())

describe('engine on an OAuth drive', () => {
  it('a 401 refreshes once and the sync succeeds with the new token', async () => {
    const { d, db, e } = await signedInDevice()
    expect(d.f.count('/oauth2/token')).toBe(0)
    d.api.valid = 'a2' // the access token was revoked or expired early
    await addSong(db, 's2', 'Blue Bossa')
    await e.sync()
    expect(d.f.count('/oauth2/token')).toBe(1)
    expect(form(d.f.calls.find((c) => c.url.includes('/oauth2/token'))!.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid' })
    expect(e.status).toMatchObject({ phase: 'idle', error: undefined })
    expect(await readTokens(db, 'dropbox')).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' })
    // Later requests use the new token straight away.
    await e.sync()
    expect(d.f.count('/oauth2/token')).toBe(1)
  })

  it('a refused refresh stops sync with reauth (fatal) until the next sign-in', async () => {
    const { w, d, db, e } = await signedInDevice()
    d.api.valid = 'other'
    d.api.refresh = () => json({ error: 'invalid_grant', error_description: 'refresh token is malformed' }, 400)
    const err = await e.sync().catch((x) => x)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.code).toBe('reauth')
    expect(e.status.phase).toBe('error')
    expect(e.status.error).toMatchObject({ code: 'reauth', message: 'Sign in to your storage again to keep syncing. Your changes are kept on this device until then.' })
    expect((e as unknown as { fatal(): boolean }).fatal()).toBe(true)
    // Signing in again stores new tokens; the restarted engine syncs.
    e.stop()
    await storeTokens(db, 'dropbox', { ...TOKENS(w), accessToken: 'other', refreshToken: 'r9' })
    const e2 = await Engine.open(db, { now: w.now, backend: new GatedBackend(w.backend(), d.http(db)) })
    await e2.sync()
    expect(e2.status).toMatchObject({ phase: 'idle', error: undefined })
  })

  it('a provider rate limit is "syncing" with a backoff of at least retryAfterMs, never offline or an error', async () => {
    const { d, e } = await signedInDevice()
    d.api.rateLimit = 1
    const err = await e.sync().catch((x) => x)
    expect(err).toMatchObject({ code: 'rateLimited', retryAfterMs: 120_000 })
    expect(e.status.phase).toBe('syncing')
    expect(e.status.error).toBeUndefined()
    expect(e.backoff).toBeGreaterThanOrEqual(119_000)
    await e.sync()
    expect(e.status.phase).toBe('idle')
    expect(e.backoff).toBe(0)
  })

  it('Engine.fromConfig gives a drive backend this device’s tokens', async () => {
    const w = world()
    const db = w.db('A')
    await storeTokens(db, 'dropbox', TOKENS(w))
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).headers.get('authorization') ?? '')
      return json({ error_summary: 'path/not_found/..', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409)
    })
    const e = await Engine.fromConfig(db, { v: 1, secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', libraryId: 'l', roomId: 'r', deviceId: '0123456789abcdef', backend: { kind: 'dropbox', root: '' }, relay: null, name: 'n', joinedAt: 0, paused: false }, { now: w.now })
    await e.core.backend.head('os1/x/meta').catch(() => {})
    expect(seen).toContain('Bearer a1')
  })
})

describe('joining and leaving on a drive', () => {
  it('a missing library on a drive is wrongAccount, naming both accounts', async () => {
    const w = world()
    const db = w.db('B')
    await storeTokens(db, 'dropbox', { ...TOKENS(w), account: 'me@example.com' })
    const p = { v: 1 as const, s: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', b: { kind: 'dropbox' as const, root: '', account: 'band@example.com', accountId: 'dbid:BAND' } }
    const err = await openPairing(p, { backend: w.backend() }, db).catch((x) => x)
    expect(err).toBeInstanceOf(SyncError)
    expect([err.code, err.detail]).toEqual(['wrongAccount', 'band@example.com'])
    expect(err.message).toBe(
      'This library isn’t in the Dropbox account you signed in with (me@example.com). The code was made for band@example.com. Sign in with that account, or get a new code if the library was deleted.',
    )
    // Google Drive: the folder itself is gone for this account.
    const gone = { ...w.backend(), get: async () => Promise.reject(new BackendError('notFound', 'gone', { providerCode: 'FolderGone' })) } as unknown as StorageBackend
    const g = await openPairing({ ...p, b: { kind: 'gdrive', folder: 'f'.repeat(20) } }, { backend: gone }, db).catch((x) => x)
    expect(g.code).toBe('wrongAccount')
    // S3 keeps libraryGone.
    expect((await openPairing({ ...p, b: w.cfg }, { backend: w.backend() }).catch((x) => x)).code).toBe('libraryGone')
  })

  it('stop syncing revokes the Dropbox token and deletes it; keepSignIn keeps it', async () => {
    const revoke = fakeFetch({ [DROPBOX_REVOKE]: () => new Response(null, { status: 200 }) })
    vi.stubGlobal('fetch', revoke.fetch)
    const a = await signedInDevice()
    await leave(a.db, a.e, { now: a.w.now })
    expect(revoke.calls).toHaveLength(1)
    expect(revoke.calls[0].headers.authorization).toBe('Bearer a1')
    expect(await readTokens(a.db, 'dropbox')).toBeUndefined()
    expect(await getConfig(a.db)).toBeUndefined()

    const b = await signedInDevice()
    await leave(b.db, b.e, { now: b.w.now, keepSignIn: true })
    expect(revoke.calls).toHaveLength(1)
    expect(await readTokens(b.db, 'dropbox')).toEqual(TOKENS(b.w))
    expect(await getConfig(b.db)).toBeUndefined()
  })
})
