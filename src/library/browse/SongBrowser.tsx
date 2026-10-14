import {
  ArrowDownUp,
  CheckSquare,
  ChevronLeft,
  Filter,
  FolderPlus,
  Heart,
  LayoutGrid,
  ListMusic,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Play,
  Rows3,
  Search,
  SlidersHorizontal,
  StretchHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Song } from '../../db/schema'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { Button, cx, IconButton, Input, Menu, promptDialog, toast, useMenu, type MenuItem } from '../../ui/primitives'
import { useSortOptions } from './data'
import { AdvancedFilterDialog, FilterBar, FilterChips } from './filters'
import {
  buildLetterIndex,
  defaultDir,
  filterCount,
  indexSource,
  matchesFilter,
  matchesTerms,
  queryTerms,
  SEARCH_FIELDS,
  searchText,
  sortSongs,
  sortTitle,
  type SearchField,
  type SortField,
  type SortSpec,
} from './logic'
import { createSetlist, perform, setFavorite } from './ops'
import { confirmDelete, exportItems, openSetlist, songMenu } from './songActions'
import { SongList, useSelection } from './SongList'
import { useTerms, type Terms } from './terms'
import { ui } from './ui'
import { DrawerButton } from './widgets'

/* Search haystacks are cached per song object; Dexie hands out new objects after every change. */
const hayCache = new Map<SearchField, WeakMap<Song, string>>()
function hay(s: Song, f: SearchField) {
  let m = hayCache.get(f)
  if (!m) hayCache.set(f, (m = new WeakMap()))
  let h = m.get(s)
  if (h === undefined) m.set(s, (h = searchText(s, f)))
  return h
}

export function filterSongs(songs: Song[], query: string, field: SearchField, filter: Parameters<typeof matchesFilter>[1]) {
  const terms = queryTerms(query)
  const active = filterCount(filter) > 0
  if (!terms.length && !active) return songs
  return songs.filter((s) => (!active || matchesFilter(s, filter)) && (!terms.length || matchesTerms(hay(s, field), terms)))
}

const SORTS: { field: SortField; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'artist', label: 'Artist' },
  { field: 'key', label: 'Key' },
  { field: 'createdAt', label: 'Date added' },
  { field: 'modifiedAt', label: 'Date modified' },
  { field: 'lastPlayedAt', label: 'Last played' },
  { field: 'playCount', label: 'Play count' },
  { field: 'rating', label: 'Rating' },
  { field: 'difficulty', label: 'Difficulty' },
  { field: 'duration', label: 'Duration' },
]

function SortMenu({ sort, onChange }: { sort: SortSpec; onChange: (s: SortSpec) => void }) {
  const m = useMenu()
  const items: MenuItem[] = [
    ...SORTS.map((s) => ({ label: s.label, checked: sort.field === s.field, onSelect: () => onChange({ field: s.field, dir: defaultDir(s.field) }) })),
    { divider: true, label: '' },
    { label: 'Ascending', checked: sort.dir === 'asc', onSelect: () => onChange({ ...sort, dir: 'asc' }) },
    { label: 'Descending', checked: sort.dir === 'desc', onSelect: () => onChange({ ...sort, dir: 'desc' }) },
  ]
  return (
    <>
      <IconButton ref={m.ref} label={`Sort: ${SORTS.find((s) => s.field === sort.field)?.label}`} onClick={m.toggle}>
        <ArrowDownUp className="size-5" />
      </IconButton>
      <Menu anchor={m.anchor} open={m.open} onClose={m.close} items={items} />
    </>
  )
}

const CAPTION_CHOICES = ['artists', 'composers', 'albums', 'genres', 'collections', 'sources', 'years', 'tags', 'custom']

