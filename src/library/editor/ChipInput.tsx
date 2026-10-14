import { X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { db } from '../../db/db'
import type { GroupField } from '../../db/schema'
import { capitalizeWords } from '../../files/import'
import { cx } from '../../ui/primitives'

const cache = new Map<string, Promise<string[]>>()

/** Distinct existing values of a multi-entry group index (cached per editor session). */
export function groupValues(field: GroupField, refresh = false): Promise<string[]> {
  let p = cache.get(field)
  if (!p || refresh) {
    p = db.songs
      .orderBy(field)
      .uniqueKeys()
      .then((keys) => (keys as string[]).filter((k) => typeof k === 'string' && k.trim()))
      .catch(() => [])
    cache.set(field, p)
  }
  return p
}
export function clearGroupValueCache() {
  cache.clear()
}

function rank(options: string[], q: string, exclude: string[]) {
  const ex = new Set(exclude.map((v) => v.toLowerCase()))
  const s = q.trim().toLowerCase()
  const avail = options.filter((o) => !ex.has(o.toLowerCase()))
  if (!s) return avail.slice(0, 50)
  const starts: string[] = []
  const words: string[] = []
  const inner: string[] = []
  for (const o of avail) {
    const l = o.toLowerCase()
    if (l === s) continue
    if (l.startsWith(s)) starts.push(o)
    else if (l.split(/[\s\-/(]+/).some((w) => w.startsWith(s))) words.push(o)
    else if (l.includes(s)) inner.push(o)
  }
  return [...starts, ...words, ...inner].slice(0, 30)
}

/**
 * Multi-value input: values are chips; Enter, comma, semicolon or Tab commits the typed text.
 * Suggestions come from existing library values (or a static list) and are keyboard navigable.
 */
export function ChipInput({
  value,
  onChange,
  suggestions,
  field,
  placeholder,
  capitalize,
  inputMode,
  validate,
  showAllOnFocus,
  trailing,
  id,
  'aria-label': ariaLabel,
}: {
  value: string[]
  onChange: (v: string[]) => void
  /** Static suggestions (shown before library values). */
  suggestions?: string[]
  /** Group field whose existing values are suggested. */
  field?: GroupField
  placeholder?: string
  capitalize?: boolean
  inputMode?: 'text' | 'numeric' | 'decimal'
  /** Return a normalized value, or null to reject the entry. */
  validate?: (v: string) => string | null
  showAllOnFocus?: boolean
  trailing?: ReactNode
  id?: string
  'aria-label'?: string
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [lib, setLib] = useState<string[]>([])
  const [hi, setHi] = useState(-1)
  const [invalid, setInvalid] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  useEffect(() => {
    if (focused && field) groupValues(field).then(setLib)
  }, [focused, field])

  const options = useMemo(() => {
    const seen = new Set<string>()
    const all: string[] = []
    for (const o of [...(suggestions ?? []), ...lib]) {
      const k = o.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        all.push(o)
      }
    }
    return rank(all, text, value)
  }, [suggestions, lib, text, value])
  const showList = focused && options.length > 0 && (text.trim() !== '' || !!showAllOnFocus)

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (!parts.length) {
      setText('')
      return true
    }
    const next = [...value]
    for (let p of parts) {
      if (capitalize && p === p.toLowerCase()) p = capitalizeWords(p)
      // Prefer the existing spelling of a value (case-insensitive) so groups don't fragment.
      const existing = [...(suggestions ?? []), ...lib].find((o) => o.toLowerCase() === p.toLowerCase())
      if (existing) p = existing
      if (validate) {
        const v = validate(p)
        if (v === null) {
          setInvalid(true)
          return false
        }
        p = v
      }
      if (!next.some((n) => n.toLowerCase() === p.toLowerCase())) next.push(p)
    }
    onChange(next)
    setText('')
    setHi(-1)
    setInvalid(false)
    return true
  }

  const remove = (i: number) => onChange(value.filter((_, k) => k !== i))

  return (
    <div
      ref={boxRef}
      className={cx(
        'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-1.5 py-1 transition',
        focused ? 'border-accent ring-2 ring-accent-soft' : 'border-line',
        invalid && 'border-danger ring-danger/20',
      )}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}
    >
      {value.map((v, i) => (
        <span key={v + i} className="inline-flex h-7 max-w-full items-center gap-0.5 rounded-md bg-surface-2 pl-2 text-sm text-fg">
          <span className="truncate">{v}</span>
          <button
            type="button"
            aria-label={`Remove ${v}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-3 hover:text-fg"
            onClick={() => remove(i)}
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined}
        autoCapitalize={capitalize ? 'words' : 'off'}
        autoComplete="off"
        inputMode={inputMode}
        value={text}
        placeholder={value.length ? '' : placeholder}
        className="h-8 min-w-24 flex-1 bg-transparent px-1.5 text-sm text-fg outline-none placeholder:text-faint"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          if (text.trim()) commit(text)
        }}
        onChange={(e) => {
          const v = e.target.value
          setInvalid(false)
          if (/[,;]/.test(v)) commit(v)
          else {
            setText(v)
            setHi(-1)
          }
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text')
          if (/[,;\n]/.test(t)) {
            e.preventDefault()
            commit(text + t.replace(/\n/g, ','))
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && options.length) {
            e.preventDefault()
            setHi((h) => (h + 1) % options.length)
          } else if (e.key === 'ArrowUp' && options.length) {
            e.preventDefault()
            setHi((h) => (h <= 0 ? options.length - 1 : h - 1))
          } else if (e.key === 'Enter') {
            if (showList && hi >= 0) {
              e.preventDefault()
              commit(options[hi])
            } else if (text.trim()) {
              e.preventDefault()
              commit(text)
            }
          } else if (e.key === 'Tab' && text.trim()) {
            if (!commit(showList && hi >= 0 ? options[hi] : text)) e.preventDefault()
          } else if (e.key === 'Backspace' && !text && value.length) {
            remove(value.length - 1)
          } else if (e.key === 'Escape' && showList) {
            e.stopPropagation()
            setText('')
          }
        }}
      />
      {trailing}
      {showList && (
        <Dropdown anchor={boxRef.current}>
          <ul id={listId} role="listbox" className="py-1">
            {options.map((o, i) => (
              <li
                key={o}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === hi}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => commit(o)}
                className={cx('cursor-pointer truncate px-3 py-2 text-sm', i === hi ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2')}
              >
                {o}
              </li>
            ))}
          </ul>
        </Dropdown>
      )}
    </div>
  )
}

/** A list anchored under (or above) an element, portaled so scroll containers don't clip it. */
export function Dropdown({ anchor, children, maxHeight = 240 }: { anchor: HTMLElement | null; children: ReactNode; maxHeight?: number }) {
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const below = window.innerHeight - r.bottom
      const width = Math.max(r.width, 180)
      const left = Math.min(r.left, window.innerWidth - width - 8)
      setPos(below < maxHeight + 16 && r.top > below ? { left, bottom: window.innerHeight - r.top + 4, width } : { left, top: r.bottom + 4, width })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor, maxHeight])
  if (!pos) return null
  return createPortal(
    <div
      className="fixed z-[65] overflow-y-auto rounded-xl border border-line bg-surface text-fg shadow-xl"
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight }}
    >
      {children}
    </div>,
    document.body,
  )
}
