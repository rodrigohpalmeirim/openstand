/**
 * Library-sync flows (docs/SYNC.md §10.3–§10.5, §3.2): enable (first device), join (here / merge; the
 * new-library variant is a `here` join into a freshly created library, done by the facade), leave, delete
 * remote data, and the join preview. Every join step is idempotent and checkpointed in `syncState.join`,
 * so an interrupted join resumes (`resumeJoin`).
 */
import type { OpenStandDB } from '../db/db'
import type { KV, PageAnnotations, Setlist, Song, SongLayers } from '../db/schema'
import { createBackend } from './backends'
import { BackendError, type BackendConfig, type StorageBackend } from './backends/types'
import { SHA256 } from './blobs'
import { decodeBatch, decodeMeta, encodeMeta, objectStream, readSnapshot } from './codec'
import { b64url, deriveLibraryKeys, FormatError, newDeviceId, newSecret, type LibraryKeys } from './crypto'
import { Engine, bestSnapshot, SyncError, type EngineOptions } from './engine'
import { kvShape, syncedKv } from './fields'
import { HLC_ZERO } from './hlc'
import { joinFileMap, joinLayers, joinPages, joinSong, planJoin, remapSetlist } from './joinPlan'
import { materialize, mergeDelta } from './merge'
import type { JoinCheckpoint, JoinMode, PairingPayload, RecordDelta, SyncConfig } from './model'
import { headsPrefix, latestHeads, libraryPrefix, logKey, metaKey, parseKey, snapPrefix } from './paths'
import { allRecordKeys, clearSyncTables, deleteState, getConfig, getState, markDirty, putState, setCapture } from './state'

export interface FlowOptions extends EngineOptions {
  /** Build the backend for a config (tests share one MemoryBackend). */
  makeBackend?: (cfg: BackendConfig) => StorageBackend
  /** Untouched-demo check; defaults to `isUntouchedDemo` from the welcome screen. */
  isUntouchedDemo?: (song: Song, db: OpenStandDB) => Promise<boolean>
  onProgress?: (step: string, done: number, total: number) => void
}

const backendFor = (cfg: BackendConfig, o: FlowOptions) => o.backend ?? o.makeBackend?.(cfg) ?? createBackend(cfg, { now: o.now })

const defaultDemoCheck = async (song: Song, db: OpenStandDB) => (await import('../library/browse/Welcome')).isUntouchedDemo(song, db)

// ---------------------------------------------------------------------------------------------
// Enable (first device)
// ---------------------------------------------------------------------------------------------

/**
 * §10.3 Enable: create the synced library from this one. Returns the engine; its first `sync()` publishes
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

// ---------------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------------

/** Derive keys from a pairing payload and prove them by decrypting `meta` (§10.3 step 1). */
export async function openPairing(p: PairingPayload, o: FlowOptions = {}): Promise<{ keys: LibraryKeys; backend: StorageBackend; name: string }> {
  const keys = await deriveLibraryKeys(p.s)
  const backend = backendFor(p.b, o)
  const bytes = await backend.get(metaKey(keys.libraryId))
  if (!bytes) throw new SyncError('libraryGone')
  try {
    const meta = await decodeMeta(keys, bytes)
    return { keys, backend, name: p.n || meta.name }
  } catch (e) {
    if (e instanceof FormatError && e.code === 'newerFormat') throw new SyncError('newerFormat')
    throw new SyncError('wrongSecret')
  }
}

