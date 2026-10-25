/**
 * Library-sync flows: enable (first device), join (here / merge; the
 * new-library variant is a `here` join into a freshly created library, done by the facade), leave, delete
 * remote data, and the join preview. Every join step is idempotent and checkpointed in `syncState.join`,
 * so an interrupted join resumes (`resumeJoin`).
 */
import type { OpenStandDB } from '../db/db'
import type { KV, PageAnnotations, Setlist, Song, SongLayers } from '../db/schema'
import { createBackend } from './backends'
import { listAll } from './backends/util'
import { BackendError, isOAuthKind, type BackendConfig, type StorageBackend } from './backends/types'
import { claimedSize } from './apply'
import { SHA256 } from './blobs'
import { decodeBatch, decodeDevice, decodeMeta, encodeMeta, objectStream, readSnapshot } from './codec'
import { b64url, deriveLibraryKeys, FormatError, newDeviceId, newSecret, type LibraryKeys } from './crypto'
import { Engine, rankSnapshots, SyncError, type EngineOptions } from './engine'
import { kvShape, syncedKv, validateDelta } from './fields'
import { HLC_ZERO } from './hlc'
import { joinFileMap, joinLayers, joinPages, joinSong, planJoin, remapSetlist } from './joinPlan'
import { materialize, mergeDelta } from './merge'
import type { DeviceRecord, JoinCheckpoint, JoinMode, PairingPayload, RecordDelta, SyncConfig } from './model'
import { devicesPrefix, headsPrefix, latestHeads, libraryPrefix, logKey, logPrefix, metaKey, parseKey, snapPrefix } from './paths'
import { allRecordKeys, clearSyncTables, deleteState, getConfig, getState, markDirty, putState, setCapture } from './state'
import { PROVIDERS } from './oauth/config'
import { forgetTokens, readTokens, tokenSource } from './oauth/tokens'

export interface FlowOptions extends EngineOptions {
  /** Build the backend for a config (tests share one MemoryBackend). */
  makeBackend?: (cfg: BackendConfig) => StorageBackend
  /** Untouched-demo check; defaults to `isUntouchedDemo` from the welcome screen. */
  isUntouchedDemo?: (song: Song, db: OpenStandDB) => Promise<boolean>
  onProgress?: (step: string, done: number, total: number) => void
}

/** Drives sign in with this device's tokens for library `db`; without `db` they throw `reauth`. */
const backendFor = (cfg: BackendConfig, o: FlowOptions, db?: OpenStandDB) =>
  o.backend ??
  o.makeBackend?.(cfg) ??
  createBackend(cfg, { now: o.now, auth: db && isOAuthKind(cfg.kind) ? tokenSource(db, cfg.kind, { now: o.now }) : undefined })

const defaultDemoCheck = async (song: Song, db: OpenStandDB) => (await import('../library/browse/Welcome')).isUntouchedDemo(song, db)

// ---------------------------------------------------------------------------------------------
// Enable (first device)
// ---------------------------------------------------------------------------------------------

/**
 * Enable: create the synced library from this one. Returns the engine; its first `sync()` publishes
 * everything (the dirty marks and upload transfers persist, so an interrupted initial upload resumes).
 */
export async function enable(
  db: OpenStandDB,
  o: FlowOptions & { backendConfig: BackendConfig; relay: string | null; name: string; skipCheck?: boolean },
): Promise<Engine> {
  if (await getConfig(db)) throw new SyncError('unknown', 'Library sync is already on for this library')
  const backend = backendFor(o.backendConfig, o)
  if (!o.skipCheck) {
    const check = await backend.check()
    if (!check.ok) throw check.error ?? new BackendError('unknown', 'The storage check failed')
  }
  const now = o.now ?? Date.now
  const secret = newSecret()
  const keys = await deriveLibraryKeys(secret)
  await backend.put(metaKey(keys.libraryId), await encodeMeta(keys, { v: 1, createdAt: now(), name: o.name }), { ifNoneMatch: true })
  const config: SyncConfig = {
    v: 1,
    secret: b64url(secret),
    libraryId: keys.libraryId,
    roomId: keys.roomId,
    deviceId: newDeviceId(),
    backend: o.backendConfig,
    relay: o.relay,
    name: o.name,
    joinedAt: now(),
    paused: false,
  }
  const engine = await Engine.fromConfig(db, config, { ...o, backend, keys })
  await engine.putDevice()
  await db.transaction('rw', db.syncState, async () => {
    await putState(db, 'config', config)
    await putState(db, 'seq', { next: 1 })
    await putState(db, 'cursors', {})
    await putState(db, 'clock', HLC_ZERO)
  })
  setCapture(db, true)
  await markDirty(db, await allRecordKeys(db, syncedKv))
  return engine
}

