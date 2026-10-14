import { ArrowDownUp, ChevronRight, FileDown, FolderMinus, ListMusic, ListPlus, MoreVertical, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import type { GroupField, Song } from '../../db/schema'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { Button, confirmDialog, cx, Empty, IconButton, Menu, promptDialog, toast, useMenu, type MenuItem } from '../../ui/primitives'
import { useLibrary, useSortOptions } from './data'
import { buildLetterIndex, formatTotal, groupValues, normalize, songHasValue, sortGroups, stripArticle, type GroupSort, type GroupValue } from './logic'
import { addToGroup, createCollection, createSetlist, deleteGroup, perform, removeFromGroup, renameGroup } from './ops'
import { SearchBox, SongBrowser } from './SongBrowser'
import { openSetlist } from './songActions'
import { SongPicker } from './SongPicker'
import { useTerms, type Terms } from './terms'
import { ui } from './ui'
import { AlphaIndex, DrawerButton, openMenuAt, useLongPress, useWindow } from './widgets'

/** Route value for "songs without any value in this group". */
export const NONE = '\u0000none'

function songsIn(songs: Song[], field: GroupField, group: string) {
  return group === NONE ? songs.filter((s) => !(s[field] ?? []).length) : songs.filter((s) => songHasValue(s, field, group))
}

async function renameFlow(field: GroupField, name: string, values: GroupValue[], t: Terms) {
  const to = (await promptDialog({ title: `Rename ${t.one(field).toLowerCase()}`, label: 'New name', initial: name }))?.trim()
  if (!to || to === name) return
  const existing = values.find((v) => normalize(v.name) === normalize(to) && normalize(v.name) !== normalize(name))
  if (
    existing &&
    !(await confirmDialog({
      title: `Merge into “${existing.name}”?`,
      message: `“${existing.name}” already exists. Move all ${t.songs} from “${name}” to “${existing.name}”?`,
      confirmLabel: 'Merge',
    }))
  )
    return
  const target = existing?.name ?? to
  await renameGroup(field, name, target)
  const r = useNav.getState().route
  if (r.name === 'library' && r.group === name) useNav.getState().go({ ...r, group: target })
  toast(existing ? `Merged into “${target}”` : `Renamed to “${target}”`, 'ok')
}

async function deleteFlow(field: GroupField, name: string, count: number, t: Terms) {
  const ok = await confirmDialog({
    title: `Delete ${t.one(field).toLowerCase()} “${name}”?`,
    message: count
      ? `It will be removed from ${t.count(count)}. The ${t.songs} themselves stay in your library.`
      : `This ${t.one(field).toLowerCase()} has no ${t.songs}.`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  await deleteGroup(field, name)
  const r = useNav.getState().route
  if (r.name === 'library' && r.group === name) useNav.getState().go({ name: 'library', section: r.section })
  toast(`Deleted “${name}”`, 'ok')
}

function groupMenu(field: GroupField, g: GroupValue, songs: Song[], values: GroupValue[], t: Terms): MenuItem[] {
  const ids = () => songsIn(songs, field, g.name).map((s) => s.id)
  const none = g.name === NONE
  return [
    { label: `Perform all`, icon: <Play className="size-4" />, disabled: !g.count, onSelect: () => perform(ids()) },
    { label: 'Add all to setlist…', icon: <ListPlus className="size-4" />, disabled: !g.count, onSelect: () => ui.addTo('setlist', ids()) },
    {
      label: 'Create setlist from these',
      icon: <ListMusic className="size-4" />,
      disabled: !g.count,
      onSelect: async () => {
        const name = none ? `No ${t.one(field).toLowerCase()}` : g.name
        const id = await createSetlist(name, ids())
        toast(`Created setlist “${name}”`, 'ok', { label: 'Open', run: () => openSetlist(id) })
      },
    },
    {
      label: 'Export title list',
      icon: <FileDown className="size-4" />,
      disabled: !g.count,
      onSelect: () =>
        import('../../backup/exportSongs')
          .then((m) => m.exportTitleList(ids(), none ? t.group(field) : g.name, 'txt'))
          .catch((e) => toast(String(e), 'error')),
    },
    ...(none
      ? []
      : [
          { divider: true, label: '' },
          { label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: () => renameFlow(field, g.name, values, t) },
          { label: 'Delete…', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => deleteFlow(field, g.name, g.count, t) },
        ]),
  ]
}

const GROUP_SORTS: { value: GroupSort; label: string }[] = [
  { value: 'name-asc', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'count-desc', label: 'Most songs' },
  { value: 'count-asc', label: 'Fewest songs' },
]

function GroupRow({ g, top, label, sub, onOpen, menu }: { g: GroupValue; top: number; label: string; sub: string; onOpen: () => void; menu: () => MenuItem[] }) {
  const lp = useLongPress((e) => openMenuAt(e, menu()))
  const articles = useSortOptions().articles
  const initial = g.name === NONE ? '–' : (stripArticle(g.name, articles).trim()[0] ?? '#').toUpperCase()
  return (
    <div
      role="row"
      tabIndex={0}
      style={{ top, height: 60 }}
      className="no-select group absolute inset-x-0 flex cursor-pointer items-center gap-3 border-b border-line/60 pl-3 pr-8 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 md:pl-4"
      {...lp.handlers}
      onClick={() => !lp.consumed() && onOpen()}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return
        e.preventDefault()
        openMenuAt(e, menu())
      }}
    >
      <div className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold', g.count ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}>
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cx('truncate font-medium', !g.count && 'text-faint', g.name === NONE && 'italic text-muted')}>{label}</div>
        <div className="truncate text-xs text-muted">{sub}</div>
      </div>
      <IconButton
        size="sm"
        label="More actions"
        className="text-muted!"
        onClick={(e) => {
          e.stopPropagation()
          openMenuAt(e.currentTarget, menu())
        }}
      >
        <MoreVertical className="size-4" />
      </IconButton>
      <ChevronRight className="size-4 text-faint" />
    </div>
  )
}

