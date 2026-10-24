/** Settings → Library sync (§12.2): off (set up / join), on (status, devices, storage, danger zone). */
import {
  Cloud,
  CloudOff,
  ExternalLink,
  HardDrive,
  KeyRound,
  Laptop,
  Loader2,
  Lock,
  MonitorSmartphone,
  Pencil,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Tablet,
  TriangleAlert,
  WifiOff,
} from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useLibSync, type InstantSyncTest, type LibSyncStatus, type PullTrigger } from '../api'
import type { S3Config } from '../backends/types'
import { useLibraries } from '../../library/browse/libraries'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { defaultDeviceName } from '../../sync/deviceName'
import { Button, Dialog, Field, IconButton, Input, confirmDialog, cx, toast } from '../../ui/primitives'
import { checkBackend, currentPayload, deleteRemoteData, enableSync, leaveSync, renameDevice, repair, setPaused, syncNow, testInstantSync, updateBackend } from './client'
import { active, controls, downloadLine, errorText, failureText, fraction, initialLine, phaseLine, plural, relayLine, relayNote, syncProblem, timeAgo, uploadLine, type ErrorAction } from './format'
import { JoinFlow } from './JoinFlow'
import { PairingQr } from './PairingQr'
import { Bar, Block, Note, SwitchRow } from './parts'
import { CheckList, CorsHelp, S3Fields, SetupWizard } from './SetupWizard'
import { checkFailureText, formFromConfig, needsCors, preset, toConfig, validateForm, type S3Form } from './wizard'

type Modal =
  | { kind: 'wizard' }
  | { kind: 'join'; rejoin?: boolean; reason?: 'libraryGone' }
  | { kind: 'rename' }
  | { kind: 'pair' }
  | { kind: 'keys' }
  | { kind: 'cors' }
  | { kind: 'confirm'; what: 'delete' | 'reset' }
  | null

const fail = (e: unknown) => toast(failureText(e), 'error')

/** The shared storage config (from the pairing payload), loaded when `want` turns true. */
function useStorageConfig(want: boolean): { config: S3Config | null; relay?: string | null; loading: boolean } {
  const [st, setSt] = useState<{ config: S3Config | null; relay?: string | null; loading: boolean }>({ config: null, loading: false })
  useEffect(() => {
    if (!want) return
    let live = true
    void Promise.resolve()
      .then(() => live && setSt((x) => ({ ...x, loading: true })))
      .then(() => currentPayload())
      .then((p) => live && setSt({ config: p?.b.kind === 's3' ? p.b : null, relay: p?.r, loading: false }))
    return () => {
      live = false
    }
  }, [want])
  return st
}

/* ---------------------------------------------------------------- Off */

function Bullet({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">{icon}</span>
      <span className="text-sm">
        <span className="block font-medium">{title}</span>
        <span className="block text-muted">{children}</span>
      </span>
    </li>
  )
}

function OffView({ open }: { open: (m: Modal) => void }) {
  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted">Keep the same songs, files, annotations and setlists on your phone, tablet and computer.</p>
      <ul className="grid gap-3">
        <Bullet icon={<HardDrive className="size-4" />} title="Your own storage">
          A bucket you control at Cloudflare R2, Backblaze B2, Amazon S3 or MinIO. No accounts, no OpenStand servers.
        </Bullet>
        <Bullet icon={<Lock className="size-4" />} title="Encrypted on the device">
          Everything is encrypted before it leaves this device. The storage only ever sees scrambled data.
        </Bullet>
        <Bullet icon={<WifiOff className="size-4" />} title="A full offline copy everywhere">
          Every device keeps the whole library, so you can perform without internet.
        </Bullet>
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Cloud className="size-4" />} onClick={() => open({ kind: 'wizard' })}>
          Set up sync
        </Button>
        <Button icon={<QrCode className="size-4" />} onClick={() => open({ kind: 'join' })}>
          Join from another device
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- Status */

/** Non-fatal: a device's changes are held back or its clock is ahead. Calm, amber, sync carries on. */
function WarningBanner({ s, onAction }: { s: LibSyncStatus; onAction: (a: ErrorAction) => void }) {
  const w = syncProblem(s).warning
  if (!w) return null
  return (
    <Note
      tone="warn"
      action={
        w.action ? (
          <Button size="sm" variant="secondary" onClick={() => onAction(w.action!)}>
            {w.actionLabel}
          </Button>
        ) : undefined
      }
    >
      {w.lines.map((l) => (
        <p key={l} className="font-medium">
          {l}
        </p>
      ))}
      {w.note && <p className="mt-0.5 text-xs text-muted">{w.note}</p>}
    </Note>
  )
}

