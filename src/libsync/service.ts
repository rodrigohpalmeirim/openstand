/**
 * Library-sync background service (docs/SYNC.md §10.1). One engine per library database, in one tab: the
 * tab holding the Web Lock `openstand-libsync:<db>` runs it, the others only write (their dirty marks
 * reach the engine through Dexie's cross-tab change events) and mirror its status over a
 * BroadcastChannel. The engine restarts when the active library changes.
 */
import { db as currentDb, OpenStandDB } from '../db/db'
import { flush as flushAnnotations, remoteChanged } from '../annotations/store'
import { useLibraries } from '../library/browse/libraries'
import { registerService } from '../services'
import { settings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { defaultDeviceName } from '../sync/sync'
import { on } from '../viewer/events'
import { emitBlobReady, offStatus, useLibSync, type LibSyncStatus } from './api'
import type { Engine, EngineEnv, EngineStatus } from './engine'
import { getConfig, getState, registerDbHooks } from './state'

// The engine, crypto and backends load only once a library actually syncs.
const engineModule = () => import('./engine')
const joinModule = () => import('./join')

// db.ts and capture.ts don't import libsync: register the kv allow-list and the prune guard.
registerDbHooks()

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

let lastInput = Date.now()
const env: EngineEnv = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  performing: () => useViewer.getState().queue.length > 0,
  idle: () => env.visible() && !env.performing() && Date.now() - lastInput > 60_000,
}

export const deviceName = () => settings().sync.deviceName.trim() || defaultDeviceName()

// ---------------------------------------------------------------------------------------------
// Status: published to `useLibSync` here, mirrored to other tabs
// ---------------------------------------------------------------------------------------------

const CHANNEL = 'openstand-libsync-status'
let channel: BroadcastChannel | null = null
let initial: LibSyncStatus['initial']

function publish(s: EngineStatus | null, configured: boolean) {
  const next: LibSyncStatus = s
    ? {
        phase: s.phase,
        configured,
        backendLabel: s.backendLabel,
        lastSyncAt: s.lastSyncAt,
        pendingChanges: s.pendingChanges,
        upload: s.upload,
        download: s.download,
        offlineReady: s.offlineReady,
        initial,
        relay: s.relay,
        devices: s.devices,
        error: s.error ?? (s.warning && s.phase !== 'error' ? s.warning : undefined),
      }
    : { ...offStatus(), configured, phase: configured ? 'starting' : 'off', initial }
  useLibSync.setState(next, true)
  channel?.postMessage({ db: currentDb.name, status: next })
}

export function setInitial(p: LibSyncStatus['initial']) {
  initial = p
  useLibSync.setState({ initial: p })
}

// ---------------------------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------------------------

let engine: Engine | null = null
let generation = 0
let releaseLock: (() => void) | null = null

/** The running engine for the current library (only in the tab holding the lock). */
export const currentEngine = () => engine

function hooksFor(d: OpenStandDB) {
  const global = () => d === currentDb
  return {
    beforeApply: async (ops: { c: string }[]) => {
      if (global() && ops.some((o) => o.c === 'ann')) await flushAnnotations()
    },
    afterApply: async (a: { anns: Set<string> }) => {
      if (global() && a.anns.size) await remoteChanged(a.anns)
    },
    blobReady: (hash: string) => emitBlobReady(hash),
    status: (s: EngineStatus) => global() && publish(s, true),
  }
}

async function stopEngine() {
  generation++
  engine?.stop()
  engine = null
  releaseLock?.()
  releaseLock = null
}

