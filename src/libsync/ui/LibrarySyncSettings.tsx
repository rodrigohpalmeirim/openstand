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
  QrCode,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Tablet,
  TriangleAlert,
  WifiOff,
} from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useLibSync, type LibSyncStatus } from '../api'
import type { S3Config } from '../backends/types'
import { useLibraries } from '../../library/browse/libraries'
import { useNav } from '../../state/nav'
import { Button, Dialog, Input, confirmDialog, cx, toast } from '../../ui/primitives'
import { checkBackend, currentPayload, deleteRemoteData, enableSync, leaveSync, repair, setPaused, syncNow, updateBackend } from './client'
import { active, downloadLine, errorText, fraction, phaseLine, plural, timeAgo, uploadLine, type ErrorAction } from './format'
import { JoinFlow } from './JoinFlow'
import { PairingQr } from './PairingQr'
import { Bar, Block, Note, SwitchRow } from './parts'
import { CheckList, CorsHelp, S3Fields, SetupWizard } from './SetupWizard'
import { checkFailureText, formFromConfig, needsCors, preset, toConfig, validateForm, type S3Form } from './wizard'

type Modal =
  | { kind: 'wizard' }
  | { kind: 'join'; rejoin?: boolean }
  | { kind: 'pair' }
  | { kind: 'keys' }
  | { kind: 'cors' }
  | { kind: 'confirm'; what: 'delete' | 'reset' }
  | null

const fail = (e: unknown) => toast((e as Error)?.message || 'Something went wrong', 'error')

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

