/** Wording and number formatting for the library-sync UI. Pure. */
import { LibSyncFailure, type BackendKind, type BlobState, type OAuthKind, type LibSyncError, type LibSyncErrorCode, type LibSyncStatus, type TransferProgress } from '../api'
import { drive, isDrive, wrongAccountText } from './signin'

export const fmtBytes = (n: number) =>
  n < 1000 ? `${n} B` : n < 1000 ** 2 ? `${Math.round(n / 1000)} KB` : n < 1000 ** 3 ? `${Math.round(n / 1000 ** 2)} MB` : `${(n / 1000 ** 3).toFixed(1)} GB`

export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`

/** "just now", "2 min ago", "3 h ago", "yesterday", "5 days ago", then a date. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 14) return `${d} days ago`
  return new Date(at).toLocaleDateString()
}

/** Remaining files and bytes of a transfer. */
export const remaining = (t: TransferProgress) => ({ files: Math.max(0, t.files - t.doneFiles), bytes: Math.max(0, t.bytes - t.doneBytes) })

export const fraction = (t: TransferProgress) => (t.bytes > 0 ? Math.min(1, t.doneBytes / t.bytes) : t.files > 0 ? Math.min(1, t.doneFiles / t.files) : 0)

export const active = (t: TransferProgress) => t.files > t.doneFiles

/** "Uploading 3 files (12 MB)" */
export function uploadLine(t: TransferProgress): string {
  const r = remaining(t)
  return `Uploading ${plural(r.files, 'file')}${r.bytes ? ` (${fmtBytes(r.bytes)})` : ''}`
}

/** "Downloading 120 files. You can keep using OpenStand." */
export function downloadLine(t: TransferProgress): string {
  return `Downloading ${plural(remaining(t).files, 'file')}. You can keep using OpenStand.`
}

export const OFFLINE_LINE = 'Offline. Changes will sync when you’re back online.'

/**
 * Friendly wording for the enable/join checkpoint steps the service reports in `initial.step` (`verify`,
 * `bootstrap`, `register`, `merge`, `publish`, `snapshot`). Unknown steps never reach the screen as-is.
 */
export function stepLabel(initial: Pick<NonNullable<LibSyncStatus['initial']>, 'kind' | 'step'>): string {
  const join = initial.kind === 'join'
  switch (initial.step) {
    case 'verify':
      return 'Checking the synced library…'
    case 'bootstrap':
      return 'Loading the synced library…'
    case 'register':
      return 'Adding this device…'
    case 'merge':
      return 'Combining your songs…'
    case 'publish':
      return join ? 'Uploading this device’s songs…' : 'Uploading songs and files…'
    case 'snapshot':
      return 'Finishing up…'
    default:
      return join ? 'Joining the synced library…' : 'Uploading your library…'
  }
}

/** Progress caption: "Loading the synced library… 812 of 1,240" (no count for single-step phases). */
export function initialLine(initial: NonNullable<LibSyncStatus['initial']>): string {
  const label = stepLabel(initial)
  return initial.total > 1 ? `${label} ${initial.done.toLocaleString('en-US')} of ${initial.total.toLocaleString('en-US')}` : label
}

/** The headline of the status card and the indicator popover. */
export function phaseLine(s: LibSyncStatus, now = Date.now()): string {
  switch (s.phase) {
    case 'off':
      return 'Not syncing'
    case 'starting':
      return s.initial?.kind === 'join' ? 'Joining the synced library…' : s.initial ? 'Uploading your library…' : 'Starting…'
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return OFFLINE_LINE
    case 'paused':
      return 'Sync is paused'
    case 'error':
      return s.error ? errorText(s.error, s.backendKind).message : 'Sync stopped'
    case 'idle':
      return s.lastSyncAt ? `Up to date · ${timeAgo(s.lastSyncAt, now)}` : 'Up to date'
  }
}

/** Status card: what instant updates are doing, once sync runs (paused/offline/error say it themselves). */
export function relayNote(s: Pick<LibSyncStatus, 'phase' | 'relay' | 'relayConfigured'>): string | undefined {
  if (s.phase !== 'idle' && s.phase !== 'syncing') return undefined
  if (s.relay === 'open') return 'Instant updates on'
  if (s.relay === 'error') return 'Instant updates reconnecting'
  if (s.relay === 'off' && s.relayConfigured === false) return 'Instant updates off: no relay configured'
  return 'Instant updates connecting…'
}

export type ErrorAction =
  | 'updateKeys'
  | 'showCors'
  | 'openProvider'
  | 'storageSettings'
  | 'retry'
  | 'joinAgain'
  | 'joinNew'
  | 'stopSyncing'
  | 'reload'
  | 'rejoin'
  /** Cloud drives: sign in to the same account again (`startSignIn(kind, {type: 'reauth'})`). */
  | 'signIn'
  /** Cloud drives: sign in, picking the account (`chooseAccount: true`). */
  | 'chooseAccount'

export interface ErrorText {
  message: string
  /** What the banner's button does; none for warnings like `clockAhead`. */
  action?: ErrorAction
  actionLabel?: string
  /** A second, quieter button. */
  secondary?: ErrorAction
  secondaryLabel?: string
  /** What to do next, under the message. */
  hint?: string
  /** Shown as a warning (amber), not an error. */
  warning?: boolean
}

const ACTION_LABEL: Record<ErrorAction, string> = {
  updateKeys: 'Update storage keys',
  showCors: 'Show CORS rule',
  openProvider: 'Open provider',
  storageSettings: 'Storage settings',
  retry: 'Retry',
  joinAgain: 'Join again',
  joinNew: 'Join with a new code',
  stopSyncing: 'Stop syncing',
  reload: 'Reload app',
  rejoin: 'Rejoin',
  signIn: 'Sign in again',
  chooseAccount: 'Sign in with another account',
}

/** Engine-provided sentences (with a device name or an amount) win for the parameterised codes. */
const sentence = (e: LibSyncError) => (e.message && e.message !== e.code && /\s/.test(e.message.trim()) ? e.message.trim() : undefined)

const FIXED: Record<LibSyncErrorCode, Omit<ErrorText, 'actionLabel' | 'secondaryLabel'>> = {
  auth: { message: 'Your storage rejected the access key. It may have expired or been revoked.', action: 'updateKeys' },
  cors: { message: 'Your bucket doesn’t allow this site yet.', action: 'showCors' },
  quota: { message: 'Your storage is full.', action: 'openProvider' },
  localQuota: { message: 'This device is out of space.', action: 'storageSettings' },
  clock: { message: 'This device’s clock is wrong, so the storage refused the request.', action: 'retry' },
  clockAhead: { message: 'Another device has its clock set ahead. Edits from it may win over newer ones.', warning: true },
  wrongSecret: { message: 'This code doesn’t match the data in that storage.', action: 'joinAgain' },
  libraryGone: {
    message: 'The synced library was reset or deleted from another device.',
    hint: 'To keep syncing, get a new pairing code from a device that’s still syncing and join again. Your songs stay on this device.',
    action: 'joinNew',
    secondary: 'stopSyncing',
  },
  newerFormat: { message: 'Another device uses a newer OpenStand. Update this one to keep syncing.', action: 'reload' },
  rejoin: { message: 'This device needs to rejoin the synced library.', action: 'rejoin' },
  corrupt: { message: 'This device needs to rejoin the synced library.', action: 'rejoin' },
  network: { message: OFFLINE_LINE, warning: true },
  server: { message: 'Your storage had a problem answering. Sync will try again.', action: 'retry' },
  unknown: { message: 'Something went wrong while syncing.', action: 'retry' },
  // Cloud drives; `errorText` names the provider when it knows the backend kind.
  reauth: { message: 'Sign in to your storage again to keep syncing. Your changes are kept on this device until then.', action: 'signIn' },
  wrongAccount: { message: 'This library isn’t in the account you signed in with.', action: 'chooseAccount' },
}

/** Cloud drives: the drive's name in the messages, and sign-in actions instead of storage keys. */
function driveText(e: Pick<LibSyncError, 'code' | 'message' | 'detail'>, kind: OAuthKind, want?: string): Omit<ErrorText, 'actionLabel' | 'secondaryLabel'> | undefined {
  const name = drive(kind).name
  switch (e.code) {
    case 'reauth':
      return { message: `Sign in to ${name} again to keep syncing. Your changes are kept on this device until then.`, action: 'signIn' }
    case 'wrongAccount':
      // `want` comes from this library's config; the engine's own sentence is the fallback.
      return { message: want ? wrongAccountText(kind, undefined, want) : (sentence(e as LibSyncError) ?? wrongAccountText(kind)), action: 'chooseAccount' }
    case 'auth':
      return { message: `${name} refused access to the OpenStand folder.`, action: 'signIn' }
    case 'quota':
      return { message: `Your ${name} storage is full.`, action: 'openProvider' }
    case 'cors':
      // Not an S3 bucket: there's no rule to paste. A browser block here is a network problem.
      return { message: `Can’t reach ${name} from this browser right now.`, action: 'retry' }
    case 'server':
      return { message: `${name} had a problem answering. Sync will try again.`, action: 'retry' }
    default:
      return undefined
  }
}

/**
 * Fixed wording and action per error code. `kind` (the status's `backendKind`) switches to the cloud
 * drive wording; `want` is the account the library is in (from the pairing payload), for `wrongAccount`.
 */
export function errorText(e: Pick<LibSyncError, 'code' | 'message' | 'detail'>, kind?: BackendKind, want?: string): ErrorText {
  const base = { ...(isDrive(kind) ? driveText(e, kind, want) : undefined) ?? FIXED[e.code] ?? FIXED.unknown }
  if (e.code === 'localQuota') {
    const own = sentence(e as LibSyncError)
    const need = Number(e.detail)
    if (e.detail && Number.isFinite(need) && need > 0) base.message = `This device is out of space (needs ${fmtBytes(need)} more).`
    else if (own) base.message = own
  } else if (e.code === 'clockAhead') {
    const own = sentence(e as LibSyncError)
    if (own) base.message = own
  }
  const label = (a?: ErrorAction) => (a === 'openProvider' && isDrive(kind) ? `Open ${drive(kind).name}` : a && ACTION_LABEL[a])
  return { ...base, actionLabel: label(base.action), secondaryLabel: label(base.secondary) }
}

/**
 * Toast wording for a failed action: the fixed sentence for a `LibSyncFailure`, an engine sentence as is,
 * and never a bare identifier ("unknown", "libraryGone").
 */
export function failureText(e: unknown, fallback = 'Something went wrong. Try again.', kind?: BackendKind): string {
  if (e instanceof LibSyncFailure || (e as Error)?.name === 'LibSyncFailure') {
    const f = e as LibSyncFailure
    const own = sentence({ code: f.code, message: f.message, at: 0 })
    return f.code === 'unknown' || f.code === 'corrupt' ? (own ?? FIXED.unknown.message) : errorText(f, kind).message
  }
  const m = (e as Error)?.message?.trim()
  return m && /\s/.test(m) ? m : fallback
}

/** Non-fatal wording per code: the engine's own sentence (with the device name) wins when it has one. */
const WARNING: Partial<Record<LibSyncErrorCode, { message: string; action?: ErrorAction }>> = {
  unknown: { message: 'Some changes from another device couldn’t be applied yet.' },
  newerFormat: { message: 'Another device uses a newer OpenStand. Update this one to get its changes.', action: 'reload' },
  rejoin: { message: 'Changes from another device were written by an older OpenStand.' },
  corrupt: { message: 'Some changes from another device couldn’t be applied yet.' },
  clockAhead: { message: FIXED.clockAhead.message },
}

export interface SyncWarning {
  /** One line per held-back device (or the single warning). */
  lines: string[]
  /** Calm follow-up: what happens next. */
  note?: string
  action?: ErrorAction
  actionLabel?: string
}

/**
 * Splits the status into a fatal error (sync stopped: `phase` is `error`) and a non-fatal warning (a device's
 * changes held back, a clock ahead: sync carries on). The service mirrors warnings into `error` too, so the
 * phase decides. `network` is neither (it shows as offline).
 */
export function syncProblem(s: LibSyncStatus): { error?: LibSyncError; warning?: SyncWarning } {
  if (s.phase === 'error') return { error: s.error }
  const streams = Object.values(s.streams ?? {})
  const list = streams.length ? streams : [s.warning ?? s.error].filter((e): e is LibSyncError => !!e && e.code !== 'network')
  if (!list.length) return {}
  const lines = [...new Set(list.map((e) => sentence(e) ?? WARNING[e.code]?.message ?? WARNING.unknown!.message))]
  const retrying = list.some((e) => e.code !== 'clockAhead' && e.code !== 'newerFormat')
  const action = list.map((e) => WARNING[e.code]?.action).find(Boolean)
  return {
    warning: {
      lines,
      note: retrying ? 'OpenStand keeps retrying in the background.' : undefined,
      action,
      actionLabel: action && ACTION_LABEL[action],
    },
  }
}

export interface Controls {
  /** "Sync now" is shown; `syncNowOff` is why it's disabled, if it is. */
  syncNow: boolean
  syncNowOff?: string
  /** "Add a device" (a pairing code for this library). */
  addDevice: boolean
  /** "Update storage keys" (S3), or "Sign in again" (cloud drives). */
  storageKeys: boolean
  /** The "Pause sync" switch. */
  pause: boolean
  /** "Re-check files". */
  recheck: boolean
  /** "Reset sync…" (it deletes the synced copy first: nothing to reset once it's gone). */
  reset: boolean
  /** "Delete synced data from storage…". */
  deleteRemote: boolean
  /** Renaming this device (rewrites its record in the library). */
  rename: boolean
}

/**
 * Which controls make sense in this state. When the library is gone or this device can't read it, the
 * banner's actions are the only way on: syncing can't succeed, and a pairing code would point other
 * devices at a deleted library or one this device can't read.
 */
export function controls(s: LibSyncStatus, online = typeof navigator === 'undefined' || navigator.onLine !== false): Controls {
  const code = s.phase === 'error' ? s.error?.code : undefined
  // The library is deleted, or this code doesn't open it.
  const gone = code === 'libraryGone' || code === 'wrongSecret'
  // This device has to join (again) before anything else works.
  const broken = gone || code === 'rejoin' || code === 'corrupt'
  // Cloud drives: nothing reaches the storage until this device signs in (again, or as the right account).
  const signedOut = code === 'reauth' || code === 'wrongAccount'
  // Offline because the storage didn't answer (the device is online): "Sync now" is the retry.
  const syncNowOff =
    s.phase === 'paused'
      ? 'Sync is paused.'
      : s.phase === 'starting'
        ? 'Sync is starting.'
        : s.phase === 'offline' && !online
          ? 'This device is offline.'
          : undefined
  return {
    // A newer OpenStand elsewhere: only reloading helps.
    syncNow: !broken && !signedOut && code !== 'newerFormat',
    syncNowOff,
    addDevice: !broken,
    storageKeys: !gone,
    pause: !broken,
    recheck: !broken && !signedOut,
    reset: !gone,
    deleteRemote: code !== 'libraryGone',
    rename: !broken,
  }
}

export type IndicatorIcon = 'cloud' | 'upload' | 'download' | 'off' | 'alert' | 'sync'

/**
 * What the sidebar indicator shows. `progress` (0..1) draws the ring; `dot` is the red error dot, `warn` a
 * softer amber one for non-fatal warnings.
 */
export function indicatorState(s: LibSyncStatus): { icon: IndicatorIcon; label: string; progress?: number; dot?: boolean; warn?: boolean } {
  if (s.phase === 'error') return { icon: 'alert', label: `Library sync: ${phaseLine(s)}`, dot: true }
  const w = syncProblem(s).warning
  const st = activityState(s)
  return w ? { ...st, label: `${st.label} · ${w.lines[0]}`, warn: true } : st
}

function activityState(s: LibSyncStatus): { icon: IndicatorIcon; label: string; progress?: number } {
  if (s.phase === 'offline') return { icon: 'off', label: 'Library sync: offline' }
  if (s.phase === 'paused') return { icon: 'off', label: 'Library sync: paused' }
  if (s.initial) return { icon: s.initial.kind === 'join' ? 'download' : 'upload', label: `Library sync: ${phaseLine(s)}`, progress: s.initial.total ? s.initial.done / s.initial.total : undefined }
  if (active(s.download)) return { icon: 'download', label: `Library sync: ${downloadLine(s.download)}`, progress: fraction(s.download) }
  if (active(s.upload)) return { icon: 'upload', label: `Library sync: ${uploadLine(s.upload)}`, progress: fraction(s.upload) }
  if (s.phase === 'syncing' || s.phase === 'starting') return { icon: 'sync', label: 'Library sync: syncing' }
  return { icon: 'cloud', label: 'Library sync: up to date' }
}

/** Short caption for song rows and thumbnails, or undefined when the file is here. */
export function pendingCaption(b: BlobState): string | undefined {
  switch (b.state) {
    case 'local':
      return undefined
    case 'waiting':
    case 'missing':
      return 'Waiting for upload'
    case 'offline':
      return 'Not downloaded yet'
    default:
      return 'Downloading'
  }
}

/* ------------------------------------------------------------ Pairing */

const S3_WARNING = 'Anyone with this code can read and change your library and use your storage keys.'

/**
 * What the code gives away, per backend. A drive code holds the library key and the account email, never
 * sign-in tokens: the other device still signs in itself.
 */
export function pairingWarning(kind?: BackendKind): string {
  if (!isDrive(kind)) return S3_WARNING
  const p = drive(kind)
  return `Treat this code like a password: anyone with it can read and change your library. It names your ${p.name} account but holds no sign-in, so the other device still signs in to ${p.name} with the same account.`
}