export function GroupListView({ field }: { field: GroupField }) {
  const t = useTerms()
  const { songs, extraCollections } = useLibrary()
  const o = useSortOptions()
  const go = useNav((n) => n.go)
  const query = useDeferredValue(useNav((n) => n.query))
  const sortBy = (useSettings((s) => s.s.groupSort[field]) ?? 'name-asc') as GroupSort
  const setSettings = useSettings((s) => s.set)
  const sortMenu = useMenu()
  const ref = useRef<HTMLDivElement>(null)

  const values = useMemo(() => {
    const v = groupValues(songs, field)
    if (field === 'collections') for (const c of extraCollections) if (!v.some((x) => normalize(x.name) === normalize(c))) v.push({ name: c, count: 0, duration: 0 })
    return v
  }, [songs, field, extraCollections])
  const list = useMemo(() => {
    const q = normalize(query)
    const sorted = sortGroups(q ? values.filter((v) => normalize(v.name).includes(q)) : values, sortBy, field, o)
    const unassigned = q ? 0 : songs.filter((s) => !(s[field] ?? []).length).length
    if (unassigned && values.length) sorted.push({ name: NONE, count: unassigned, duration: 0 })
    return sorted
  }, [values, query, sortBy, field, o, songs])
  const letters = useMemo(
    () => (sortBy.startsWith('name') ? buildLetterIndex(list.map((g) => (g.name === NONE ? '' : stripArticle(g.name, o.ignoreArticles ? o.articles : [])))) : null),
    [list, sortBy, field, o],
  )
  const win = useWindow(ref, list.length, 60)

  const open = (g: GroupValue) => go({ name: 'library', section: field, group: g.name })
  const newCollection = async () => {
    const name = (await promptDialog({ title: 'New collection', label: 'Collection name' }))?.trim()
    if (!name) return
    await createCollection(name)
    go({ name: 'library', section: 'collections', group: name })
  }

  const sub = (g: GroupValue) => {
    const parts = [t.count(g.count)]
    if (g.duration && (field === 'collections' || field === 'albums')) parts.push(formatTotal(g.duration))
    return parts.join(' · ')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="flex h-14 items-center gap-1 px-2 md:px-3">
          <DrawerButton />
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-lg font-semibold leading-tight">{t.group(field)}</h1>
            <div className="truncate text-xs text-muted">{values.length.toLocaleString()} {values.length === 1 ? t.one(field).toLowerCase() : t.group(field).toLowerCase()}</div>
          </div>
          {field === 'collections' && (
            <Button size="sm" variant="primary" className="h-9" icon={<Plus className="size-4" />} onClick={newCollection}>
              <span className="max-sm:hidden">New collection</span>
            </Button>
          )}
          <IconButton ref={sortMenu.ref} label="Sort" onClick={sortMenu.toggle}>
            <ArrowDownUp className="size-5" />
          </IconButton>
          <Menu
            anchor={sortMenu.anchor}
            open={sortMenu.open}
            onClose={sortMenu.close}
            items={GROUP_SORTS.map((s) => ({
              label: s.label.replace('songs', t.songs),
              checked: s.value === sortBy,
              onSelect: () => setSettings({ groupSort: { ...useSettings.getState().s.groupSort, [field]: s.value } }),
            }))}
          />
        </div>
        <div className="flex px-3 pb-2.5 md:px-4">
          <SearchBox placeholder={`Search ${t.group(field).toLowerCase()}`} fields={false} />
        </div>
      </div>
      {list.length === 0 ? (
        <Empty icon={<ListMusic className="size-6" />} title={query ? 'No matches' : `No ${t.group(field).toLowerCase()} yet`}>
          {query
            ? `No ${t.group(field).toLowerCase()} match “${query}”.`
            : field === 'collections'
              ? `Collections group ${t.songs} without an order — e.g. a book, a band, or “Christmas”.`
              : `Set the ${t.one(field).toLowerCase()} in the ${t.song} editor or with batch edit, and it will show up here.`}
          {field === 'collections' && !query && (
            <div className="mt-4">
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={newCollection}>
                New collection
              </Button>
            </div>
          )}
        </Empty>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div ref={ref} className="absolute inset-0 overflow-y-auto overscroll-contain" role="grid">
            <div className="relative" style={{ height: win.total }}>
              {list.slice(win.start, win.end).map((g, k) => (
                <GroupRow
                  key={g.name}
                  g={g}
                  top={(win.start + k) * 60}
                  label={g.name === NONE ? `No ${t.one(field).toLowerCase()}` : g.name}
                  sub={sub(g)}
                  onOpen={() => open(g)}
                  menu={() => groupMenu(field, g, songs, values, t)}
                />
              ))}
            </div>
          </div>
          {letters && letters.size > 1 && <AlphaIndex index={letters} onJump={(row) => ref.current && (ref.current.scrollTop = row * 60)} />}
        </div>
      )}
    </div>
  )
}

