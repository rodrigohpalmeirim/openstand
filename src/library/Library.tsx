import { useLiveQuery } from 'dexie-react-hooks'
import { FilePlus2, FolderOpen, Music4, Search, Settings, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { db } from '../db/db'
import type { Song } from '../db/schema'
import { importFiles, sourcesFromFileList } from '../files/import'
import { ACCEPT } from '../files/kinds'
import { useNav } from '../state/nav'
import { useViewer } from '../state/viewer'
import { Button, Empty, Input, toast } from '../ui/primitives'
import { Thumb } from './Thumb'

/** Starter library view. Will be expanded by the library module. */
export function Library() {
  const songs = useLiveQuery(() => db.songs.orderBy('title').toArray(), [])
  const query = useNav((n) => n.query)
  const setQuery = useNav((n) => n.setQuery)
  const go = useNav((n) => n.go)
  const open = useViewer((v) => v.open)
  const fileInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !songs) return songs ?? []
    return songs.filter((s) => [s.title, ...s.artists, ...s.composers].some((v) => v.toLowerCase().includes(q)))
  }, [songs, query])

  const doImport = async (files: FileList | File[]) => {
    const srcs = sourcesFromFileList(files)
    if (!srcs.length) return toast('No supported files found', 'error')
    const r = await importFiles(srcs, { skipDuplicates: true })
    toast(`Imported ${r.songs.length} song${r.songs.length === 1 ? '' : 's'}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`, 'ok')
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        doImport(e.dataTransfer.files)
      }}
    >
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <Music4 className="size-5 text-accent" /> OpenStand
        </div>
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input className="pl-9" placeholder="Search songs" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()}>
          Import
        </Button>
        <Button icon={<FolderOpen className="size-4" />} onClick={() => dirInput.current?.click()}>
          Folder
        </Button>
        <Button variant="ghost" icon={<Settings className="size-4" />} onClick={() => go({ name: 'settings' })} />
        <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && doImport(e.target.files)} />
        <input ref={dirInput} type="file" hidden {...({ webkitdirectory: '' } as object)} onChange={(e) => e.target.files && doImport(e.target.files)} />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {songs && songs.length === 0 ? (
          <Empty icon={<FilePlus2 className="size-6" />} title="Your library is empty">
            Import PDFs, images, ChordPro or ABC files — or drop them anywhere on this window.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((s, i) => (
              <SongRow key={s.id} song={s} onOpen={() => open(list.map((x) => x.id), i)} />
            ))}
          </ul>
        )}
      </main>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-lg font-semibold">Drop files to import</div>
        </div>
      )}
    </div>
  )
}

function SongRow({ song, onOpen }: { song: Song; onOpen: () => void }) {
  return (
    <li>
      <button onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2">
        <Thumb song={song} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{song.title}</div>
          <div className="truncate text-sm text-muted">{song.artists.join(', ')}</div>
        </div>
        {song.keys[0] && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{song.keys[0]}</span>}
      </button>
    </li>
  )
}
