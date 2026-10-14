import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx, IconButton, Toggle } from '../../ui/primitives'

/** True when `el` is the top-most modal dialog in the document (portals append in mount order). */
export function isTopDialog(el: HTMLElement | null) {
  if (!el) return false
  const all = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
  return all[all.length - 1] === el
}

/**
 * Editor-sized modal: full screen on phones, a large centred panel from `sm` up. Unlike the basic
 * Dialog, Escape only reaches the top-most sheet, so nested editors (crop/page order inside the song
 * editor, confirm prompts on top) close one at a time.
 */
export function Sheet({
  open = true,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  children,
  size = 'lg',
  bodyClassName,
  tone = 'default',
  labelledBy,
}: {
  open?: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  /** Extra header buttons (left of the close button). */
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
  size?: 'md' | 'lg' | 'full'
  bodyClassName?: string
  tone?: 'default' | 'dark'
  labelledBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const t = setTimeout(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true })
    }, 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopDialog(ref.current)) return
      e.stopPropagation()
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      prev?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 backdrop-blur-[2px] animate-fade-in sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx(
          'flex h-full w-full flex-col overflow-hidden shadow-2xl outline-none animate-pop-in sm:h-[min(92dvh,940px)] sm:rounded-2xl sm:border',
          tone === 'dark' ? 'dark bg-[#121315] text-[#ecebe8] sm:border-white/10' : 'bg-surface text-fg sm:border-line',
          size === 'md' && 'sm:max-w-2xl',
          size === 'lg' && 'sm:max-w-5xl',
          size === 'full' && 'sm:max-w-[min(1400px,98vw)]',
        )}
        style={{ paddingTop: 'env(safe-area-inset-top)', outline: 'none' }}
      >
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-line px-2 sm:px-4">
          <IconButton label="Close" onClick={onClose} className="sm:order-last">
            <X className="size-5" />
          </IconButton>
          <div className="min-w-0 flex-1 py-2">
            <h2 id={labelledBy} className="truncate text-base font-semibold leading-tight">
              {title}
            </h2>
            {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
        <div className={cx('min-h-0 flex-1', bodyClassName ?? 'overflow-y-auto')}>{children}</div>
        {footer && (
          <footer
            className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-3 py-2.5 sm:px-4"
            style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Small labelled section used inside editor tabs. */
export function Section({ title, children, actions, className }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cx('flex flex-col gap-3', className)}>
      {(title || actions) && (
        <div className="flex min-h-8 items-center gap-2">
          {title && <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  )
}