function ErrorBanner({ s, onAction, providerConsole }: { s: LibSyncStatus; onAction: (a: ErrorAction) => void; providerConsole?: string }) {
  if (s.phase !== 'error' || !s.error || s.error.code === 'network') return null
  const t = errorText(s.error)
  const action =
    t.action === 'openProvider' ? (
      providerConsole ? (
        <a href={providerConsole} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
          {t.actionLabel} <ExternalLink className="size-3.5" />
        </a>
      ) : null
    ) : t.action ? (
      <>
        <Button size="sm" variant={t.warning ? 'secondary' : 'primary'} onClick={() => onAction(t.action!)}>
          {t.actionLabel}
        </Button>
        {t.secondary && (
          <Button size="sm" variant="secondary" onClick={() => onAction(t.secondary!)}>
            {t.secondaryLabel}
          </Button>
        )}
      </>
    ) : null
  return (
    <Note tone={t.warning ? 'warn' : 'danger'} action={action}>
      <p className="font-medium">{t.message}</p>
      {t.hint && <p className="mt-0.5 text-muted">{t.hint}</p>}
      {s.error.detail && !/^\d+$/.test(s.error.detail) && (
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer select-none">Technical details</summary>
          <p className="mt-0.5 break-words">{s.error.detail}</p>
        </details>
      )}
    </Note>
  )
}

function StatusCard({ s }: { s: LibSyncStatus }) {
  const [, tick] = useState(0)
  // Keep "2 min ago" fresh.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const Icon = s.phase === 'offline' || s.phase === 'paused' ? CloudOff : s.phase === 'error' ? TriangleAlert : Cloud
  const warned = !!syncProblem(s).warning
  const dot = s.phase === 'idle' ? (warned ? 'bg-warn' : 'bg-ok') : s.phase === 'error' ? 'bg-danger' : s.phase === 'offline' || s.phase === 'paused' ? 'bg-faint' : 'bg-warn animate-pulse'
  const missing = s.offlineReady.total - s.offlineReady.have
  const note = relayNote(s)
  return (
    <div className="grid gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <Icon className={cx('mt-0.5 size-5 shrink-0', s.phase === 'error' ? 'text-danger' : 'text-muted')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={cx('size-2 shrink-0 rounded-full', dot)} />
            <span className="min-w-0">{s.phase === 'error' ? 'Sync stopped' : phaseLine(s)}</span>
          </div>
          <div className="text-xs text-muted">
            {s.pendingChanges > 0 ? `${plural(s.pendingChanges, 'change')} waiting to upload` : s.phase === 'idle' ? 'All changes uploaded' : ''}
            {note ? `${s.pendingChanges > 0 || s.phase === 'idle' ? ' · ' : ''}${note}` : ''}
          </div>
        </div>
      </div>
      {s.initial && (
        <Bar value={s.initial.total > 1 ? s.initial.done / s.initial.total : undefined} label={initialLine(s.initial)} />
      )}
      {!s.initial && active(s.upload) && <Bar value={fraction(s.upload)} label={uploadLine(s.upload)} />}
      {!s.initial && active(s.download) && <Bar value={fraction(s.download)} label={downloadLine(s.download)} />}
      {s.offlineReady.total > 0 && (
        <div className={cx('text-xs', missing > 0 ? 'text-muted' : 'text-ok')}>
          Ready offline: {s.offlineReady.have.toLocaleString()} of {plural(s.offlineReady.total, 'file')}
        </div>
      )}
    </div>
  )
}

const TRIGGER: Record<PullTrigger, string> = {
  start: 'when sync started',
  notice: 'after a change notice',
  poll: 'regular check',
  focus: 'when the app came back',
  online: 'when back online',
  relay: 'after reconnecting',
  manual: 'Sync now',
  local: 'after closing a song',
  retry: 'retry',
}

/** Clock time with seconds; the date too when it isn't today. */
function clock(at: number) {
  const d = new Date(at)
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString()} ${t}`
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`)