/** First-device initial upload: publish, upload every file, then write the first snapshot. */
export async function initialUpload(engine: Engine, o: { onProgress?: FlowOptions['onProgress'] } = {}) {
  o.onProgress?.('publish', 0, 1)
  await engine.sync()
  await engine.transfers.start()
  await engine.transfers.idle()
  await engine.sync()
  o.onProgress?.('snapshot', 0, 1)
  await engine.writeSnapshot()
}

/**
 * A library without a relay (the site's relay check failed at setup, or the pairing code carried none from
 * such a device) adopts `base` when `available()` says this site hosts one: saved in the config, so new
 * pairing codes carry it, and connected at once. Safe: the relay only carries sealed hints, in a room derived
 * from the library secret. Returns whether it was adopted.
 */
export async function adoptSiteRelay(engine: Engine, base: string, available: () => Promise<boolean>): Promise<boolean> {
  if (engine.config.relay || !(await available())) return false
  const d = engine.db
  const adopted = await d.transaction('rw', d.syncState, async () => {
    const config = await getConfig(d)
    if (!config || config.relay || config.libraryId !== engine.config.libraryId) return false
    await putState(d, 'config', { ...config, relay: base })
    return true
  })
  if (adopted) engine.adoptRelay(base)
  return adopted
}

// ---------------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------------

/**
 * Derive keys from a pairing payload and prove them by decrypting `meta`. `db`: the library
 * whose drive tokens to use. On a drive, a missing `meta` (or Drive folder) most likely means another account:
 * `wrongAccount`, whose `detail` is the account the code was made for.
 */
export async function openPairing(p: PairingPayload, o: FlowOptions = {}, db?: OpenStandDB): Promise<{ keys: LibraryKeys; backend: StorageBackend; name: string }> {
  const keys = await deriveLibraryKeys(p.s)
  const backend = backendFor(p.b, o, db)
  let bytes: Uint8Array | null
  try {
    bytes = await backend.get(metaKey(keys.libraryId))
  } catch (e) {
    if (isOAuthKind(p.b.kind) && e instanceof BackendError && e.code === 'notFound') throw await wrongAccount(p, db)
    throw e
  }
  if (!bytes) throw isOAuthKind(p.b.kind) ? await wrongAccount(p, db) : new SyncError('libraryGone')
  try {
    const meta = await decodeMeta(keys, bytes)
    return { keys, backend, name: p.n || meta.name }
  } catch (e) {
    if (e instanceof FormatError && e.code === 'newerFormat') throw new SyncError('newerFormat')
    if (e instanceof FormatError && e.code === 'oldFormat')
      throw new SyncError('rejoin', 'That synced library was made by an older OpenStand. Reset sync on a device that has it, then pair again.')
    throw new SyncError('wrongSecret')
  }
}

async function wrongAccount(p: PairingPayload, db?: OpenStandDB): Promise<SyncError> {
  const cfg = p.b as Extract<BackendConfig, { account?: string }>
  const name = PROVIDERS[p.b.kind as keyof typeof PROVIDERS].name
  const got = db && isOAuthKind(p.b.kind) ? (await readTokens(db, p.b.kind).catch(() => undefined))?.account : undefined
  const want = cfg.account
  const message =
    `This library isn’t in the ${name} account you signed in with${got ? ` (${got})` : ''}.` +
    `${want ? ` The code was made for ${want}.` : ''} Sign in with that account, or get a new code if the library was deleted.`
  return new SyncError('wrongAccount', message, want)
}

