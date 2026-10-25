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
import type { Song } from '../../db/schema'
import { useNav } from '../../state/nav'
import { confirmDialog, toast, type MenuItem } from '../../ui/primitives'
import { deleteSongs, duplicateSong, perform, setFavorite } from './ops'
import type { Terms } from './terms'
import { ui } from './ui'

const ic = (I: LucideIcon) => <I className="size-4" />

/** Run an action, reporting a failure as a toast. Resolves to whether it succeeded. */
async function run(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    console.error(e)
    toast(`${label} failed: ${(e as Error).message ?? e}`, 'error')
    return false
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
  if (!(await run('Delete', () => deleteSongs(ids)))) return false
  toast(n === 1 ? `Deleted ${titles ?? t.song}` : `Deleted ${n} ${t.songs}`, 'ok')
  return true
}

/** Export code (pdf-lib, zip) is loaded on first use to keep the library's startup bundle small. */
const exporter = () => import('../../backup/exportSongs')

export function exportItems(ids: string[], title: string, opts: { setlistIds?: string[] } = {}): MenuItem[] {
  // A single setlist's title list keeps its order, set breaks and entry notes.
  const list = { setlistId: opts.setlistIds?.length === 1 ? opts.setlistIds[0] : undefined }
  return [
    { label: 'Share / export package', icon: ic(Package), onSelect: () => run('Export', async () => (await exporter()).exportSongsPackage(ids, opts)) },
    { label: 'Export files', icon: ic(FileDown), onSelect: () => run('Export', async () => (await exporter()).exportSongFiles(ids, undefined, { name: list.setlistId && title })) },
    { label: 'Title list (.txt)', icon: ic(FileDown), onSelect: () => run('Export', async () => (await exporter()).exportTitleList(ids, title, 'txt', list)) },
    { label: 'Title list (.pdf)', icon: ic(FileDown), onSelect: () => run('Export', async () => (await exporter()).exportTitleList(ids, title, 'pdf', list)) },
    { label: 'Print…', icon: ic(Printer), onSelect: () => run('Print', async () => (await exporter()).printSongs(ids, { withAnnotations: true, title })) },
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