/** (Re)start sync for the current library: take the lock, resume an interrupted join, run the engine. */
export async function restart(o: { afterStart?: (e: Engine) => Promise<void> } = {}) {
  await stopEngine()
  const gen = generation
  const d = currentDb
  const config = await getConfig(d).catch(() => undefined)
  if (gen !== generation) return
  if (!config) return publish(null, false)
  publish(null, true)
  const run = async () => {
    if (gen !== generation) return
    try {
      const { Engine } = await engineModule()
      const e = (await getState(d, 'join'))
        ? await (await joinModule()).resumeJoin(d, { hooks: hooksFor(d), env, deviceName })
        : await Engine.open(d, { hooks: hooksFor(d), env, deviceName, log: (m, x) => console.debug('[libsync]', m, x ?? '') })
      if (gen !== generation) return e.stop()
      engine = e
      await e.start()
      if (o.afterStart) void o.afterStart(e).catch((err) => console.warn('[libsync]', err))
    } catch (err) {
      const { toSyncError } = await engineModule()
      useLibSync.setState({ phase: 'error', configured: true, error: toSyncError(err) })
    }
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return run()
  void locks.request(`openstand-libsync:${d.name}`, () => {
    if (gen !== generation) return
    return new Promise<void>((resolve) => {
      releaseLock = resolve
      void run()
    })
  })
}

/** Give the engine to the caller's flow (enable/join) and restart it afterwards. */
export async function withEngineStopped<T>(fn: () => Promise<T>): Promise<T> {
  await stopEngine()
  try {
    return await fn()
  } finally {
    void restart()
  }
}

/** Called by `deleteLibrary` before the database is deleted. */
export async function beforeLibraryDelete(dbName: string) {
  if (engine && engine.db.name === dbName) await stopEngine()
  const d = new OpenStandDB(dbName)
  try {
    await (await joinModule()).retireBeforeDelete(d)
  } finally {
    d.close()
  }
}

/** Raise download priority for these songs' files (a song or setlist opened). */
export async function prioritizeSongs(ids: string[]) {
  const e = engine
  if (!e) return
  const songs = await e.db.songs.bulkGet(ids)
  const hashes = songs.flatMap((s) => (s ? [...s.files.map((f) => f.blobId), ...s.audio.flatMap((a) => (a.blobId ? [a.blobId] : []))] : []))
  await e.transfers.prioritize(hashes)
}

registerService(() => {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (ev) => {
      const m = ev.data as { db?: string; status?: LibSyncStatus; cmd?: string }
      if (m.db !== currentDb.name) return
      if (m.status && !engine) useLibSync.setState(m.status, true)
      if (m.cmd === 'syncNow' && engine) void engine.sync().catch(() => {})
    }
  }
  const input = () => (lastInput = Date.now())
  const vis = () => engine?.onVisibility(env.visible())
  const online = () => engine?.onOnline()
  const offline = () => useLibSync.setState({ phase: 'offline' })
  const hidden = () => {
    if (document.visibilityState === 'hidden') void flushAnnotations()
  }
  window.addEventListener('pointerdown', input, { passive: true })
  window.addEventListener('keydown', input, { passive: true })
  document.addEventListener('visibilitychange', vis)
  document.addEventListener('visibilitychange', hidden)
  window.addEventListener('online', online)
  window.addEventListener('offline', offline)
  const offClosed = on('songClosed', () => engine?.onSongClosed())
  const offOpened = on('songOpened', ({ song }) => void prioritizeSongs([song.id]))
  let active = useLibraries.getState().active
  const unsub = useLibraries.subscribe((s) => {
    if (s.active === active) return
    active = s.active
    void restart()
  })
  void restart()
  return () => {
    unsub()
    offClosed()
    offOpened()
    window.removeEventListener('pointerdown', input)
    window.removeEventListener('keydown', input)
    document.removeEventListener('visibilitychange', vis)
    document.removeEventListener('visibilitychange', hidden)
    window.removeEventListener('online', online)
    window.removeEventListener('offline', offline)
    channel?.close()
    channel = null
    void stopEngine()
  }
})

/** Ask whichever tab runs the engine to sync now. */
export function requestSyncNow() {
  channel?.postMessage({ db: currentDb.name, cmd: 'syncNow' })
}
