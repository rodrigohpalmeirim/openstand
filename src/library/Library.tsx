import { useEffect, useRef, useState } from 'react'
import type { GroupField } from '../db/schema'
import { sourcesFromFileList, type ImportSource } from '../files/import'
import { kindOf } from '../files/kinds'
import { useNav, type Route } from '../state/nav'
import { toast } from '../ui/primitives'
import { LibraryDataProvider } from './browse/data'
import { AddToDialog, BatchEditDialog, LibrariesDialog, LibraryPrefsDialog } from './browse/dialogs'
import { GroupListView, GroupSongsView } from './browse/GroupsView'
import './browse/libraries' // opens the active library before the first query
import { SetlistDetail } from './browse/SetlistDetail'
import { SetlistsView } from './browse/SetlistsView'
import { BottomNav, Drawer, Sidebar } from './browse/Sidebar'
import { isGroupSection, useTerms } from './browse/terms'
import { useLibraryUI } from './browse/ui'
import { BookmarksView, FavoritesView, RecentView, SongsView } from './browse/views'
import { Welcome } from './browse/Welcome'
import { ContextMenuHost } from './browse/widgets'
import { SongEditor } from './editor/SongEditor'
import { ImportDialog } from './import/ImportDialog'

/** Library browser: sidebar (tablet/desktop) or drawer + bottom nav (phone), section views and dialogs. */
export function Library() {
  const epoch = useNav((n) => n.libraryEpoch)
  return (
    <LibraryDataProvider key={epoch}>
      <LibraryShell />
    </LibraryDataProvider>
  )
}

function SectionView({ route }: { route: Extract<Route, { name: 'library' }> }) {
  const { section, group, setlistId } = route
  switch (section) {
    case 'songs':
      return <SongsView />
    case 'recent':
      return <RecentView />
    case 'favorites':
      return <FavoritesView />
    case 'bookmarks':
      return <BookmarksView />
    case 'setlists':
      return setlistId ? <SetlistDetail key={setlistId} id={setlistId} /> : <SetlistsView />
    default:
      if (!isGroupSection(section)) return <SongsView />
      return group !== undefined ? <GroupSongsView key={group} field={section as GroupField} group={group} /> : <GroupListView field={section as GroupField} />
  }
}

function LibraryShell() {
  const route = useNav((n) => n.route)
  const t = useTerms()
  const editor = useLibraryUI((u) => u.editor)
  const importing = useLibraryUI((u) => u.importing)
  const setUI = useLibraryUI((u) => u.set)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    document.title = route.name === 'library' ? `${t.section(route.section)} · OpenStand` : 'OpenStand'
  }, [route, t])

  const lib = route.name === 'library' ? route : ({ name: 'library', section: 'songs' } as const)
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files')

  return (
    <div
      className="flex h-full"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={async (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const sources = await sourcesFromDrop(e.dataTransfer)
        if (!sources.length) return toast('No supported files found (PDF, images, ChordPro, text, ABC)', 'error')
        setUI({ importing: { initial: sources } })
      }}
    >
      <aside className="hidden w-64 shrink-0 border-r border-line md:flex lg:w-72">
        <Sidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1">
          <SectionView route={lib} />
        </main>
        <BottomNav />
      </div>
      <Drawer />

      <ImportDialog open={!!importing} onClose={() => setUI({ importing: null })} initial={importing?.initial} />
      {editor && <SongEditor songId={editor.songId} initialTab={editor.tab} onClose={() => setUI({ editor: null })} />}
      <AddToDialog />
      <BatchEditDialog />
      <LibraryPrefsDialog />
      <LibrariesDialog />
      <Welcome />
      <ContextMenuHost />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center shadow-xl">
            <div className="text-lg font-semibold">Drop to import</div>
            <div className="text-sm text-muted">Files or whole folders</div>
          </div>
        </div>
      )}
    </div>
  )
}

/* Dropped folders: walk them with the (widely supported) FileSystemEntry API, keeping relative paths. */
async function sourcesFromDrop(dt: DataTransfer): Promise<ImportSource[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  if (!entries.some((e) => e.isDirectory)) return sourcesFromFileList(dt.files)
  const out: ImportSource[] = []
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      if (kindOf(file.name, file.type)) out.push({ file, path })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // readEntries returns batches; call until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const child of batch) await walk(child, path)
      }
    }
  }
  for (const e of entries) await walk(e, '')
  return out.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '', undefined, { numeric: true }))
}
