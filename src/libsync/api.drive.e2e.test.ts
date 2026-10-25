// @vitest-environment node
/**
 * The setup wizard's real path on each cloud drive, end to end: sign-in tokens stored for the library →
 * `driveBackendConfig` → `checkBackend` → `enableSync` ("Start syncing") → initial upload; then a second device
 * signs in for its own library, previews and joins the pairing code as a new library, and the two converge.
 * Nothing injects a backend: every flow builds its own through `createBackend` with the library's token
 * source, against the in-process provider fakes (installed as the global `fetch`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FakeAuth } from './backends/fakes/harness'

// Node environment (jsdom's Blob doesn't survive fake-indexeddb, so files would never upload); the library
// list and settings need a localStorage.
if (typeof localStorage === 'undefined') {
  const m = new Map<string, string>()
  const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}

vi.mock('../sync/transports', async (orig) => ({ ...(await orig<typeof import('../sync/transports')>()), sameSiteRelayAvailable: async () => false }))

const api = await import('./api')
const dbm = await import('../db/db')
const svc = await import('./service')
const { Engine } = await import('./engine')
const { storeTokens, readTokens } = await import('./oauth/tokens')
const { createBackend } = await import('./backends')
const { listAll } = await import('./backends/util')
const { parseKey } = await import('./paths')
const { getConfig, getState } = await import('./state')
const { createLibrary, switchLibrary } = await import('../library/browse/libraries')
const { addSong, bytes } = await import('./sync.test-helper')
const { DropboxFake } = await import('./backends/fakes/dropbox.fake')
const { GDriveFake, FOLDER_MIME } = await import('./backends/fakes/gdrive.fake')
const { GraphFake } = await import('./backends/fakes/graph.fake')

type Kind = 'dropbox' | 'gdrive' | 'onedrive'
type Fake = InstanceType<typeof DropboxFake | typeof GDriveFake | typeof GraphFake>
type Db = InstanceType<typeof dbm.OpenStandDB>
type Cfg = Parameters<typeof createBackend>[0]

function makeFake(kind: Kind): { fake: Fake; accountId: string } {
  if (kind === 'dropbox') {
    const fake = new DropboxFake()
    return { fake, accountId: fake.account.id }
  }
  if (kind === 'gdrive') {
    const fake = new GDriveFake()
    return { fake, accountId: fake.user.permissionId }
  }
  const fake = new GraphFake()
  return { fake, accountId: fake.opts.driveId }
}

/**
 * The fake as the global `fetch`, with network failures to switch on: writes of device records (the step
 * right after `meta` in `enable`), and with `cleanup: false` every delete after such a refused write.
 */
function install(fake: Fake) {
  const faults = { devices: false, cleanup: true, deletes: false }
  const latin1 = new TextDecoder('latin1')
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const del = req.method === 'DELETE' || req.url.endsWith('/files/delete_v2')
      // The key is in the URL (OneDrive), the Dropbox-API-Arg header (Dropbox) or the metadata part (Drive).
      const what = `${req.url} ${req.headers.get('dropbox-api-arg') ?? ''} ${latin1.decode(await req.clone().arrayBuffer())}`
      if (faults.deletes && del) throw new TypeError('Failed to fetch (test)')
      if (faults.devices && !del && what.includes('devices')) {
        faults.deletes = !faults.cleanup
        throw new TypeError('Failed to fetch (test)')
      }
    }
    return fake.fetch(req)
  })
  return faults
}

/** What `completeSignIn` stores for the library the sign-in started in: a token the fake accepts. */
async function signIn(db: Db, kind: Kind, fake: Fake, accountId: string): Promise<FakeAuth> {
  const auth = fake.auth()
  await storeTokens(db, kind, { accessToken: auth.current, refreshToken: `r-${auth.current}`, expiresAt: Date.now() + 3_600_000, account: 'rod@example.com', accountId })
  return auth
}

