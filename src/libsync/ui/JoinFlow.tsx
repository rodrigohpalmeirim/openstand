/** "Join from another device" (§10.3, §12.2): scan or paste → preview → mode → progress. */
import { Check, Library, Loader2, Merge, ShieldAlert } from 'lucide-react'
import { useEffect, useReducer, useRef, type ReactNode } from 'react'
import { useLibSync } from '../api'
import type { JoinMode } from '../model'
import { useLibraries } from '../../library/browse/libraries'
import { Button, Dialog, cx } from '../../ui/primitives'
import { joinSync, leaveSync, parsePairingCode, previewJoin } from './client'
import { active, downloadLine } from './format'
import { initialJoin, joinErrorText, joinReducer, joinTarget, mergeLine, previewLine, type JoinTarget } from './joinState'
import { PairScanner } from './PairScanner'
import { Bar, Note } from './parts'

function ModeOption({ value, current, onPick, icon, title, children }: { value: JoinMode; current: JoinMode; onPick: (m: JoinMode) => void; icon: ReactNode; title: ReactNode; children: ReactNode }) {
  const on = value === current
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 transition', on ? 'border-accent bg-accent-soft/40' : 'border-line hover:bg-surface-2')}>
      <input type="radio" name="libsync-join-mode" value={value} checked={on} onChange={() => onPick(value)} className="mt-1 size-4 shrink-0 accent-[var(--os-accent)]" />
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 text-sm">
        <span className="block font-medium">{title}</span>
        <span className="block text-muted">{children}</span>
      </span>
    </label>
  )
}

/** Where the code points: shown before joining so a code from someone else's storage stands out. */
function TargetBox({ t }: { t: JoinTarget }) {
  const row = (label: string, value: string) => (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all font-medium">{value}</dd>
    </>
  )
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-xl border border-line px-4 py-3 text-sm" aria-label="Where this code syncs to">
      {row('Storage', t.storage)}
      {t.bucket && row('Bucket', t.bucket)}
      {row('Instant updates', t.relay ?? 'Off (checks every few minutes)')}
    </dl>
  )
}

/**
 * `rejoin`: this device's sync is broken (`rejoin`, `corrupt`, `wrongSecret`); joining first stops the old
 * sync, and merging into this library is preselected so unsynced local edits aren't stranded.
 */
