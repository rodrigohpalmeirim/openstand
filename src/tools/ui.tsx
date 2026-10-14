import { Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../ui/primitives'
import { DARK_VARS } from './util'


export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div style={DARK_VARS} className={cx('space-y-5 p-4 text-white', className)}>
      {children}
    </div>
  )
}

export function Section({ title, action, children, className }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-white/50">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-sm text-white/85">{label}</div>
        {hint && <div className="text-xs text-white/45">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** − value + control with 44px touch targets. */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  label,
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  format?: (v: number) => ReactNode
  label: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  return (
    <div className="inline-flex items-center rounded-xl border border-white/10 bg-white/5">
      <button type="button" aria-label={`Decrease ${label}`} className="flex size-10 items-center justify-center rounded-l-xl text-white/80 hover:bg-white/10 disabled:opacity-30" disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
        <Minus className="size-4" />
      </button>
      <span className="min-w-10 px-1 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {format ? format(value) : value}
      </span>
      <button type="button" aria-label={`Increase ${label}`} className="flex size-10 items-center justify-center rounded-r-xl text-white/80 hover:bg-white/10 disabled:opacity-30" disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
        <Plus className="size-4" />
      </button>
    </div>
  )
}

/** Flat dark button used inside viewer panels. */
export function PanelButton({
  children,
  onClick,
  active,
  primary,
  danger,
  className,
  disabled,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  primary?: boolean
  danger?: boolean
  className?: string
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-35',
        primary
          ? 'bg-[var(--os-accent)] text-[var(--os-accent-fg)] hover:brightness-110'
          : active
            ? 'border border-[var(--os-accent)] bg-[var(--os-accent)]/15 text-white'
            : danger
              ? 'border border-white/10 text-red-300 hover:bg-red-500/10'
              : 'border border-white/10 text-white/85 hover:bg-white/10',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Hint line under a section, e.g. "Saved for this song · Use default". */
export function ScopeLine({ perSong, onReset, onMakeDefault }: { perSong: boolean; onReset: () => void; onMakeDefault: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-white/50">
      <span>{perSong ? 'Saved for this song' : 'Using your defaults'}</span>
      {perSong ? (
        <span className="flex gap-3">
          <button className="text-[var(--os-accent)]" onClick={onMakeDefault}>
            Make default
          </button>
          <button className="text-[var(--os-accent)]" onClick={onReset}>
            Use defaults
          </button>
        </span>
      ) : null}
    </div>
  )
}
