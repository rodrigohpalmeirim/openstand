import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronLeft,
  CalendarDays,
  Coffee,
  GripVertical,
  ListPlus,
  MessageSquareText,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Shuffle,
  SortAsc,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { uid } from '../../db/db'
import type { Setlist, SetlistEntry, Song } from '../../db/schema'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { Button, cx, Empty, IconButton, Menu, promptDialog, toast, useMenu, type MenuItem } from '../../ui/primitives'
import { Thumb } from '../Thumb'
import { useLibrary, useSortOptions } from './data'
import { collator, formatDuration, formatTotal, keyRank, moveItem, shuffled, sortTitle } from './logic'
import { addToSetlist, perform, performSetlist, updateSetlist } from './ops'
import { formatGigDate, setlistMenu, setlistStats, SetlistDetailsDialog } from './SetlistsView'
import { SongPicker } from './SongPicker'
import { songCaption } from './SongList'
import { useTerms } from './terms'
import { ui } from './ui'
import { Badge, openMenuAt } from './widgets'

/* --------------------------------------------------------------- Reorder */

interface Drag {
  from: number
  to: number
  dy: number
  h: number
}

/**
 * Pointer-based drag-to-reorder for a vertical list (mouse, touch and pen). The handle gets
 * `touch-action: none` so dragging it never scrolls; the scroller auto-scrolls near its edges.
 */
function useReorder(scroller: React.RefObject<HTMLDivElement | null>, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const st = useRef<{ from: number; startY: number; startScroll: number; mids: number[]; top: number; h: number; y: number; raf: number; to: number } | null>(null)

  const update = () => {
    const s = st.current
    const el = scroller.current
    if (!s || !el) return
    const dy = s.y - s.startY + (el.scrollTop - s.startScroll)
    const center = s.top + s.h / 2 + dy
    let to = s.from
    for (let j = 0; j < s.mids.length; j++) {
      if (j < s.from && center < s.mids[j]) to = Math.min(to, j)
      if (j > s.from && center > s.mids[j]) to = Math.max(to, j)
    }
    s.to = to
    setDrag({ from: s.from, to, dy, h: s.h })
  }

  const tick = () => {
    const s = st.current
    const el = scroller.current
    if (!s || !el) return
    const r = el.getBoundingClientRect()
    const edge = 56
    let v = 0
    if (s.y < r.top + edge) v = -Math.ceil(((r.top + edge - s.y) / edge) * 14)
    else if (s.y > r.bottom - edge) v = Math.ceil(((s.y - (r.bottom - edge)) / edge) * 14)
    if (v) {
      el.scrollTop += v
      update()
    }
    s.raf = requestAnimationFrame(tick)
  }

  const start = (i: number, e: RPointerEvent<HTMLElement>) => {
    const el = scroller.current
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const base = el.getBoundingClientRect().top - el.scrollTop
    const rows = [...el.querySelectorAll<HTMLElement>('[data-entry]')].map((r) => r.getBoundingClientRect())
    const mine = rows[i]
    st.current = {
      from: i,
      to: i,
      startY: e.clientY,
      y: e.clientY,
      startScroll: el.scrollTop,
      mids: rows.map((r) => r.top - base + r.height / 2),
      top: mine.top - base,
      h: mine.height,
      raf: requestAnimationFrame(tick),
    }
    setDrag({ from: i, to: i, dy: 0, h: mine.height })
  }
  const move = (e: RPointerEvent) => {
    if (!st.current) return
    st.current.y = e.clientY
    update()
  }
  const end = () => {
    const s = st.current
    if (!s) return
    cancelAnimationFrame(s.raf)
    st.current = null
    setDrag(null)
    if (s.to !== s.from) onMove(s.from, s.to)
  }

  const offset = (k: number) => {
    if (!drag) return 0
    if (k === drag.from) return drag.dy
    if (drag.from < drag.to && k > drag.from && k <= drag.to) return -drag.h
    if (drag.to < drag.from && k >= drag.to && k < drag.from) return drag.h
    return 0
  }
  return { drag, handle: (i: number) => ({ onPointerDown: (e: RPointerEvent<HTMLElement>) => start(i, e), onPointerMove: move, onPointerUp: end, onPointerCancel: end }), offset }
}

