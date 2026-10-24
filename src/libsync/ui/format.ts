/** Wording and number formatting for the library-sync UI (docs/SYNC.md §12.3). Pure. */
import type { BlobState, LibSyncError, LibSyncErrorCode, LibSyncStatus, TransferProgress } from '../api'

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
      return s.error ? errorText(s.error).message : 'Sync stopped'
    case 'idle':
      return s.lastSyncAt ? `Up to date · ${timeAgo(s.lastSyncAt, now)}` : 'Up to date'
  }
}

export type ErrorAction = 'updateKeys' | 'showCors' | 'openProvider' | 'storageSettings' | 'retry' | 'joinAgain' | 'stopSyncing' | 'reload' | 'rejoin'

export interface ErrorText {
  message: string
  /** What the banner's button does; none for warnings like `clockAhead`. */
  action?: ErrorAction
  actionLabel?: string
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
  stopSyncing: 'Stop syncing',
  reload: 'Reload app',
  rejoin: 'Rejoin',
}

/** Engine-provided sentences (with a device name or an amount) win for the parameterised codes. */
const sentence = (e: LibSyncError) => (e.message && e.message !== e.code && /\s/.test(e.message.trim()) ? e.message.trim() : undefined)

const FIXED: Record<LibSyncErrorCode, Omit<ErrorText, 'actionLabel'>> = {
  auth: { message: 'Your storage rejected the access key. It may have expired or been revoked.', action: 'updateKeys' },
  cors: { message: 'Your bucket doesn’t allow this site yet.', action: 'showCors' },
  quota: { message: 'Your storage is full.', action: 'openProvider' },
  localQuota: { message: 'This device is out of space.', action: 'storageSettings' },
  clock: { message: 'This device’s clock is wrong, so the storage refused the request.', action: 'retry' },
  clockAhead: { message: 'Another device has its clock set ahead. Edits from it may win over newer ones.', warning: true },
  wrongSecret: { message: 'This code doesn’t match the data in that storage.', action: 'joinAgain' },
  libraryGone: { message: 'The synced library was deleted from storage.', action: 'stopSyncing' },
  newerFormat: { message: 'Another device uses a newer OpenStand. Update this one to keep syncing.', action: 'reload' },
  rejoin: { message: 'This device needs to rejoin the synced library.', action: 'rejoin' },
  corrupt: { message: 'This device needs to rejoin the synced library.', action: 'rejoin' },
  network: { message: OFFLINE_LINE, warning: true },
  server: { message: 'Your storage had a problem answering. Sync will try again.', action: 'retry' },
  unknown: { message: 'Something went wrong while syncing.', action: 'retry' },
}

/** §12.3: fixed wording and action per error code. */
export function errorText(e: Pick<LibSyncError, 'code' | 'message' | 'detail'>): ErrorText {
  const base = { ...FIXED[e.code] ?? FIXED.unknown }
  if (e.code === 'localQuota') {
    const own = sentence(e as LibSyncError)
    const need = Number(e.detail)
    if (e.detail && Number.isFinite(need) && need > 0) base.message = `This device is out of space (needs ${fmtBytes(need)} more).`
    else if (own) base.message = own
  } else if (e.code === 'clockAhead') {
    const own = sentence(e as LibSyncError)
    if (own) base.message = own
  }
  return { ...base, actionLabel: base.action && ACTION_LABEL[base.action] }
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