/** Batches the join preview reads at most (beyond the snapshot); it's an estimate, not a sync. */
const PREVIEW_LOGS = 2000
/** Snapshot headers the preview reads at most. */
const PREVIEW_SNAPS = 16

/**
 * Remote songs and setlists as they'd materialise: best trusted snapshot plus the logs after it (preview
 * only). Every loop is bounded by what a LIST shows, not by head values (anyone with bucket access can
 * write heads), and anything unreadable is skipped.
 */
async function remoteLibrary(keys: LibraryKeys, backend: StorageBackend, now = Date.now()): Promise<{ songs: Song[]; setlists: Setlist[] }> {
  const lib = keys.libraryId
  const states = new Map<string, RecordDelta>()
  const add = (op: RecordDelta) => {
    if ((op.c !== 'song' && op.c !== 'setlist') || validateDelta(op)) return
    states.set(op.c + '/' + op.id, mergeDelta(states.get(op.c + '/' + op.id), op))
  }
  const list = async (prefix: string) => (await listAll(backend, prefix)).map((i) => i.key)
  const devices = new Map<string, DeviceRecord>()
  for (const k of await list(devicesPrefix(lib))) {
    const p = parseKey(k)
    if (p?.type !== 'device') continue
    const b = await backend.get(k)
    if (b) await decodeDevice(keys, b, p.deviceId).then((d) => void devices.set(d.id, d), () => {})
  }
  const heads = Object.fromEntries(Object.entries(latestHeads(lib, await list(headsPrefix(lib)))).filter(([d]) => devices.has(d)))
  const { readSnapshotHeader } = await import('./codec')
  const { FIRST_CHUNK_RANGE } = await import('./crypto')
  const snaps: { key: string; deviceId: string; n: number; header: Awaited<ReturnType<typeof readSnapshotHeader>> }[] = []
  const snapKeys = (await list(snapPrefix(lib)))
    .map((k) => ({ k, p: parseKey(k) }))
    .flatMap(({ k, p }) => (p?.type === 'snap' && devices.has(p.deviceId) ? [{ k, deviceId: p.deviceId, n: p.seq }] : []))
    .sort((a, b) => b.n - a.n)
    .slice(0, PREVIEW_SNAPS)
  for (const { k, deviceId, n } of snapKeys) {
    const b = await backend.get(k, { range: FIRST_CHUNK_RANGE })
    if (!b) continue
    try {
      snaps.push({ key: k, deviceId, n, header: await readSnapshotHeader(keys, { deviceId, n }, b, { now }) })
    } catch {
      /* unreadable: skip */
    }
  }
  let vector: Record<string, number> = {}
  for (const best of rankSnapshots(snaps, { heads, devices, now }).slice(0, 2)) {
    try {
      const r = await readSnapshot(keys, { deviceId: best.deviceId, n: best.n }, objectStream(backend, best.key), { now })
      for await (const op of r.records) add(op)
      vector = best.header.vector
      break
    } catch {
      /* unreadable or truncated: what was read still counts; try the next one */
    }
  }
  // Existing log entries after the snapshot, by LIST (never 1..head).
  const pending: { d: string; s: number }[] = []
  for (const k of await list(logPrefix(lib))) {
    const p = parseKey(k)
    if (p?.type === 'log' && Object.hasOwn(heads, p.deviceId) && p.seq > (vector[p.deviceId] ?? 0) && p.seq <= heads[p.deviceId]) pending.push({ d: p.deviceId, s: p.seq })
  }
  pending.sort((a, b) => a.d.localeCompare(b.d) || a.s - b.s)
  for (const { d, s } of pending.slice(0, PREVIEW_LOGS)) {
    const bytes = await backend.get(logKey(lib, d, s))
    if (!bytes) continue
    try {
      for (const op of (await decodeBatch(keys, bytes, { deviceId: d, seq: s })).ops) add(op)
    } catch {
      /* unreadable: skip (preview only) */
    }
  }
  const songs: Song[] = []
  const setlists: Setlist[] = []
  for (const st of states.values()) {
    let row: ReturnType<typeof materialize>
    try {
      row = materialize(st.c as 'song', st, null)
    } catch {
      continue
    }
    if (!row) continue
    if (st.c === 'song') songs.push(row as Song)
    else setlists.push(row as unknown as Setlist)
  }
  return { songs, setlists }
}

