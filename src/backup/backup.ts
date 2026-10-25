/**
 * Full-library backup/restore flows plus the background reminder and automatic folder backups.
 */
import { create } from 'zustand'
import { db, getKV, setKV } from '../db/db'
import { useLibSync } from '../libsync/api'
import { registerService } from '../services'
import { activeLibraryName, useLibraries } from '../library/browse/libraries'
import { terms } from '../library/browse/terms'
import { settings, useSettings } from '../state/settings'
import { toast } from '../ui/primitives'
import { openArchive, restoreArchive, writeArchive, type Manifest, type OnProgress, type Progress, type RestoreOptions, type RestoreResult } from './archive'
import { dateStamp, downloadBlob, pickDirectory, pickSaveFile, safeName } from './deliver'
import { MemorySink, type ZipPart, type ZipSink } from './zip'

export const BACKUP_EXT = '.osbackup'
export const BACKUP_MIME = 'application/x-openstand-backup'
const SETTINGS_KEY = 'openstand-settings'
const KV_LAST = 'backup.lastAt'
const KV_DIR = 'backup.dir'
const KV_REMINDED = 'backup.remindedAt'
const KV_AUTO_LAST = 'backup.autoLastAt'
const DAY = 86_400_000

/** UI-observable state of the running backup/restore job. */
export const useBackupJob = create<{ busy: null | 'backup' | 'restore'; progress?: Progress; lastAt?: number; autoDir?: string }>(() => ({ busy: null }))

/** Display name of the active library; none for an unrenamed default library. */
const libraryName = () => {
  const name = activeLibraryName()
  return useLibraries.getState().active === 'default' && name === 'My Library' ? undefined : name
}
/** File-name part for the active library ('' for the default one). */
const libraryFilePart = () => {
  const lib = libraryName()
  return lib ? `-${safeName(lib, 'Library').slice(0, 60).trim().replace(/\s+/g, '_')}` : ''
}

export function backupFileName(prefix = 'OpenStand') {
  return `${prefix}${libraryFilePart()}-${dateStamp()}${BACKUP_EXT}`
}

/** Short stable token for a library id: display names can collide once made file-safe, ids can't. */
const libraryToken = (id: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36).padStart(7, '0')
}
const AUTO_STAMP = /^\d{4}-\d\d-\d\d-\d\d-\d\d\.osbackup$/

/** File-name prefix of an automatic backup: `OpenStand-auto[-<name>]-<token>-` (the name is only for people). */
export const autoBackupPrefix = (id: string, filePart: string) => `OpenStand-auto${filePart}-${libraryToken(id)}-`

/**
 * Whether a file is one of this library's automatic backups, matched by library id so a rename or another
 * library with a similar name can't confuse pruning. Also matches the older id-only names.
 */
export function isAutoBackupOf(file: string, id: string): boolean {
  if (new RegExp(`^OpenStand-auto-(?:.*-)?${libraryToken(id)}-${AUTO_STAMP.source.slice(1)}`).test(file)) return true
  const legacy = `OpenStand-auto${id === 'default' ? '' : `-${id.replace(/\s+/g, '_')}`}-`
  return file.startsWith(legacy) && AUTO_STAMP.test(file.slice(legacy.length))
}

class WritableSink implements ZipSink {
  private w: FileSystemWritableFileStream
  constructor(w: FileSystemWritableFileStream) {
    this.w = w
  }
  write(part: ZipPart) {
    return this.w.write(part as Blob)
  }
}

const progressTo = (job: 'backup' | 'restore'): OnProgress => (progress) => useBackupJob.setState({ busy: job, progress })

async function writeBackupTo(sink: ZipSink, onProgress: OnProgress): Promise<Manifest> {
  return writeArchive(sink, {
    kind: 'backup',
    settings: settings().backup.includeSettings ? localStorage.getItem(SETTINGS_KEY) : null,
    libraryName: libraryName(),
    onProgress,
  })
}

