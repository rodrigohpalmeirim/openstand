/** Library-sync status icon for the sidebar (§12.2). Hidden when sync isn't set up. */
import { Cloud, CloudAlert, CloudDownload, CloudOff, CloudUpload, Loader2, RefreshCw, Settings, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useLibSync } from '../api'
import { Button, Popover, cx } from '../../ui/primitives'
import { syncNow } from './client'
import { active, controls, downloadLine, fraction, indicatorState, initialLine, phaseLine, plural, syncProblem, uploadLine } from './format'
import { openLibSyncSettings } from './nav'
import { Bar } from './parts'

const ICONS = { cloud: Cloud, upload: CloudUpload, download: CloudDownload, off: CloudOff, alert: CloudAlert, sync: Cloud }

function Ring({ value }: { value: number }) {
  const r = 19
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 44 44" className="pointer-events-none absolute inset-0 size-full -rotate-90" aria-hidden>
      <circle cx="22" cy="22" r={r} fill="none" strokeWidth="2.5" className="stroke-surface-3" />
      <circle cx="22" cy="22" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-accent transition-[stroke-dashoffset] duration-300" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0.02, value)))} />
    </svg>
  )
}

export function SyncIndicator({ className }: { className?: string }) {
  const s = useLibSync()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const [busy, setBusy] = useState(false)
  if (!s.configured) return null
  const st = indicatorState(s)
  const Icon = ICONS[st.icon]
  const { warning } = syncProblem(s)
  const c = controls(s)

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={st.label}
        title={st.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cx('relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg', className)}
      >
        {st.progress !== undefined && <Ring value={st.progress} />}
        <Icon className={cx('size-5', st.icon === 'alert' && 'text-danger', st.icon === 'sync' && 'animate-pulse')} />
        {st.dot && <span className="absolute right-2 top-2 size-2 rounded-full bg-danger ring-2 ring-surface" />}
        {!st.dot && st.warn && <span className="absolute right-2 top-2 size-2 rounded-full bg-warn ring-2 ring-surface" />}
      </button>
      <Popover anchor={anchor} open={open} onClose={close} align="start" side="top" className="w-80 max-w-[calc(100vw-16px)]">
        <div role="dialog" aria-label="Library sync status" className="grid gap-3 p-3">
          <div className="flex items-start gap-2.5">
            <Icon className={cx('mt-0.5 size-5 shrink-0', st.icon === 'alert' ? 'text-danger' : 'text-muted')} />
            <div className="min-w-0 text-sm">
              <div className="font-semibold">Library sync</div>
              <div className={cx(s.phase === 'error' ? 'text-danger' : 'text-muted')}>{phaseLine(s)}</div>
              {s.backendLabel && <div className="truncate text-xs text-faint">{s.backendLabel}</div>}
            </div>
          </div>
          {warning && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-2 text-xs">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />
              <div className="grid gap-0.5">
                {warning.lines.map((l) => (
                  <div key={l}>{l}</div>
                ))}
                {warning.note && <div className="text-muted">{warning.note}</div>}
              </div>
            </div>
          )}
          {s.initial && <Bar value={s.initial.total > 1 ? s.initial.done / s.initial.total : undefined} label={initialLine(s.initial)} />}
          {!s.initial && active(s.upload) && <Bar value={fraction(s.upload)} label={uploadLine(s.upload)} />}
          {!s.initial && active(s.download) && <Bar value={fraction(s.download)} label={downloadLine(s.download)} />}
          {(s.pendingChanges > 0 || s.offlineReady.total > s.offlineReady.have) && (
            <div className="grid gap-0.5 text-xs text-muted">
              {s.pendingChanges > 0 && <div>{plural(s.pendingChanges, 'change')} waiting to upload</div>}
              {s.offlineReady.total > s.offlineReady.have && (
                <div>
                  Ready offline: {s.offlineReady.have.toLocaleString()} of {plural(s.offlineReady.total, 'file')}
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            {c.syncNow && (
            <Button
              size="sm"
              className="h-10 flex-1"
              title={c.syncNowOff}
              disabled={!!c.syncNowOff || busy}
              icon={busy || s.phase === 'syncing' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              onClick={async () => {
                setBusy(true)
                try {
                  await syncNow()
                } catch {
                  /* the status shows the error */
                } finally {
                  setBusy(false)
                }
              }}
            >
              Sync now
            </Button>
            )}
            <Button
              size="sm"
              variant={c.syncNow ? 'ghost' : 'primary'}
              className="h-10 flex-1"
              icon={<Settings className="size-4" />}
              onClick={() => {
                close()
                openLibSyncSettings()
              }}
            >
              Open settings
            </Button>
          </div>
        </div>
      </Popover>
    </>
  )
}