/* ------------------------------------------------------------------ Rows */

function EntryRow({
  e,
  song,
  num,
  index,
  last,
  offset,
  dragging,
  animate,
  handle,
  onOpen,
  menu,
  onKeyMove,
}: {
  e: SetlistEntry
  song?: Song
  num: number
  index: number
  last: number
  offset: number
  dragging: boolean
  animate: boolean
  handle: ReturnType<ReturnType<typeof useReorder>['handle']>
  onOpen: () => void
  menu: () => MenuItem[]
  onKeyMove: (to: number) => void
}) {
  const style = { transform: offset ? `translateY(${offset}px)` : undefined, transition: animate && !dragging ? 'transform 150ms ease' : undefined }
  const grip = (
    <button
      type="button"
      aria-label={`Reorder ${song?.title ?? e.breakLabel ?? 'break'} (use arrow keys)`}
      data-grip={e.key}
      className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-faint hover:text-fg active:cursor-grabbing"
      {...handle}
      onKeyDown={(ev) => {
        if (ev.key === 'ArrowUp' && index > 0) {
          ev.preventDefault()
          onKeyMove(index - 1)
        } else if (ev.key === 'ArrowDown' && index < last) {
          ev.preventDefault()
          onKeyMove(index + 1)
        }
      }}
    >
      <GripVertical className="size-4" />
    </button>
  )
  const ctx = (ev: React.MouseEvent) => {
    ev.preventDefault()
    openMenuAt(ev, menu())
  }
  if (e.isBreak) {
    return (
      <div
        data-entry
        style={style}
        onContextMenu={ctx}
        className={cx('relative flex items-center gap-2 border-b border-line/60 bg-surface-2/60 py-1.5 pl-1 pr-2 md:pl-2', dragging && 'z-10 shadow-xl ring-1 ring-accent')}
      >
        {grip}
        <Coffee className="size-4 text-muted" />
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="truncate text-sm font-semibold uppercase tracking-wide text-muted">{e.breakLabel || 'Set break'}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <IconButton size="sm" label="Break actions" className="text-muted!" onClick={(ev) => openMenuAt(ev.currentTarget, menu())}>
          <MoreVertical className="size-4" />
        </IconButton>
      </div>
    )
  }
  return (
    <div
      data-entry
      style={style}
      onContextMenu={ctx}
      className={cx(
        'group relative flex items-center gap-2 border-b border-line/60 bg-bg py-1.5 pl-1 pr-2 md:pl-2',
        dragging && 'z-10 bg-surface shadow-xl ring-1 ring-accent',
      )}
    >
      {grip}
      <span className="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-faint">{num}</span>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-0.5 text-left" onClick={onOpen} disabled={!song}>
        {song ? <Thumb song={song} className="h-11 w-8" /> : <div className="h-11 w-8 rounded-md border border-dashed border-line" />}
        <div className="min-w-0 flex-1">
          <div className={cx('truncate font-medium', !song && 'italic text-faint')}>{song?.title ?? 'Missing song (deleted)'}</div>
          {song && <div className="truncate text-sm text-muted">{songCaption(song, ['artists', 'composers'])}</div>}
          {e.note && (
            <div className="flex items-center gap-1 truncate text-xs font-medium text-accent">
              <MessageSquareText className="size-3 shrink-0" /> {e.note}
            </div>
          )}
        </div>
      </button>
      {song?.keys[0] && <Badge>{song.keys[0]}</Badge>}
      {!!song?.duration && <span className="hidden w-11 text-right text-xs tabular-nums text-muted sm:block">{formatDuration(song.duration)}</span>}
      {song && (
        <IconButton size="sm" label="Perform from here" className="text-accent! max-md:hidden md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100" onClick={onOpen}>
          <Play className="size-4 fill-current" />
        </IconButton>
      )}
      <IconButton size="sm" label="Entry actions" className="text-muted!" onClick={(ev) => openMenuAt(ev.currentTarget, menu())}>
        <MoreVertical className="size-4" />
      </IconButton>
    </div>
  )
}