async function markBackedUp() {
  const now = Date.now()
  await setKV(KV_LAST, now)
  useBackupJob.setState({ lastAt: now })
}

/**
 * Back up the whole library. Call directly from a click: the save picker needs the user gesture.
 * Streams into the chosen file when the File System Access API exists, otherwise downloads.
 */
export async function createBackup(): Promise<boolean> {
  if (useBackupJob.getState().busy) return false
  const name = backupFileName()
  const handle = await pickSaveFile(name, 'OpenStand backup', BACKUP_MIME)
  if (handle === null) return false
  useBackupJob.setState({ busy: 'backup', progress: { phase: 'preparing', done: 0, total: 1 } })
  try {
    let manifest: Manifest
    if (handle) {
      const w = await handle.createWritable()
      try {
        manifest = await writeBackupTo(new WritableSink(w), progressTo('backup'))
        await w.close()
      } catch (e) {
        await w.abort().catch(() => {})
        throw e
      }
    } else {
      // Parts are kept as Blob references, so this doesn't copy file data into JS memory.
      const sink = new MemorySink()
      manifest = await writeBackupTo(sink, progressTo('backup'))
      downloadBlob(sink.blob(BACKUP_MIME), name)
    }
    await markBackedUp()
    toast(`Exported ${terms(settings()).count(manifest.counts.songs)}`, 'ok')
    return true
  } catch (e) {
    console.error(e)
    toast(`Export failed: ${(e as Error).message ?? e}`, 'error')
    return false
  } finally {
    useBackupJob.setState({ busy: null, progress: undefined })
  }
}

/** Peek at a backup file (for the confirmation step). */
export async function inspectBackup(file: File) {
  return openArchive(file, 'backup')
}

export function applySettingsJson(raw: string) {
  try {
    JSON.parse(raw)
  } catch {
    return
  }
  localStorage.setItem(SETTINGS_KEY, raw)
  void useSettings.persist.rehydrate()
}

export async function restoreBackup(file: File, opts: Omit<RestoreOptions, 'onProgress' | 'applySettings'>): Promise<RestoreResult | null> {
  if (useBackupJob.getState().busy) return null
  useBackupJob.setState({ busy: 'restore', progress: { phase: 'preparing', done: 0, total: 1 } })
  try {
    const archive = await openArchive(file, 'backup')
    const r = await restoreArchive(archive, { ...opts, applySettings: applySettingsJson, onProgress: progressTo('restore') })
    return r
  } finally {
    useBackupJob.setState({ busy: null, progress: undefined })
  }
}

/* --------------------------------------------------------- auto backup */

type PermHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

export async function getAutoDir(): Promise<PermHandle | undefined> {
  return getKV<PermHandle | undefined>(KV_DIR, undefined)
}

export async function chooseAutoDir(): Promise<boolean> {
  const dir = await pickDirectory('openstand-backups')
  if (!dir) return false
  await setKV(KV_DIR, dir)
  useBackupJob.setState({ autoDir: dir.name })
  return true
}

export async function forgetAutoDir() {
  await db.kv.delete(KV_DIR)
  useBackupJob.setState({ autoDir: undefined })
}

async function ensurePermission(dir: PermHandle, interactive: boolean) {
  if (!dir.queryPermission) return true
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  if (!interactive || !dir.requestPermission) return false
  return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'
}