const localHashOf = async (db: OpenStandDB) => {
  const map = new Map<string, string>()
  for (const b of await db.blobs.toArray()) map.set(b.id, b.hash)
  return (id: string) => (SHA256.test(id) ? id : (map.get(id) ?? ''))
}

/** Local songs without the untouched demos. */
async function realLocalSongs(db: OpenStandDB, o: FlowOptions) {
  const check = o.isUntouchedDemo ?? defaultDemoCheck
  const out: Song[] = []
  const demos: Song[] = []
  for (const s of await db.songs.toArray()) ((await check(s, db)) ? demos : out).push(s)
  return { songs: out, demos }
}

export interface JoinPreview {
  remoteSongs: number
  remoteBytes: number
  localSongs: number
  matches: number
  suggested: 'here' | 'newLibrary'
}

/** What joining would bring, and the suggested mode. */
export async function previewJoin(db: OpenStandDB, p: PairingPayload, o: FlowOptions = {}): Promise<JoinPreview> {
  const { keys, backend } = await openPairing(p, o, db)
  const remote = await remoteLibrary(keys, backend, (o.now ?? Date.now)())
  const { songs } = await realLocalSongs(db, o)
  const plan = planJoin({ songs, setlists: await db.setlists.toArray() }, remote, await localHashOf(db))
  const sizes = new Map<string, number>()
  for (const s of remote.songs) for (const f of s.files) sizes.set(f.blobId, claimedSize(f.size))
  return {
    remoteSongs: remote.songs.length,
    remoteBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    localSongs: songs.length,
    matches: plan.songMap.size,
    suggested: songs.length ? 'newLibrary' : 'here',
  }
}

/**
 * Join into `db` (mode `here` or `merge`; for `newLibrary` the facade creates and switches to a new
 * library and joins it `here`). Resolves when the bootstrap is done; downloads continue in the engine.
 */
export async function join(db: OpenStandDB, p: PairingPayload, mode: Exclude<JoinMode, 'newLibrary'>, o: FlowOptions = {}): Promise<Engine> {
  if ((await getConfig(db)) && !(await getState(db, 'join'))) throw new SyncError('unknown', 'Library sync is already on for this library')
  const { keys, backend, name } = await openPairing(p, o, db)
  const now = o.now ?? Date.now
  let config = await getConfig(db)
  if (!config) {
    // Untouched demo songs are dropped before anything is published.
    const { demos } = await realLocalSongs(db, o)
    if (demos.length) await db.songs.bulkDelete(demos.map((s) => s.id))
    config = {
      v: 1,
      secret: p.s,
      libraryId: keys.libraryId,
      roomId: keys.roomId,
      deviceId: newDeviceId(),
      backend: p.b,
      relay: p.r ?? null,
      name,
      joinedAt: now(),
      paused: false,
    }
    const stash: Record<string, unknown> = {}
    if (mode === 'merge') for (const kv of await db.kv.toArray()) if (syncedKv(kv.key)) stash[kv.key] = kv.value
    const cp: JoinCheckpoint = { phase: 'bootstrap', mode, startedAt: now(), stash }
    await db.transaction('rw', db.syncState, async () => {
      await putState(db, 'config', config!)
      await putState(db, 'join', cp)
      await putState(db, 'seq', { next: 1 })
      await putState(db, 'cursors', {})
      await putState(db, 'clock', HLC_ZERO)
    })
  }
  return resumeJoin(db, { ...o, backend, keys })
}

