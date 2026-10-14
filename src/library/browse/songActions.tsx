import {
  Copy,
  FileDown,
  FolderPlus,
  Heart,
  HeartOff,
  ListPlus,
  ListMusic,
  Package,
  Pencil,
  Play,
  Trash2,
  type LucideIcon,
  Printer,
} from 'lucide-react'
import { exportSongFiles, exportSongsPackage, exportTitleList, printSongs } from '../../backup/exportSongs'
import type { Song } from '../../db/schema'
import { useNav } from '../../state/nav'
import { confirmDialog, toast, type MenuItem } from '../../ui/primitives'
import { deleteSongs, duplicateSong, perform, setFavorite } from './ops'
import type { Terms } from './terms'
import { ui } from './ui'

const ic = (I: LucideIcon) => <I className="size-4" />

async function run(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (e) {
    console.error(e)
    toast(`${label} failed: ${(e as Error).message ?? e}`, 'error')
  }
}

export async function confirmDelete(ids: string[], t: Terms, titles?: string): Promise<boolean> {
  const n = ids.length
  const ok = await confirmDialog({
    title: n === 1 ? `Delete ${titles ? `“${titles}”` : `this ${t.song}`}?` : `Delete ${n} ${t.songs}?`,
    message: `${n === 1 ? 'It' : 'They'} will be removed from your library, setlists and collections, with ${n === 1 ? 'its' : 'their'} annotations. This can’t be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return false
  await run('Delete', () => deleteSongs(ids))
  toast(n === 1 ? `Deleted ${titles ?? t.song}` : `Deleted ${n} ${t.songs}`, 'ok')
  return true
}

export function exportItems(ids: string[], title: string, opts: { setlistIds?: string[] } = {}): MenuItem[] {
  return [
    { label: 'Share / export package', icon: ic(Package), onSelect: () => run('Export', () => exportSongsPackage(ids, opts)) },
    { label: 'Export files', icon: ic(FileDown), onSelect: () => run('Export', () => exportSongFiles(ids)) },
    { label: 'Title list (.txt)', icon: ic(FileDown), onSelect: () => run('Export', () => exportTitleList(ids, title, 'txt')) },
    { label: 'Title list (.pdf)', icon: ic(FileDown), onSelect: () => run('Export', () => exportTitleList(ids, title, 'pdf')) },
    { label: 'Print…', icon: ic(Printer), onSelect: () => run('Print', () => printSongs(ids, { withAnnotations: true, title })) },
  ]
}

/**
 * Context menu for one song. `queue`/`index` describe the list it was opened from (for Perform);
 * `editQueue` is the visible list the editor's "Save & next" walks through.
 */
export function songMenu(song: Song, t: Terms, o: { queue?: string[]; index?: number; extra?: MenuItem[]; editQueue?: string[] } = {}): MenuItem[] {
  return [
    {
      label: 'Perform',
      icon: ic(Play),
      onSelect: () => (o.queue ? perform(o.queue, o.index ?? 0) : perform([song.id])),
    },
    { label: 'Edit…', icon: ic(Pencil), onSelect: () => ui.edit(song.id, undefined, o.editQueue ?? o.queue) },
    {
      label: `Duplicate ${t.song}`,
      icon: ic(Copy),
      onSelect: () =>
        run('Duplicate', async () => {
          const c = await duplicateSong(song.id)
          if (c) toast(`Created “${c.title}”`, 'ok', { label: 'Edit', run: () => ui.edit(c.id) })
        }),
    },
    ...(o.extra?.length ? [{ divider: true, label: '' }, ...o.extra] : []),
    { divider: true, label: '' },
    { label: 'Add to setlist…', icon: ic(ListPlus), onSelect: () => ui.addTo('setlist', [song.id]) },
    { label: 'Add to collection…', icon: ic(FolderPlus), onSelect: () => ui.addTo('collection', [song.id]) },
    {
      label: song.favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: ic(song.favorite ? HeartOff : Heart),
      onSelect: () => setFavorite([song.id], !song.favorite),
    },
    { divider: true, label: '' },
    ...exportItems([song.id], song.title),
    { divider: true, label: '' },
    { label: `Delete ${t.song}…`, icon: ic(Trash2), danger: true, onSelect: () => confirmDelete([song.id], t, song.title) },
  ]
}

/** Navigate to a setlist (used after creating one). */
export function openSetlist(id: string) {
  useNav.getState().go({ name: 'library', section: 'setlists', setlistId: id })
}

export const icons = { Play, ListPlus, FolderPlus, Heart, Trash2, ListMusic, Pencil }
