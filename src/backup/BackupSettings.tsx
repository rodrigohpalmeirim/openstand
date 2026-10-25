import { ArchiveRestore, Cloud, FolderOpen, HardDriveDownload, Loader2, PackageOpen, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { terms, useTerms } from '../library/browse/terms'
import { useLibSync } from '../libsync/api'
import { settings, useSettings } from '../state/settings'
import { Button, Dialog, Field, Segmented, Select, Toggle, confirmDialog, cx, toast } from '../ui/primitives'
import type { OpenedArchive, Progress, RestoreResult } from './archive'
import { BACKUP_EXT, chooseAutoDir, createBackup, daysSince, forgetAutoDir, inspectBackup, restoreBackup, runAutoBackup, useBackupJob } from './backup'
import { canPickDirectory } from './deliver'
import { PACKAGE_EXT, importPackage } from './exportSongs'

const fmtBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function progressLabel(p?: Progress) {
  if (!p) return 'Working…'
  if (p.phase === 'preparing') return 'Preparing…'
  if (p.phase === 'files') return `Files ${p.done} of ${p.total}${p.totalBytes ? ` · ${fmtBytes(p.bytes ?? 0)} of ${fmtBytes(p.totalBytes)}` : ''}`
  if (p.phase === 'library') return 'Writing library…'
  return 'Finishing…'
}

function progressValue(p?: Progress) {
  if (!p) return 0
  if (p.phase === 'files') return p.totalBytes ? 0.05 + 0.9 * ((p.bytes ?? 0) / p.totalBytes) : 0.05 + 0.9 * (p.done / Math.max(1, p.total))
  return p.phase === 'preparing' ? 0.02 : p.phase === 'library' ? 0.96 : 0.99
}

export function ProgressBar({ progress }: { progress?: Progress }) {
  return (
    <div className="grid gap-1.5" role="status" aria-live="polite">
      <div className="h-2 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(progressValue(progress) * 100)}%` }} />
      </div>
      <div className="text-xs tabular-nums text-muted">{progressLabel(progress)}</div>
    </div>
  )
}

function Section({ title, icon, children, description }: { title: string; icon: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">{icon}</div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
      </div>
      <div className="grid gap-3 sm:pl-11">{children}</div>
    </section>
  )
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4">
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </label>
  )
}

function RestoreDialog({ file, archive, onClose }: { file: File; archive: OpenedArchive; onClose: () => void }) {
  const [mode, setMode] = useState<'replace' | 'merge'>('merge')
  const t = useTerms()
  const [conflict, setConflict] = useState<'newer' | 'keepBoth'>('newer')
  // Settings come along by default only when replacing everything; a merge shouldn't change preferences.
  const [settingsChoice, setWithSettings] = useState<boolean | null>(null)
  const withSettings = settingsChoice ?? mode === 'replace'
  const [result, setResult] = useState<RestoreResult | null>(null)
  const { busy, progress } = useBackupJob()
  const m = archive.manifest
  const hasSettings = !!archive.library.settings
  const synced = useLibSync((st) => st.configured)

  const run = async () => {
    if (mode === 'replace') {
      const ok = await confirmDialog({
        title: 'Replace your library?',
        message: synced
          ? `This replaces the library on all your synced devices: all ${t.songs}, setlists and annotations are replaced by the backup. This cannot be undone.`
          : `All ${t.songs}, setlists and annotations on this device are replaced by the backup. This cannot be undone.`,
        confirmLabel: 'Replace library',
        danger: true,
      })
      if (!ok) return
    }
    try {
      const r = await restoreBackup(file, { mode, conflict, restoreSettings: withSettings && hasSettings })
      if (r) setResult(r)
    } catch (e) {
      toast(`Import failed: ${(e as Error).message ?? e}`, 'error')
    }
  }

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={result ? 'Import finished' : 'Import library'}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant={mode === 'replace' ? 'danger' : 'primary'} disabled={!!busy} onClick={run}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === 'replace' ? 'Replace library' : 'Merge into library'}
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
          <div className="truncate font-medium">{file.name}</div>
          <div className="mt-0.5 text-muted">
            {new Date(m.createdAt).toLocaleString()} · {t.count(m.counts.songs)} · {plural(m.counts.setlists, 'setlist')} · {fmtBytes(m.counts.bytes)}
            {m.library ? ` · library “${m.library}”` : ''}
          </div>
        </div>
        {result ? (
          <ul className="grid gap-1 text-sm">
            <li>{plural(result.songsAdded, t.song)} added</li>
            {result.songsUpdated > 0 && <li>{plural(result.songsUpdated, t.song)} updated from the backup</li>}
            {result.songsKept > 0 && <li>{plural(result.songsKept, t.song)} kept as they are on this device</li>}
            <li>{plural(result.setlists, 'setlist')} restored</li>
            {result.missingFiles > 0 && <li className="text-warn">{result.missingFiles === 1 ? '1 file was' : `${result.missingFiles} files were`} missing from the backup</li>}
            {result.settingsRestored && <li>Settings restored</li>}
          </ul>
        ) : busy ? (
          <ProgressBar progress={progress} />
        ) : (
          <>
            <Field label="How to restore">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'merge', label: 'Merge' },
                  { value: 'replace', label: 'Replace everything' },
                ]}
              />
            </Field>
            <p className="-mt-2 text-sm text-muted">
              {mode === 'merge'
                ? `Adds ${t.songs} and setlists from the backup. ${t.Songs} that came from the same library count as the same ${t.song}; ${t.songs} added separately on each device may appear twice.`
                : synced
                  ? 'Deletes the library on this device and on all your synced devices, and restores the backup exactly.'
                  : 'Deletes this device’s library and restores the backup exactly.'}
            </p>
            {mode === 'merge' && (
              <Field label={`When a ${t.song} exists on both`}>
                <Segmented
                  value={conflict}
                  onChange={setConflict}
                  options={[
                    { value: 'newer', label: 'Keep the newer one' },
                    { value: 'keepBoth', label: 'Keep both' },
                  ]}
                />
              </Field>
            )}
            {hasSettings && <SwitchRow label="Restore settings too" hint="Display, page turning, MIDI and other preferences" checked={withSettings} onChange={setWithSettings} />}
          </>
        )}
      </div>
    </Dialog>
  )
}