/** Continue a checkpointed join from its phase (every step is idempotent). */
export async function resumeJoin(db: OpenStandDB, o: FlowOptions = {}): Promise<Engine> {
  const config = await getConfig(db)
  let cp = await getState(db, 'join')
  if (!config || !cp) throw new SyncError('unknown', 'No join in progress')
  const engine = await Engine.fromConfig(db, config, { ...o, backend: o.backend ?? backendFor(config.backend, o, db) })
  const step = async (phase: JoinCheckpoint['phase']) => {
    cp = { ...cp!, phase }
    await putState(db, 'join', cp)
  }
  if (cp.phase === 'bootstrap') {
    setCapture(db, false)
    o.onProgress?.('bootstrap', 0, 1)
    await engine.bootstrap({ onProgress: (d, t) => o.onProgress?.('bootstrap', d, t) })
    await engine.pull()
    await step('register')
  }
  if (cp.phase === 'register') {
    setCapture(db, true)
    await engine.putDevice()
    await step(cp.mode === 'merge' ? 'merge' : 'publish')
  }
  if (cp.phase === 'merge') {
    o.onProgress?.('merge', 0, 1)
    await joinMerge(db, cp.stash ?? {}, o)
    await step('publish')
  }
  if (cp.phase === 'publish') {
    // Local-only records (no shadow) are published like new edits.
    const shadowed = new Set((await db.syncShadow.toCollection().primaryKeys()) as string[])
    const keys = (await allRecordKeys(db, syncedKv)).filter((k) => !shadowed.has(k.slice(k.indexOf('/') + 1)))
    await markDirty(db, keys)
    await deleteState(db, 'join')
  }
  return engine
}

function unionKv(key: string, local: unknown, remote: unknown): unknown {
  if (remote === undefined || remote === null) return local
  if (key.startsWith('layers:')) return joinLayers(local as SongLayers, remote as SongLayers).layers
  const spec = kvShape(key)?.table.value
  switch (spec?.kind) {
    case 'set':
      return [...new Set([...((remote as string[]) ?? []), ...((local as string[]) ?? [])])]
    case 'list': {
      const k = spec.key ?? 'name'
      const r = (remote as Record<string, unknown>[]) ?? []
      const have = new Set(r.map((x) => x[k]))
      return [...r, ...((local as Record<string, unknown>[]) ?? []).filter((x) => !have.has(x[k]))]
    }
    case 'max':
      return Math.max(Number(local) || 0, Number(remote) || 0)
    default:
      return remote
  }
}

/** Combine matched local songs into their remote twins. A normal, captured write. */
async function joinMerge(db: OpenStandDB, stash: Record<string, unknown>, o: FlowOptions) {
  const shadowed = new Set((await db.syncShadow.toCollection().primaryKeys()) as string[])
  const songs = await db.songs.toArray()
  const setlists = await db.setlists.toArray()
  const local = { songs: songs.filter((s) => !shadowed.has(s.id)), setlists: setlists.filter((s) => !shadowed.has(s.id)) }
  const remote = { songs: songs.filter((s) => shadowed.has(s.id)), setlists: setlists.filter((s) => shadowed.has(s.id)) }
  const plan = planJoin(local, remote, await localHashOf(db))
  const byId = new Map(songs.map((s) => [s.id, s]))
  await db.transaction('rw', [db.songs, db.setlists, db.annotations, db.kv], async () => {
    for (const [lid, rid] of plan.songMap) {
      const L = byId.get(lid)!
      const R = byId.get(rid)!
      await db.songs.put(joinSong(L, R))
      const layersL = (await db.kv.get(`layers:${lid}`))?.value as SongLayers | undefined
      const layersR = (await db.kv.get(`layers:${rid}`))?.value as SongLayers | undefined
      const { layers, map } = joinLayers(layersL, layersR)
      if (layers && layersL) await db.kv.put({ key: `layers:${rid}`, value: layers })
      const lp = await db.annotations.where('songId').equals(lid).toArray()
      const rp = await db.annotations.where('songId').equals(rid).toArray()
      const pages: PageAnnotations[] = joinPages(lp, rp, joinFileMap(L, R), rid, map)
      if (pages.length) await db.annotations.bulkPut(pages)
      await db.annotations.bulkDelete(lp.map((p) => p.id))
      await db.kv.delete(`layers:${lid}`)
      await db.kv.delete(`textLayout:${lid}`)
      await db.songs.delete(lid)
    }
    for (const s of local.setlists) {
      if (plan.setlistMap.has(s.id)) await db.setlists.delete(s.id)
      else {
        const next = remapSetlist(s, plan.songMap)
        if (next !== s) await db.setlists.put(next)
      }
    }
    for (const [key, value] of Object.entries(stash)) {
      const cur = (await db.kv.get(key)) as KV | undefined
      await db.kv.put({ key, value: unionKv(key, value, cur?.value) })
    }
  })
  o.onProgress?.('merge', 1, 1)
}