export function ViewMenu() {
  const m = useMenu()
  const t = useTerms()
  const s = useSettings((st) => st.s)
  const set = useSettings((st) => st.set)
  const toggleField = (f: string) => set({ listFields: s.listFields.includes(f) ? s.listFields.filter((x) => x !== f) : [...s.listFields, f] })
  const items: MenuItem[] = [
    { label: 'List', icon: <Rows3 className="size-4" />, checked: s.libraryView === 'list', onSelect: () => set({ libraryView: 'list' }) },
    { label: 'Compact', icon: <StretchHorizontal className="size-4" />, checked: s.libraryView === 'compact', onSelect: () => set({ libraryView: 'compact' }) },
    { label: 'Grid', icon: <LayoutGrid className="size-4" />, checked: s.libraryView === 'grid', onSelect: () => set({ libraryView: 'grid' }) },
    { divider: true, label: '' },
    ...CAPTION_CHOICES.map((f) => ({ label: `Show ${t.group(f as 'artists').toLowerCase()}`, checked: s.listFields.includes(f), onSelect: () => toggleField(f) })),
    { label: 'Show key', checked: s.listFields.includes('keys'), onSelect: () => toggleField('keys') },
    { label: 'Show duration', checked: s.listFields.includes('duration'), onSelect: () => toggleField('duration') },
    { label: 'Show rating', checked: s.listFields.includes('rating'), onSelect: () => toggleField('rating') },
    { label: 'A–Z index', checked: s.showAlphabet, onSelect: () => set({ showAlphabet: !s.showAlphabet }) },
    { divider: true, label: '' },
    { label: 'Library preferences…', icon: <SlidersHorizontal className="size-4" />, onSelect: ui.prefs },
  ]
  return (
    <>
      <IconButton ref={m.ref} label="View options" onClick={m.toggle}>
        {s.libraryView === 'grid' ? <LayoutGrid className="size-5" /> : <Rows3 className="size-5" />}
      </IconButton>
      <Menu anchor={m.anchor} open={m.open} onClose={m.close} items={items} />
    </>
  )
}

