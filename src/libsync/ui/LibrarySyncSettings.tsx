/** Settings → Library sync: off (set up / join), on (status, devices, storage, danger zone). */
import {
  Cloud,
  CloudOff,
  ExternalLink,
  FolderOpen,
  HardDrive,
  KeyRound,
  LogIn,
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
import { useLibSync, type BackendDescription, type LibSyncStatus, type OAuthKind } from '../api'
import type { BackendConfig, S3Config } from '../backends/types'
import { useLibraries } from '../../library/browse/libraries'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { defaultDeviceName } from '../../sync/deviceName'
import { Button, Dialog, Field, IconButton, Input, confirmDialog, cx, toast } from '../../ui/primitives'
import {
  checkBackend,
  currentPayload,
  deleteRemoteData,
  describeBackend,
  enableSync,
  leaveSync,
  oauthProviders,
  refreshDevices,
  renameDevice,
  repair,
  setPaused,
  syncNow,
  updateBackend,
  useMockOpen,
} from './client'
import { DisconnectLinks, DriveLeaveNote, SignInProblemNote } from './DriveSignIn'
import { active, controls, downloadLine, errorText, failureText, fmtBytes, fraction, initialLine, phaseLine, plural, relayNote, syncProblem, timeAgo, uploadLine, type ErrorAction } from './format'
import { JoinFlow } from './JoinFlow'
import { PairingQr } from './PairingQr'
import { Bar, Block, Note, SwitchRow } from './parts'
import { CheckList, CorsHelp, S3Fields, SetupWizard } from './SetupWizard'
import { DRIVE_HOME, accountOf, ackSignInReturn, drive, isDrive, signInAgain, signInProblem, takeSignInReturn, type SignInProblem, type SignInReturn } from './signin'
import { checkFailureText, formFromConfig, needsCors, preset, toConfig, validateForm, type S3Form } from './wizard'

type Modal =
  | { kind: 'wizard'; resume?: SignInReturn; storage?: OAuthKind }
  | { kind: 'join'; rejoin?: boolean; reason?: 'libraryGone'; resume?: SignInReturn; code?: string }
  | { kind: 'rename' }
  | { kind: 'pair' }
  | { kind: 'keys' }
  | { kind: 'cors' }
  | { kind: 'confirm'; what: 'delete' | 'reset' }
  | null

const fail = (e: unknown) => toast(failureText(e), 'error')

interface StorageConfig {
  /** The S3 config, when the library syncs through S3. */
  config: S3Config | null
  /** The shared backend config, any kind (cloud drives: the account hints). */
  backend: BackendConfig | null
  relay?: string | null
  loading: boolean
}

/** The shared storage config (from the pairing payload), loaded when `want` turns true. */
function useStorageConfig(want: boolean): StorageConfig {
  const [st, setSt] = useState<StorageConfig>({ config: null, backend: null, loading: false })
  useEffect(() => {
    if (!want) return
    let live = true
    void Promise.resolve()
      .then(() => live && setSt((x) => ({ ...x, loading: true })))
      .then(() => currentPayload())
      .then((p) => live && setSt({ config: p?.b.kind === 's3' ? p.b : null, backend: p?.b ?? null, relay: p?.r, loading: false }))
    return () => {
      live = false
    }
  }, [want])
  return st
}

/**
 * The screen to open when Settings mounts: a drive sign-in that came back from the provider reopens
 * the wizard or the join flow where it left; otherwise a dev mock may ask for one.
 */
function initialModal(r: SignInReturn | null): Modal {
  if (r?.intent.type === 'setup') return { kind: 'wizard', resume: r }
  if (r?.intent.type === 'join') return { kind: 'join', resume: r, rejoin: r.ui.rejoin, reason: r.ui.reason }
  if (r) return null
  const mock = import.meta.env.DEV ? useMockOpen.getState().open : undefined
  if (mock?.kind === 'wizard') return { kind: 'wizard', storage: mock.storage }
  if (mock?.kind === 'join') return { kind: 'join', code: mock.code }
  return null
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
  const [drives, setDrives] = useState<OAuthKind[]>([])
  useEffect(() => {
    let live = true
    oauthProviders()
      .then((d) => live && setDrives(d))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const names = drives.map((k) => drive(k).name)
  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted">
        Keep the same songs, files, annotations and setlists on your phone, tablet and computer.{' '}
        <a href="/privacy" target="_blank" rel="noopener" className="text-accent hover:underline">
          Privacy policy
        </a>
      </p>
      <ul className="grid gap-3">
        <Bullet icon={<HardDrive className="size-4" />} title="Your own storage">
          {names.length
            ? `Your ${names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0]}, or a bucket you control (R2, B2, S3, MinIO). No OpenStand accounts or servers.`
            : 'A bucket you control at Cloudflare R2, Backblaze B2, Amazon S3 or MinIO. No accounts, no OpenStand servers.'}
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

function ErrorBanner({ s, onAction, providerConsole, want }: { s: LibSyncStatus; onAction: (a: ErrorAction) => void; providerConsole?: string; want?: string }) {
  if (s.phase !== 'error' || !s.error || s.error.code === 'network') return null
  const t = errorText(s.error, s.backendKind, want)
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
          <Input
            value={name}
            maxLength={60}
            placeholder={fallback}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              void save()
            }}
            autoFocus
            autoComplete="off"
          />
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
              <div className="break-all rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-sm">
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
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          onEnter()
        }}
        autoFocus={autoFocus}
        autoComplete="off"
      />
    </>
  )
}

