import { useLiveQuery } from 'dexie-react-hooks'
import { Bookmark, Clock, FilePlus2, Heart, ListMusic, Play, Sparkles, Upload } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { Song } from '../../db/schema'
import { Button, confirmDialog, cx, Empty, IconButton, toast } from '../../ui/primitives'
import { Thumb } from '../Thumb'
import { useLibrary } from './data'
import { collator, matchesTerms, normalize, queryTerms } from './logic'
import { clearRecent, getRecentClearedAt, performAtPage, performSetlist } from './ops'
import { setlistStats } from './SetlistsView'
import { SearchBox, SongBrowser } from './SongBrowser'
import { openSetlist } from './songActions'
import { useTerms } from './terms'
import { ui } from './ui'
import { DrawerButton, relativeTime } from './widgets'
import { createDemoSongs } from './Welcome'
import { useNav } from '../../state/nav'

export function SongsView() {
  const t = useTerms()
  const { songs } = useLibrary()
  const [busy, setBusy] = useState(false)
  return (
    <SongBrowser
      title={t.Songs}
      base={songs}
      empty={
        <Empty icon={<FilePlus2 className="size-6" />} title="Your library is empty">
          Import PDFs, images, ChordPro or ABC files — or drop them anywhere on this window.
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => ui.import()}>
              Import music
            </Button>
            <Button
              icon={<Sparkles className="size-4" />}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await createDemoSongs().finally(() => setBusy(false))
              }}
            >
              Try demo {t.songs}
            </Button>
            <Button variant="ghost" onClick={() => ui.edit(null)}>
              New {t.song}
            </Button>
          </div>
        </Empty>
      }
    />
  )
}

export function FavoritesView() {
  const t = useTerms()
  const { songs } = useLibrary()
  const base = useMemo(() => songs.filter((s) => s.favorite), [songs])
  return (
    <SongBrowser
      title="Favorites"
      base={base}
      empty={
        <Empty icon={<Heart className="size-6" />} title="No favorites yet">
          Tap the heart on a {t.song}, or select several and choose “Add to favorites”.
        </Empty>
      }
    />
  )
}

export function RecentView() {
  const t = useTerms()
  const { songs, setlists, byId } = useLibrary()
  const clearedAt = useLiveQuery(() => getRecentClearedAt(), []) ?? 0
  const base = useMemo(
    () =>
      songs
        .filter((s) => (s.lastPlayedAt ?? 0) > clearedAt)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        .slice(0, 200),
    [songs, clearedAt],
  )
  const recentSets = useMemo(
    () =>
      setlists
        .filter((s) => (s.lastPlayedAt ?? 0) > clearedAt)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        .slice(0, 8),
    [setlists, clearedAt],
  )
  const header =
    recentSets.length > 0 ? (
      <div className="border-b border-line/60 px-3 py-3 md:px-4">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Setlists</div>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {recentSets.map((sl) => {
            const st = setlistStats(sl, byId)
            return (
              <div key={sl.id} className="flex w-56 shrink-0 items-center gap-2 rounded-xl border border-line bg-surface p-2">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => openSetlist(sl.id)}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <ListMusic className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{sl.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {t.count(st.songs)} · {relativeTime(sl.lastPlayedAt ?? 0)}
                    </span>
                  </span>
                </button>
                <IconButton size="sm" label={`Perform ${sl.name}`} className="text-accent!" onClick={() => performSetlist(sl, 0, (id) => byId.has(id))}>
                  <Play className="size-4 fill-current" />
                </IconButton>
              </div>
            )
          })}
        </div>
      </div>
    ) : undefined
  return (
    <SongBrowser
      title="Recent"
      base={base}
      sortable={false}
      subtitle={`${t.count(base.length)} played recently`}
      caption={(s) => `${s.artists[0] ? s.artists[0] + ' · ' : ''}${relativeTime(s.lastPlayedAt ?? 0)}${s.playCount > 1 ? ` · played ${s.playCount}×` : ''}`}
      header={header}
      actions={
        base.length > 0 || recentSets.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={async () => {
              if (await confirmDialog({ title: 'Clear the recent list?', message: 'Play counts and “last played” sorting are kept.', confirmLabel: 'Clear' })) {
                await clearRecent()
                toast('Recent list cleared', 'ok')
              }
            }}
          >
            Clear
          </Button>
        ) : undefined
      }
      empty={
        <Empty icon={<Clock className="size-6" />} title="Nothing played yet">
          {t.Songs} and setlists you perform will show up here.
        </Empty>
      }
    />
  )
}

interface BookmarkItem {
  song: Song
  name: string
  pageIndex: number
  key: string
}

export function BookmarksView() {
  const { songs } = useLibrary()
  const [all, setAll] = useState(false)
  const query = useDeferredValue(useNav((n) => n.query))
  const items = useMemo(() => {
    const col = collator()
    const terms = queryTerms(query)
    const out: BookmarkItem[] = []
    for (const s of songs)
      for (const b of s.bookmarks ?? [])
        if (all || b.showInLibrary) {
          if (terms.length && !matchesTerms(normalize(`${b.name} ${s.title}`), terms)) continue
          out.push({ song: s, name: b.name, pageIndex: b.pageIndex, key: `${s.id}:${b.id}` })
        }
    return out.sort((a, b) => col.compare(a.name, b.name) || col.compare(a.song.title, b.song.title))
  }, [songs, all, query])
  const total = useMemo(() => songs.reduce((n, s) => n + (s.bookmarks?.length ?? 0), 0), [songs])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface">
        <div className="flex h-14 items-center gap-1 px-2 md:px-3">
          <DrawerButton />
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-lg font-semibold leading-tight">Bookmarks</h1>
            <div className="truncate text-xs text-muted">{items.length} shown</div>
          </div>
          <div className="flex rounded-lg border border-line bg-surface-2 p-0.5 text-xs font-medium">
            {[false, true].map((v) => (
              <button
                key={String(v)}
                className={cx('h-8 rounded-md px-2.5', all === v ? 'bg-surface text-fg shadow-sm' : 'text-muted')}
                onClick={() => setAll(v)}
              >
                {v ? `All (${total})` : 'Library'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex px-3 pb-2.5 md:px-4">
          <SearchBox placeholder="Search bookmarks" fields={false} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <Empty icon={<Bookmark className="size-6" />} title={total && !all ? 'No library bookmarks' : 'No bookmarks yet'}>
            {total && !all
              ? `Bookmarks appear here when “Show in library” is on. Switch to “All” to see every bookmark.`
              : `Add bookmarks while performing (e.g. for each piece in a book), then jump straight to them from here.`}
          </Empty>
        ) : (
          items.map((b) => (
            <button
              key={b.key}
              className="flex w-full items-center gap-3 border-b border-line/60 px-3 py-2 text-left hover:bg-surface-2 md:px-4"
              onClick={() => performAtPage(b.song.id, b.pageIndex)}
            >
              <Thumb song={b.song} page={b.pageIndex} className="h-12 w-9" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{b.name}</div>
                <div className="truncate text-sm text-muted">
                  {b.song.title} · page {b.pageIndex + 1}
                </div>
              </div>
              <Bookmark className="size-4 text-accent" />
            </button>
          ))
        )}
      </div>
    </div>
  )
}