function testText(r: InstantSyncTest, relayConfigured?: boolean): { tone: 'ok' | 'warn'; text: string } {
  if (!r.sent)
    return {
      tone: 'warn',
      text:
        r.relay === 'off' && relayConfigured === false
          ? 'This library has no relay, so instant updates are off. Changes arrive with the regular checks.'
          : 'Not connected to the relay right now. Try again in a moment.',
    }
  if (!r.answers.length)
    return { tone: 'warn', text: 'No other device answered within 5 s. Open OpenStand on another device of this library, keep it on screen, and try again.' }
  return { tone: 'ok', text: r.answers.map((a) => `“${a.name}” answered in ${seconds(a.rtt)}`).join(' · ') }
}

/** Settings → Library sync → Connection details: what the relay and the pull scheduler are doing. */
function ConnectionDetails({ s }: { s: LibSyncStatus }) {
  const [test, setTest] = useState<{ busy: boolean; result?: InstantSyncTest; error?: string }>({ busy: false })
  const d = s.diag
  const name = (id: string) => s.devices.find((x) => x.id === id)?.name ?? 'another device'
  const relay = relayLine(s)
  const run = async () => {
    setTest({ busy: true })
    try {
      setTest({ busy: false, result: await testInstantSync() })
    } catch (e) {
      setTest({ busy: false, error: failureText(e) })
    }
  }
  const out = test.result ? testText(test.result, s.relayConfigured) : test.error ? { tone: 'warn' as const, text: test.error } : null
  const rows: [string, ReactNode][] = [
    ['Instant updates', `${relay}${d?.relaySince ? ` since ${clock(d.relaySince)}` : ''}`],
    ['Last notice sent', d?.noticeSent ? `${clock(d.noticeSent.at)} (change ${d.noticeSent.seq})` : 'None yet'],
    [
      'Last notice received',
      d?.noticeReceived
        ? `${clock(d.noticeReceived.at)} from “${name(d.noticeReceived.device)}”${d.noticeReceived.hidden ? ', while this window was hidden' : ''}`
        : 'None yet',
    ],
    [
      'Last check for changes',
      d?.lastPull
        ? `${clock(d.lastPull.at)}, ${TRIGGER[d.lastPull.trigger]}${d.lastPull.hidden ? ' (window hidden)' : ''}, took ${seconds(d.lastPull.ms)}${d.lastPull.ok ? '' : ' (failed)'}`
        : 'None yet',
    ],
    ['Regular checks', d ? `Every ${Math.round(d.pollMs / 1000)} s while this window is visible` : '—'],
  ]
  return (
    <details className="group rounded-xl border border-line px-4 py-2 text-sm">
      <summary className="-mx-4 -my-2 flex min-h-11 cursor-pointer select-none items-center px-4 py-2 font-medium text-muted hover:text-fg">Connection details</summary>
      <div className="grid gap-3 pb-2 pt-3">
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-xs text-muted sm:text-sm">{k}</dt>
              <dd className="mb-1 tabular-nums sm:mb-0">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button size="sm" onClick={() => void run()} disabled={test.busy || s.phase === 'paused'}>
            {test.busy && <Loader2 className="size-4 animate-spin" />}
            Test instant sync
          </Button>
          <span className="text-xs text-muted">Asks your other open devices to answer through the relay.</span>
        </div>
        {out && (
          <p role="status" className={cx('text-sm', out.tone === 'ok' ? 'text-ok' : 'text-warn')}>
            {out.text}
          </p>
        )}
      </div>
    </details>
  )
}

function DeviceIcon({ platform }: { platform: string }) {
  const p = platform.toLowerCase()
  const C = /ipad|tablet/.test(p) ? Tablet : /iphone|android|ios/.test(p) ? Smartphone : /mac|windows|linux|chrome ?os/.test(p) ? Laptop : MonitorSmartphone
  return <C className="size-5 shrink-0 text-muted" />
}