// ---------------------------------------------------------------------------------------------
// Leave, delete, reset
// ---------------------------------------------------------------------------------------------

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]).catch(() => undefined)

/**
 * After "Stop syncing" or "Delete synced data": this device's drive sign-in for the library goes too, Dropbox's
 * revoked first. Best effort; the sync tables (and with them the tokens) are cleared next.
 */
async function forgetSignIn(db: OpenStandDB, o: FlowOptions & { keepSignIn?: boolean }) {
  if (o.keepSignIn) return
  const kinds = Object.keys((await getState(db, 'oauth').catch(() => undefined)) ?? {}).filter(isOAuthKind)
  for (const kind of kinds) await withTimeout(forgetTokens(db, kind, { now: o.now }), 10_000)
}

/**
 * Stop syncing on this device. Library rows stay; the library becomes a normal local one. `keepSignIn`:
 * keep this device's drive tokens (rejoining the same library right after), else they are deleted (and
 * Dropbox's revoked).
 */
export async function leave(db: OpenStandDB, engine?: Engine, o: FlowOptions & { keepSignIn?: boolean } = {}) {
  const e = engine ?? (await getConfig(db).then((c) => (c ? Engine.fromConfig(db, c, o) : undefined)))
  if (e) {
    await withTimeout(e.sync(), 10_000)
    e.stop()
    try {
      // Heads, logs and snapshots stay: devices that join later still need this stream until a snapshot
      // covers it, and the retired-device pruning removes them then. A deleted or reset library gets
      // no record: nothing would ever remove it.
      if (await e.core.backend.head(metaKey(e.core.keys.libraryId))) await e.putDevice({ retired: true })
    } catch (err) {
      o.log?.('could not retire device', err)
    }
  }
  setCapture(db, false)
  const kept = o.keepSignIn ? await getState(db, 'oauth') : undefined
  await forgetSignIn(db, o)
  await clearSyncTables(db)
  if (kept) await putState(db, 'oauth', kept)
}

/** Delete everything under `os1/<libraryId>/`. Then sync is off on this device too. */
export async function deleteRemote(db: OpenStandDB, engine?: Engine, o: FlowOptions = {}) {
  const config = await getConfig(db)
  if (!config) return
  const e = engine ?? (await Engine.fromConfig(db, config, o))
  e.stop()
  const prefix = libraryPrefix(e.core.keys.libraryId)
  // Meta first, so other devices see `libraryGone` rather than a half-deleted library.
  await e.core.backend.delete(metaKey(e.core.keys.libraryId))
  for (const k of await e.listAll(prefix)) await e.core.backend.delete(k.key)
  setCapture(db, false)
  await forgetSignIn(db, o)
  await clearSyncTables(db)
}

/** Retire this device and clear its flag before a library database is deleted (best effort). */
export async function retireBeforeDelete(db: OpenStandDB, o: FlowOptions = {}) {
  try {
    if (await getConfig(db)) await withTimeout(leave(db, undefined, o), 15_000)
  } finally {
    setCapture(db, false)
  }
}


