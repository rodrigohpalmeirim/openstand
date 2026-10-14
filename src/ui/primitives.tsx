import { X } from 'lucide-react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ Buttons */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-sm',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:brightness-110',
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }
>(function Button({ variant = 'secondary', size = 'md', icon, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition select-none disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-5 text-base',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' | 'lg' }
>(function IconButton({ label, active, size = 'md', className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        'inline-flex items-center justify-center rounded-lg transition select-none shrink-0 disabled:opacity-35 disabled:pointer-events-none',
        size === 'sm' && 'size-8',
        size === 'md' && 'size-10',
        size === 'lg' && 'size-12',
        active ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

/* ------------------------------------------------------------------- Inputs */

const inputBase =
  'w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft transition'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputBase, 'h-10', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(inputBase, 'py-2 min-h-24', className)} {...rest} />
  },
)

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputBase, 'h-10 pr-8 appearance-auto', className)} {...rest}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label
      className={cx('flex flex-col gap-1.5', className)}
      onClick={(e) => {
        // A <label> forwards clicks to its first labelable descendant. When that is a button (chip ✕,
        // star, segment) a click on the caption would press it, and a button removed by its own click
        // makes the browser re-target the NEXT button. Buttons handle their own clicks; skip forwarding.
        const t = e.target as Element
        const btn = t.closest('button')
        if ((btn && e.currentTarget.contains(btn) && !(btn.type === 'submit' && btn.form)) || (!btn && e.currentTarget.control instanceof HTMLButtonElement))
          e.preventDefault()
      }}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span
        className={cx(
          'inline-block size-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5.5' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div className={cx('inline-flex rounded-lg bg-surface-2 p-0.5 border border-line', className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition whitespace-nowrap',
            size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
            o.value === value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  label,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  className?: string
  label?: string
}) {
  return (
    <input
      type="range"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cx('w-full accent-[var(--os-accent)]', className)}
    />
  )
}

/* ------------------------------------------------------------------ Dialogs */

/** Open overlays, innermost last: Escape closes only the topmost one. */
const escapeStack: { current: () => void }[] = []

function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !escapeStack.length) return
  e.stopPropagation()
  e.preventDefault()
  escapeStack[escapeStack.length - 1].current()
}

export function useEscape(active: boolean, onEscape: () => void) {
  const handler = useRef(onEscape)
  handler.current = onEscape
  useEffect(() => {
    if (!active) return
    if (!escapeStack.length) window.addEventListener('keydown', onEscapeKey, true)
    escapeStack.push(handler)
    return () => {
      escapeStack.splice(escapeStack.indexOf(handler), 1)
      if (!escapeStack.length) window.removeEventListener('keydown', onEscapeKey, true)
    }
  }, [active])
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  className,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  className?: string
}) {
  useEscape(open, onClose)
  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 animate-fade-in"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface text-fg shadow-2xl animate-pop-in',
          'rounded-t-2xl sm:rounded-2xl border border-line',
          size === 'sm' && 'sm:max-w-sm',
          size === 'md' && 'sm:max-w-lg',
          size === 'lg' && 'sm:max-w-2xl',
          size === 'xl' && 'sm:max-w-4xl',
          size === 'full' && 'sm:max-w-[min(1200px,96vw)] sm:h-[92dvh]',
          className,
        )}
      >
        {title !== undefined && (
          <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
            <h2 className="flex-1 truncate text-base font-semibold">{title}</h2>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X className="size-4.5" />
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* -------------------------------------------------------- Popover / Menus */

export interface MenuItem {
  label: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  divider?: boolean
  hint?: ReactNode
}

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'end' | 'center'
  side?: 'bottom' | 'top'
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useEscape(open, onClose)
  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const m = ref.current.getBoundingClientRect()
    let left = align === 'start' ? a.left : align === 'end' ? a.right - m.width : a.left + a.width / 2 - m.width / 2
    let top = side === 'bottom' ? a.bottom + 6 : a.top - m.height - 6
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 6)
    if (top < 8) top = Math.min(window.innerHeight - m.height - 8, a.bottom + 6)
    left = Math.min(Math.max(8, left), window.innerWidth - m.width - 8)
    setPos({ left, top: Math.max(8, top) })
  }, [open, anchor, align, side])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, onClose, anchor])
  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className={cx(
        'fixed z-[60] max-h-[80dvh] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-fg shadow-xl animate-pop-in',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  )
}

