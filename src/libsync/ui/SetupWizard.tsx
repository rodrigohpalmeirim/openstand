/** "Set up sync" (§12.2): storage → S3 form → connection test → start → pairing code. */
import { Check, CircleAlert, CircleDashed, Cloud, ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react'
import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react'
import { corsRule, useLibSync } from '../api'
import type { BackendCheck, S3Config } from '../backends/types'
import { Button, Dialog, Input, Toggle, cx } from '../../ui/primitives'
import { checkBackend, enableSync } from './client'
import { PairingQr } from './PairingQr'
import { Bar, CopyBox, Note } from './parts'
import {
  CHECK_LABEL,
  OPTIONAL_STEPS,
  PROVIDERS,
  checkFailureText,
  initialWizard,
  needsCors,
  preset,
  toConfig,
  validateForm,
  wizardReducer,
  type FormErrors,
  type S3Form,
} from './wizard'

const DOTS = ['storage', 'form', 'check', 'pair'] as const

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

/** The CORS rule to paste and where it goes (§7.1). */
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

/** The connection-test checklist. */
export function CheckList({ check, checking }: { check?: BackendCheck; checking: boolean }) {
  const steps = check?.steps ?? []
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
          <span className={cx(!s.ok && !OPTIONAL_STEPS.includes(s.id) && 'font-medium')}>{CHECK_LABEL[s.id]}</span>
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

/* ---------------------------------------------------------------- Wizard */

const TITLES = { storage: 'Where to keep your library', form: 'Connect your bucket', check: 'Test the connection', start: 'Uploading your library', pair: 'Add your other devices' }

export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, dispatch] = useReducer(wizardReducer, undefined, initialWizard)
  const initial = useLibSync((st) => st.initial)
  const heading = useRef<HTMLHeadingElement>(null)
  const p = preset(s.form.provider)
  const errors = s.showErrors ? validateForm(s.form) : {}
  const cfg = toConfig(s.form)

  // Move focus to the new step's heading so keyboard and screen-reader users follow along.
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [s.step, open])

  const test = async () => {
    if (Object.keys(validateForm(s.form)).length) return dispatch({ type: 'next' })
    dispatch({ type: 'checkStart' })
    try {
      dispatch({ type: 'checkDone', check: await checkBackend(cfg) })
    } catch (e) {
      dispatch({ type: 'checkFailed', message: (e as Error).message || 'The test couldn’t run.' })
    }
  }

  const start = async () => {
    dispatch({ type: 'startBegin' })
    try {
      // No relay given: the engine picks the same-site relay when there is one (§9).
      await enableSync({ backend: cfg })
      dispatch({ type: 'startDone' })
    } catch (e) {
      dispatch({ type: 'startFailed', message: (e as Error).message || 'Sync couldn’t start.' })
    }
  }

  const footer = (() => {
    const back = (
      <Button variant="ghost" onClick={() => dispatch({ type: 'back' })} disabled={s.checking || s.starting}>
        Back
      </Button>
    )
    switch (s.step) {
      case 'storage':
        return (
          <>
            <Button variant="ghost" onClick={onClose}>
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
      case 'check':
        return (
          <>
            {back}
            {s.check?.ok ? (
              <Button variant="primary" onClick={start}>
                Start syncing
              </Button>
            ) : (
              <Button variant="primary" onClick={test} disabled={s.checking}>
                {s.checking && <Loader2 className="size-4 animate-spin" />}
                Test again
              </Button>
            )}
          </>
        )
      case 'start':
        return s.failure ? (
          <>
            <Button variant="ghost" onClick={onClose}>
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
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )
    }
  })()

  return (
    <Dialog open={open} onClose={onClose} title="Set up library sync" footer={footer}>
      <div className="grid gap-5 px-5 py-4">
        <div className="flex items-center gap-2" aria-hidden>
          {DOTS.map((st, i) => (
            <span key={st} className={cx('h-1 flex-1 rounded-full', i <= DOTS.indexOf(s.step === 'start' ? 'pair' : s.step) ? 'bg-accent' : 'bg-surface-3')} />
          ))}
        </div>
        <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
          {TITLES[s.step]}
        </h3>

        {s.step === 'storage' && (
          <>
            <div className="flex items-start gap-3 rounded-xl border-2 border-accent bg-accent-soft/40 px-4 py-3">
              <Cloud className="mt-0.5 size-5 shrink-0 text-accent" />
              <div className="text-sm">
                <div className="font-medium">S3-compatible storage</div>
                <p className="text-muted">A bucket you own. OpenStand has no servers of its own, and your files are encrypted before they leave this device.</p>
              </div>
            </div>
            <div className="grid gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">Provider</span>
              <ProviderChips value={s.form.provider} onChange={(provider) => dispatch({ type: 'provider', provider })} />
              <p className="text-sm text-muted">{p.name}</p>
            </div>
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

        {s.step === 'check' && (
          <>
            <p className="text-sm text-muted">
              {p.name} · {cfg.bucket}/{cfg.prefix}
            </p>
            <CheckList check={s.check} checking={s.checking} />
            {s.check?.ok && <Note tone="ok">Everything works. Your library will be encrypted on this device and uploaded to this bucket.</Note>}
            {s.check && !s.check.ok && <Note tone="danger">{checkFailureText(s.check)}</Note>}
            {s.failure && <Note tone="danger">{s.failure}</Note>}
            {needsCors(s.check) && <CorsHelp config={cfg} />}
          </>
        )}

        {s.step === 'start' && (
          <>
            {s.failure ? (
              <Note tone="danger">{s.failure}</Note>
            ) : (
              <Bar value={initial?.total ? initial.done / initial.total : undefined} label={initial ? `${initial.step} · ${initial.done.toLocaleString()} of ${initial.total.toLocaleString()}` : 'Creating the synced library…'} />
            )}
          </>
        )}

        {s.step === 'pair' && (
          <>
            <Note tone="ok">
              Sync is on. {initial ? 'Your library is uploading in the background; you can keep using OpenStand.' : 'Your library is uploaded.'}
            </Note>
            {initial && <Bar value={initial.total ? initial.done / initial.total : undefined} label={`${initial.step} · ${initial.done.toLocaleString()} of ${initial.total.toLocaleString()}`} />}
            <p className="text-sm text-muted">You can pair other devices now. They see your songs first, and files as they finish uploading.</p>
            <PairingQr />
          </>
        )}
      </div>
    </Dialog>
  )
}
