import { Heart, MoreVertical } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { GroupField, Song } from '../../db/schema'
import { useSettings } from '../../state/settings'
import { cx, IconButton, type MenuItem } from '../../ui/primitives'
import { Thumb } from '../Thumb'
import { formatDuration } from './logic'
import { setFavorite } from './ops'
import { AlphaIndex, Badge, Checkbox, openMenuAt, Stars, useLongPress, useWindow } from './widgets'

/* ------------------------------------------------------------- Selection */

export interface Selection {
  selecting: boolean
  selected: Set<string>
  start: (id?: string) => void
  toggle: (id: string, range?: boolean) => void
  setAll: (ids: string[]) => void
  clear: () => void
  has: (id: string) => boolean
}

/** Multi-select state over an ordered list of ids (shift = range from the last toggled row). */
export function useSelection(order: string[]): Selection {
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchor = useRef<string | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  // Drop ids that disappeared (deleted / filtered out).
  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s
      const present = new Set(order)
      const next = new Set([...s].filter((id) => present.has(id)))
      return next.size === s.size ? s : next
    })
  }, [order])
  const toggle = useCallback((id: string, range?: boolean) => {
    setSelecting(true)
    setSelected((s) => {
      const next = new Set(s)
      const ord = orderRef.current
      if (range && anchor.current && anchor.current !== id) {
        const a = ord.indexOf(anchor.current)
        const b = ord.indexOf(id)
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ord[i])
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      anchor.current = id
      return next
    })
  }, [])
  return {
    selecting,
    selected,
    start: useCallback((id?: string) => {
      setSelecting(true)
      if (id) {
        anchor.current = id
        setSelected((s) => new Set(s).add(id))
      }
    }, []),
    toggle,
    setAll: useCallback((ids: string[]) => setSelected(new Set(ids)), []),
    clear: useCallback(() => {
      setSelecting(false)
      setSelected(new Set())
      anchor.current = null
    }, []),
    has: useCallback((id: string) => selected.has(id), [selected]),
  }
}

/* ------------------------------------------------------------------ Rows */

const CAPTION_FIELDS: GroupField[] = ['artists', 'composers', 'albums', 'genres', 'collections', 'signatures', 'sources', 'years', 'tags', 'custom', 'custom2']

export function songCaption(s: Song, fields: string[]): string {
  const parts: string[] = []
  for (const f of fields)
    if ((CAPTION_FIELDS as string[]).includes(f)) {
      let v = s[f as GroupField]
      // Classical scores often have a composer but no artist: show that instead of nothing.
      if (f === 'artists' && !v?.length && !fields.includes('composers')) v = s.composers
      if (v?.length) parts.push(v.join(', '))
    }
  return parts.join(' · ')
}

interface RowProps {
  song: Song
  index: number
  top: number
  height: number
  view: 'list' | 'compact'
  fields: string[]
  selecting: boolean
  selected: boolean
  caption?: ReactNode
  padRight: boolean
  onActivate: (index: number, e: MouseEvent | KeyboardEvent) => void
  onLong: (index: number) => void
  menu: (song: Song, index: number) => MenuItem[]
}