function LastBackup() {
  const lastAt = useBackupJob((j) => j.lastAt)
  const reminderDays = useSettings((s) => s.s.backup.reminderDays)
  const synced = useLibSync((st) => st.configured)
  const t = useTerms()
  const d = lastAt ? daysSince(lastAt) : undefined
  // With library sync on, the storage already holds a copy, so an old (or missing) export isn't a warning.
  const stale = !synced && (d === undefined || (reminderDays > 0 && d >= reminderDays))
  return (
    <div className={cx('flex items-center gap-3 rounded-xl border px-4 py-3', stale ? 'border-warn/40 bg-warn/10' : 'border-line bg-surface-2')}>
      {synced ? <Cloud className="size-5 shrink-0 text-ok" /> : stale ? <ShieldAlert className="size-5 shrink-0 text-warn" /> : <ShieldCheck className="size-5 shrink-0 text-ok" />}
      <div className="text-sm">
        <div className="font-medium">
          {d === undefined ? 'No export yet' : d === 0 ? 'Last export today' : d === 1 ? 'Last export yesterday' : `Last export ${d} days ago`}
        </div>
        {lastAt && <div className="text-xs text-muted">{new Date(lastAt).toLocaleString()}</div>}
        {synced ? (
          <div className="text-xs text-muted">
            Your library is synced to your storage and your other devices. An export is an independent copy, handy as an extra backup or to move
            {t.songs} to another library.
          </div>
        ) : (
          d === undefined && <div className="text-xs text-muted">Your music lives only in this browser. Export a copy and keep it somewhere safe.</div>
        )}
      </div>
    </div>
  )
}

