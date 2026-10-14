import { Bookmark as BookmarkIcon, BookmarkPlus, ChevronLeft, ChevronRight, Library, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { uid, updateSong } from '../db/db'
import type { Bookmark } from '../db/schema'
import { settings } from '../state/settings'
import { confirmDialog, cx, Menu, promptDialog, toast, useMenu } from '../ui/primitives'
import { runAction } from '../viewer/actions'
import type { PanelProps } from '../viewer/panels'
import { sortBookmarks } from './navigation'
import { PanelBody, PanelButton } from './ui'

export function BookmarksPanel({ song, currentPage, goToPage, pages }: PanelProps) {
  const list = sortBookmarks(song.bookmarks)
  const save = (bookmarks: Bookmark[]) => updateSong(song.id, { bookmarks })

  const add = async () => {
    const existing = song.bookmarks.find((b) => b.pageIndex === currentPage)
    if (existing && !(await confirmDialog({ title: 'Page already has a bookmark', message: `"${existing.name}" is on page ${currentPage + 1}. Add another?`, confirmLabel: 'Add' }))) return
    const name = await promptDialog({ title: `Bookmark page ${currentPage + 1}`, label: 'Name', initial: `Page ${currentPage + 1}` })
    if (name === null) return
    await save([...song.bookmarks, { id: uid(), name: name.trim() || `Page ${currentPage + 1}`, pageIndex: currentPage, showInLibrary: true }])
    toast('Bookmark added', 'ok')
  }

  return (
    <PanelBody className="space-y-3">
      <PanelButton primary className="min-h-12 w-full" onClick={add}>
        <BookmarkPlus className="size-4" /> Bookmark page {currentPage + 1}
      </PanelButton>
      <div className="grid grid-cols-2 gap-2">
        <PanelButton onClick={() => runAction('prevBookmark')} disabled={!list.some((b) => b.pageIndex < currentPage)}>
          <ChevronLeft className="size-4" /> Previous
        </PanelButton>
        <PanelButton onClick={() => runAction('nextBookmark')} disabled={!list.some((b) => b.pageIndex > currentPage)}>
          Next <ChevronRight className="size-4" />
        </PanelButton>
      </div>
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-white/50">
          <BookmarkIcon className="size-8 text-white/25" />
          No bookmarks yet. Bookmark sections (Verse, Coda, Movement II…) to jump to them, or step through them with a pedal.
        </div>
      ) : (
        <ul className="-mx-1">
          {list.map((b) => (
            <BookmarkRow
              key={b.id}
              b={b}
              active={b.pageIndex === currentPage}
              pageCount={pages.length}
              onGo={() => goToPage(b.pageIndex)}
              onChange={(patch) => save(song.bookmarks.map((x) => (x.id === b.id ? { ...x, ...patch } : x)))}
              onDelete={async () => {
                if (settings().display.performanceLock) return toast('Performance lock is on')
                if (await confirmDialog({ title: `Delete "${b.name}"?`, danger: true, confirmLabel: 'Delete' })) await save(song.bookmarks.filter((x) => x.id !== b.id))
              }}
            />
          ))}
        </ul>
      )}
    </PanelBody>
  )
}

function BookmarkRow({ b, active, pageCount, onGo, onChange, onDelete }: { b: Bookmark; active: boolean; pageCount: number; onGo: () => void; onChange: (p: Partial<Bookmark>) => void; onDelete: () => void }) {
  const menu = useMenu()
  return (
    <li className={cx('flex items-center rounded-xl', active && 'bg-[var(--os-accent)]/15')}>
      <button className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left hover:bg-white/5" onClick={onGo}>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-white/50">p.{b.pageIndex + 1}</span>
        <span className="min-w-0 flex-1 truncate text-[15px]">{b.name}</span>
        {b.showInLibrary && <Library className="size-3.5 shrink-0 text-white/35" aria-label="Shown in library" />}
      </button>
      <button ref={menu.ref} onClick={menu.toggle} aria-label={`Options for ${b.name}`} className="flex size-11 items-center justify-center rounded-xl text-white/60 hover:bg-white/10">
        <MoreVertical className="size-4" />
      </button>
      <Menu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        items={[
          {
            label: 'Rename',
            icon: <Pencil className="size-4" />,
            onSelect: async () => {
              const name = await promptDialog({ title: 'Rename bookmark', initial: b.name })
              if (name?.trim()) onChange({ name: name.trim() })
            },
          },
          {
            label: 'Change page…',
            onSelect: async () => {
              const v = await promptDialog({ title: `Page (1–${pageCount})`, initial: String(b.pageIndex + 1) })
              const n = Number(v)
              if (v !== null && Number.isInteger(n) && n >= 1 && n <= pageCount) onChange({ pageIndex: n - 1 })
            },
          },
          { label: 'Show in library', checked: !!b.showInLibrary, onSelect: () => onChange({ showInLibrary: !b.showInLibrary }) },
          { divider: true, label: '' },
          { label: 'Delete', danger: true, icon: <Trash2 className="size-4" />, onSelect: onDelete },
        ]}
      />
    </li>
  )
}
