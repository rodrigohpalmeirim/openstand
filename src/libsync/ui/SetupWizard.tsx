/**
 * "Set up sync": storage → S3 form → connection test → start → pairing code. Cloud drives:
 * storage → sign in (redirect to the provider and back) → connection test → start → pairing code.
 */
import { Check, CircleAlert, CircleDashed, Cloud, ExternalLink, Eye, EyeOff, HardDrive, Loader2 } from 'lucide-react'
import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { corsRule, useLibSync, type OAuthKind } from '../api'
import type { BackendCheck, S3Config } from '../backends/types'
import { Button, Dialog, Input, Toggle, cx } from '../../ui/primitives'
import { checkBackend, describeBackend, discardSignIn, driveBackendConfig, enableSync, oauthProviders, startSignIn } from './client'
import { DesktopAppNote, DriveAccountCard, DriveSignInPanel, SignInButton } from './DriveSignIn'
import { failureText, initialLine } from './format'
import { PairingQr } from './PairingQr'
import { Bar, CopyBox, Note } from './parts'
import { ackSignInReturn, drive, signInProblem, type SignInReturn } from './signin'
import {
  OPTIONAL_STEPS,
  PROVIDERS,
  checkFailureText,
  checkLabel,
  initialWizard,
  needsCors,
  preset,
  toConfig,
  validateForm,
  visibleSteps,
  wizardReducer,
  type FormErrors,
  type S3Form,
  type StorageChoice,
} from './wizard'

/* --------------------------------------------------------------- Pieces */

function TextField({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string
  children: (p: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode
}) {
  const id = useId()
  const desc = `${id}-d`
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error || hint ? desc : undefined })}
      {(error || hint) && (
        <span id={desc} className={cx('text-xs', error ? 'text-danger' : 'text-faint')}>
          {error ?? hint}
        </span>
      )}
    </div>
  )
}

const plain = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const

/** Provider chips (a radio group, arrow keys move). */
export function ProviderChips({ value, onChange }: { value: S3Form['provider']; onChange: (p: S3Form['provider']) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  return (
    <div role="radiogroup" aria-label="Storage provider" className="flex flex-wrap gap-2">
      {PROVIDERS.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          tabIndex={value === p.id ? 0 : -1}
          onClick={() => onChange(p.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
            if (!d) return
            e.preventDefault()
            const j = (i + d + PROVIDERS.length) % PROVIDERS.length
            onChange(PROVIDERS[j].id)
            refs.current[j]?.focus()
          }}
          className={cx(
            'flex h-11 min-w-16 items-center justify-center gap-1.5 rounded-full border px-4 text-sm font-medium transition',
            value === p.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-fg hover:bg-surface-2',
          )}
        >
          {value === p.id && <Check className="size-4" />}
          {p.label}
        </button>
      ))}
    </div>
  )
}