/** Write a backup into the chosen folder and prune old automatic backups. */
export async function runAutoBackup(interactive: boolean): Promise<'ok' | 'no-dir' | 'no-permission' | 'busy' | 'error'> {
  if (useBackupJob.getState().busy) return 'busy'
  const dir = await getAutoDir()
  if (!dir) return 'no-dir'
  if (!(await ensurePermission(dir, interactive))) return 'no-permission'
  const libId = useLibraries.getState().active
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  const name = `${autoBackupPrefix(libId, libraryFilePart())}${stamp}${BACKUP_EXT}`
  const ours = (n: string) => isAutoBackupOf(n, libId)
  useBackupJob.setState({ busy: 'backup', progress: { phase: 'preparing', done: 0, total: 1 } })
  try {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    try {
      await writeBackupTo(new WritableSink(w), progressTo('backup'))
      await w.close()
    } catch (e) {
      await w.abort().catch(() => {})
      await dir.removeEntry(name).catch(() => {})
      throw e
    }
    await markBackedUp()
    await setKV(KV_AUTO_LAST, Date.now())
    // Keep the newest N automatic backups (names sort by timestamp).
    const keep = Math.max(1, settings().backup.keepCount)
    const autos: string[] = []
    for await (const [n, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>)
      if (h.kind === 'file' && ours(n)) autos.push(n)
    autos.sort().reverse()
    for (const old of autos.slice(keep)) await dir.removeEntry(old).catch(() => {})
    return 'ok'
  } catch (e) {
    console.error('auto backup failed', e)
    return 'error'
  } finally {
    useBackupJob.setState({ busy: null, progress: undefined })
  }
}

export async function lastBackupAt(): Promise<number | undefined> {
  return getKV<number | undefined>(KV_LAST, undefined)
}

/** Whole days since a timestamp. */
export const daysSince = (t: number, now = Date.now()) => Math.floor((now - t) / DAY)

async function check() {
  const b = settings().backup
  const now = Date.now()
  const last = await lastBackupAt()

  if (b.autoBackup && (await getAutoDir())) {
    const lastAuto = (await getKV<number | undefined>(KV_AUTO_LAST, undefined)) ?? 0
    if (now - lastAuto >= b.autoEveryDays * DAY - 60_000) {
      const r = await runAutoBackup(false)
      if (r === 'ok') return
      if (r === 'no-permission') {
        toast('Automatic backup needs permission to write to its folder', 'info', {
          label: 'Allow',
          run: () => void runAutoBackup(true).then((x) => x === 'ok' && toast('Backup saved', 'ok')),
        })
        return
      }
    }
  }

  // Library sync already keeps a copy in the user's storage, so don't nag about exports.
  if (!b.reminderDays || useLibSync.getState().configured) return
  const songs = await db.songs.count()
  if (!songs) return
  const remindedAt = (await getKV<number | undefined>(KV_REMINDED, undefined)) ?? 0
  if (now - remindedAt < DAY) return
  let due = false
  let msg = ''
  if (last) {
    const d = daysSince(last, now)
    due = d >= b.reminderDays
    msg = `Last export was ${d} days ago`
  } else {
    const first = await db.songs.orderBy('createdAt').first()
    due = !!first && daysSince(first.createdAt, now) >= b.reminderDays
    msg = 'Your library has never been exported'
  }
  if (!due) return
  await setKV(KV_REMINDED, now)
  toast(msg, 'info', { label: 'Export', run: () => void createBackup() })
}

/** Backup state lives in each library's kv: reload it for the active library. */
function loadState() {
  const name = db.name
  void Promise.all([lastBackupAt(), getAutoDir()]).then(([lastAt, d]) => {
    if (db.name === name) useBackupJob.setState({ lastAt, autoDir: d?.name })
  })
}

registerService(() => {
  loadState()
  let active = useLibraries.getState().active
  const unsub = useLibraries.subscribe((s) => {
    if (s.active === active) return
    active = s.active
    useBackupJob.setState({ lastAt: undefined, autoDir: undefined })
    loadState()
  })
  // Give the app time to settle before touching the disk.
  const first = setTimeout(() => void check().catch((e) => console.warn(e)), 15_000)
  const timer = setInterval(() => void check().catch((e) => console.warn(e)), 3 * 3600_000)
  return () => {
    unsub()
    clearTimeout(first)
    clearInterval(timer)
  }
})
