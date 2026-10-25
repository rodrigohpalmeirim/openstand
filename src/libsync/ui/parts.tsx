/** Small building blocks shared by the library-sync screens. */
import { AlertTriangle, Check, Copy, Info } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Button, Toggle, cx } from '../../ui/primitives'
import { copyText } from './clipboard'

export function Bar({ value, label, tone = 'accent' }: { value?: number; label: ReactNode; tone?: 'accent' | 'muted' }) {
  const pct = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="grid gap-1.5">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={typeof label === 'string' ? label : undefined}
      >
        {pct === undefined ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
        ) : (
          <div className={cx('h-full rounded-full transition-[width] duration-300', tone === 'accent' ? 'bg-accent' : 'bg-faint')} style={{ width: `${pct}%` }} />
        )}
      </div>
      <div className="text-xs tabular-nums text-muted">{label}</div>
    </div>
  )
}

/** A titled block with an icon, like the backup settings. */
export function Block({ title, icon, description, children }: { title: string; icon: ReactNode; description?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section className="grid gap-3" aria-labelledby={id}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">{icon}</div>
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold">
            {title}
          </h3>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
      </div>
      <div className="grid gap-3 sm:pl-11">{children}</div>
    </section>
  )
}

export function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4">
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </label>
  )
}

export function Note({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'ok' ? Check : tone === 'info' ? Info : AlertTriangle
  return (
    <div
      role={tone === 'danger' || tone === 'warn' ? 'alert' : undefined}
      className={cx(
        'flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm',
        tone === 'info' && 'border-line bg-surface-2',
        tone === 'ok' && 'border-ok/40 bg-ok/10',
        tone === 'warn' && 'border-warn/40 bg-warn/10',
        tone === 'danger' && 'border-danger/40 bg-danger/10',
      )}
    >
      <Icon className={cx('mt-0.5 size-4.5 shrink-0', tone === 'info' ? 'text-muted' : tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-danger')} />
      <div className="min-w-0 flex-1 basis-48 break-words">{children}</div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  )
}

/** Read-only monospace text with a Copy button (CORS rule). */
export function CopyBox({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre aria-label={label} tabIndex={0} className="max-h-56 overflow-auto rounded-lg border border-line bg-surface-2 p-3 pr-24 font-mono text-xs leading-relaxed text-fg">
        {text}
      </pre>
      <Button
        size="sm"
        className="absolute right-2 top-2"
        icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        onClick={async () => {
          if (await copyText(text)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