/** The S3 connection fields. `keysOnly` locks everything but the access key and secret. */
export function S3Fields({
  form,
  errors,
  onField,
  keysOnly,
}: {
  form: S3Form
  errors: FormErrors
  onField: (field: keyof S3Form, value: string | boolean) => void
  keysOnly?: boolean
}) {
  const p = preset(form.provider)
  const [showSecret, setShowSecret] = useState(false)
  const [advanced, setAdvanced] = useState(form.prefix !== 'openstand/' || (form.provider === 'other' && !form.pathStyle))
  const set = (f: keyof S3Form) => (e: { target: { value: string } }) => onField(f, e.target.value)
  return (
    <div className="grid gap-4">
      {!keysOnly && p.asks.includes('accountId') && (
        <TextField label="Account ID" error={errors.accountId} hint="32 characters, on the R2 overview page of the Cloudflare dashboard.">
          {(a) => <Input {...a} {...plain} value={form.accountId} onChange={set('accountId')} placeholder="0123456789abcdef0123456789abcdef" className="font-mono" />}
        </TextField>
      )}
      {!keysOnly && p.asks.includes('endpoint') && (
        <TextField label="Address (endpoint)" error={errors.endpoint} hint={form.provider === 'minio' ? 'For example http://192.168.1.20:9000' : 'For example https://s3.example.com'}>
          {(a) => <Input {...a} {...plain} inputMode="url" value={form.endpoint} onChange={set('endpoint')} placeholder="https://" />}
        </TextField>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!keysOnly && (
          <TextField label="Bucket" error={errors.bucket}>
            {(a) => <Input {...a} {...plain} value={form.bucket} onChange={set('bucket')} placeholder="my-music" />}
          </TextField>
        )}
        {!keysOnly && p.asks.includes('region') && (
          <TextField label={form.provider === 'minio' || form.provider === 'other' ? 'Region (optional)' : 'Region'} error={errors.region}>
            {(a) => <Input {...a} {...plain} value={form.region} onChange={set('region')} placeholder={p.regionPlaceholder} />}
          </TextField>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Access key ID" error={errors.accessKeyId}>
          {(a) => <Input {...a} {...plain} autoComplete="off" value={form.accessKeyId} onChange={set('accessKeyId')} className="font-mono" />}
        </TextField>
        <TextField label="Secret access key" error={errors.secretAccessKey}>
          {(a) => (
            <div className="relative">
              <Input
                {...a}
                {...plain}
                type={showSecret ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.secretAccessKey}
                onChange={set('secretAccessKey')}
                className="pr-11 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                aria-pressed={showSecret}
                className="absolute right-0.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:text-fg"
              >
                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          )}
        </TextField>
      </div>
      {!keysOnly &&
        (advanced ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Folder in the bucket" error={errors.prefix} hint="Several libraries can share a bucket.">
              {(a) => <Input {...a} {...plain} value={form.prefix} onChange={set('prefix')} placeholder="openstand/" />}
            </TextField>
            {form.provider === 'other' && (
              <label className="flex min-h-11 items-center justify-between gap-4 self-end text-sm">
                <span>
                  Path-style addresses
                  <span className="block text-xs text-muted">address/bucket/file. Turn off for bucket.address/file.</span>
                </span>
                <Toggle checked={form.pathStyle} onChange={(v) => onField('pathStyle', v)} label="Path-style addresses" />
              </label>
            )}
          </div>
        ) : (
          <button type="button" className="justify-self-start rounded text-sm font-medium text-accent hover:underline" onClick={() => setAdvanced(true)}>
            More options
          </button>
        ))}
    </div>
  )
}

/** The CORS rule to paste and where it goes. */
export function CorsHelp({ config }: { config: S3Config }) {
  const p = preset(config.provider)
  return (
    <div className="grid gap-2">
      <p className="text-sm">{p.corsWhere}</p>
      <CopyBox text={corsRule(config)} label="CORS rule" />
      {p.docs && config.provider === 'aws' && (
        <a className="inline-flex items-center gap-1 justify-self-start text-sm text-accent hover:underline" href={p.docs.url} target="_blank" rel="noreferrer">
          {p.docs.label} <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  )
}

/** The connection-test checklist (a drive hides the S3-only steps and names its own). */
export function CheckList({ check, checking, storage = 's3' }: { check?: BackendCheck; checking: boolean; storage?: StorageChoice }) {
  const steps = visibleSteps(check, storage)
  return (
    <ul className="grid gap-1.5" aria-live="polite" aria-busy={checking}>
      {steps.map((s) => (
        <li key={s.id} className="flex items-center gap-2.5 text-sm">
          {s.ok ? (
            <Check className="size-4 shrink-0 text-ok" aria-label="Passed" />
          ) : OPTIONAL_STEPS.includes(s.id) ? (
            <CircleDashed className="size-4 shrink-0 text-faint" aria-label="Not supported" />
          ) : (
            <CircleAlert className="size-4 shrink-0 text-danger" aria-label="Failed" />
          )}
          <span className={cx(!s.ok && !OPTIONAL_STEPS.includes(s.id) && 'font-medium')}>{checkLabel(s.id, storage)}</span>
          {s.detail && !s.ok && <span className="truncate text-xs text-muted">{s.detail}</span>}
        </li>
      ))}
      {checking && (
        <li className="flex items-center gap-2.5 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Testing the connection…
        </li>
      )}
    </ul>
  )
}

/* ------------------------------------------------------------- Storage */

/** One large radio card on the storage step. */
function StorageCard({
  value,
  current,
  onPick,
  refFn,
  onKeyDown,
  icon,
  title,
  children,
}: {
  value: StorageChoice
  current: StorageChoice
  onPick: (v: StorageChoice) => void
  refFn: (el: HTMLButtonElement | null) => void
  onKeyDown: (e: KeyboardEvent) => void
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  const on = value === current
  return (
    <button
      ref={refFn}
      type="button"
      role="radio"
      aria-checked={on}
      tabIndex={on ? 0 : -1}
      onClick={() => onPick(value)}
      onKeyDown={onKeyDown}
      className={cx(
        'flex min-h-14 w-full items-start gap-3 rounded-xl border-2 px-4 py-3 text-left transition',
        on ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface hover:bg-surface-2',
      )}
    >
      <span className={cx('mt-0.5 shrink-0', on ? 'text-accent' : 'text-muted')}>{icon}</span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block font-medium">{title}</span>
        <span className="block text-muted">{children}</span>
      </span>
      <span
        aria-hidden
        className={cx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-accent bg-accent text-accent-fg' : 'border-line')}
      >
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  )
}

/** The order storage choices are offered in; the first one available is preselected. */
const STORAGE_ORDER: StorageChoice[] = ['gdrive', 'onedrive', 'dropbox', 's3']
const storageOptions = (drives: OAuthKind[]) => STORAGE_ORDER.filter((o) => o === 's3' || drives.includes(o))

/** Storage step: the drives `oauthProviders()` offers here, then S3-compatible (a radio group; arrow keys move). */
function StorageCards({ value, drives, onChange }: { value: StorageChoice; drives: OAuthKind[]; onChange: (v: StorageChoice) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const options = storageOptions(drives)
  const keys = (i: number) => (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const j = (i + d + options.length) % options.length
    onChange(options[j])
    refs.current[j]?.focus()
  }
  return (
    <div role="radiogroup" aria-label="Where to keep your library" className="grid gap-2">
      {options.map((o, i) => (
        <StorageCard
          key={o}
          value={o}
          current={value}
          onPick={onChange}
          refFn={(el) => {
            refs.current[i] = el
          }}
          onKeyDown={keys(i)}
          icon={o === 's3' ? <HardDrive className="size-5" /> : <Cloud className="size-5" />}
          title={o === 's3' ? 'S3-compatible storage' : drive(o).name}
        >
          {o === 's3'
            ? 'A bucket you own. OpenStand has no servers of its own, and your files are encrypted before they leave this device.'
            : `Uses your ${drive(o).name} account. OpenStand gets its own folder and can’t see your other files.`}
        </StorageCard>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- Wizard */

const TITLES = {
  storage: 'Where to keep your library',
  form: 'Connect your bucket',
  signin: 'Sign in',
  check: 'Test the connection',
  start: 'Uploading your library',
  pair: 'Add your other devices',
}

/**
 * `resume`: a drive sign-in came back from the provider; the wizard opens at the check step and
 * completes it. `storage`: open at that drive's sign-in step (dev mocks).
 */
export function SetupWizard({ open, onClose, resume, storage }: { open: boolean; onClose: () => void; resume?: SignInReturn; storage?: OAuthKind }) {
  const [s, dispatch] = useReducer(wizardReducer, undefined, () =>
    resume ? wizardReducer(initialWizard(resume.kind), { type: 'resume', kind: resume.kind }) : initialWizard(storage),
  )
  const [drives, setDrives] = useState<OAuthKind[]>([])
  const initial = useLibSync((st) => st.initial)
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(true)
  const p = preset(s.form.provider)
  const errors = s.showErrors ? validateForm(s.form) : {}
  const kind = s.storage === 's3' ? undefined : s.storage
  const cfg = kind ? s.driveConfig : toConfig(s.form)
  const dots = s.storage === 's3' ? (['storage', 'form', 'check', 'pair'] as const) : (['storage', 'signin', 'check', 'pair'] as const)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The drives offered here; S3 is always there, so the step works while this loads. Once they're known,
  // preselect the first choice (Google Drive when offered) unless the user already picked one.
  // (Opened at a specific drive — a sign-in return or a dev mock — counts as already picked.)
  const picked = useRef(!!resume || !!storage)
  useEffect(() => {
    let live = true
    oauthProviders()
      .then((d) => {
        if (!live) return
        setDrives(d)
        if (!picked.current) dispatch({ type: 'storage', storage: storageOptions(d)[0] })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // Move focus to the new step's heading so keyboard and screen-reader users follow along.
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [s.step, open])

  /** Drives: the connection test with the config made after sign-in. */
  const testDrive = async (k: OAuthKind, c = s.driveConfig) => {
    if (!c) return
    dispatch({ type: 'checkStart' })
    try {
      const check = await checkBackend(c)
      if (alive.current) dispatch({ type: 'checkDone', check })
    } catch (e) {
      if (alive.current) dispatch({ type: 'checkFailed', message: failureText(e, 'The test couldn’t run.', k) })
    }
  }

  // Back from the provider: complete the sign-in, make the drive's config, describe it, and test it.
  useEffect(() => {
    if (!resume) return
    let live = true
    const k = resume.kind
    void (async () => {
      const out = await resume.done
      if (!live) return
      ackSignInReturn(resume)
      if (!out.ok) return dispatch({ type: 'signInFailed', problem: signInProblem(out.error, k) })
      try {
        const config = await driveBackendConfig(k)
        if (!live) return
        dispatch({ type: 'signedIn', account: out.result.account, config })
        describeBackend(config)
          .then((description) => live && dispatch({ type: 'described', description }))
          .catch(() => {})
        const check = await checkBackend(config)
        if (live) dispatch({ type: 'checkDone', check })
      } catch (e) {
        if (!live) return
        const f = e as { code?: string }
        if (f?.code === 'reauth' || f?.code === 'wrongAccount') dispatch({ type: 'signInFailed', problem: signInProblem(e, k) })
        else dispatch({ type: 'checkFailed', message: failureText(e, 'The test couldn’t run.', k) })
      }
    })()
    return () => {
      live = false
    }
  }, [resume])

  const test = async () => {
    if (kind) return testDrive(kind)
    if (Object.keys(validateForm(s.form)).length) return dispatch({ type: 'next' })
    dispatch({ type: 'checkStart' })
    try {
      dispatch({ type: 'checkDone', check: await checkBackend(toConfig(s.form)) })
    } catch (e) {
      dispatch({ type: 'checkFailed', message: (e as Error).message || 'The test couldn’t run.' })
    }
  }

  /** Drives: leave for the provider (never returns when it works). */
  const signIn = async (chooseAccount?: boolean) => {
    if (!kind) return
    dispatch({ type: 'signInStart' })
    try {
      await startSignIn(kind, { type: 'setup' }, chooseAccount ? { chooseAccount: true } : undefined)
    } catch (e) {
      if (alive.current) dispatch({ type: 'signInFailed', problem: signInProblem(e, kind) })
    }
  }

  const start = async () => {
    if (!cfg) return
    dispatch({ type: 'startBegin' })
    try {
      // No relay given: the engine picks the same-site relay when there is one.
      await enableSync({ backend: cfg })
      dispatch({ type: 'startDone' })
    } catch (e) {
      dispatch({ type: 'startFailed', message: failureText(e, 'Sync couldn’t start.', kind) })
    }
  }

  const close = () => {
    ackSignInReturn(resume)
    // Cancelled after signing in: forget the tokens (a no-op if the library already syncs through this drive).
    if (kind && (s.account || resume) && s.step !== 'pair' && !s.starting) void discardSignIn(kind).catch(() => {})
    onClose()
  }

  const needsSignIn = !!kind && s.check?.error?.code === 'reauth'

  const footer = (() => {
    const back = (
      <Button variant="ghost" onClick={() => dispatch({ type: 'back' })} disabled={s.checking || s.starting || s.signingIn || s.resuming}>
        Back
      </Button>
    )
    switch (s.step) {
      case 'storage':
        return (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => dispatch({ type: 'next' })}>
              Next
            </Button>
          </>
        )
      case 'form':
        return (
          <>
            {back}
            <Button variant="primary" onClick={test}>
              Test connection
            </Button>
          </>
        )
      case 'signin':
        return (
          <>
            {back}
            {kind && <SignInButton kind={kind} busy={s.signingIn} onClick={() => void signIn()} />}
          </>
        )
      case 'check':
        return (
          <>
            {back}
            {s.check?.ok ? (
              <Button variant="primary" onClick={start}>
                Start syncing
              </Button>
            ) : needsSignIn ? (
              <Button variant="primary" onClick={() => void signIn()}>
                Sign in again
              </Button>
            ) : (
              <Button variant="primary" onClick={test} disabled={s.checking || (!!kind && !s.driveConfig)}>
                {s.checking && <Loader2 className="size-4 animate-spin" />}
                Test again
              </Button>
            )}
          </>
        )
      case 'start':
        return s.failure ? (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button variant="primary" onClick={start}>
              Try again
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled>
            <Loader2 className="size-4 animate-spin" /> Starting…
          </Button>
        )
      case 'pair':
        return (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        )
    }
  })()

  const title = s.step === 'signin' && kind ? `Sign in to ${drive(kind).name}` : s.step === 'check' && kind ? `Connect ${drive(kind).name}` : TITLES[s.step]

  return (
    <Dialog open={open} onClose={close} title="Set up library sync" footer={footer}>
      <div className="grid gap-5 px-5 py-4">
        <div className="flex items-center gap-2" aria-hidden>
          {dots.map((st, i) => (
            <span
              key={st}
              className={cx('h-1 flex-1 rounded-full', i <= (dots as readonly string[]).indexOf(s.step === 'start' ? 'pair' : s.step) ? 'bg-accent' : 'bg-surface-3')}
            />
          ))}
        </div>
        <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
          {title}
        </h3>

        {s.step === 'storage' && (
          <>
            <StorageCards
              value={s.storage}
              drives={drives}
              onChange={(storage) => {
                picked.current = true
                dispatch({ type: 'storage', storage })
              }}
            />
            {s.storage === 's3' ? (
              <div className="grid gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Provider</span>
                <ProviderChips value={s.form.provider} onChange={(provider) => dispatch({ type: 'provider', provider })} />
                <p className="text-sm text-muted">{p.name}</p>
              </div>
            ) : (
              <p className="text-sm text-muted">
                OpenStand has no servers of its own: your library goes straight from this device to {drive(s.storage).name}, encrypted.
              </p>
            )}
          </>
        )}

        {s.step === 'form' && (
          <>
            <Note>
              <p>{p.hint}</p>
              <p className="mt-1">
                Every device you pair uses these keys. Keys limited to this one bucket mean a lost device or a leaked pairing code can’t reach anything else in your account.
              </p>
              {p.docs && (
                <a className="mt-1 inline-flex items-center gap-1 text-accent hover:underline" href={p.docs.url} target="_blank" rel="noreferrer">
                  {p.docs.label} <ExternalLink className="size-3.5" />
                </a>
              )}
            </Note>
            <S3Fields form={s.form} errors={errors} onField={(field, value) => dispatch({ type: 'field', field, value })} />
          </>
        )}

        {s.step === 'signin' && kind && (
          <DriveSignInPanel kind={kind} problem={s.signInError} onChooseAccount={() => void signIn(true)} />
        )}

        {s.step === 'check' && kind && (
          <>
            <DriveAccountCard
              kind={kind}
              account={s.account}
              description={s.description}
              loading={s.resuming}
              onChooseAccount={s.checking || s.resuming ? undefined : () => void signIn(true)}
            />
            {!s.resuming && <CheckList check={s.check} checking={s.checking} storage={kind} />}
            {s.check?.ok && <Note tone="ok">Everything works. Your library will be encrypted on this device and uploaded to {drive(kind).name}.</Note>}
            {s.check && !s.check.ok && <Note tone="danger">{checkFailureText(s.check, kind)}</Note>}
            {s.failure && <Note tone="danger">{s.failure}</Note>}
            {s.check?.ok && <DesktopAppNote kind={kind} />}
          </>
        )}

        {s.step === 'check' && !kind && (
          <>
            <p className="text-sm text-muted">
              {p.name} · {s.form.bucket.trim()}/{toConfig(s.form).prefix}
            </p>
            <CheckList check={s.check} checking={s.checking} />
            {s.check?.ok && <Note tone="ok">Everything works. Your library will be encrypted on this device and uploaded to this bucket.</Note>}
            {s.check && !s.check.ok && <Note tone="danger">{checkFailureText(s.check)}</Note>}
            {s.failure && <Note tone="danger">{s.failure}</Note>}
            {needsCors(s.check) && <CorsHelp config={toConfig(s.form)} />}
          </>
        )}

        {s.step === 'start' && (
          <>
            {s.failure ? (
              <Note tone="danger">{s.failure}</Note>
            ) : (
              <Bar value={initial && initial.total > 1 ? initial.done / initial.total : undefined} label={initial ? initialLine(initial) : 'Creating the synced library…'} />
            )}
          </>
        )}

        {s.step === 'pair' && (
          <>
            <Note tone="ok">
              Sync is on. {initial ? 'Your library is uploading in the background; you can keep using OpenStand.' : 'Your library is uploaded.'}
            </Note>
            {initial && <Bar value={initial.total > 1 ? initial.done / initial.total : undefined} label={initialLine(initial)} />}
            <p className="text-sm text-muted">
              You can pair other devices now. They see your songs first, and files as they finish uploading.
              {kind && ` Each one signs in to ${drive(kind).name} with the same account.`}
            </p>
            <PairingQr />
          </>
        )}
      </div>
    </Dialog>
  )
}
