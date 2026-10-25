import { ArrowDownUp, CalendarDays, Copy, ListMusic, MoreVertical, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { Setlist } from '../../db/schema'
import { useNav } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { Button, cx, Dialog, Empty, Field, IconButton, Input, Menu, promptDialog, Textarea, toast, useMenu, type MenuItem } from '../../ui/primitives'
import { useLibrary, type LibraryData } from './data'
import { collator, formatTotal, normalize } from './logic'
import { createSetlist, deleteSetlist, duplicateSetlist, performSetlist, updateSetlist } from './ops'
import { SearchBox } from './SongBrowser'
import { exportItems, openSetlist } from './songActions'
import { useTerms, type Terms } from './terms'
import { DrawerButton, openMenuAt, useLongPress } from './widgets'

export function setlistStats(sl: Setlist, byId: LibraryData['byId']) {
  let songs = 0
  let duration = 0
  for (const e of sl.entries) {
    if (e.isBreak) continue
    const s = byId.get(e.songId)
    if (!s) continue
    songs++
    duration += s.duration || 0
  }
  return { songs, duration }
}

export function formatGigDate(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso + 'T12:00:00')
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export async function newSetlistFlow(ids: string[] = []) {
  const name = (await promptDialog({ title: 'New setlist', label: 'Setlist name' }))?.trim()
  if (!name) return
  const id = await createSetlist(name, ids)
  openSetlist(id)
  return id
}

export async function renameSetlistFlow(sl: Setlist) {
  const name = (await promptDialog({ title: 'Rename setlist', label: 'Name', initial: sl.name }))?.trim()
  if (name && name !== sl.name) await updateSetlist(sl.id, { name })
}

export async function deleteSetlistFlow(sl: Setlist) {
  const undo = await deleteSetlist(sl.id)
  const r = useNav.getState().route
  if (r.name === 'library' && r.setlistId === sl.id) useNav.getState().go({ name: 'library', section: 'setlists' })
  toast(`Deleted “${sl.name}”`, 'info', { label: 'Undo', run: undo })
}

export function setlistMenu(sl: Setlist, lib: LibraryData, t: Terms, editDetails: () => void): MenuItem[] {
  const ids = sl.entries.filter((e) => !e.isBreak && lib.byId.has(e.songId)).map((e) => e.songId)
  void t
  return [
    { label: 'Perform', icon: <Play className="size-4" />, disabled: !ids.length, onSelect: () => performSetlist(sl, 0, (id) => lib.byId.has(id)) },
    { label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: () => renameSetlistFlow(sl) },
    { label: 'Date, venue & notes…', icon: <CalendarDays className="size-4" />, onSelect: editDetails },
    {
      label: 'Duplicate',
      icon: <Copy className="size-4" />,
      onSelect: async () => {
        const id = await duplicateSetlist(sl.id)
        if (id) toast('Setlist duplicated', 'ok', { label: 'Open', run: () => openSetlist(id) })
      },
    },
    { divider: true, label: '' },
    // In setlist order, repeats included: a joined PDF plays through like the setlist.
    ...exportItems(ids, sl.name, { setlistIds: [sl.id] }),
    { divider: true, label: '' },
    { label: 'Delete setlist', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => deleteSetlistFlow(sl) },
  ]
}

export function SetlistDetailsDialog({ setlist, onClose }: { setlist: Setlist; onClose: () => void }) {
  const [name, setName] = useState(setlist.name)
  const [date, setDate] = useState(setlist.date ?? '')
  const [venue, setVenue] = useState(setlist.venue ?? '')
  const [notes, setNotes] = useState(setlist.notes ?? '')
  const save = async () => {
    await updateSetlist(setlist.id, { name: name.trim() || setlist.name, date: date || undefined, venue: venue.trim() || undefined, notes })
    onClose()
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Setlist details"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Venue">
            <Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Line-up, gear, reminders…" />
        </Field>
      </div>
    </Dialog>
  )
}

type SetlistSort = 'name' | 'modified' | 'played' | 'date'
const SORTS: { value: SetlistSort; label: string }[] = [
  { value: 'modified', label: 'Recently changed' },
  { value: 'played', label: 'Recently performed' },
  { value: 'date', label: 'Gig date' },
  { value: 'name', label: 'Name' },
]

function SetlistRow({ sl, lib, t, onDetails }: { sl: Setlist; lib: LibraryData; t: Terms; onDetails: () => void }) {
  const { songs, duration } = setlistStats(sl, lib.byId)
  const menu = () => setlistMenu(sl, lib, t, onDetails)
  const lp = useLongPress((e) => openMenuAt(e, menu()))
  const meta = [t.count(songs), formatTotal(duration), formatGigDate(sl.date), sl.venue].filter(Boolean).join(' · ')
  return (
    <div
      role="row"
      tabIndex={0}
      className="no-select group flex min-h-16 cursor-pointer items-center gap-3 border-b border-line/60 px-3 py-2 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 md:px-4"
      {...lp.handlers}
      onClick={() => !lp.consumed() && openSetlist(sl.id)}
      onKeyDown={(e) => e.key === 'Enter' && openSetlist(sl.id)}
      onContextMenu={(e) => {
        if (e.defaultPrevented) return
        e.preventDefault()
        openMenuAt(e, menu())
      }}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <ListMusic className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{sl.name}</div>
        <div className="truncate text-xs text-muted">{meta}</div>
      </div>
      <IconButton
        label={`Perform ${sl.name}`}
        disabled={!songs}
        className="text-accent!"
        onClick={(e) => {
          e.stopPropagation()
          performSetlist(sl, 0, (id) => lib.byId.has(id))
        }}
      >
        <Play className="size-5 fill-current" />
      </IconButton>
      <IconButton
        size="sm"
        label={`More actions for ${sl.name}`}
        title="More actions"
        className="text-muted!"
        onClick={(e) => {
          e.stopPropagation()
          openMenuAt(e.currentTarget, menu())
        }}
      >
        <MoreVertical className="size-4" />
      </IconButton>
    </div>
  )
}

export function SetlistsView() {
  const t = useTerms()
  const lib = useLibrary()
  const query = useDeferredValue(useNav((n) => n.query))
  const sortBy = (useSettings((s) => s.s.groupSort.setlists) ?? 'modified') as SetlistSort
  const setSettings = useSettings((s) => s.set)
  const sortMenu = useMenu()
  const [details, setDetails] = useState<Setlist | null>(null)

  const list = useMemo(() => {
    const q = normalize(query)
    const col = collator()
    const xs = q ? lib.setlists.filter((s) => normalize(s.name).includes(q) || normalize(s.venue ?? '').includes(q)) : [...lib.setlists]
    const byName = (a: Setlist, b: Setlist) => col.compare(a.name, b.name)
    switch (sortBy) {
      case 'name':
        return xs.sort(byName)
      case 'played':
        return xs.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.modifiedAt - a.modifiedAt)
      case 'date':
        return xs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || byName(a, b))
      default:
        return xs.sort((a, b) => b.modifiedAt - a.modifiedAt)
    }
  }, [lib.setlists, query, sortBy])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="flex h-14 items-center gap-1 px-2 md:px-3">
          <DrawerButton />
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-lg font-semibold leading-tight">Setlists</h1>
            <div className="truncate text-xs text-muted">
              {lib.setlists.length} setlist{lib.setlists.length === 1 ? '' : 's'}
            </div>
          </div>
          <Button size="sm" variant="primary" className="h-9" icon={<Plus className="size-4" />} onClick={() => newSetlistFlow()}>
            <span className="max-sm:hidden">New setlist</span>
          </Button>
          <IconButton ref={sortMenu.ref} label="Sort" onClick={sortMenu.toggle}>
            <ArrowDownUp className="size-5" />
          </IconButton>
          <Menu
            anchor={sortMenu.anchor}
            open={sortMenu.open}
            onClose={sortMenu.close}
            items={SORTS.map((s) => ({
              label: s.label,
              checked: s.value === sortBy,
              onSelect: () => setSettings({ groupSort: { ...useSettings.getState().s.groupSort, setlists: s.value } }),
            }))}
          />
        </div>
        {lib.setlists.length > 0 && (
          <div className="flex px-3 pb-2.5 md:px-4">
            <SearchBox placeholder="Search setlists" fields={false} />
          </div>
        )}
      </div>
      <div className={cx('min-h-0 flex-1 overflow-y-auto')}>
        {list.length === 0 ? (
          <Empty icon={<ListMusic className="size-6" />} title={query ? 'No matches' : 'No setlists yet'}>
            {query ? `No setlists match “${query}”.` : `A setlist is an ordered list of ${t.songs} for a gig, rehearsal or service. ${t.Songs} can appear more than once.`}
            {!query && (
              <div className="mt-4">
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => newSetlistFlow()}>
                  New setlist
                </Button>
              </div>
            )}
          </Empty>
        ) : (
          list.map((sl) => <SetlistRow key={sl.id} sl={sl} lib={lib} t={t} onDetails={() => setDetails(sl)} />)
        )}
      </div>
      {details && <SetlistDetailsDialog setlist={details} onClose={() => setDetails(null)} />}
    </div>
  )
}
