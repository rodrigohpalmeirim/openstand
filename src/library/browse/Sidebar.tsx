import {
  Asterisk,
  BookOpen,
  Bookmark,
  CalendarDays,
  Camera,
  ChevronsUpDown,
  Clock,
  Disc3,
  Divide,
  Feather,
  FolderOpen,
  Heart,
  ListMusic,
  MicVocal,
  Music,
  Music2,
  Music4,
  Palette,
  Plus,
  Settings,
  SlidersHorizontal,
  Tag,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { SyncIndicator } from '../../libsync/ui/SyncIndicator'
import { scanToNewSong } from '../../scan/launch'
import { useNav, type Section } from '../../state/nav'
import { useSettings } from '../../state/settings'
import { Button, cx, IconButton } from '../../ui/primitives'
import { useLibrary } from './data'
import { useLibraries } from './libraries'
import { BROWSE_GROUPS, useTerms } from './terms'
import { ui, useLibraryUI } from './ui'

export const SECTION_ICONS: Record<Section, LucideIcon> = {
  songs: Music,
  recent: Clock,
  favorites: Heart,
  setlists: ListMusic,
  collections: FolderOpen,
  bookmarks: Bookmark,
  artists: MicVocal,
  composers: Feather,
  albums: Disc3,
  genres: Palette,
  keys: Music2,
  signatures: Divide,
  sources: BookOpen,
  years: CalendarDays,
  tags: Tag,
  custom: Asterisk,
  custom2: Asterisk,
}

/** Navigate to a section (clears the search so nothing is silently hidden in the new view). */
export function goSection(section: Section) {
  const n = useNav.getState()
  n.setQuery('')
  n.go({ name: 'library', section })
  useLibraryUI.getState().set({ drawer: false })
}

function Item({ section, label, count, active }: { section: Section; label: string; count?: number; active: boolean }) {
  const Icon = SECTION_ICONS[section]
  return (
    <button
      onClick={() => goSection(section)}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition',
        active ? 'bg-accent-soft font-semibold text-accent' : 'text-fg hover:bg-surface-2',
      )}
    >
      <Icon className={cx('size-[18px] shrink-0', !active && 'text-muted')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <span className={cx('text-xs tabular-nums', active ? 'text-accent' : 'text-faint')}>{count.toLocaleString()}</span>}
    </button>
  )
}

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const t = useTerms()
  const route = useNav((n) => n.route)
  const visible = useSettings((s) => s.s.visibleGroups)
  const { songs, setlists } = useLibrary()
  const { list, active } = useLibraries()
  const current = route.name === 'library' ? route.section : null
  const libName = list.find((l) => l.id === active)?.name ?? 'My Library'

  const counts = useMemo(() => {
    let fav = 0
    let bm = 0
    const coll = new Set<string>()
    for (const s of songs) {
      if (s.favorite) fav++
      for (const b of s.bookmarks ?? []) if (b.showInLibrary) bm++
      for (const c of s.collections) coll.add(c.toLowerCase())
    }
    return { fav, bm, coll: coll.size }
  }, [songs])

  const top = visible.filter((g) => g === 'setlists' || g === 'collections') as Section[]
  const browse = visible.filter((g) => (BROWSE_GROUPS as string[]).includes(g)) as Section[]

  return (
    <nav aria-label="Library" className="flex h-full w-full flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
          <Music4 className="size-[18px]" />
        </div>
        <button
          className="flex min-w-0 flex-1 flex-col rounded-lg px-1.5 py-1 text-left hover:bg-surface-2"
          onClick={() => useLibraryUI.getState().set({ libraries: true })}
          title="Switch library"
        >
          <span className="text-sm font-semibold leading-tight">OpenStand</span>
          <span className="flex items-center gap-1 truncate text-xs text-muted">
            {libName}
            <ChevronsUpDown className="size-3" />
          </span>
        </button>
        {onClose && (
          <IconButton label="Close menu" onClick={onClose}>
            <X className="size-5" />
          </IconButton>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="flex flex-col gap-0.5">
          <Item section="songs" label={t.Songs} count={songs.length} active={current === 'songs'} />
          <Item section="recent" label="Recent" active={current === 'recent'} />
          <Item section="favorites" label="Favorites" count={counts.fav} active={current === 'favorites'} />
          {top.map((g) => (
            <Item key={g} section={g} label={t.section(g)} count={g === 'setlists' ? setlists.length : counts.coll} active={current === g} />
          ))}
          <Item section="bookmarks" label="Bookmarks" count={counts.bm} active={current === 'bookmarks'} />
        </div>
        {browse.length > 0 && (
          <>
            <div className="mb-1 mt-5 flex items-center justify-between px-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Browse by</span>
              <button className="rounded p-1 text-faint hover:text-fg" onClick={ui.prefs} aria-label="Customize sections" title="Customize sections">
                <SlidersHorizontal className="size-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-0.5">
              {browse.map((g) => (
                <Item key={g} section={g} label={t.section(g)} active={current === g} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1 border-t border-line p-2">
        <div className="flex gap-1.5">
          <Button
            variant="primary"
            className="flex-1"
            icon={<Upload className="size-4" />}
            onClick={() => {
              useLibraryUI.getState().set({ drawer: false })
              ui.import()
            }}
          >
            Import
          </Button>
          <IconButton
            label="Scan sheet music"
            className="border border-line"
            onClick={async () => {
              useLibraryUI.getState().set({ drawer: false })
              const id = await scanToNewSong()
              if (id) ui.edit(id, 'fields')
            }}
          >
            <Camera className="size-5" />
          </IconButton>
          <IconButton
            label={`New ${t.song}`}
            className="border border-line"
            onClick={() => {
              useLibraryUI.getState().set({ drawer: false })
              ui.edit(null)
            }}
          >
            <Plus className="size-5" />
          </IconButton>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              useLibraryUI.getState().set({ drawer: false })
              useNav.getState().go({ name: 'settings' })
            }}
            className="flex h-10 flex-1 items-center gap-3 rounded-lg px-3 text-sm text-fg hover:bg-surface-2"
          >
            <Settings className="size-[18px] text-muted" /> Settings
          </button>
          <SyncIndicator />
        </div>
      </div>
    </nav>
  )
}

/** Phone drawer wrapping the sidebar. */
export function Drawer() {
  const open = useLibraryUI((u) => u.drawer)
  const close = () => useLibraryUI.getState().set({ drawer: false })
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={close} />
      <div className="absolute inset-y-0 left-0 w-[min(300px,85vw)] border-r border-line shadow-2xl" style={{ animation: 'os-drawer-in 200ms cubic-bezier(0.2,0.9,0.3,1)' }}>
        <Sidebar onClose={close} />
      </div>
      <style>{'@keyframes os-drawer-in{from{transform:translateX(-100%)}to{transform:none}}'}</style>
    </div>
  )
}

/** Phone bottom navigation. */
export function BottomNav() {
  const t = useTerms()
  const route = useNav((n) => n.route)
  const current = route.name === 'library' ? route.section : null
  const items: { section: Section; label: string }[] = [
    { section: 'songs', label: t.Songs },
    { section: 'setlists', label: 'Setlists' },
    { section: 'recent', label: 'Recent' },
    { section: 'favorites', label: 'Favorites' },
  ]
  const inMore = current && !items.some((i) => i.section === current)
  return (
    <nav aria-label="Sections" className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map(({ section, label }) => {
        const Icon = SECTION_ICONS[section]
        const active = current === section
        return (
          <button
            key={section}
            onClick={() => goSection(section)}
            aria-current={active ? 'page' : undefined}
            className={cx('flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-accent' : 'text-muted')}
          >
            <Icon className={cx('size-5', active && section === 'favorites' && 'fill-current')} />
            {label}
          </button>
        )
      })}
      <button
        onClick={() => useLibraryUI.getState().set({ drawer: true })}
        className={cx('flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', inMore ? 'text-accent' : 'text-muted')}
      >
        <FolderOpen className="size-5" />
        Browse
      </button>
    </nav>
  )
}
