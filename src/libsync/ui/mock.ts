/**
 * Dev only: `?libsyncMock=<phase>` drives the library-sync UI without storage (loaded by api.ts in dev).
 *
 * Phases: off, starting, join, idle, syncing, pending, offline, paused, error (= error-auth), and
 * error-<code> for every `LibSyncErrorCode` (error-cors, error-quota, error-localQuota, error-clock,
 * error-clockAhead, error-wrongSecret, error-libraryGone, error-newerFormat, error-rejoin, error-corrupt, …).
 * Actions are faked too, so the wizard, join flow and buttons can be walked through. In the wizard, a bucket
 * name containing "cors" or an access key containing "bad" makes the connection test fail.
 */
import { LibSyncFailure, offStatus, useLibSync, type BlobState, type LibSyncErrorCode, type LibSyncStatus } from '../api'
import type { BackendCheck, S3Config } from '../backends/types'
import { BackendError } from '../backends/types'
import { PairingError, type PairingPayload } from '../model'
import { overrideActions, useMockBlobs } from './client'

const MIN = 60_000
const now = Date.now()

const BACKEND: S3Config = {
  kind: 's3',
  provider: 'r2',
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'my-music',
  prefix: 'openstand/',
  accessKeyId: 'a1b2c3d4e5f6',
  secretAccessKey: 'mock-secret',
  pathStyle: true,
}

const PAYLOAD: PairingPayload = { v: 1, s: 'mock-secret-0123456789abcdefghijklmnopqrstu', n: 'My Library', b: BACKEND, r: '/relay' }
// Long enough to give a realistically dense QR (a typical S3 code is ~300 characters).
const CODE = `OSJ1.${'q1Zy0rM0NDDQMzI0MzQzNjE2MbE0NDY0MzExMjEwMzI0MDAzM'.repeat(6)}`

const DEVICES: LibSyncStatus['devices'] = [
  { v: 1, id: 'a1b2c3d4e5f60718', name: 'Chrome on Linux', platform: 'Linux', appVersion: '0.1.0', createdAt: now - 40 * 86400_000, lastSeenAt: now, self: true },
  { v: 1, id: 'b2c3d4e5f6071829', name: 'iPad', platform: 'iPadOS', appVersion: '0.1.0', createdAt: now - 30 * 86400_000, lastSeenAt: now - 2 * 3600_000, self: false },
  { v: 1, id: 'c3d4e5f60718293a', name: 'Pixel 8', platform: 'Android', appVersion: '0.1.0', createdAt: now - 9 * 86400_000, lastSeenAt: now - 3 * 86400_000, self: false },
  { v: 1, id: 'd4e5f60718293a4b', name: 'Old phone', platform: 'Android', appVersion: '0.0.9', createdAt: now - 90 * 86400_000, lastSeenAt: now - 50 * 86400_000, self: false, retired: true },
]

const ERRORS: Record<LibSyncErrorCode, string> = {
  auth: 'Your storage rejected the access key.',
  cors: 'Your bucket doesn’t allow this site yet.',
  quota: 'Your storage is full.',
  localQuota: 'This device is out of space (needs 1.2 GB more).',
  network: 'offline',
  clock: 'RequestTimeTooSkewed',
  clockAhead: '“iPad” has its clock set 3 h ahead. Edits from it may win over newer ones.',
  wrongSecret: 'wrongSecret',
  libraryGone: 'libraryGone',
  newerFormat: 'newerFormat',
  corrupt: 'corrupt',
  rejoin: 'rejoin',
  server: 'InternalError',
  unknown: 'unknown',
}

function on(over: Partial<LibSyncStatus> = {}): LibSyncStatus {
  return {
    ...offStatus(),
    phase: 'idle',
    configured: true,
    backendLabel: 'Cloudflare R2 · my-music/openstand',
    lastSyncAt: now - 2 * MIN,
    relay: 'open',
    devices: DEVICES,
    offlineReady: { have: 1240, total: 1240 },
    ...over,
  }
}

const tp = (files: number, doneFiles: number, bytes: number, doneBytes: number) => ({ files, doneFiles, bytes, doneBytes })

function statusFor(phase: string): LibSyncStatus {
  if (phase.startsWith('error')) {
    const code = (phase.split('-')[1] || 'auth') as LibSyncErrorCode
    const warn = code === 'clockAhead'
    return on({ phase: warn ? 'idle' : 'error', error: { code, message: ERRORS[code] ?? code, at: now - MIN } })
  }
  switch (phase) {
    case 'off':
      return offStatus()
    case 'starting':
      return on({
        phase: 'starting',
        lastSyncAt: undefined,
        devices: DEVICES.slice(0, 1),
        initial: { kind: 'upload', step: 'Uploading files', done: 37, total: 120 },
        upload: tp(120, 37, 412e6, 131e6),
        pendingChanges: 1240,
      })
    case 'join':
      return on({
        phase: 'starting',
        lastSyncAt: undefined,
        initial: { kind: 'join', step: 'Loading songs', done: 812, total: 1240 },
        download: tp(1240, 0, 3.2e9, 0),
        offlineReady: { have: 0, total: 1240 },
      })
    case 'syncing':
      return on({ phase: 'syncing', pendingChanges: 4, upload: tp(3, 0, 12e6, 0), download: tp(120, 2, 410e6, 9e6), offlineReady: { have: 1120, total: 1240 } })
    case 'pending':
      return on({ download: tp(24, 6, 96e6, 30e6), offlineReady: { have: 1216, total: 1240 } })
    case 'offline':
      return on({ phase: 'offline', relay: 'off', pendingChanges: 7, lastSyncAt: now - 95 * MIN, offlineReady: { have: 1238, total: 1240 } })
    case 'paused':
      return on({ phase: 'paused', relay: 'off', pendingChanges: 2 })
    case 'idle':
    default:
      return on()
  }
}

