/**
 * "Join from another device": scan or paste → preview → mode → progress. A cloud-drive code
 * signs in first: scan → sign in (redirect and back) → preview → mode → progress.
 */
import { Check, Library, Loader2, Merge, ShieldAlert } from 'lucide-react'
import { useEffect, useReducer, useRef, type ReactNode } from 'react'
import { LibSyncFailure, useLibSync, type OAuthKind } from '../api'
import type { JoinMode, PairingPayload } from '../model'
import { useLibraries } from '../../library/browse/libraries'
import { Button, Dialog, cx } from '../../ui/primitives'
import { joinSync, leaveSync, parsePairingCode, previewJoin, startSignIn } from './client'
import { DesktopAppNote, SignInButton, SignInProblemNote } from './DriveSignIn'
import { active, downloadLine, initialLine } from './format'
import { initialJoin, joinErrorText, joinReducer, joinTarget, mergeLine, previewLine, type JoinState, type JoinTarget } from './joinState'
import { PairScanner } from './PairScanner'
import { Bar, Note } from './parts'
import { accountLabel, ackSignInReturn, codeIn, drive, isDrive, joinWrongAccountText, saveJoinUi, signInProblem, type SignInReturn } from './signin'

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
      {t.account && row('Account', t.account)}
      {t.bucket && row('Bucket', t.bucket)}
      {row('Instant updates', t.relay ?? 'This site’s relay, if it has one')}
    </dl>
  )
}

const driveOf = (p?: PairingPayload): { kind: OAuthKind; account?: string } | undefined =>
  p && isDrive(p.b.kind) ? { kind: p.b.kind, account: (p.b as { account?: string }).account } : undefined

/** The sign-in step for a cloud-drive code, before and after the redirect. */
function DriveJoinStep({
  s,
  onSignIn,
  onContinueAnyway,
  onScanAnother,
}: {
  s: JoinState
  onSignIn: (chooseAccount?: boolean) => void
  onContinueAnyway: () => void
  onScanAnother: () => void
}) {
  const d = driveOf(s.payload)
  if (!d) return null
  const p = drive(d.kind)
  const got = accountLabel(s.account)
  const signedIn = !!s.account && !s.signInError
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        This library is stored in <b>{p.name}</b>
        {d.account ? <> ({d.account})</> : null}.
      </p>
      {s.mismatch && (
        <Note
          tone="warn"
          action={
            <>
              <Button size="sm" variant="primary" onClick={() => onSignIn(true)}>
                Sign in with another account
              </Button>
              <Button size="sm" variant="secondary" onClick={onContinueAnyway}>
                Continue anyway
              </Button>
            </>
          }
        >
          <p className="font-medium">
            This code is for {d.account ?? `another ${p.name} account`}, but you signed in as {got ?? `a different account`}.
          </p>
        </Note>
      )}
      {s.signInError && (
        <SignInProblemNote
          problem={s.signInError}
          onChooseAccount={() => onSignIn(true)}
          extra={
            s.wrongAccount ? (
              <Button size="sm" variant="secondary" onClick={onScanAnother}>
                Scan another code
              </Button>
            ) : undefined
          }
        />
      )}
      {s.error && <Note tone="danger">{s.error}</Note>}
      {signedIn && !s.mismatch ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
          <Check className="size-4 shrink-0 text-ok" />
          <span className="min-w-0 flex-1 break-words">
            Signed in as <b>{got ?? `your ${p.name} account`}</b>
          </span>
        </div>
      ) : !s.mismatch && !s.signInError ? (
        <p className="text-sm">
          Sign in with {p.signInWith} using <b>{d.account ?? 'the same account'}</b>
          {d.account ? ', the account this library is in.' : ' as on your other devices.'} Each device signs in by itself: the code never contains your {p.name} sign-in.
        </p>
      ) : null}
      <DesktopAppNote kind={d.kind} />
    </div>
  )
}

/**
 * `rejoin`: this device's sync is broken (`rejoin`, `corrupt`, `wrongSecret`); joining first stops the old
 * sync, and merging into this library is preselected so unsynced local edits aren't stranded.
 * `reason: 'libraryGone'`: the synced library was reset or deleted elsewhere and this device already
 * stopped syncing (its songs stayed); the user joins again with a new code.
 */