/** Search box with a field selector; "/" or Ctrl/Cmd+K focuses it. */
export function SearchBox({ placeholder, fields = true }: { placeholder: string; fields?: boolean }) {
  const t = useTerms()
  const query = useNav((n) => n.query)
  const setQuery = useNav((n) => n.setQuery)
  const field = useNav((n) => n.searchField)
  const setField = useNav((n) => n.setSearchField)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        ref.current?.focus()
        ref.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const label = (f: SearchField) => (f === 'all' ? 'All fields' : f === 'title' ? 'Title' : f === 'notes' ? 'Notes' : f === 'keywords' ? 'Keywords' : t.group(f))
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <Search className="pointer-events-none absolute left-3 size-4 text-faint" />
      <Input
        ref={ref}
        type="search"
        aria-label="Search"
        className={cx('pl-9 [&::-webkit-search-cancel-button]:appearance-none', fields ? 'pr-28' : 'pr-9')}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation()
            setQuery('')
          }
        }}
      />
      {query && (
        <button aria-label="Clear search" className={cx('absolute flex size-6 items-center justify-center rounded-full text-faint hover:text-fg', fields ? 'right-24' : 'right-2')} onClick={() => setQuery('')}>
          <X className="size-3.5" />
        </button>
      )}
      {fields && (
        <select
          aria-label="Search in"
          value={field}
          onChange={(e) => setField(e.target.value as SearchField)}
          className="absolute right-1 h-8 max-w-[5.5rem] truncate rounded-md bg-transparent px-1.5 text-xs font-medium text-muted outline-none hover:bg-surface-2"
        >
          {SEARCH_FIELDS.map((f) => (
            <option key={f} value={f}>
              {label(f)}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/* ------------------------------------------------------- Selection bar */

function selectionItems(ids: string[], t: Terms, title: string, extra: MenuItem[], clear: () => void): MenuItem[] {
  return [
    { label: 'Perform selection', icon: <Play className="size-4" />, onSelect: () => perform(ids) },
    { label: 'Add to setlist…', icon: <ListPlus className="size-4" />, onSelect: () => ui.addTo('setlist', ids) },
    {
      label: 'New setlist from selection…',
      icon: <ListMusic className="size-4" />,
      onSelect: async () => {
        const name = (await promptDialog({ title: 'New setlist', label: 'Setlist name' }))?.trim()
        if (!name) return
        const id = await createSetlist(name, ids)
        clear()
        toast(`Created “${name}” with ${t.count(ids.length)}`, 'ok', { label: 'Open', run: () => openSetlist(id) })
      },
    },
    { label: 'Add to collection…', icon: <FolderPlus className="size-4" />, onSelect: () => ui.addTo('collection', ids) },
    { label: 'Add to favorites', icon: <Heart className="size-4" />, onSelect: () => setFavorite(ids, true) },
    { label: 'Remove from favorites', icon: <Heart className="size-4" />, onSelect: () => setFavorite(ids, false) },
    { label: 'Batch edit…', icon: <Pencil className="size-4" />, onSelect: () => ui.batch(ids) },
    ...extra,
    { divider: true, label: '' },
    ...exportItems(ids, title),
    { divider: true, label: '' },
    { label: `Delete ${ids.length === 1 ? t.song : t.songs}…`, icon: <Trash2 className="size-4" />, danger: true, onSelect: () => confirmDelete(ids, t).then((ok) => ok && clear()) },
  ]
}

function SelectionBar({ ids, total, onAll, onClear, items }: { ids: string[]; total: number; onAll: () => void; onClear: () => void; items: MenuItem[] }) {
  const more = useMenu()
  const none = ids.length === 0
  const btn = (label: string, icon: ReactNode, onClick: () => void, cls = '') => (
    <Button variant="ghost" size="sm" disabled={none} onClick={onClick} className={cx('h-10 px-2.5 lg:px-3', cls)} title={label} aria-label={label}>
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </Button>
  )
  return (
    <div className="flex h-14 items-center gap-1 border-b border-line bg-accent-soft px-2 md:px-3">
      <IconButton label="Exit selection" onClick={onClear}>
        <X className="size-5" />
      </IconButton>
      <div className="min-w-0 flex-1 truncate text-sm font-semibold">{ids.length} selected</div>
      <Button variant="ghost" size="sm" className="h-10" onClick={ids.length === total ? onClear : onAll}>
        {ids.length === total ? 'None' : 'All'}
      </Button>
      {btn('Perform', <Play className="size-4" />, () => perform(ids))}
      {btn('Add to setlist', <ListPlus className="size-4" />, () => ui.addTo('setlist', ids))}
      {btn('Favorite', <Heart className="size-4" />, () => setFavorite(ids, true), 'max-sm:hidden')}
      {btn('Delete', <Trash2 className="size-4" />, () => items.at(-1)?.onSelect?.(), 'text-danger max-sm:hidden')}
      <IconButton ref={more.ref} label="More actions" disabled={none} onClick={more.toggle}>
        <MoreHorizontal className="size-5" />
      </IconButton>
      <Menu anchor={more.anchor} open={more.open} onClose={more.close} items={items} />
    </div>
  )
}

/* ------------------------------------------------------------- Browser */

export interface SongBrowserProps {
  title: ReactNode
  /** Short plain-text title for exports. */
  exportTitle?: string
  subtitle?: ReactNode
  base: Song[]
  back?: () => void
  /** Extra header buttons (e.g. a group menu). */
  actions?: ReactNode
  /** false = keep the order of `base` (Recent). */
  sortable?: boolean
  selectionExtra?: (ids: string[], clear: () => void) => MenuItem[]
  rowExtra?: (song: Song) => MenuItem[]
  caption?: (song: Song) => ReactNode
  empty: ReactNode
  header?: ReactNode
}

export function SongBrowser(p: SongBrowserProps) {
  const t = useTerms()
  const query = useDeferredValue(useNav((n) => n.query))
  const field = useNav((n) => n.searchField)
  const filter = useNav((n) => n.filter)
  const sort = useSettings((s) => s.s.librarySort) as SortSpec
  const showAlphabet = useSettings((s) => s.s.showAlphabet)
  const loadEntire = useSettings((s) => s.s.loadEntireList)
  const setSettings = useSettings((s) => s.set)
  const o = useSortOptions()
  const [filtersOpen, setFiltersOpen] = useState(() => filterCount(filter) > 0)
  const [advanced, setAdvanced] = useState(false)
  const sortable = p.sortable !== false

  const list = useMemo(() => {
    const f = filterSongs(p.base, query, field, filter)
    return sortable ? sortSongs(f, sort, o) : f
  }, [p.base, query, field, filter, sort, o, sortable])
  const ids = useMemo(() => list.map((s) => s.id), [list])
  const sel = useSelection(ids)

  const letters = useMemo(() => {
    if (!showAlphabet || !sortable) return null
    const src = indexSource(sort)
    if (!src) return null
    return buildLetterIndex(list.map((s) => (src === 'title' ? sortTitle(s, o) : (s.artists[0] ?? s.composers[0] ?? ''))))
  }, [list, sort, o, showAlphabet, sortable])

  const onOpen = useCallback((i: number) => (loadEntire ? perform(ids, i) : perform([ids[i]])), [ids, loadEntire])
  const { rowExtra } = p
  const menu = useCallback((s: Song, i: number) => songMenu(s, t, { queue: loadEntire ? ids : undefined, editQueue: ids, index: i, extra: rowExtra?.(s) }), [t, ids, loadEntire, rowExtra])

  // Selection keyboard shortcuts.
  const selRef = useRef(sel)
  selRef.current = sel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = selRef.current
      const typing = e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)
      if (typing) return
      if (e.key === 'Escape' && s.selecting) s.clear()
      else if (e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        s.start()
        s.setAll(ids)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selecting && s.selected.size) {
        confirmDelete([...s.selected], t).then((ok) => ok && s.clear())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ids, t])

  const selected = useMemo(() => ids.filter((id) => sel.selected.has(id)), [ids, sel.selected])
  const nFilters = filterCount(filter)
  const searching = !!query.trim() || nFilters > 0
  const exportTitle = p.exportTitle ?? (typeof p.title === 'string' ? p.title : t.Songs)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        {sel.selecting ? (
          <SelectionBar
            ids={selected}
            total={ids.length}
            onAll={() => sel.setAll(ids)}
            onClear={sel.clear}
            items={selectionItems(selected, t, exportTitle, p.selectionExtra?.(selected, sel.clear) ?? [], sel.clear)}
          />
        ) : (
          <div className="flex h-14 items-center gap-1 px-2 md:px-3">
            {!p.back && <DrawerButton />}
            {p.back && (
              <IconButton label="Back" onClick={p.back}>
                <ChevronLeft className="size-5" />
              </IconButton>
            )}
            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-lg font-semibold leading-tight">{p.title}</h1>
              <div className="truncate text-xs text-muted">
                {searching ? `${list.length.toLocaleString()} of ${t.count(p.base.length)}` : (p.subtitle ?? t.count(p.base.length))}
              </div>
            </div>
            {list.length > 0 && (
              <Button variant="primary" size="sm" className="h-9 max-sm:px-2.5" icon={<Play className="size-4 fill-current" />} onClick={() => perform(ids)} title="Perform all">
                <span className="max-sm:hidden">Perform</span>
              </Button>
            )}
            {p.actions}
            <IconButton label="Select" onClick={() => sel.start()} className="max-sm:hidden">
              <CheckSquare className="size-5" />
            </IconButton>
            {sortable && <SortMenu sort={sort} onChange={(s) => setSettings({ librarySort: s })} />}
            <span className={cx('contents', !!p.back && !!p.actions && 'max-sm:hidden')}>
              <ViewMenu />
            </span>
          </div>
        )}
        <div className="flex items-center gap-2 px-3 pb-2.5 md:px-4">
          <SearchBox placeholder={`Search ${t.songs}`} />
          <IconButton label="Filters" active={filtersOpen || nFilters > 0} onClick={() => setFiltersOpen((v) => !v)} className="relative">
            <Filter className="size-5" />
            {nFilters > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-fg">{nFilters}</span>
            )}
          </IconButton>
          <IconButton label="Select" onClick={() => (sel.selecting ? sel.clear() : sel.start())} className="sm:hidden" active={sel.selecting}>
            <CheckSquare className="size-5" />
          </IconButton>
        </div>
        {filtersOpen && <FilterBar onAdvanced={() => setAdvanced(true)} />}
        {!filtersOpen && <FilterChips />}
      </div>
      {list.length === 0 && p.base.length > 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Search className="size-8 text-faint" />
          <div className="font-semibold">No matches</div>
          <div className="text-sm text-muted">Nothing matches your search and filters.</div>
          <Button
            size="sm"
            onClick={() => {
              useNav.getState().setQuery('')
              useNav.getState().setFilter({})
            }}
          >
            Clear search and filters
          </Button>
        </div>
      ) : list.length === 0 ? (
        <div className="flex-1 overflow-y-auto">{p.empty}</div>
      ) : (
        <SongList songs={list} selection={sel} letters={letters} onOpen={onOpen} menu={menu} caption={p.caption} header={p.header} />
      )}
      <AdvancedFilterDialog open={advanced} onClose={() => setAdvanced(false)} />
    </div>
  )
}