/** Remote songs and setlists as they'd materialise: best snapshot plus the logs after it (preview only). */
async function remoteLibrary(keys: LibraryKeys, backend: StorageBackend): Promise<{ songs: Song[]; setlists: Setlist[] }> {
  const lib = keys.libraryId
  const states = new Map<string, RecordDelta>()
  const add = (op: RecordDelta) => {
    if (op.c !== 'song' && op.c !== 'setlist') return
    states.set(op.c + '/' + op.id, mergeDelta(states.get(op.c + '/' + op.id), op))
  }
  const list = async (prefix: string) => {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await backend.list(prefix, { cursor })
      keys.push(...page.items.map((i) => i.key))
      cursor = page.cursor
    } while (cursor)
    return keys
  }
  const { readSnapshotHeader } = await import('./codec')
  const { FIRST_CHUNK_RANGE } = await import('./crypto')
  const snaps: { key: string; deviceId: string; n: number; header: Awaited<ReturnType<typeof readSnapshotHeader>> }[] = []
  for (const k of await list(snapPrefix(lib))) {
    const p = parseKey(k)
    if (p?.type !== 'snap') continue
    const b = await backend.get(k, { range: FIRST_CHUNK_RANGE })
    if (!b) continue
    try {
      snaps.push({ key: k, deviceId: p.deviceId, n: p.seq, header: await readSnapshotHeader(keys, { deviceId: p.deviceId, n: p.seq }, b) })
    } catch {
      /* unreadable: skip */
    }
  }
  const best = bestSnapshot(snaps)
  const vector = best?.header.vector ?? {}
  if (best) {
    const r = await readSnapshot(keys, { deviceId: best.deviceId, n: best.n }, objectStream(backend, best.key))
    for await (const op of r.records) add(op)
  }
  const heads = latestHeads(lib, await list(headsPrefix(lib)))
  for (const [d, head] of Object.entries(heads)) {
    for (let s = (vector[d] ?? 0) + 1; s <= head; s++) {
      const bytes = await backend.get(logKey(lib, d, s))
      if (!bytes) continue
      for (const op of (await decodeBatch(keys, bytes, { deviceId: d, seq: s })).ops) add(op)
    }
  }
  const songs: Song[] = []
  const setlists: Setlist[] = []
  for (const st of states.values()) {
    const row = materialize(st.c as 'song', st, null)
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

/** §10.3 step 2: what joining would bring, and the suggested mode. */
export async function previewJoin(db: OpenStandDB, p: PairingPayload, o: FlowOptions = {}): Promise<JoinPreview> {
  const { keys, backend } = await openPairing(p, o)
  const remote = await remoteLibrary(keys, backend)
  const { songs } = await realLocalSongs(db, o)
  const plan = planJoin({ songs, setlists: await db.setlists.toArray() }, remote, await localHashOf(db))
  const sizes = new Map<string, number>()
  for (const s of remote.songs) for (const f of s.files) sizes.set(f.blobId, f.size ?? 0)
  return {
    remoteSongs: remote.songs.length,
    remoteBytes: [...sizes.values()].reduce((a, b) => a + b, 0),
    localSongs: songs.length,
    matches: plan.songMap.size,
    suggested: songs.length ? 'newLibrary' : 'here',
  }
}

/**
 * §10.3 Join into `db` (mode `here` or `merge`; for `newLibrary` the facade creates and switches to a new
 * library and joins it `here`). Resolves when the bootstrap is done; downloads continue in the engine.
 */
export async function join(db: OpenStandDB, p: PairingPayload, mode: Exclude<JoinMode, 'newLibrary'>, o: FlowOptions = {}): Promise<Engine> {
  if ((await getConfig(db)) && !(await getState(db, 'join'))) throw new SyncError('unknown', 'Library sync is already on for this library')
  const { keys, backend, name } = await openPairing(p, o)
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
  const engine = await Engine.fromConfig(db, config, { ...o, backend: o.backend ?? backendFor(config.backend, o) })
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

/** §10.3 step 8: combine matched local songs into their remote twins. A normal, captured write. */
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

/** §10.4 Stop syncing on this device. Library rows stay; the library becomes a normal local one. */
export async function leave(db: OpenStandDB, engine?: Engine, o: FlowOptions = {}) {
  const e = engine ?? (await getConfig(db).then((c) => (c ? Engine.fromConfig(db, c, o) : undefined)))
  if (e) {
    await withTimeout(e.sync(), 10_000)
    e.stop()
    try {
      await e.putDevice({ retired: true })
      const { backend, keys, config } = e.core
      for (const k of await e.listAll(headsPrefix(keys.libraryId, config.deviceId))) await backend.delete(k.key)
    } catch (err) {
      o.log?.('could not retire device', err)
    }
  }
  setCapture(db, false)
  await clearSyncTables(db)
}

/** §10.5 Delete everything under `os1/<libraryId>/`. Then sync is off on this device too. */
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