/** Export & import section of the settings screen. */
export function BackupSettings() {
  const t = useTerms()
  const b = useSettings((s) => s.s.backup)
  const synced = useLibSync((st) => st.configured)
  const setIn = useSettings((s) => s.setIn)
  const { busy, progress, autoDir } = useBackupJob()
  const restoreInput = useRef<HTMLInputElement>(null)
  const pkgInput = useRef<HTMLInputElement>(null)
  const [restore, setRestore] = useState<{ file: File; archive: OpenedArchive } | null>(null)
  const [importing, setImporting] = useState(false)

  const onRestoreFile = async (file?: File) => {
    if (!file) return
    try {
      setRestore({ file, archive: await inspectBackup(file) })
    } catch (e) {
      toast((e as Error).message ?? String(e), 'error')
    }
  }

  const onPackage = async (file?: File) => {
    if (!file) return
    setImporting(true)
    try {
      const r = await importPackage(file)
      if (r.songs || r.setlists) toast(`Imported ${terms(settings()).count(r.songs)}${r.setlists ? ` and ${r.setlists} setlist${r.setlists === 1 ? '' : 's'}` : ''}`, 'ok')
    } catch (e) {
      toast((e as Error).message ?? String(e), 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="grid gap-8">
      <Section title="Export library" icon={<HardDriveDownload className="size-4" />} description={`One ${BACKUP_EXT} file with every ${t.song}, file, setlist and annotation.`}>
        <LastBackup />
        {busy === 'backup' ? (
          <ProgressBar progress={progress} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void createBackup()} disabled={!!busy}>
              Export now
            </Button>
          </div>
        )}
        <SwitchRow label="Include settings" hint="So a restore brings back your preferences too" checked={b.includeSettings} onChange={(includeSettings) => setIn('backup', { includeSettings })} />
        <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
          <span>
            Remind me to export
            <span className="block text-xs text-muted">{synced ? 'Off while library sync is on' : 'A gentle reminder when the last export is older than this'}</span>
          </span>
          <Select className="!w-auto shrink-0" value={b.reminderDays} onChange={(e) => setIn('backup', { reminderDays: Number(e.target.value) })}>
            <option value={0}>Never</option>
            {[7, 14, 30, 60, 90].map((d) => (
              <option key={d} value={d}>
                After {d} days
              </option>
            ))}
          </Select>
        </label>
      </Section>

      {canPickDirectory() && (
        <Section title="Automatic backups" icon={<FolderOpen className="size-4" />} description="Save a backup into a folder of your choice (for example a synced cloud folder) while OpenStand is open.">
          <SwitchRow
            label="Back up automatically"
            checked={b.autoBackup}
            onChange={async (autoBackup) => {
              if (autoBackup && !autoDir && !(await chooseAutoDir())) return
              setIn('backup', { autoBackup })
            }}
          />
          {b.autoBackup && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
                <FolderOpen className="size-4 text-muted" />
                <span className="flex-1 truncate">{autoDir ?? 'No folder chosen'}</span>
                <Button size="sm" variant="ghost" onClick={() => void chooseAutoDir()}>
                  Change…
                </Button>
                {autoDir && (
                  <Button size="sm" variant="ghost" onClick={() => void forgetAutoDir().then(() => setIn('backup', { autoBackup: false }))}>
                    Forget
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Every">
                  <Select value={b.autoEveryDays} onChange={(e) => setIn('backup', { autoEveryDays: Number(e.target.value) })}>
                    <option value={1}>Day</option>
                    <option value={3}>3 days</option>
                    <option value={7}>Week</option>
                    <option value={30}>Month</option>
                  </Select>
                </Field>
                <Field label="Keep">
                  <Select value={b.keepCount} onChange={(e) => setIn('backup', { keepCount: Number(e.target.value) })}>
                    {[2, 3, 5, 10, 20].map((n) => (
                      <option key={n} value={n}>
                        Last {n}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div>
                <Button
                  size="sm"
                  disabled={!!busy || !autoDir}
                  onClick={async () => {
                    const r = await runAutoBackup(true)
                    toast(r === 'ok' ? 'Backup saved to the folder' : r === 'no-permission' ? 'No permission to write to the folder' : 'Automatic backup failed', r === 'ok' ? 'ok' : 'error')
                  }}
                >
                  Run now
                </Button>
              </div>
            </>
          )}
        </Section>
      )}

      <Section title="Import library" icon={<ArchiveRestore className="size-4" />} description={`Load an ${BACKUP_EXT} file and merge it with what is here, or replace everything.`}>
        <div>
          <Button onClick={() => restoreInput.current?.click()} disabled={!!busy}>
            Choose file…
          </Button>
          <input
            ref={restoreInput}
            type="file"
            accept={`${BACKUP_EXT},application/zip,application/octet-stream`}
            className="hidden"
            onChange={(e) => {
              void onRestoreFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </Section>

      <Section title={`${t.Song} packages`} icon={<PackageOpen className="size-4" />} description={`Import ${PACKAGE_EXT} files shared by other OpenStand users. Export them from a ${t.song} or setlist menu.`}>
        <div className="flex items-center gap-3">
          <Button onClick={() => pkgInput.current?.click()} disabled={importing}>
            {importing && <Loader2 className="size-4 animate-spin" />}
            Import package…
          </Button>
          <input
            ref={pkgInput}
            type="file"
            accept={`${PACKAGE_EXT},${BACKUP_EXT},application/zip`}
            className="hidden"
            onChange={(e) => {
              void onPackage(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </Section>

      {restore && <RestoreDialog file={restore.file} archive={restore.archive} onClose={() => setRestore(null)} />}
    </div>
  )
}