export function Menu({
  anchor,
  open,
  onClose,
  items,
  align,
  side,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  items: MenuItem[]
  align?: 'start' | 'end' | 'center'
  side?: 'bottom' | 'top'
}) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align={align} side={side} className="min-w-52">
      <div role="menu">
        {items.map((it, i) =>
          it.divider ? (
            <div key={i} className="my-1 h-px bg-line" />
          ) : (
            <button
              key={i}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                onClose()
                it.onSelect?.()
              }}
              className={cx(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-surface-2 disabled:opacity-40',
                it.danger && 'text-danger',
              )}
            >
              <span className="flex size-4 items-center justify-center text-muted">{it.icon}</span>
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-xs text-faint">{it.hint}</span>}
              {it.checked !== undefined && (
                <span className={cx('size-2 rounded-full', it.checked ? 'bg-accent' : 'bg-transparent')} />
              )}
            </button>
          ),
        )}
      </div>
    </Popover>
  )
}

/** Small hook for anchor-based menus: `const m = useMenu(); <button ref={m.ref} onClick={m.toggle}/>` */
export function useMenu<T extends HTMLElement = HTMLButtonElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [open, setOpen] = useState(false)
  return {
    ref: setEl,
    anchor: el,
    open,
    toggle: useCallback(() => setOpen((o) => !o), []),
    close: useCallback(() => setOpen(false), []),
    show: useCallback(() => setOpen(true), []),
  }
}

/* ------------------------------------------------------------------- Toasts */

interface Toast {
  id: number
  message: ReactNode
  tone?: 'info' | 'ok' | 'error'
  action?: { label: string; run: () => void }
}

const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})

let toastSink: ((t: Omit<Toast, 'id'>) => void) | null = null
/** Fire a toast from non-React code. */
export function toast(message: ReactNode, tone: Toast['tone'] = 'info', action?: Toast['action']) {
  toastSink?.({ message, tone, action })
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    // Repeating the same text message (e.g. a pedal held at the end of a list) refreshes it instead of stacking.
    const same = (x: Toast) => typeof t.message === 'string' && x.message === t.message && x.tone === t.tone
    setToasts((ts) => [...ts.filter((x) => !same(x)).slice(-3), { ...t, id }])
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.action ? 6000 : 3200)
  }, [])
  useEffect(() => {
    toastSink = push
    return () => {
      toastSink = null
    }
  }, [push])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-lg animate-pop-in',
                'bg-fg text-bg',
                t.tone === 'error' && '!bg-danger !text-white',
              )}
            >
              <span>{t.message}</span>
              {t.action && (
                <button
                  className="font-semibold text-accent"
                  onClick={() => {
                    t.action!.run()
                    setToasts((ts) => ts.filter((x) => x.id !== t.id))
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

/* ------------------------------------------------------------ Confirm/prompt */

type AskState =
  | { kind: 'confirm'; title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; label?: string; initial?: string; resolve: (v: string | null) => void }

let askSink: ((s: AskState) => void) | null = null

/** Resolves true for the confirm button; false for the other button (`cancelLabel`), Escape or close. */
export function confirmDialog(opts: { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => (askSink ? askSink({ kind: 'confirm', ...opts, resolve }) : resolve(window.confirm(opts.title))))
}

export function promptDialog(opts: { title: string; label?: string; initial?: string }) {
  return new Promise<string | null>((resolve) => (askSink ? askSink({ kind: 'prompt', ...opts, resolve }) : resolve(window.prompt(opts.title, opts.initial))))
}

export function AskHost() {
  const [s, setS] = useState<AskState | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    askSink = (st) => {
      setText(st.kind === 'prompt' ? st.initial ?? '' : '')
      setS(st)
    }
    return () => {
      askSink = null
    }
  }, [])
  if (!s) return null
  const close = (v: boolean) => {
    if (s.kind === 'confirm') s.resolve(v)
    else s.resolve(v ? text : null)
    setS(null)
  }
  return (
    <Dialog
      open
      size="sm"
      onClose={() => close(false)}
      title={s.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {(s.kind === 'confirm' && s.cancelLabel) || 'Cancel'}
          </Button>
          <Button variant={s.kind === 'confirm' && s.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {s.kind === 'confirm' ? s.confirmLabel ?? 'OK' : 'OK'}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4 text-sm text-muted">
        {s.kind === 'confirm' ? (
          s.message
        ) : (
          <Field label={s.label ?? 'Name'}>
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && close(true)}
            />
          </Field>
        )}
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------------- Misc */

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div>}
      <div className="text-base font-semibold">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>
  )
}