export function JoinFlow({
  open,
  onClose,
  rejoin,
  reason,
  resume,
  code,
}: {
  open: boolean
  onClose: () => void
  rejoin?: boolean
  reason?: 'libraryGone'
  /** A drive sign-in for a join came back from the provider: resume with its code. */
  resume?: SignInReturn
  /** Start with this code, as if pasted (dev mocks). */
  code?: string
}) {
  const [s, dispatch] = useReducer(joinReducer, undefined, () => (resume ? joinReducer(initialJoin(), { type: 'resume' }) : initialJoin()))
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

  const sRef = useRef(s)
  useEffect(() => {
    sRef.current = s
  })

  /** Counts what the join brings; for a drive, with the account this device signed in to. */
  const preview = async (payload: PairingPayload) => {
    try {
      const pv = await previewJoin(payload)
      if (!alive.current) return
      dispatch({ type: 'previewed', preview: pv })
      if (rejoin) dispatch({ type: 'mode', mode: 'merge' })
    } catch (e) {
      if (!alive.current) return
      const d = driveOf(payload)
      const f = e as LibSyncFailure
      if (d && (e instanceof LibSyncFailure || f?.name === 'LibSyncFailure') && (f.code === 'wrongAccount' || f.code === 'reauth' || f.code === 'auth')) {
        const problem =
          f.code === 'wrongAccount'
            ? {
                // The facade's wrong-account sentence; `detail` is the account the code was made for.
                message: /\s/.test(f.message?.trim() ?? '') ? f.message.trim() : joinWrongAccountText(d.kind, accountLabel(sRef.current.account), f.detail ?? d.account),
                action: 'chooseAccount' as const,
              }
            : f.code === 'auth'
              ? { message: `${drive(d.kind).name} refused access to the OpenStand folder.`, action: 'retry' as const }
              : signInProblem(e, d.kind)
        dispatch({ type: 'signInFailed', problem, wrongAccount: f.code === 'wrongAccount' })
      } else dispatch({ type: 'failed', error: joinErrorText(e, payload) })
    }
  }

  const onCode = async (text: string) => {
    dispatch({ type: 'code' })
    try {
      const payload = await parsePairingCode(text)
      if (!alive.current) return
      // A drive code: sign in first; nothing can be read before that.
      if (isDrive(payload.b.kind)) return dispatch({ type: 'needsSignIn', payload, code: codeIn(text) })
      dispatch({ type: 'parsed', payload })
      await preview(payload)
    } catch (e) {
      if (alive.current) dispatch({ type: 'failed', error: joinErrorText(e) })
    }
  }

  // Dev mocks: start with a code.
  const started = useRef(false)
  useEffect(() => {
    if (!code || resume || started.current) return
    started.current = true
    void onCode(code)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the provider: complete the sign-in, then check the account and preview.
  useEffect(() => {
    if (!resume || resume.intent.type !== 'join') return
    let live = true
    const pairing = resume.intent.pairing
    void (async () => {
      const out = await resume.done
      if (!live) return
      ackSignInReturn(resume)
      let payload: PairingPayload
      try {
        payload = await parsePairingCode(pairing)
      } catch (e) {
        if (live) dispatch({ type: 'failed', error: joinErrorText(e) })
        return
      }
      if (!live) return
      if (!out.ok) {
        dispatch({ type: 'needsSignIn', payload, code: pairing })
        const want = driveOf(payload)?.account
        return dispatch({ type: 'signInFailed', problem: signInProblem(out.error, resume.kind, { want }) })
      }
      dispatch({ type: 'signedIn', payload, code: pairing, account: out.result.account })
    })()
    return () => {
      live = false
    }
  }, [resume]) // eslint-disable-line react-hooks/exhaustive-deps

  // Signed in (and the account matches, or the user went on anyway): preview with it.
  const checking = s.step === 'checking' && !!s.account && !!s.payload
  useEffect(() => {
    if (checking && sRef.current.payload) void preview(sRef.current.payload)
  }, [checking]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Leave for the provider's sign-in; the join resumes with the code afterwards. */
  const signIn = async (chooseAccount?: boolean) => {
    const d = driveOf(s.payload)
    if (!d || !s.code) return
    dispatch({ type: 'signInStart' })
    try {
      saveJoinUi({ rejoin, reason })
      await startSignIn(d.kind, { type: 'join', pairing: s.code }, { ...(d.account ? { loginHint: d.account } : {}), ...(chooseAccount ? { chooseAccount: true } : {}) })
    } catch (e) {
      if (alive.current) dispatch({ type: 'signInFailed', problem: signInProblem(e, d.kind) })
    }
  }

  const join = async () => {
    if (!s.payload) return
    dispatch({ type: 'join' })
    try {
      // Keep the sign-in: a drive code's join needs the tokens this device just stored.
      if (rejoin && useLibSync.getState().configured) await leaveSync(driveOf(s.payload) ? { keepSignIn: true } : undefined)
      // Keeps running if the dialog is closed; the sidebar indicator shows the progress.
      await joinSync(s.payload, s.mode)
      if (alive.current) dispatch({ type: 'joined' })
    } catch (e) {
      if (alive.current) dispatch({ type: 'failed', error: joinErrorText(e, s.payload) })
    }
  }

  const close = () => {
    ackSignInReturn(resume)
    onClose()
  }

  const name = s.payload?.n
  const lines = s.preview && previewLine(s.preview, name)
  const simple = s.preview?.suggested === 'here' && !rejoin
  // What `preview` preselects: merging when rejoining (unsynced local edits stay in this library), else a new library.
  const recommended: JoinMode = rejoin ? 'merge' : 'newLibrary'
  const recommendedBadge = <span className="ml-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Recommended</span>
  const target = s.payload && joinTarget(s.payload)

  const signInKind = driveOf(s.payload)?.kind
  const footer =
    s.step === 'signin' ? (
      <>
        <Button variant="ghost" onClick={() => dispatch({ type: 'back' })} disabled={s.signingIn}>
          Back
        </Button>
        {s.mismatch ? null : s.account && !s.signInError ? (
          <Button variant="primary" className="h-11" onClick={() => dispatch({ type: 'check' })}>
            Continue
          </Button>
        ) : signInKind && !s.wrongAccount ? (
          <SignInButton kind={signInKind} busy={s.signingIn} onClick={() => void signIn()} />
        ) : null}
      </>
    ) : s.step === 'preview' ? (
      <>
        <Button variant="ghost" onClick={() => dispatch({ type: 'back' })}>
          Back
        </Button>
        <Button variant="primary" onClick={join}>
          {s.mode === 'merge' ? 'Join and merge' : 'Join'}
        </Button>
      </>
    ) : s.step === 'joining' ? (
      <Button variant="ghost" onClick={close}>
        Continue in the background
      </Button>
    ) : s.step === 'done' ? (
      <Button variant="primary" onClick={close}>
        Done
      </Button>
    ) : (
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
    )

  return (
    <Dialog open={open} onClose={close} title={reason === 'libraryGone' ? 'Join with a new code' : rejoin ? 'Rejoin the synced library' : 'Join a synced library'} footer={footer}>
      <div className="grid gap-5 px-5 py-4">
        {(s.step === 'scan' || s.step === 'checking') && (
          <>
            {reason === 'libraryGone' && (
              <Note tone="info">
                <p className="font-medium">This device stopped syncing. Your songs are still here.</p>
                <p className="mt-0.5 text-muted">The synced library was reset or deleted from another device. Get a new pairing code from a device that’s still syncing to join again.</p>
              </Note>
            )}
            <p className="text-sm text-muted">
              On a device that already syncs, open <b className="text-fg">Settings → Library sync → Add a device</b> and show the pairing code.
            </p>
            {s.error && <Note tone="danger">{s.error}</Note>}
            {s.step === 'checking' ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status">
                <Loader2 className="size-5 animate-spin" />{' '}
                {resume && !s.payload ? 'Finishing sign-in…' : s.account ? 'Checking the synced library…' : 'Checking the code…'}
              </div>
            ) : (
              <PairScanner onCode={onCode} />
            )}
          </>
        )}

        {s.step === 'signin' && (
          <>
            <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
              {name ? `Join “${name}”` : 'Join the synced library'}
            </h3>
            <DriveJoinStep
              s={s}
              onSignIn={(choose) => void signIn(choose)}
              onContinueAnyway={() => dispatch({ type: 'continueAnyway' })}
              onScanAnother={() => dispatch({ type: 'back' })}
            />
            {target && <TargetBox t={target} />}
          </>
        )}

        {s.step === 'preview' && s.preview && lines && (
          <>
            <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
              {name ? `Join “${name}”` : 'Join the synced library'}
            </h3>
            {s.account && (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Check className="size-4 shrink-0 text-ok" /> Signed in to {driveOf(s.payload) ? drive(driveOf(s.payload)!.kind).name : 'your drive'} as{' '}
                <b className="min-w-0 break-all text-fg">{accountLabel(s.account) ?? 'your account'}</b>
              </p>
            )}
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
                {s.preview.demoSongs
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
                  title={<>As a new library{recommended === 'newLibrary' && recommendedBadge}</>}
                >
                  Your songs here stay in “{libName}”. The synced library becomes a separate library you can switch to.
                </ModeOption>
                <ModeOption
                  value="merge"
                  current={s.mode}
                  onPick={(mode) => dispatch({ type: 'mode', mode })}
                  icon={<Merge className="size-5" />}
                  title={
                    <>
                      Merge with “{libName}”{recommended === 'merge' && recommendedBadge}
                    </>
                  }
                >
                  {mergeLine(s.preview)}
                  {s.preview.demoSongs ? ' The demo songs here will be removed.' : ''}
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
                <span>
                  Only join codes from your own devices.{' '}
                  {s.mode === 'newLibrary'
                    ? `Your songs in “${libName}” stay on this device; what you add to the new library goes to the storage in this code.`
                    : 'What you add to this library from now on goes to the storage in this code.'}
                </span>
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
              value={initial && initial.total > 1 ? initial.done / initial.total : undefined}
              label={initial ? initialLine(initial) : 'Checking the synced library…'}
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