function Devices({ s, onRename }: { s: LibSyncStatus; onRename?: () => void }) {
  const list = [...s.devices].sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || Number(b.self) - Number(a.self) || b.lastSeenAt - a.lastSeenAt)
  if (!list.length) return <p className="text-sm text-muted">No devices yet.</p>
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {list.map((d) => (
        <li key={d.id} className={cx('flex min-h-14 items-center gap-3 px-4 py-2.5', d.retired && 'opacity-50')}>
          <DeviceIcon platform={d.platform} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{d.name}</span>
              {d.self && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">This device</span>}
            </div>
            <div className="truncate text-xs text-muted">
              {d.retired ? 'Stopped syncing' : d.self ? (s.phase === 'error' ? 'Not syncing' : s.phase === 'paused' ? 'Paused' : 'Syncing now') : `Last seen ${timeAgo(d.lastSeenAt)}`}
              {d.platform ? ` · ${d.platform}` : ''}
            </div>
          </div>
          {d.self && !d.retired && onRename && (
            <IconButton label="Rename this device" className="-mr-2 size-11 text-muted" onClick={onRename}>
              <Pencil className="size-4" />
            </IconButton>
          )}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------ Dialogs */

/** Rename this device: the name other devices see (shared with performance sync). Empty = the default name. */
function RenameDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const own = useSettings((st) => st.s.sync.deviceName)
  const [name, setName] = useState(own.trim() || current)
  const [busy, setBusy] = useState(false)
  const fallback = defaultDeviceName()
  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      // Saving the default name unchanged keeps it a default (numbered if another device has it too).
      const next = !own.trim() && name.trim() === current ? '' : name.trim().slice(0, 60)
      await renameDevice(next)
      toast('Device renamed', 'ok')
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      size="sm"
      onClose={() => !busy && onClose()}
      title="Rename this device"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4 text-sm">
        <Field label="Device name" hint={`Your other devices show this name. Leave it empty to use “${fallback}”.`}>
          <Input value={name} maxLength={60} placeholder={fallback} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} autoFocus autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  )
}

function KeysDialog({ onClose }: { onClose: () => void }) {
  const { config, loading } = useStorageConfig(true)
  const [form, setForm] = useState<S3Form | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<Awaited<ReturnType<typeof checkBackend>>>()
  const f = form ?? (config ? { ...formFromConfig(config), accessKeyId: '', secretAccessKey: '' } : null)
  const errors = f && showErrors ? validateForm(f) : {}
  const save = async () => {
    if (!f) return
    if (Object.keys(validateForm(f)).length) return setShowErrors(true)
    setBusy(true)
    setCheck(undefined)
    try {
      const cfg = toConfig(f)
      const c = await checkBackend(cfg)
      if (!c.ok) return setCheck(c)
      await updateBackend(cfg)
      toast('Storage keys updated', 'ok')
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Update storage keys"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!f || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Test and save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <p className="text-sm text-muted">
          Use this after creating new keys at your storage provider. Same bucket, same library. Other devices need the new keys too: update them there, or pair them again.
        </p>
        {loading && !f ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted" />
          </div>
        ) : f ? (
          <>
            {config && (
              <div className="rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-sm">
                {preset(config.provider).name} · {config.bucket}/{config.prefix}
              </div>
            )}
            <S3Fields form={f} errors={errors} keysOnly={!!config} onField={(field, value) => setForm({ ...f, [field]: value })} />
            {check && <CheckList check={check} checking={false} />}
            {check && !check.ok && <Note tone="danger">{checkFailureText(check)}</Note>}
            {check && needsCors(check) && <CorsHelp config={toConfig(f)} />}
          </>
        ) : null}
      </div>
    </Dialog>
  )
}

function CorsDialog({ onClose }: { onClose: () => void }) {
  const { config, loading } = useStorageConfig(true)
  const fallback: S3Config = { kind: 's3', provider: 'other', endpoint: '', region: '', bucket: '', prefix: '', accessKeyId: '', secretAccessKey: '', pathStyle: true }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Allow this site in your bucket"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <p className="text-sm text-muted">Browsers only let OpenStand talk to your bucket when the bucket allows this site. Add this CORS rule, then choose Sync now.</p>
        {loading ? <Loader2 className="mx-auto size-5 animate-spin text-muted" /> : <CorsHelp config={config ?? fallback} />}
      </div>
    </Dialog>
  )
}

const useLibraryName = () => useLibraries((l) => l.list.find((x) => x.id === l.active)?.name ?? 'My Library')
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function TypeName({ name, value, onChange, onEnter, autoFocus }: { name: string; value: string; onChange: (v: string) => void; onEnter: () => void; autoFocus?: boolean }) {
  const id = useId()
  return (
    <>
      <label htmlFor={id} className="text-muted">
        Type <b className="text-fg">{name}</b> to confirm.
      </label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} autoFocus={autoFocus} autoComplete="off" />
    </>
  )
}

