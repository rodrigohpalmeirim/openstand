import { Check, Menu as MenuIcon, Star } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { cx, IconButton, Menu, type MenuItem } from '../../ui/primitives'
import { LETTERS } from './logic'
import { useLibraryUI } from './ui'

/* ------------------------------------------------------------- Windowing */

/** Minimal fixed-row-height windowing: only rows in view (plus overscan) are rendered. */
export function useWindow(ref: RefObject<HTMLElement | null>, count: number, rowHeight: number, offset = 0, overscan = 6) {
  const [view, setView] = useState({ top: 0, height: 800 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setView({ top: el.scrollTop, height: el.clientHeight }))
    }
    setView({ top: el.scrollTop, height: el.clientHeight })
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref])
  const top = view.top - offset
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((top + view.height) / rowHeight) + overscan)
  return { start, end, total: count * rowHeight }
}

/* ------------------------------------------------------------ A–Z index */

/**
 * Vertical letter strip. Tap or drag (touch-friendly scrubbing) to jump; letters with no rows are dimmed and
 * jump to the next available letter.
 */
export function AlphaIndex({ index, onJump }: { index: Map<string, number>; onJump: (row: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const pick = (clientY: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const i = Math.max(0, Math.min(LETTERS.length - 1, Math.floor(((clientY - r.top) / r.height) * LETTERS.length)))
    for (let j = i; j < LETTERS.length; j++) {
      const row = index.get(LETTERS[j])
      if (row !== undefined) {
        setActive(LETTERS[i])
        onJump(row)
        return
      }
    }
    setActive(LETTERS[i])
  }
  return (
    <>
      <div
        ref={ref}
        role="navigation"
        aria-label="Jump to letter"
        className="no-select absolute inset-y-1 right-0 z-10 flex w-6 touch-none flex-col items-center justify-between py-1 text-[10px] font-semibold leading-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          pick(e.clientY)
        }}
        onPointerMove={(e) => e.buttons && pick(e.clientY)}
        onPointerUp={() => setActive(null)}
        onPointerCancel={() => setActive(null)}
      >
        {LETTERS.map((l) => (
          <span key={l} className={cx('flex-1 flex items-center', index.has(l) ? 'text-accent' : 'text-faint/50')}>
            {l}
          </span>
        ))}
      </div>
      {active && (
        <div className="pointer-events-none absolute right-10 top-1/2 z-20 flex size-16 -translate-y-1/2 items-center justify-center rounded-2xl bg-accent text-3xl font-bold text-accent-fg shadow-xl">
          {active}
        </div>
      )}
    </>
  )
}

/* --------------------------------------------------------- Context menu */

const useCtx = create<{ x: number; y: number; items: MenuItem[] } | { x: null }>(() => ({ x: null }))

/** Open a menu at a point (right-click / long-press) or under an element. */
export function openMenuAt(e: { clientX: number; clientY: number } | HTMLElement, items: MenuItem[]) {
  if (e instanceof HTMLElement) {
    const r = e.getBoundingClientRect()
    useCtx.setState({ x: r.right, y: r.bottom - 4, items })
  } else useCtx.setState({ x: e.clientX, y: e.clientY, items })
}

export function ContextMenuHost() {
  const st = useCtx()
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  if (st.x === null) return null
  return createPortal(
    <>
      <div ref={setAnchor} className="pointer-events-none fixed size-px" style={{ left: st.x, top: st.y }} />
      {anchor && <Menu anchor={anchor} open onClose={() => useCtx.setState({ x: null })} items={st.items} align="end" />}
    </>,
    document.body,
  )
}

/* ------------------------------------------------------------ Long press */

/**
 * Long-press detection for touch/pen (mouse uses right-click). Returns handlers plus `consumed()` to
 * swallow the click that follows a long press.
 */
export function useLongPress(onLong: (e: { clientX: number; clientY: number }) => void, ms = 480) {
  const t = useRef<number | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    clearTimeout(t.current)
    start.current = null
  }
  return {
    handlers: {
      onPointerDown: (e: RPointerEvent) => {
        fired.current = false
        if (e.pointerType === 'mouse') return
        const p = { clientX: e.clientX, clientY: e.clientY }
        start.current = { x: e.clientX, y: e.clientY }
        t.current = window.setTimeout(() => {
          fired.current = true
          navigator.vibrate?.(10)
          onLong(p)
        }, ms)
      },
      onPointerMove: (e: RPointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: RMouseEvent) => {
        // Touch long-press also fires contextmenu on Android; we've handled it already.
        if (fired.current) e.preventDefault()
      },
    },
    consumed: () => {
      const f = fired.current
      fired.current = false
      return f
    },
  }
}

/* ----------------------------------------------------------------- Bits */

export function Stars({ value, size = 'size-3' }: { value: number; size?: string }) {
  if (!value) return null
  return (
    <span className="inline-flex items-center gap-px text-warn" aria-label={`${value} of 5 stars`} title={`${value} / 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} className={cx(size, i < value ? 'fill-current' : 'opacity-25')} />
      ))}
    </span>
  )
}

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
      {Array.from({ length: 5 }, (_, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i + 1}
          aria-label={`${i + 1} stars`}
          onClick={() => onChange(value === i + 1 ? 0 : i + 1)}
          className="flex size-9 items-center justify-center rounded-lg text-warn hover:bg-surface-2"
        >
          <Star className={cx('size-5', i < value ? 'fill-current' : 'opacity-30')} />
        </button>
      ))}
    </div>
  )
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange?: () => void; label?: string }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={
        onChange &&
        ((e) => {
          e.stopPropagation()
          onChange()
        })
      }
      className={cx(
        'flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition',
        checked ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface',
      )}
    >
      {checked && <Check className="size-3.5" strokeWidth={3} />}
    </span>
  )
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex h-5 items-center rounded-md bg-surface-2 px-1.5 text-[11px] font-semibold text-muted tabular-nums', className)}>
      {children}
    </span>
  )
}

/** Opens the navigation drawer on phones. */
export function DrawerButton() {
  return (
    <IconButton label="Menu" className="md:hidden -ml-1" onClick={() => useLibraryUI.getState().set({ drawer: true })}>
      <MenuIcon className="size-5" />
    </IconButton>
  )
}

/** Keep a ref to the latest value (for stable callbacks in effects). */
export function useLatest<T>(v: T) {
  const r = useRef(v)
  useEffect(() => {
    r.current = v
  })
  return r
}

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d > 300 ? 'numeric' : undefined })
}