async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Objects stored under `os1/` (listed with a token of the fake's own). */
async function stored(fake: Fake, cfg: Cfg) {
  const b = createBackend(cfg, { fetch: fake.fetch, auth: fake.auth() })
  return (await listAll(b, 'os1/')).map((i) => ({ key: i.key, p: parseKey(i.key) }))
}

const freshLibrary = (name: string) => {
  switchLibrary(createLibrary(name))
  return dbm.db
}

afterEach(() => {
  svc.currentEngine()?.stop()
  vi.unstubAllGlobals()
})

describe.each(['dropbox', 'gdrive', 'onedrive'] as const)('setup wizard on %s (no injected backend)', (kind) => {
  it('sign in → check → Start syncing uploads everything; a second device joins as a new library; both converge', async () => {
    const { fake, accountId } = makeFake(kind)
    install(fake)

    // Device A: sign in, the wizard's config and connection check, then "Start syncing".
    const dbA = freshLibrary(`A ${kind}`)
    await addSong(dbA, 's1', 'Autumn Leaves', { files: [{ id: 'f1', data: bytes(1, 3000) }] })
    const authA = await signIn(dbA, kind, fake, accountId)
    const cfg = await api.driveBackendConfig(kind)
    expect(cfg).toMatchObject({ kind, accountId })
    expect(await api.describeBackend(cfg)).toMatchObject({ account: { id: accountId } })
    const check = await api.checkBackend(cfg)
    expect(check.error).toBeUndefined()
    expect(check.ok).toBe(true)
    await api.enableSync({ backend: cfg })
    expect(await getConfig(dbA)).toMatchObject({ backend: cfg })

    // The initial upload runs in the restarted engine: meta, device, log, blob and snapshot reach the drive.
    await until('the initial upload', async () => (await stored(fake, cfg)).some((o) => o.p?.type === 'snap'))
    const types = new Set((await stored(fake, cfg)).map((o) => o.p?.type))
    for (const t of ['meta', 'device', 'head', 'log', 'blob', 'snap']) expect(types).toContain(t)
    expect(api.useLibSync.getState().error).toBeUndefined()
    const code = await api.pairingCode()
    svc.currentEngine()?.stop()
    // From here device A's token is dead: device B must sync with its own sign-in only.
    authA.expireNow()

    // Device B: signs in for its current library, previews the code and joins it as a new library.
    const home = freshLibrary(`B home ${kind}`)
    await signIn(home, kind, fake, accountId)
    const homeTokens = await readTokens(home, kind)
    const p = await api.parsePairingCode(code)
    expect(await api.previewJoin(p)).toMatchObject({ remoteSongs: 1, localSongs: 0 })
    await api.joinSync(p, 'newLibrary')
    const dbB = dbm.db
    expect(dbB.name).not.toBe(home.name)
    expect(await readTokens(dbB, kind)).toEqual(homeTokens)
    expect((await dbB.songs.get('s1'))?.title).toBe('Autumn Leaves')
    // The restarted engine downloads the file with B's tokens.
    await until('B’s engine', () => svc.currentEngine()?.db.name === dbB.name)
    const hash = (await dbB.songs.get('s1'))!.files[0].blobId
    await until('the file on B', async () => (await dbB.blobs.where('hash').equals(hash).count()) > 0)

    // B edits; A (signed in again) pulls it through an engine that builds its own backend.
    await addSong(dbB, 's2', 'Blue Bossa')
    await svc.currentEngine()!.sync()
    expect(api.useLibSync.getState().error).toBeUndefined()
    const a = new dbm.OpenStandDB(dbA.name)
    await signIn(a, kind, fake, accountId)
    const eA = await Engine.open(a, {})
    await eA.sync()
    expect((await a.songs.get('s2'))?.title).toBe('Blue Bossa')
    expect(eA.status.error).toBeUndefined()
    eA.stop()
    a.close()
    fake.verify()
  })
})

describe.each(['dropbox', 'gdrive'] as const)('retrying "Start syncing" on %s', (kind) => {
  it('a failed enable removes what it wrote; Try again succeeds on one library (and one Drive folder)', async () => {
    const { fake, accountId } = makeFake(kind)
    const faults = install(fake)
    const db = freshLibrary(`retry ${kind}`)
    await addSong(db, 's1', 'Autumn Leaves')
    await signIn(db, kind, fake, accountId)
    const cfg = await api.driveBackendConfig(kind)
    expect((await api.checkBackend(cfg)).ok).toBe(true)

    // `meta` goes in, then the device record fails to upload.
    faults.devices = true
    await expect(api.enableSync({ backend: cfg })).rejects.toMatchObject({ code: 'network' })
    faults.devices = false
    expect(await getConfig(db)).toBeUndefined()
    expect(await stored(fake, cfg)).toEqual([])
    const pending = await getState(db, 'enable')
    expect(pending).toBeDefined()

    // "Try again" (the wizard calls enableSync with the same config).
    await api.enableSync({ backend: cfg })
    const config = (await getConfig(db))!
    expect(config.secret).toBe(pending!.secret)
    expect(await getState(db, 'enable')).toBeUndefined()
    await until('the initial upload', async () => (await stored(fake, cfg)).some((o) => o.p?.type === 'snap'))
    expect(new Set((await stored(fake, cfg)).map((o) => o.p?.libraryId))).toEqual(new Set([config.libraryId]))
    if (fake instanceof GDriveFake) {
      // Back through the wizard (driveBackendConfig again) finds the same folder: still one OpenStand folder.
      expect(await api.driveBackendConfig('gdrive')).toMatchObject({ folder: (cfg as { folder: string }).folder })
      expect(fake.created.filter((f) => f.mimeType === FOLDER_MIME && f.appProperties.openstand === 'root')).toHaveLength(1)
    }
    fake.verify()
  })

  it('when even the cleanup fails, Try again adopts the meta the failed attempt left', async () => {
    const { fake, accountId } = makeFake(kind)
    const faults = install(fake)
    const db = freshLibrary(`adopt ${kind}`)
    await signIn(db, kind, fake, accountId)
    const cfg = await api.driveBackendConfig(kind)

    faults.devices = true
    faults.cleanup = false
    await expect(api.enableSync({ backend: cfg })).rejects.toMatchObject({ code: 'network' })
    faults.devices = faults.deletes = false
    const left = (await stored(fake, cfg)).filter((o) => o.p?.type === 'meta')
    expect(left).toHaveLength(1)

    await api.enableSync({ backend: cfg })
    const config = (await getConfig(db))!
    expect(left[0].p?.libraryId).toBe(config.libraryId)
    expect((await stored(fake, cfg)).filter((o) => o.p?.type === 'meta')).toHaveLength(1)
    fake.verify()
  })
})