/** Delete synced data: confirmed by typing the library name (§10.5). */
function DeleteDialog({ s, onClose }: { s: LibSyncStatus; onClose: () => void }) {
  const name = useLibraryName()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const okName = sameName(typed, name)
  const run = async () => {
    if (!okName || busy) return
    setBusy(true)
    try {
      await deleteRemoteData()
      toast('Synced data deleted from storage', 'ok')
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      size="sm"
      onClose={() => !busy && onClose()}
      title="Delete synced data from storage?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={!okName || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Delete synced data
          </Button>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4 text-sm">
        <p className="text-muted">
          This deletes the synced copy of “{name}” from {s.backendLabel ?? 'your storage'}, for every device. Each device keeps its own copy of the library but stops syncing.
        </p>
        <TypeName name={name} value={typed} onChange={setTyped} onEnter={() => void run()} autoFocus />
      </div>
    </Dialog>
  )
}

/**
 * Reset sync (§10.5): a new library secret (so a lost device or leaked code can't read or change anything
 * synced afterwards) and, optionally, new storage keys. The bucket keys are the user's to rotate at the
 * provider; we only offer to switch to new ones in the same step.
 */
function ResetDialog({ s, onClose }: { s: LibSyncStatus; onClose: () => void }) {
  const name = useLibraryName()
  const { config, relay, loading } = useStorageConfig(true)
  const [typed, setTyped] = useState('')
  const [rotate, setRotate] = useState(false)
  const [form, setForm] = useState<S3Form | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [check, setCheck] = useState<Awaited<ReturnType<typeof checkBackend>>>()
  const [keyError, setKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The replaced access key id, once a reset with new keys is done (to revoke at the provider). */
  const [rotated, setRotated] = useState<string | null>(null)
  const p = config ? preset(config.provider) : null
  const f = form ?? (config ? { ...formFromConfig(config), accessKeyId: '', secretAccessKey: '' } : null)
  const errors = rotate && f && showErrors ? validateForm(f) : {}
  const okName = sameName(typed, name)
  const storage = p?.name ?? 'your storage provider'

  const run = async () => {
    if (!okName || busy || !config) return
    let backend: S3Config = config
    if (rotate) {
      if (!f || Object.keys(validateForm(f)).length) return setShowErrors(true)
      backend = toConfig(f)
      if (backend.accessKeyId === config.accessKeyId) return setKeyError('That’s the access key in use now. Create a new key first, then enter it here.')
    }
    setKeyError(null)
    setCheck(undefined)
    setBusy(true)
    try {
      if (rotate) {
        const c = await checkBackend(backend)
        if (!c.ok) return setCheck(c)
        // Proves the new keys reach this library and saves them, so the reset below runs with them.
        await updateBackend(backend)
      }
      await deleteRemoteData()
      // No relay saved (the site's check failed at setup): look again rather than carry that forward.
      await enableSync({ backend, relay: relay ?? undefined })
      if (rotate) setRotated(config.accessKeyId)
      else {
        toast('Sync was reset. Pair your other devices again.', 'ok')
        onClose()
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const consoleLink = p?.console && (
    <a href={p.console} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
      Open the {p.name} console <ExternalLink className="size-3.5" />
    </a>
  )

  if (rotated)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Sync was reset"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="grid gap-3 px-5 py-4 text-sm">
          <Note tone="ok">New encryption key and new storage keys are in use. Pair your other devices again with the new code.</Note>
          <p className="font-medium">Last step: revoke the old storage key</p>
          <p className="text-muted">Until you do, a lost device or leaked code can still use the old key to delete or fill up your bucket.</p>
          <p className="text-muted">
            At {storage}, delete or deactivate the access key <code className="break-all rounded bg-surface-2 px-1 font-mono text-xs text-fg">{rotated}</code>.
          </p>
          {consoleLink}
        </div>
      </Dialog>
    )

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title="Reset sync?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={!okName || busy || !config}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {rotate ? 'Test keys and reset' : 'Reset sync'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4 text-sm">
        <p className="text-muted">
          Use this after losing a device or sharing the pairing code by mistake. Reset makes a new encryption key and a new synced library: the synced copy in{' '}
          {s.backendLabel ?? 'your storage'} is deleted and “{name}” is uploaded again with the new key. Every other device stops syncing until you pair it again with the new code.
        </p>
        <p className="text-muted">After that, the lost device or old code can’t read or change anything you sync.</p>
        <Note tone="warn">
          <p className="font-medium">Reset doesn’t change your storage keys.</p>
          <p className="mt-0.5 text-muted">A lost device or leaked code still has them, so it can delete or fill up your bucket until you revoke them at {storage}.</p>
        </Note>
        {config ? (
          <SwitchRow label="Also switch to new storage keys" hint="Recommended when a device or code may be in someone else’s hands." checked={rotate} onChange={setRotate} disabled={busy} />
        ) : loading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted" />
        ) : null}
        {rotate && f && (
          <div className="grid gap-3 rounded-xl border border-line p-3">
            <ol className="grid list-decimal gap-1 pl-5 text-muted">
              <li>Create a new access key at {storage}, limited to this bucket.</li>
              <li>Enter it below. The reset tests it, then uses it.</li>
              <li>After the reset, revoke the old key at {storage}.</li>
            </ol>
            {p && <p className="text-xs text-muted">{p.rotate}</p>}
            {consoleLink}
            <S3Fields form={f} errors={errors} keysOnly onField={(field, value) => setForm({ ...f, [field]: value })} />
            {keyError && <Note tone="danger">{keyError}</Note>}
            {check && <CheckList check={check} checking={false} />}
            {check && !check.ok && <Note tone="danger">{checkFailureText(check)}</Note>}
          </div>
        )}
        <TypeName name={name} value={typed} onChange={setTyped} onEnter={() => void run()} />
      </div>
    </Dialog>
  )
}

/* --------------------------------------------------------------- Main */

export function LibrarySyncSettings() {
  const s = useLibSync()
  const [modal, setModal] = useState<Modal>(null)
  const [busy, setBusy] = useState<null | 'sync' | 'repair' | 'leave' | 'pause'>(null)
  const quota = s.error?.code === 'quota'
  const { config } = useStorageConfig(quota)
  const close = () => setModal(null)

  const run = (what: NonNullable<typeof busy>, fn: () => Promise<unknown>, done?: string) => async () => {
    setBusy(what)
    try {
      await fn()
      if (done) toast(done, 'ok')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const leave = async () => {
    const missing = s.offlineReady.total - s.offlineReady.have
    const ok = await confirmDialog({
      title: 'Stop syncing on this device?',
      message: (
        <>
          {missing > 0 && (
            <span className="mb-2 block font-medium text-warn">
              {plural(missing, 'file')} {missing === 1 ? 'hasn’t' : 'haven’t'} downloaded yet and will be missing on this device.
            </span>
          )}
          This device keeps its library as a normal local library. Your other devices keep syncing.
        </>
      ),
      confirmLabel: 'Stop syncing',
      danger: true,
    })
    if (ok) await run('leave', leaveSync, 'Stopped syncing on this device')()
  }

  // The library is gone: stop syncing (local songs stay as they are), then join again with a new code.
  const joinNew = async () => {
    setBusy('leave')
    try {
      await leaveSync()
      setModal({ kind: 'join', rejoin: true, reason: 'libraryGone' })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const onAction = (a: ErrorAction) => {
    if (a === 'updateKeys') setModal({ kind: 'keys' })
    else if (a === 'showCors') setModal({ kind: 'cors' })
    else if (a === 'storageSettings') useNav.getState().go({ name: 'settings', page: 'storage' })
    else if (a === 'retry') void run('sync', syncNow)()
    else if (a === 'joinAgain' || a === 'rejoin') setModal({ kind: 'join', rejoin: true })
    else if (a === 'joinNew') void joinNew()
    else if (a === 'stopSyncing') void leave()
    else if (a === 'reload') location.reload()
  }

  const dialogs = (
    <>
      {modal?.kind === 'wizard' && <SetupWizard open onClose={close} />}
      {modal?.kind === 'join' && <JoinFlow open onClose={close} rejoin={modal.rejoin} reason={modal.reason} />}
      {modal?.kind === 'rename' && <RenameDialog current={s.devices.find((d) => d.self)?.name ?? defaultDeviceName()} onClose={close} />}
      {modal?.kind === 'keys' && <KeysDialog onClose={close} />}
      {modal?.kind === 'cors' && <CorsDialog onClose={close} />}
      {modal?.kind === 'confirm' && modal.what === 'delete' && <DeleteDialog s={s} onClose={close} />}
      {modal?.kind === 'confirm' && modal.what === 'reset' && <ResetDialog s={s} onClose={close} />}
      {modal?.kind === 'pair' && (
        <Dialog
          open
          onClose={close}
          title="Add a device"
          footer={
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          }
        >
          <div className="grid gap-4 px-5 py-4">
            <p className="text-sm text-muted">The new device gets the whole library and the storage keys. It can be a phone, tablet or computer with OpenStand open in a browser.</p>
            <PairingQr />
          </div>
        </Dialog>
      )}
    </>
  )

  // Dialogs stay at the same tree position whether sync is on or off, so the wizard and join flow
  // survive the switch to "on" that they cause.
  if (!s.configured)
    return (
      <>
        <OffView open={setModal} />
        {dialogs}
      </>
    )

  const paused = s.phase === 'paused'
  const c = controls(s)
  return (
    <>
      <div className="grid gap-8">
        <div className="grid gap-3">
          <ErrorBanner s={s} onAction={onAction} providerConsole={config ? preset(config.provider).console : undefined} />
          <WarningBanner s={s} onAction={onAction} />
          <StatusCard s={s} />
          {(c.syncNow || c.addDevice) && (
            <div className="flex flex-wrap items-center gap-2">
              {c.syncNow && (
                <Button
                  icon={busy === 'sync' || s.phase === 'syncing' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  onClick={run('sync', syncNow)}
                  title={c.syncNowOff}
                  disabled={!!busy || !!c.syncNowOff}
                >
                  Sync now
                </Button>
              )}
              {c.addDevice && (
                <Button variant="primary" icon={<QrCode className="size-4" />} onClick={() => setModal({ kind: 'pair' })}>
                  Add a device
                </Button>
              )}
            </div>
          )}
          <ConnectionDetails s={s} />
        </div>

        <Block title="Devices" icon={<MonitorSmartphone className="size-4" />} description="Every device keeps a full copy of the library.">
          <Devices s={s} onRename={c.rename ? () => setModal({ kind: 'rename' }) : undefined} />
        </Block>

        <Block title="Storage" icon={<HardDrive className="size-4" />}>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-2.5">
            <span className="min-w-0 flex-1 basis-48 break-words text-sm">{s.backendLabel ?? 'Your storage'}</span>
            {c.storageKeys && (
              <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setModal({ kind: 'keys' })}>
                Update storage keys
              </Button>
            )}
          </div>
          {c.pause && (
            <SwitchRow
              label="Pause sync"
              hint="Stops uploading and downloading on this device until you turn it back on."
              checked={paused}
              disabled={busy === 'pause'}
              onChange={(v) => void run('pause', () => setPaused(v))()}
            />
          )}
        </Block>

        <Block title="Troubleshooting" icon={<ShieldAlert className="size-4" />}>
          <div className="grid gap-2">
            {c.recheck && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button size="sm" onClick={run('repair', repair, 'Files checked')} disabled={!!busy}>
                  {busy === 'repair' && <Loader2 className="size-4 animate-spin" />}
                  Re-check files
                </Button>
                <span className="text-xs text-muted">Uploads any file the storage is missing.</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button size="sm" onClick={leave} disabled={!!busy}>
                {busy === 'leave' && <Loader2 className="size-4 animate-spin" />}
                Stop syncing on this device
              </Button>
              <span className="text-xs text-muted">The library stays here as a normal local library.</span>
            </div>
          </div>
          <div className="mt-2 grid gap-2 rounded-xl border border-danger/30 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-danger">Danger zone</h4>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" className="!text-danger" onClick={() => setModal({ kind: 'confirm', what: 'reset' })}>
                Reset sync…
              </Button>
              {c.deleteRemote && (
                <Button size="sm" variant="ghost" className="!text-danger" onClick={() => setModal({ kind: 'confirm', what: 'delete' })}>
                  Delete synced data from storage…
                </Button>
              )}
            </div>
          </div>
        </Block>
      </div>
      {dialogs}
    </>
  )
}