export function JoinFlow({ open, onClose, rejoin }: { open: boolean; onClose: () => void; rejoin?: boolean }) {
  const [s, dispatch] = useReducer(joinReducer, undefined, initialJoin)
  const initial = useLibSync((st) => st.initial)
  const download = useLibSync((st) => st.download)
  const libName = useLibraries((l) => l.list.find((x) => x.id === l.active)?.name ?? 'My Library')
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (open && s.step !== 'scan') heading.current?.focus()
  }, [s.step, open])

  const onCode = async (text: string) => {
    dispatch({ type: 'code' })
    try {
      const payload = await parsePairingCode(text)
      dispatch({ type: 'parsed', payload })
      const preview = await previewJoin(payload)
      if (!alive.current) return
      dispatch({ type: 'previewed', preview })
      if (rejoin) dispatch({ type: 'mode', mode: 'merge' })
    } catch (e) {
      if (alive.current) dispatch({ type: 'failed', error: joinErrorText(e) })
    }
  }

  const join = async () => {
    if (!s.payload) return
    dispatch({ type: 'join' })
    try {
      if (rejoin && useLibSync.getState().configured) await leaveSync()
      // Keeps running if the dialog is closed; the sidebar indicator shows the progress.
      await joinSync(s.payload, s.mode)
      if (alive.current) dispatch({ type: 'joined' })
    } catch (e) {
      if (alive.current) dispatch({ type: 'failed', error: joinErrorText(e) })
    }
  }

  const name = s.payload?.n
  const lines = s.preview && previewLine(s.preview, name)
  const simple = s.preview?.suggested === 'here' && !rejoin
  const target = s.payload && joinTarget(s.payload)

  const footer =
    s.step === 'preview' ? (
      <>
        <Button variant="ghost" onClick={() => dispatch({ type: 'back' })}>
          Back
        </Button>
        <Button variant="primary" onClick={join}>
          {s.mode === 'merge' ? 'Join and merge' : 'Join'}
        </Button>
      </>
    ) : s.step === 'joining' ? (
      <Button variant="ghost" onClick={onClose}>
        Continue in the background
      </Button>
    ) : s.step === 'done' ? (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    ) : (
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    )

  return (
    <Dialog open={open} onClose={onClose} title={rejoin ? 'Rejoin the synced library' : 'Join a synced library'} footer={footer}>
      <div className="grid gap-5 px-5 py-4">
        {(s.step === 'scan' || s.step === 'checking') && (
          <>
            <p className="text-sm text-muted">
              On a device that already syncs, open <b className="text-fg">Settings → Library sync → Add a device</b> and show the pairing code.
            </p>
            {s.error && <Note tone="danger">{s.error}</Note>}
            {s.step === 'checking' ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status">
                <Loader2 className="size-5 animate-spin" /> Checking the code…
              </div>
            ) : (
              <PairScanner onCode={onCode} />
            )}
          </>
        )}

        {s.step === 'preview' && s.preview && lines && (
          <>
            <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
              {name ? `Join “${name}”` : 'Join the synced library'}
            </h3>
            <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
              <div className="font-medium">{lines.remote}</div>
              <div className="text-muted">{lines.local}</div>
            </div>
            {target && <TargetBox t={target} />}
            {target?.insecure && (
              <Note tone="danger">
                <p className="font-medium">This storage uses an unencrypted http:// address.</p>
                <p className="mt-0.5 text-muted">
                  Anyone on the network between you and {target.storage} can watch and tamper with sync traffic. Your files stay encrypted, but only continue if this is storage on your own network.
                </p>
              </Note>
            )}
            {s.error && <Note tone="danger">{s.error}</Note>}
            {simple ? (
              <p className="text-sm text-muted">
                {s.preview.localSongs
                  ? 'The synced library will be loaded here. The demo songs on this device will be removed.'
                  : 'The synced library will be loaded here.'}
              </p>
            ) : (
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">How to join</legend>
                <ModeOption
                  value="newLibrary"
                  current={s.mode}
                  onPick={(mode) => dispatch({ type: 'mode', mode })}
                  icon={<Library className="size-5" />}
                  title={
                    <>
                      As a new library <span className="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Recommended</span>
                    </>
                  }
                >
                  Your songs here stay in “{libName}”. The synced library becomes a separate library you can switch to.
                </ModeOption>
                <ModeOption value="merge" current={s.mode} onPick={(mode) => dispatch({ type: 'mode', mode })} icon={<Merge className="size-5" />} title={`Merge with “${libName}”`}>
                  {mergeLine(s.preview)}
                </ModeOption>
              </fieldset>
            )}
            {s.mode === 'merge' ? (
              <Note tone="danger">
                <p className="font-medium">Only join codes from your own devices.</p>
                <p className="mt-0.5">
                  Merging uploads every song, file and annotation in “{libName}” to the storage in this code. Whoever controls that storage and code can read all of it.
                </p>
              </Note>
            ) : (
              <p className="flex items-start gap-2 text-sm text-muted">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
                <span>Only join codes from your own devices. Joining sends your library to the storage in this code.</span>
              </p>
            )}
          </>
        )}

        {s.step === 'joining' && (
          <>
            <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
              Joining{name ? ` “${name}”` : ''}…
            </h3>
            <Bar
              value={initial?.total ? initial.done / initial.total : undefined}
              label={initial ? `${initial.step} · ${initial.done.toLocaleString()} of ${initial.total.toLocaleString()}` : 'Checking the synced library…'}
            />
            <p className="text-sm text-muted">You can close this window. Joining continues in the background, and the cloud icon in the sidebar shows how far it got.</p>
          </>
        )}

        {s.step === 'done' && (
          <>
            <h3 ref={heading} tabIndex={-1} className="flex items-center gap-2 text-base font-semibold outline-none">
              <Check className="size-5 text-ok" /> You’re in
            </h3>
            <p className="text-sm text-muted">
              {active(download) ? downloadLine(download) : 'Songs and files arrive in the background. You can keep using OpenStand.'}
            </p>
          </>
        )}
      </div>
    </Dialog>
  )
}