/** Delete synced data: confirmed by typing the library name. */
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
 * Reset sync: a new library secret (so a lost device or leaked code can't read or change anything
 * synced afterwards) and, optionally, new storage keys. The bucket keys are the user's to rotate at the
 * provider; we only offer to switch to new ones in the same step.
 */
function ResetDialog({ s, onClose }: { s: LibSyncStatus; onClose: () => void }) {
  const name = useLibraryName()
  const { config, backend: shared, relay, loading } = useStorageConfig(true)
  const kind = shared && isDrive(shared.kind) ? shared.kind : undefined
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
    if (!okName || busy || !shared) return
    let backend: BackendConfig = shared
    if (rotate && config) {
      if (!f || Object.keys(validateForm(f)).length) return setShowErrors(true)
      backend = toConfig(f)
      if (backend.kind === 's3' && backend.accessKeyId === config.accessKeyId) return setKeyError('That’s the access key in use now. Create a new key first, then enter it here.')
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
      if (rotate && config) setRotated(config.accessKeyId)
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
          <Button variant="danger" onClick={run} disabled={!okName || busy || !shared}>
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
        {kind ? (
          <Note tone="warn">
            <p className="font-medium">A lost device stays signed in to {drive(kind).name}.</p>
            <p className="mt-0.5 text-muted">
              It can’t read anything you sync after the reset, but it could still delete or fill up the OpenStand folder. To cut it off, remove OpenStand from your {drive(kind).signInWith}{' '}
              account after the reset, then sign in again on each of your devices.
            </p>
            <div className="mt-1.5">
              <DisconnectLinks kind={kind} />
            </div>
          </Note>
        ) : (
          <Note tone="warn">
            <p className="font-medium">Reset doesn’t change your storage keys.</p>
            <p className="mt-0.5 text-muted">A lost device or leaked code still has them, so it can delete or fill up your bucket until you revoke them at {storage}.</p>
          </Note>
        )}
        {kind ? null : config ? (
          <SwitchRow label="Also switch to new storage keys" hint="Recommended when a device or code may be in someone else’s hands." checked={rotate} onChange={setRotate} disabled={busy} />
        ) : loading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted" />
        ) : null}
        {rotate && f && !kind && (
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
  // Back from a drive sign-in: taken once, before the first render, so the right screen opens at once.
  const [ret] = useState(() => takeSignInReturn())
  const [modal, setModal] = useState<Modal>(() => initialModal(ret))
  const [busy, setBusy] = useState<null | 'sync' | 'repair' | 'leave' | 'pause'>(null)
  const [reauthing, setReauthing] = useState(ret?.intent.type === 'reauth')
  const [signInIssue, setSignInIssue] = useState<{ kind: OAuthKind; problem: SignInProblem } | null>(null)
  const [desc, setDesc] = useState<BackendDescription>()
  const kind = isDrive(s.backendKind) ? s.backendKind : undefined
  const quota = s.error?.code === 'quota'
  const { config, backend } = useStorageConfig(quota || !!kind)
  const close = () => setModal(null)

  // Other devices' names and "last seen" can be hours old in the cached list: re-read it when the page opens.
  const configured = s.configured
  useEffect(() => {
    if (configured) refreshDevices()
  }, [configured])

  // "Sign in again" came back: the engine restarts with the new tokens; say so, or why it didn't work.
  useEffect(() => {
    if (ret?.intent.type !== 'reauth') return
    let live = true
    void ret.done.then(async (out) => {
      if (!live) return
      ackSignInReturn(ret)
      setReauthing(false)
      if (out.ok) {
        setSignInIssue(null)
        toast(`Signed in to ${drive(ret.kind).name} again`, 'ok')
      } else {
        const want = accountOf((await currentPayload())?.b)
        if (live) setSignInIssue({ kind: ret.kind, problem: signInProblem(out.error, ret.kind, { want }) })
      }
    })
    return () => {
      live = false
    }
  }, [ret])

  // Drives: where the folder is and free space (needs this device's sign-in; skipped while signed out).
  const signedOut = s.error?.code === 'reauth'
  useEffect(() => {
    if (!backend || !isDrive(backend.kind) || signedOut) return
    let live = true
    describeBackend(backend)
      .then((d) => live && setDesc(d))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [backend, signedOut])

  /** Leave for the provider's sign-in (never returns when it works). */
  const reSignIn = async (chooseAccount?: boolean) => {
    const k = kind ?? signInIssue?.kind
    if (!k) return
    try {
      await signInAgain(k, chooseAccount)
    } catch (e) {
      setSignInIssue({ kind: k, problem: signInProblem(e, k) })
    }
  }

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
          {kind && <DriveLeaveNote kind={kind} />}
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
    else if (a === 'signIn' || a === 'chooseAccount') void reSignIn(a === 'chooseAccount')
  }

  const dialogs = (
    <>
      {modal?.kind === 'wizard' && <SetupWizard open onClose={close} resume={modal.resume} storage={modal.storage} />}
      {modal?.kind === 'join' && <JoinFlow open onClose={close} rejoin={modal.rejoin} reason={modal.reason} resume={modal.resume} code={modal.code} />}
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
            <p className="text-sm text-muted">
              {kind
                ? `The new device gets the whole library, and signs in to ${drive(kind).name} itself with the same account. It can be a phone, tablet or computer with OpenStand open in a browser.`
                : 'The new device gets the whole library and the storage keys. It can be a phone, tablet or computer with OpenStand open in a browser.'}
            </p>
            <PairingQr />
          </div>
        </Dialog>
      )}
    </>
  )

  // Dialogs stay at the same tree position whether sync is on or off, so the wizard and join flow
  // survive the switch to "on" that they cause.
  const signInNotes = (
    <>
      {reauthing && ret && (
        <Note>
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Finishing sign-in with {drive(ret.kind).signInWith}…
          </span>
        </Note>
      )}
      {signInIssue && (
        <SignInProblemNote problem={signInIssue.problem} onRetry={() => void reSignIn()} onChooseAccount={() => void reSignIn(true)} />
      )}
    </>
  )

  if (!s.configured)
    return (
      <>
        {/* One element before the dialogs, as when sync is on: the wizard must not remount when sync starts. */}
        <div>
          {(reauthing || signInIssue) && <div className="mb-4 grid gap-3">{signInNotes}</div>}
          <OffView open={setModal} />
        </div>
        {dialogs}
      </>
    )

  const paused = s.phase === 'paused'
  const c = controls(s)
  return (
    <>
      <div className="grid gap-8">
        <div className="grid gap-3">
          {signInNotes}
          {!signInIssue && !reauthing && (
            <ErrorBanner
              s={s}
              onAction={onAction}
              providerConsole={kind ? (desc?.openUrl ?? DRIVE_HOME[kind]) : config ? preset(config.provider).console : undefined}
              want={accountOf(backend)}
            />
          )}
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
        </div>

        <Block title="Devices" icon={<MonitorSmartphone className="size-4" />} description="Every device keeps a full copy of the library.">
          <Devices s={s} onRename={c.rename ? () => setModal({ kind: 'rename' }) : undefined} />
        </Block>

        <Block title="Storage" icon={<HardDrive className="size-4" />}>
          {kind ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line px-4 py-2.5">
              <span className="min-w-0 flex-1 basis-48 text-sm">
                <span className="block break-words font-medium">{s.backendLabel ?? drive(kind).name}</span>
                <span className="block text-xs text-muted">
                  {desc?.location ?? drive(kind).location}
                  {desc?.freeBytes !== undefined ? ` · ${fmtBytes(desc.freeBytes)} free` : ''}
                </span>
              </span>
              {desc?.openUrl && (
                <a
                  href={desc.openUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium hover:bg-surface-2"
                >
                  <FolderOpen className="size-4" /> Open folder
                </a>
              )}
              {c.storageKeys && (
                <Button size="sm" variant="ghost" icon={<LogIn className="size-4" />} onClick={() => void reSignIn()}>
                  Sign in again
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-2.5">
              <span className="min-w-0 flex-1 basis-48 break-words text-sm">{s.backendLabel ?? 'Your storage'}</span>
              {c.storageKeys && (
                <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setModal({ kind: 'keys' })}>
                  Update storage keys
                </Button>
              )}
            </div>
          )}
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
          {(c.reset || c.deleteRemote) && (
            <div className="mt-2 grid gap-2 rounded-xl border border-danger/30 p-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-danger">Danger zone</h4>
              <div className="flex flex-wrap gap-2">
                {c.reset && (
                  <Button size="sm" variant="ghost" className="!text-danger" onClick={() => setModal({ kind: 'confirm', what: 'reset' })}>
                    Reset sync…
                  </Button>
                )}
                {c.deleteRemote && (
                  <Button size="sm" variant="ghost" className="!text-danger" onClick={() => setModal({ kind: 'confirm', what: 'delete' })}>
                    Delete synced data from storage…
                  </Button>
                )}
              </div>
            </div>
          )}
        </Block>
      </div>
      {dialogs}
    </>
  )
}
