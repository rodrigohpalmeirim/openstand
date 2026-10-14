import { Bookmark, Save, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { GROUP_FIELDS, type GroupField } from '../../db/schema'
import { useNav } from '../../state/nav'
import { Button, cx, Dialog, IconButton, Input, Popover, promptDialog, confirmDialog, Segmented, Select, toast, useMenu } from '../../ui/primitives'
import { useLibrary, useSortOptions } from './data'
import {
  filterCount,
  groupValues,
  quickGroupValue,
  setQuickGroup,
  sortGroups,
  type GroupFilter,
  type GroupMode,
  type LibraryFilter,
  type SearchField,
} from './logic'
import { getSavedFilters, setSavedFilters, type SavedFilter } from './ops'
import { useTerms } from './terms'
import { Checkbox } from './widgets'

const QUICK: GroupField[] = ['keys', 'genres', 'collections', 'sources']

function useValues(field: GroupField) {
  const { songs, extraCollections } = useLibrary()
  const o = useSortOptions()
  return useMemo(() => {
    const vals = groupValues(songs, field)
    if (field === 'collections') for (const c of extraCollections) if (!vals.some((v) => v.name === c)) vals.push({ name: c, count: 0, duration: 0 })
    return sortGroups(vals, 'name-asc', field, o).map((v) => v.name)
  }, [songs, extraCollections, field, o])
}

function QuickSelect({ field, filter, onChange }: { field: GroupField; filter: LibraryFilter; onChange: (f: LibraryFilter) => void }) {
  const t = useTerms()
  const values = useValues(field)
  const cur = quickGroupValue(filter, field)
  const g = filter.groups?.[field]
  const advanced = g && !cur && filterCount({ groups: { [field]: g } }) > 0
  return (
    <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted">
      {t.one(field)}
      <Select
        className={cx('h-8! w-auto! max-w-40 text-xs', (cur || advanced) && 'border-accent text-accent')}
        value={advanced ? '__adv' : (cur ?? '')}
        onChange={(e) => onChange(setQuickGroup(filter, field, e.target.value || null))}
      >
        <option value="">Any</option>
        {advanced && <option value="__adv">Custom…</option>}
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </Select>
    </label>
  )
}

/** Horizontal strip of quick filters (shown under the search box when the filter button is on). */
export function FilterBar({ onAdvanced }: { onAdvanced: () => void }) {
  const filter = useNav((n) => n.filter)
  const setFilter = useNav((n) => n.setFilter)
  const n = filterCount(filter)
  return (
    <div className="flex items-center gap-3 overflow-x-auto px-3 pb-2.5 md:px-4">
      {QUICK.map((f) => (
        <QuickSelect key={f} field={f} filter={filter} onChange={setFilter} />
      ))}
      <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted">
        Difficulty
        <Select
          className={cx('h-8! w-auto! text-xs', filter.difficulty && 'border-accent text-accent')}
          value={filter.difficulty ? `${filter.difficulty[0]}-${filter.difficulty[1]}` : ''}
          onChange={(e) => {
            const v = e.target.value
            setFilter({ ...filter, difficulty: v ? (v.split('-').map(Number) as [number, number]) : undefined })
          }}
        >
          <option value="">Any</option>
          {filter.difficulty && filter.difficulty[0] !== filter.difficulty[1] && (
            <option value={`${filter.difficulty[0]}-${filter.difficulty[1]}`}>
              {filter.difficulty[0]}–{filter.difficulty[1]}
            </option>
          )}
          <option value="1-5">Easy (1–5)</option>
          <option value="6-10">Medium (6–10)</option>
          <option value="11-15">Hard (11–15)</option>
          {Array.from({ length: 15 }, (_, i) => (
            <option key={i} value={`${i + 1}-${i + 1}`}>
              {i + 1}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted">
        Rating
        <Select
          className={cx('h-8! w-auto! text-xs', !!filter.minRating && 'border-accent text-accent')}
          value={filter.minRating ?? ''}
          onChange={(e) => setFilter({ ...filter, minRating: Number(e.target.value) || undefined })}
        >
          <option value="">Any</option>
          {[1, 2, 3, 4, 5].map((r) => (
            <option key={r} value={r}>
              {'★'.repeat(r)}
              {r < 5 ? '+' : ''}
            </option>
          ))}
        </Select>
      </label>
      <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-3.5" />} onClick={onAdvanced} className="shrink-0">
        More filters
      </Button>
      <SavedFilters />
      {n > 0 && (
        <Button size="sm" variant="ghost" className="shrink-0 text-accent" onClick={() => setFilter({})}>
          Clear all
        </Button>
      )}
    </div>
  )
}

/** Removable chips describing the active filter. */
export function FilterChips() {
  const t = useTerms()
  const filter = useNav((n) => n.filter)
  const setFilter = useNav((n) => n.setFilter)
  const chips: { label: string; clear: () => void }[] = []
  for (const [field, g] of Object.entries(filter.groups ?? {}) as [GroupField, GroupFilter][]) {
    if (!g) continue
    const name = t.one(field)
    const label =
      g.mode === 'assigned'
        ? `Has ${name.toLowerCase()}`
        : g.mode === 'unassigned'
          ? `No ${name.toLowerCase()}`
          : g.values.length
            ? `${name}${g.mode === 'exclude' ? ' ≠ ' : ': '}${g.values.join(' / ')}`
            : ''
    if (!label) continue
    chips.push({
      label,
      clear: () => {
        const groups = { ...filter.groups }
        delete groups[field]
        setFilter({ ...filter, groups })
      },
    })
  }
  if (filter.difficulty)
    chips.push({ label: `Difficulty ${filter.difficulty[0]}${filter.difficulty[1] !== filter.difficulty[0] ? `–${filter.difficulty[1]}` : ''}`, clear: () => setFilter({ ...filter, difficulty: undefined }) })
  if (filter.minRating) chips.push({ label: `${'★'.repeat(filter.minRating)}${filter.minRating < 5 ? '+' : ''}`, clear: () => setFilter({ ...filter, minRating: undefined }) })
  if (filter.audio) chips.push({ label: filter.audio === 'has' ? 'Has audio' : 'No audio', clear: () => setFilter({ ...filter, audio: undefined }) })
  if (filter.metronome)
    chips.push({ label: filter.metronome === 'configured' ? 'Metronome set' : 'No metronome', clear: () => setFilter({ ...filter, metronome: undefined }) })
  if (filter.favorite) chips.push({ label: 'Favorites', clear: () => setFilter({ ...filter, favorite: undefined }) })
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 md:px-4">
      {chips.map((c) => (
        <span key={c.label} className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft pl-3 pr-1 text-xs font-medium text-accent">
          {c.label}
          <button aria-label={`Remove filter ${c.label}`} className="flex size-5 items-center justify-center rounded-full hover:bg-accent/15" onClick={c.clear}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button className="h-7 px-2 text-xs font-medium text-muted hover:text-fg" onClick={() => setFilter({})}>
        Clear
      </button>
    </div>
  )
}

/* ------------------------------------------------------- Advanced dialog */

const MODES: { value: GroupMode | 'off'; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'include', label: 'Include' },
  { value: 'exclude', label: 'Exclude' },
  { value: 'assigned', label: 'Any' },
  { value: 'unassigned', label: 'None' },
]

function GroupFilterEditor({ field, value, onChange }: { field: GroupField; value?: GroupFilter; onChange: (g?: GroupFilter) => void }) {
  const t = useTerms()
  const values = useValues(field)
  const [q, setQ] = useState('')
  const mode = value?.mode ?? 'off'
  const sel = value?.values ?? []
  const shown = q ? values.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : values
  return (
    <div className="border-b border-line px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t.group(field)}</span>
        <Segmented
          size="sm"
          value={mode}
          options={MODES.map((m) => ({ ...m, title: m.value === 'assigned' ? `Has any ${t.one(field).toLowerCase()}` : m.value === 'unassigned' ? `Has no ${t.one(field).toLowerCase()}` : undefined }))}
          onChange={(m) => onChange(m === 'off' ? undefined : { mode: m, values: m === 'include' || m === 'exclude' ? sel : [] })}
        />
      </div>
      {(mode === 'include' || mode === 'exclude') && (
        <div className="mt-2.5">
          {values.length > 8 && <Input className="mb-2 h-8" placeholder={`Search ${t.group(field).toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />}
          {values.length === 0 && <div className="text-xs text-faint">No values yet.</div>}
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {shown.map((v) => {
              const on = sel.includes(v)
              return (
                <button
                  key={v}
                  onClick={() => onChange({ mode, values: on ? sel.filter((x) => x !== v) : [...sel, v] })}
                  className={cx('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2')}
                >
                  {v}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export function AdvancedFilterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const filter = useNav((n) => n.filter)
  const setFilter = useNav((n) => n.setFilter)
  const setGroup = (f: GroupField, g?: GroupFilter) => {
    const groups = { ...filter.groups }
    if (g) groups[f] = g
    else delete groups[f]
    setFilter({ ...filter, groups })
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Filters"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => setFilter({})}>
            Clear all
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="grid gap-4 border-b border-line px-5 py-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          Audio
          <Select value={filter.audio ?? ''} onChange={(e) => setFilter({ ...filter, audio: (e.target.value || undefined) as LibraryFilter['audio'] })}>
            <option value="">Any</option>
            <option value="has">Has audio</option>
            <option value="none">No audio</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
          Metronome
          <Select value={filter.metronome ?? ''} onChange={(e) => setFilter({ ...filter, metronome: (e.target.value || undefined) as LibraryFilter['metronome'] })}>
            <option value="">Any</option>
            <option value="configured">Configured</option>
            <option value="none">Not configured</option>
          </Select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox checked={!!filter.favorite} onChange={() => setFilter({ ...filter, favorite: filter.favorite ? undefined : true })} />
          <span onClick={() => setFilter({ ...filter, favorite: filter.favorite ? undefined : true })}>Favorites only</span>
        </label>
      </div>
      {GROUP_FIELDS.map((f) => (
        <GroupFilterEditor key={f} field={f} value={filter.groups?.[f]} onChange={(g) => setGroup(f, g)} />
      ))}
    </Dialog>
  )
}

/* ---------------------------------------------------------- Saved filters */

export function SavedFilters() {
  const m = useMenu()
  const saved = useLiveQuery(() => getSavedFilters(), []) ?? []
  const nav = useNav()
  const save = async () => {
    const name = (await promptDialog({ title: 'Save filter', label: 'Filter name' }))?.trim()
    if (!name) return
    const existing = saved.find((f) => f.name.toLowerCase() === name.toLowerCase())
    if (existing && !(await confirmDialog({ title: `Replace “${existing.name}”?`, message: 'A saved filter with this name already exists.', confirmLabel: 'Replace' }))) return
    const entry: SavedFilter = { name, query: nav.query, field: nav.searchField, filter: nav.filter }
    await setSavedFilters([...saved.filter((f) => f !== existing), entry])
    toast(`Saved filter “${name}”`, 'ok')
  }
  const load = (f: SavedFilter) => {
    nav.setFilter(f.filter)
    nav.setQuery(f.query)
    nav.setSearchField(f.field as SearchField)
    m.close()
  }
  const canSave = filterCount(nav.filter) > 0 || !!nav.query.trim()
  return (
    <>
      <Button ref={m.ref} size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={m.toggle} className="shrink-0">
        Saved{saved.length ? ` (${saved.length})` : ''}
      </Button>
      <Popover anchor={m.anchor} open={m.open} onClose={m.close} align="start" className="w-64">
        {saved.length === 0 && <div className="px-3 py-2 text-sm text-muted">No saved filters yet.</div>}
        {saved.map((f) => (
          <div key={f.name} className="flex items-center gap-1 rounded-lg hover:bg-surface-2">
            <button className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm" onClick={() => load(f)}>
              {f.name}
            </button>
            <IconButton
              size="sm"
              label={`Delete ${f.name}`}
              className="text-muted!"
              onClick={() => setSavedFilters(saved.filter((x) => x !== f))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        ))}
        <div className="my-1 h-px bg-line" />
        <button
          disabled={!canSave}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-40"
          onClick={() => {
            m.close()
            save()
          }}
        >
          <Save className="size-4 text-muted" /> Save current filter…
        </button>
      </Popover>
    </>
  )
}