function ErrorBanner({ s, onAction, providerConsole }: { s: LibSyncStatus; onAction: (a: ErrorAction) => void; providerConsole?: string }) {
  if (!s.error || s.error.code === 'network') return null
  const t = errorText(s.error)
  const action =
    t.action === 'openProvider' ? (
      providerConsole ? (
        <a href={providerConsole} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
          {t.actionLabel} <ExternalLink className="size-3.5" />
        </a>
      ) : null
    ) : t.action ? (
      <Button size="sm" variant={t.warning ? 'secondary' : 'primary'} onClick={() => onAction(t.action!)}>
        {t.actionLabel}
      </Button>
    ) : null
  return (
    <Note tone={t.warning ? 'warn' : 'danger'} action={action}>
      <p className="font-medium">{t.message}</p>
      {s.error.detail && !/^\d+$/.test(s.error.detail) && <p className="mt-0.5 text-xs text-muted">{s.error.detail}</p>}
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
  const dot = s.phase === 'idle' ? 'bg-ok' : s.phase === 'error' ? 'bg-danger' : s.phase === 'offline' || s.phase === 'paused' ? 'bg-faint' : 'bg-warn animate-pulse'
  const missing = s.offlineReady.total - s.offlineReady.have
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
            {s.relay === 'open' && (s.phase === 'idle' || s.phase === 'syncing') ? `${s.pendingChanges > 0 || s.phase === 'idle' ? ' · ' : ''}Instant updates on` : ''}
          </div>
        </div>
      </div>
      {s.initial && (
        <Bar value={s.initial.total ? s.initial.done / s.initial.total : undefined} label={`${s.initial.step} · ${s.initial.done.toLocaleString()} of ${s.initial.total.toLocaleString()}`} />
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

function Devices({ s }: { s: LibSyncStatus }) {
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
              {d.retired ? 'Stopped syncing' : d.self ? 'Syncing now' : `Last seen ${timeAgo(d.lastSeenAt)}`}
              {d.platform ? ` · ${d.platform}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------ Dialogs */

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

/** Delete / reset: confirmed by typing the library name (§10.5). */
function TypeToConfirm({ what, s, onClose }: { what: 'delete' | 'reset'; s: LibSyncStatus; onClose: () => void }) {
  const name = useLibraries((l) => l.list.find((x) => x.id === l.active)?.name ?? 'My Library')
  const { config, relay } = useStorageConfig(what === 'reset')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  const okName = typed.trim().toLowerCase() === name.trim().toLowerCase()
  const run = async () => {
    if (!okName || busy) return
    setBusy(true)
    try {
      if (what === 'reset') {
        if (!config) throw new Error('Couldn’t read the storage settings. Try again.')
        await deleteRemoteData()
        await enableSync({ backend: config, relay })
        toast('Sync was reset. Pair your other devices again.', 'ok')
      } else {
        await deleteRemoteData()
        toast('Synced data deleted from storage', 'ok')
      }
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
      title={what === 'delete' ? 'Delete synced data from storage?' : 'Reset sync?'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={!okName || busy || (what === 'reset' && !config)}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {what === 'delete' ? 'Delete synced data' : 'Reset sync'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4 text-sm">
        {what === 'delete' ? (
          <p className="text-muted">
            This deletes the synced copy of “{name}” from {s.backendLabel ?? 'your storage'}, for every device. Each device keeps its own copy of the library but stops syncing.
          </p>
        ) : (
          <p className="text-muted">
            Use this after losing a device or sharing the pairing code by mistake. The synced data is deleted, new keys are created and this library is uploaded again. Every other device has to pair again with the new code.
          </p>
        )}
        <label htmlFor={id} className="text-muted">
          Type <b className="text-fg">{name}</b> to confirm.
        </label>
        <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} autoFocus autoComplete="off" />
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

  const onAction = (a: ErrorAction) => {
    if (a === 'updateKeys') setModal({ kind: 'keys' })
    else if (a === 'showCors') setModal({ kind: 'cors' })
    else if (a === 'storageSettings') useNav.getState().go({ name: 'settings', page: 'storage' })
    else if (a === 'retry') void run('sync', syncNow)()
    else if (a === 'joinAgain' || a === 'rejoin') setModal({ kind: 'join', rejoin: true })
    else if (a === 'stopSyncing') void leave()
    else if (a === 'reload') location.reload()
  }

  const dialogs = (
    <>
      {modal?.kind === 'wizard' && <SetupWizard open onClose={close} />}
      {modal?.kind === 'join' && <JoinFlow open onClose={close} rejoin={modal.rejoin} />}
      {modal?.kind === 'keys' && <KeysDialog onClose={close} />}
      {modal?.kind === 'cors' && <CorsDialog onClose={close} />}
      {modal?.kind === 'confirm' && <TypeToConfirm what={modal.what} s={s} onClose={close} />}
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
  return (
    <>
      <div className="grid gap-8">
        <div className="grid gap-3">
          <ErrorBanner s={s} onAction={onAction} providerConsole={config ? preset(config.provider).console : undefined} />
          <StatusCard s={s} />
          <div className="flex flex-wrap gap-2">
            <Button
              icon={busy === 'sync' || s.phase === 'syncing' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              onClick={run('sync', syncNow)}
              disabled={!!busy || paused || s.phase === 'starting'}
            >
              Sync now
            </Button>
            <Button variant="primary" icon={<QrCode className="size-4" />} onClick={() => setModal({ kind: 'pair' })}>
              Add a device
            </Button>
          </div>
        </div>

        <Block title="Devices" icon={<MonitorSmartphone className="size-4" />} description="Every device keeps a full copy of the library.">
          <Devices s={s} />
        </Block>

        <Block title="Storage" icon={<HardDrive className="size-4" />}>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-2.5">
            <span className="min-w-0 flex-1 basis-48 break-words text-sm">{s.backendLabel ?? 'Your storage'}</span>
            <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setModal({ kind: 'keys' })}>
              Update storage keys
            </Button>
          </div>
          <SwitchRow
            label="Pause sync"
            hint="Stops uploading and downloading on this device until you turn it back on."
            checked={paused}
            disabled={busy === 'pause'}
            onChange={(v) => void run('pause', () => setPaused(v))()}
          />
        </Block>

        <Block title="Troubleshooting" icon={<ShieldAlert className="size-4" />}>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button size="sm" onClick={run('repair', repair, 'Files checked')} disabled={!!busy}>
                {busy === 'repair' && <Loader2 className="size-4 animate-spin" />}
                Re-check files
              </Button>
              <span className="text-xs text-muted">Uploads any file the storage is missing.</span>
            </div>
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
              <Button size="sm" variant="ghost" className="!text-danger" onClick={() => setModal({ kind: 'confirm', what: 'delete' })}>
                Delete synced data from storage…
              </Button>
            </div>
          </div>
        </Block>
      </div>
      {dialogs}
    </>
  )
}