const SongRow = memo(function SongRow(p: RowProps) {
  const { song: s } = p
  const lp = useLongPress(() => p.onLong(p.index))
  const showKey = p.fields.includes('keys') && s.keys[0]
  const caption = p.caption ?? songCaption(s, p.fields)
  return (
    <div
      role="row"
      aria-selected={p.selecting ? p.selected : undefined}
      tabIndex={0}
      data-row={p.index}
      style={{ top: p.top, height: p.height }}
      className={cx(
        'no-select group absolute inset-x-0 flex cursor-pointer items-center gap-3 border-b border-line/60 pl-3 outline-none md:pl-4',
        p.padRight ? 'pr-8' : 'pr-2 md:pr-3',
        p.selected ? 'bg-accent-soft' : 'hover:bg-surface-2 focus-visible:bg-surface-2',
      )}
      {...lp.handlers}
      onClick={(e) => {
        if (lp.consumed()) return
        p.onActivate(p.index, e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          p.onActivate(p.index, e)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const sib = e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-row="${p.index + (e.key === 'ArrowDown' ? 1 : -1)}"]`)
          sib?.focus()
        }
      }}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return
        e.preventDefault()
        openMenuAt(e, p.menu(s, p.index))
      }}
    >
      {p.selecting && <Checkbox checked={p.selected} label={`Select ${s.title}`} />}
      {p.view === 'list' && <Thumb song={s} className="h-12 w-9" />}
      <div className={cx('min-w-0 flex-1', p.view === 'compact' && 'flex items-baseline gap-2')}>
        <div className="truncate font-medium leading-snug">{s.title}</div>
        {caption && <div className={cx('truncate text-muted', p.view === 'compact' ? 'text-xs' : 'text-sm')}>{caption}</div>}
      </div>
      {showKey && <Badge>{s.keys[0]}</Badge>}
      {p.fields.includes('duration') && s.duration > 0 && (
        <span className="hidden w-11 text-right text-xs tabular-nums text-muted sm:block">{formatDuration(s.duration)}</span>
      )}
      {p.fields.includes('rating') && (
        <span className="hidden w-[68px] justify-end lg:flex">
          <Stars value={s.rating} />
        </span>
      )}
      {!p.selecting && (
        <>
          <button
            type="button"
            aria-label={s.favorite ? 'Remove from favorites' : 'Add to favorites'}
            title={s.favorite ? 'Remove from favorites' : 'Add to favorites'}
            aria-pressed={s.favorite}
            className={cx(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-surface-3',
              s.favorite ? 'text-accent' : 'text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:hidden',
            )}
            onClick={(e) => {
              e.stopPropagation()
              setFavorite([s.id], !s.favorite)
            }}
          >
            <Heart className={cx('size-4', s.favorite && 'fill-current')} />
          </button>
          <IconButton
            label="More actions"
            size="sm"
            className="text-muted!"
            onClick={(e) => {
              e.stopPropagation()
              openMenuAt(e.currentTarget, p.menu(s, p.index))
            }}
          >
            <MoreVertical className="size-4" />
          </IconButton>
        </>
      )}
    </div>
  )
})

const GridCard = memo(function GridCard(p: RowProps & { left: number; width: number }) {
  const { song: s } = p
  const lp = useLongPress(() => p.onLong(p.index))
  return (
    <div
      role="row"
      tabIndex={0}
      data-row={p.index}
      aria-selected={p.selecting ? p.selected : undefined}
      style={{ top: p.top, left: p.left, width: p.width, height: p.height }}
      className={cx(
        'no-select group absolute flex cursor-pointer flex-col gap-1.5 rounded-xl p-2 outline-none',
        p.selected ? 'bg-accent-soft' : 'hover:bg-surface-2 focus-visible:bg-surface-2',
      )}
      {...lp.handlers}
      onClick={(e) => {
        if (lp.consumed()) return
        p.onActivate(p.index, e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          p.onActivate(p.index, e)
        }
      }}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return
        e.preventDefault()
        openMenuAt(e, p.menu(s, p.index))
      }}
    >
      <div className="relative min-h-0 flex-1">
        <Thumb song={s} className="size-full" />
        {p.selecting && (
          <span className="absolute left-1.5 top-1.5">
            <Checkbox checked={p.selected} label={`Select ${s.title}`} />
          </span>
        )}
        {s.favorite && <Heart className="absolute right-1.5 top-1.5 size-4 fill-accent text-accent drop-shadow" />}
        {s.keys[0] && <Badge className="absolute bottom-1.5 right-1.5 shadow-sm">{s.keys[0]}</Badge>}
      </div>
      <div className="min-w-0 px-0.5">
        <div className="truncate text-sm font-medium">{s.title}</div>
        <div className="truncate text-xs text-muted">{p.caption ?? (songCaption(s, p.fields) || ' ')}</div>
      </div>
    </div>
  )
})

/* ------------------------------------------------------------------ List */

export interface SongListProps {
  songs: Song[]
  selection: Selection
  /** Letter → first row; null hides the A–Z index. */
  letters: Map<string, number> | null
  onOpen: (index: number) => void
  menu: (song: Song, index: number) => MenuItem[]
  caption?: (song: Song) => ReactNode
  /** Rendered above the rows inside the scroller (e.g. a recent-setlists strip). */
  header?: ReactNode
}

export function SongList({ songs, selection, letters, onOpen, menu, caption, header }: SongListProps) {
  const view = useSettings((s) => s.s.libraryView)
  const fields = useSettings((s) => s.s.listFields)
  const ref = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [headerH, setHeaderH] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      setHeaderH(headerRef.current?.offsetHeight ?? 0)
    })
    ro.observe(el)
    if (headerRef.current) ro.observe(headerRef.current)
    return () => ro.disconnect()
  }, [])

  const grid = view === 'grid'
  const cols = grid ? Math.max(2, Math.floor((width - 16) / 168)) : 1
  const cellW = grid ? Math.floor((width - 16) / cols) : 0
  const rowH = grid ? Math.round(cellW * 1.3 + 44) : view === 'compact' ? 44 : 64
  const rows = Math.ceil(songs.length / cols)
  const win = useWindow(ref, rows, rowH, headerH)
  const showIndex = !!letters && letters.size > 1 && !grid

  const { selecting, toggle, start } = selection
  const onActivate = useCallback(
    (i: number, e: MouseEvent | KeyboardEvent) => {
      const id = songs[i].id
      const mod = 'metaKey' in e && (e.metaKey || e.ctrlKey)
      if (selecting || mod || e.shiftKey) {
        if ('key' in e && e.key === 'Enter' && selecting) return toggle(id)
        toggle(id, e.shiftKey)
      } else onOpen(i)
    },
    [songs, selecting, toggle, onOpen],
  )
  const onLong = useCallback((i: number) => start(songs[i].id), [songs, start])

  const jump = useCallback(
    (row: number) => {
      if (ref.current) ref.current.scrollTop = headerH + Math.floor(row / cols) * rowH
    },
    [cols, rowH, headerH],
  )

  // Keep the list position sane when the list shrinks a lot (e.g. after typing a search).
  useEffect(() => {
    const el = ref.current
    if (el && el.scrollTop > rows * rowH) el.scrollTop = 0
  }, [rows, rowH])

  const items: ReactNode[] = []
  for (let r = win.start; r < win.end; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const s = songs[i]
      if (!s) break
      const common = {
        song: s,
        index: i,
        top: r * rowH,
        height: rowH,
        view: (view === 'compact' ? 'compact' : 'list') as 'list' | 'compact',
        fields,
        selecting,
        selected: selection.selected.has(s.id),
        caption: caption?.(s),
        padRight: showIndex,
        onActivate,
        onLong,
        menu,
      }
      items.push(grid ? <GridCard key={s.id} {...common} left={8 + c * cellW} width={cellW} /> : <SongRow key={s.id} {...common} />)
    }
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="absolute inset-0 overflow-y-auto overscroll-contain" role="grid" aria-rowcount={songs.length}>
        {header && <div ref={headerRef}>{header}</div>}
        <div className="relative" style={{ height: win.total + (grid ? 16 : 0) }}>
          {items}
        </div>
      </div>
      {showIndex && <AlphaIndex index={letters!} onJump={jump} />}
    </div>
  )
}