/* ---------------------------------------------------------------- Detail */

export function SetlistDetail({ id }: { id: string }) {
  const t = useTerms()
  const lib = useLibrary()
  const o = useSortOptions()
  const loadEntire = useSettings((s) => s.s.loadEntireList)
  const go = useNav((n) => n.go)
  const sl = lib.setlists.find((s) => s.id === id)
  const [entries, setEntries] = useState<SetlistEntry[]>(sl?.entries ?? [])
  const [picker, setPicker] = useState<number | null>(null)
  const [details, setDetails] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const menu = useMenu()
  const scroller = useRef<HTMLDivElement>(null)

  // Follow DB changes (other tabs, live queries) unless mid-drag.
  useEffect(() => {
    if (sl) setEntries(sl.entries)
  }, [sl])

  const save = (next: SetlistEntry[], undoLabel?: string) => {
    const prev = entries
    setEntries(next)
    updateSetlist(id, { entries: next })
    if (undoLabel) toast(undoLabel, 'info', { label: 'Undo', run: () => updateSetlist(id, { entries: prev }) })
  }
  const re = useReorder(scroller, (from, to) => save(moveItem(entries, from, to)))
  useLayoutEffect(() => {
    if (!focusKey) return
    scroller.current?.querySelector<HTMLElement>(`[data-grip="${focusKey}"]`)?.focus()
    setFocusKey(null)
  }, [focusKey, entries])

  const stats = useMemo(() => (sl ? setlistStats({ ...sl, entries }, lib.byId) : { songs: 0, duration: 0 }), [sl, entries, lib.byId])

  if (!sl) {
    return (
      <Empty icon={<ListPlus className="size-6" />} title="Setlist not found">
        <Button onClick={() => go({ name: 'library', section: 'setlists' })}>Back to setlists</Button>
      </Empty>
    )
  }

  const current: Setlist = { ...sl, entries }
  const exists = (sid: string) => lib.byId.has(sid)
  const open = (i: number) => (loadEntire ? performSetlist(current, i, exists) : perform([entries[i].songId], 0, { setlistId: id }))
  const labels = entries.map((e) => (e.isBreak ? `— ${e.breakLabel || 'Set break'} —` : (lib.byId.get(e.songId)?.title ?? 'Missing song')))

  const addBreak = async (at = entries.length) => {
    const label = await promptDialog({ title: 'Add set break', label: 'Label', initial: 'Set break' })
    if (label === null) return
    const next = [...entries]
    next.splice(at, 0, { key: uid(), songId: '', isBreak: true, breakLabel: label.trim() || 'Set break' })
    save(next)
  }

  const sortBy = (by: 'title' | 'artist' | 'key' | 'duration') => {
    const col = collator()
    const songOf = (e: SetlistEntry) => lib.byId.get(e.songId)
    const cmp = (a: SetlistEntry, b: SetlistEntry) => {
      const x = songOf(a)
      const y = songOf(b)
      if (!x || !y) return x ? -1 : y ? 1 : 0
      const byTitle = col.compare(sortTitle(x, o), sortTitle(y, o))
      if (by === 'artist') return col.compare(x.artists[0] ?? '￿', y.artists[0] ?? '￿') || byTitle
      if (by === 'key') return keyRank(x.keys[0]) - keyRank(y.keys[0]) || byTitle
      if (by === 'duration') return (x.duration || 0) - (y.duration || 0) || byTitle
      return byTitle
    }
    // Breaks stay where they are; songs are sorted within each set.
    save(sortWithinSets(entries, cmp), `Sorted by ${by}`)
  }

  const entryMenu = (e: SetlistEntry, i: number): MenuItem[] => {
    const song = lib.byId.get(e.songId)
    const moves: MenuItem[] = [
      { label: 'Move to top', icon: <ArrowUpToLine className="size-4" />, disabled: i === 0, onSelect: () => save(moveItem(entries, i, 0)) },
      { label: 'Move to bottom', icon: <ArrowDownToLine className="size-4" />, disabled: i === entries.length - 1, onSelect: () => save(moveItem(entries, i, entries.length - 1)) },
    ]
    if (e.isBreak)
      return [
        {
          label: 'Rename break…',
          icon: <Pencil className="size-4" />,
          onSelect: async () => {
            const label = await promptDialog({ title: 'Rename break', label: 'Label', initial: e.breakLabel })
            if (label !== null) save(entries.map((x) => (x.key === e.key ? { ...x, breakLabel: label.trim() || 'Set break' } : x)))
          },
        },
        ...moves,
        { divider: true, label: '' },
        { label: 'Remove break', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => save(entries.filter((x) => x.key !== e.key)) },
      ]
    return [
      { label: 'Perform from here', icon: <Play className="size-4" />, disabled: !song, onSelect: () => performSetlist(current, i, exists) },
      {
        label: e.note ? 'Edit note…' : 'Add note…',
        icon: <MessageSquareText className="size-4" />,
        onSelect: async () => {
          const note = await promptDialog({ title: `Note for “${song?.title ?? 'entry'}” in this setlist`, label: 'Note (e.g. capo 2, segue, solo piano)', initial: e.note ?? '' })
          if (note !== null) save(entries.map((x) => (x.key === e.key ? { ...x, note: note.trim() || undefined } : x)))
        },
      },
      ...moves,
      { label: `Insert ${t.songs} after…`, icon: <ListPlus className="size-4" />, onSelect: () => setPicker(i + 1) },
      { label: 'Insert break after', icon: <Coffee className="size-4" />, onSelect: () => addBreak(i + 1) },
      { label: `Add again (duplicate entry)`, icon: <Plus className="size-4" />, disabled: !song, onSelect: () => save([...entries.slice(0, i + 1), { ...e, key: uid() }, ...entries.slice(i + 1)]) },
      ...(song ? [{ label: `Edit ${t.song}…`, icon: <Pencil className="size-4" />, onSelect: () => ui.edit(song.id) }] : []),
      { divider: true, label: '' },
      {
        label: 'Remove from setlist',
        icon: <X className="size-4" />,
        danger: true,
        onSelect: () => save(entries.filter((x) => x.key !== e.key), `Removed “${song?.title ?? 'entry'}”`),
      },
    ]
  }

  const headerMenu: MenuItem[] = [
    { label: 'Add set break…', icon: <Coffee className="size-4" />, onSelect: () => addBreak() },
    { label: 'Shuffle', icon: <Shuffle className="size-4" />, disabled: entries.length < 2, onSelect: () => save(shuffleWithinSets(entries), 'Shuffled') },
    { label: 'Sort by title', icon: <SortAsc className="size-4" />, onSelect: () => sortBy('title') },
    { label: 'Sort by artist', icon: <SortAsc className="size-4" />, onSelect: () => sortBy('artist') },
    { label: 'Sort by key', icon: <SortAsc className="size-4" />, onSelect: () => sortBy('key') },
    { label: 'Sort by duration', icon: <SortAsc className="size-4" />, onSelect: () => sortBy('duration') },
    { divider: true, label: '' },
    ...setlistMenu(current, lib, t, () => setDetails(true)).filter((m) => m.label !== 'Perform'),
  ]

  let num = 0
  const meta = [t.count(stats.songs), formatTotal(stats.duration), formatGigDate(sl.date), sl.venue].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="flex h-14 items-center gap-1 px-2 md:px-3">
          <IconButton label="Back to setlists" onClick={() => go({ name: 'library', section: 'setlists' })}>
            <ChevronLeft className="size-5" />
          </IconButton>
          <button className="min-w-0 flex-1 rounded-lg px-1 text-left hover:bg-surface-2" onClick={() => setDetails(true)} title="Edit details">
            <h1 className="truncate text-lg font-semibold leading-tight">{sl.name}</h1>
            <div className="truncate text-xs text-muted">{meta}</div>
          </button>
          <Button variant="primary" size="sm" className="h-9 max-sm:px-2.5" disabled={!stats.songs} icon={<Play className="size-4 fill-current" />} onClick={() => performSetlist(current, 0, exists)}>
            <span className="max-sm:hidden">Perform</span>
          </Button>
          <IconButton label={`Add ${t.songs}`} onClick={() => setPicker(entries.length)}>
            <Plus className="size-5" />
          </IconButton>
          <IconButton ref={menu.ref} label="Setlist actions" onClick={menu.toggle}>
            <MoreVertical className="size-5" />
          </IconButton>
          <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} items={headerMenu} />
        </div>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {sl.notes && (
          <button className="flex w-full items-start gap-2 border-b border-line/60 px-4 py-2.5 text-left text-sm text-muted hover:bg-surface-2" onClick={() => setDetails(true)}>
            <CalendarDays className="mt-0.5 size-4 shrink-0" />
            <span className="whitespace-pre-wrap">{sl.notes}</span>
          </button>
        )}
        {entries.length === 0 ? (
          <Empty icon={<ListPlus className="size-6" />} title="This setlist is empty">
            Add {t.songs} in the order you'll play them. Drag the handles to reorder; add set breaks between sets.
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPicker(0)}>
                Add {t.songs}
              </Button>
            </div>
          </Empty>
        ) : (
          <div className="no-select relative">
            {entries.map((e, i) => {
              if (!e.isBreak) num++
              return (
                <EntryRow
                  key={e.key}
                  e={e}
                  song={lib.byId.get(e.songId)}
                  num={num}
                  index={i}
                  last={entries.length - 1}
                  offset={re.offset(i)}
                  dragging={re.drag?.from === i}
                  animate={!!re.drag}
                  handle={re.handle(i)}
                  onOpen={() => open(i)}
                  menu={() => entryMenu(e, i)}
                  onKeyMove={(to) => {
                    save(moveItem(entries, i, to))
                    setFocusKey(e.key)
                  }}
                />
              )
            })}
            <div className="flex flex-wrap gap-2 px-4 py-4">
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setPicker(entries.length)}>
                Add {t.songs}
              </Button>
              <Button size="sm" variant="ghost" icon={<Coffee className="size-4" />} onClick={() => addBreak()}>
                Add set break
              </Button>
            </div>
          </div>
        )}
      </div>
      {picker !== null && (
        <SongPicker
          title={`Add to “${sl.name}”`}
          positions={labels}
          initialPosition={picker}
          exclude={new Set(entries.map((e) => e.songId))}
          onClose={() => setPicker(null)}
          onPick={async (ids, at) => {
            await addToSetlist(id, ids, at)
            toast(`Added ${t.count(ids.length)}`, 'ok')
          }}
        />
      )}
      {details && <SetlistDetailsDialog setlist={sl} onClose={() => setDetails(false)} />}
    </div>
  )
}

/** Apply `fn` to each run of songs between breaks, keeping breaks in place. */
function withinSets(entries: SetlistEntry[], fn: (run: SetlistEntry[]) => SetlistEntry[]): SetlistEntry[] {
  const out: SetlistEntry[] = []
  let run: SetlistEntry[] = []
  for (const e of entries) {
    if (e.isBreak) {
      out.push(...fn(run), e)
      run = []
    } else run.push(e)
  }
  out.push(...fn(run))
  return out
}
const sortWithinSets = (entries: SetlistEntry[], cmp: (a: SetlistEntry, b: SetlistEntry) => number) => withinSets(entries, (r) => [...r].sort(cmp))
const shuffleWithinSets = (entries: SetlistEntry[]) => withinSets(entries, (r) => shuffled(r))