export function GroupSongsView({ field, group }: { field: GroupField; group: string }) {
  const t = useTerms()
  const { songs, extraCollections } = useLibrary()
  const go = useNav((n) => n.go)
  const menu = useMenu()
  const [picking, setPicking] = useState(false)
  const base = useMemo(() => songsIn(songs, field, group), [songs, field, group])
  const values = useMemo(() => groupValues(songs, field), [songs, field])
  const none = group === NONE
  const g: GroupValue = { name: group, count: base.length, duration: 0 }
  const title = none ? `No ${t.one(field).toLowerCase()}` : group
  const isCollection = field === 'collections'
  const existsEmpty = isCollection && extraCollections.some((c) => normalize(c) === normalize(group))

  const selectionExtra = useCallback(
    (ids: string[], clear: () => void): MenuItem[] =>
      none
        ? []
        : [
            {
              label: `Remove from “${group}”`,
              icon: <FolderMinus className="size-4" />,
              onSelect: async () => {
                await removeFromGroup(field, group, ids)
                clear()
                toast(`Removed ${t.count(ids.length)} from “${group}”`, 'ok', { label: 'Undo', run: () => addToGroup(field, group, ids) })
              },
            },
          ],
    [none, field, group, t],
  )
  const rowExtra = useCallback(
    (s: Song): MenuItem[] =>
      none ? [] : [{ label: `Remove from “${group}”`, icon: <FolderMinus className="size-4" />, onSelect: () => removeFromGroup(field, group, [s.id]) }],
    [none, field, group],
  )

  return (
    <>
      <SongBrowser
        title={title}
        exportTitle={title}
        subtitle={`${t.one(field)} · ${t.count(base.length)}`}
        base={base}
        back={() => go({ name: 'library', section: field })}
        selectionExtra={selectionExtra}
        rowExtra={rowExtra}
        actions={
          <>
            {isCollection && !none && (
              <IconButton label={`Add ${t.songs}`} onClick={() => setPicking(true)}>
                <Plus className="size-5" />
              </IconButton>
            )}
            <IconButton ref={menu.ref} label={`${t.one(field)} actions`} onClick={menu.toggle}>
              <MoreVertical className="size-5" />
            </IconButton>
            <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} items={groupMenu(field, g, songs, values.length ? values : [g], t)} />
          </>
        }
        empty={
          <Empty icon={<ListMusic className="size-6" />} title={`“${title}” is empty`}>
            {isCollection && existsEmpty ? `Add ${t.songs} to this collection to see them here.` : `No ${t.songs} here any more.`}
            {isCollection && (
              <div className="mt-4">
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPicking(true)}>
                  Add {t.songs}
                </Button>
              </div>
            )}
          </Empty>
        }
      />
      {picking && (
        <SongPicker
          title={`Add to “${group}”`}
          exclude={new Set(base.map((s) => s.id))}
          onClose={() => setPicking(false)}
          onPick={async (ids) => {
            await addToGroup(field, group, ids)
            toast(`Added ${t.count(ids.length)} to “${group}”`, 'ok')
          }}
        />
      )}
    </>
  )
}