/** Pseudo-random but stable per blob, so a list shows a mix of states. */
function blobFor(phase: string): ((id: string) => BlobState | undefined) | undefined {
  if (!['pending', 'syncing', 'join', 'offline'].includes(phase)) return undefined
  return (id) => {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    if (phase === 'offline') return h % 4 === 0 ? { state: 'offline' } : undefined
    const r = h % 5
    if (phase !== 'join' && r >= 2) return undefined
    return r === 0 ? { state: 'downloading', progress: (h % 97) / 100 } : r === 1 ? { state: 'waiting' } : { state: 'queued' }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The mock owns the status: if the real engine/service publishes over it (e.g. "not configured" on start),
// the mock state is put back.
let current: LibSyncStatus = offStatus()
function put(s: Partial<LibSyncStatus>, replace = false) {
  current = replace ? (s as LibSyncStatus) : { ...current, ...s }
  useLibSync.setState(current, true)
}

/** Animates `initial` to completion, then settles on idle. */
async function runInitial(kind: 'upload' | 'join', total: number) {
  for (let done = 0; done <= total; done += Math.ceil(total / 12)) {
    put(
      on({
        phase: 'starting',
        lastSyncAt: undefined,
        initial: { kind, step: kind === 'join' ? 'Loading songs' : 'Uploading songs', done, total },
        devices: kind === 'join' ? DEVICES : DEVICES.slice(0, 1),
      }),
      true,
    )
    await wait(250)
  }
  put(on({ lastSyncAt: Date.now(), devices: kind === 'join' ? DEVICES : DEVICES.slice(0, 1) }), true)
}

function fakeCheck(cfg: S3Config): BackendCheck {
  if (cfg.accessKeyId.includes('bad'))
    return { ok: false, steps: [{ id: 'reach', ok: true }, { id: 'auth', ok: false, detail: 'InvalidAccessKeyId' }], error: new BackendError('auth', 'InvalidAccessKeyId', { status: 403 }) }
  if (cfg.bucket.includes('cors'))
    return { ok: false, steps: [{ id: 'reach', ok: true }, { id: 'cors', ok: false }], error: new BackendError('cors', 'Blocked by CORS') }
  const ids = ['list', 'write', 'read', 'range', 'etag', 'conditional', 'delete'] as const
  return { ok: true, steps: ids.map((id) => ({ id, ok: true })) }
}

export function applyLibSyncMock(phase: string) {
  put(statusFor(phase), true)
  useLibSync.subscribe((s) => {
    if (s !== current) useLibSync.setState(current, true)
  })
  useMockBlobs.setState({ state: blobFor(phase) })
  overrideActions({
    checkBackend: async (cfg) => {
      await wait(900)
      return cfg.kind === 's3' ? fakeCheck(cfg) : { ok: true, steps: [] }
    },
    enableSync: async () => {
      await wait(400)
      void runInitial('upload', 120)
    },
    pairingCode: async () => CODE,
    parsePairingCode: async (text) => {
      await wait(150)
      if (!/OSJ1\.[A-Za-z0-9_-]{8,}/.test(text)) throw new PairingError(/OSJ[2-9]\./.test(text) ? 'version' : 'format')
      if (text.includes('gone')) throw new LibSyncFailure('libraryGone')
      return PAYLOAD
    },
    previewJoin: async () => {
      await wait(700)
      return { remoteSongs: 1240, remoteBytes: 3.2e9, localSongs: 12, matches: 3, suggested: 'newLibrary' }
    },
    joinSync: async () => {
      void runInitial('join', 1240)
      await wait(3600)
    },
    syncNow: async () => {
      const prev = useLibSync.getState()
      put({ phase: 'syncing' })
      await wait(1200)
      put({ phase: prev.phase === 'syncing' ? 'idle' : prev.phase === 'error' ? 'error' : 'idle', lastSyncAt: Date.now(), pendingChanges: 0 })
    },
    setPaused: async (paused) => {
      put({ phase: paused ? 'paused' : 'idle', relay: paused ? 'off' : 'open' })
    },
    leaveSync: async () => {
      await wait(600)
      put(offStatus(), true)
    },
    deleteRemoteData: async () => {
      await wait(800)
      put(offStatus(), true)
    },
    repair: async () => {
      await wait(1500)
    },
    updateBackend: async () => {
      await wait(500)
      put({ phase: 'idle', error: undefined, lastSyncAt: Date.now() })
    },
  })
  console.info(`[libsync] mock phase "${phase}"`)
}
