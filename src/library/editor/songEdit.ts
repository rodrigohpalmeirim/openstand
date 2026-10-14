/** Pure transformations of a draft Song used by the editor tabs (no DB access). */
import type { PageRef, PageSettings, Song, SongFile } from '../../db/schema'
import { rotateCrop } from '../../files/autoCrop'
import { resolvePageRefs } from '../../files/pageRefs'
import { normalizePageOrder } from './pageOrder'

export const pageKey = (r: PageRef) => `${r.fileId}:${r.page}`
export type Rotation = 0 | 90 | 180 | 270

/** Rotate a page by ±90° (cumulative), turning its crop with it so the same area stays visible. */
export function rotateSetting(s: PageSettings | undefined, delta: number): PageSettings {
  const cur = s?.rotation ?? 0
  const rotation = ((((cur + delta) % 360) + 360) % 360) as Rotation
  const next: PageSettings = { ...s, rotation }
  if (s?.crop) next.crop = rotateCrop(s.crop, delta)
  if (!rotation) delete next.rotation
  return next
}

export function rotatePages(settings: Record<string, PageSettings>, keys: string[], delta: number) {
  const out = { ...settings }
  for (const k of new Set(keys)) out[k] = rotateSetting(out[k], delta)
  return tidySettings(out)
}

/** Drop empty entries so unchanged songs compare equal. */
export function tidySettings(s: Record<string, PageSettings>) {
  const out: Record<string, PageSettings> = {}
  for (const [k, v] of Object.entries(s)) if (v && (v.crop || v.rotation)) out[k] = v
  return out
}

export function addFiles(song: Song, files: SongFile[]): Song {
  const next = { ...song, files: [...song.files, ...files] }
  if (song.pageOrder) {
    next.pageOrder = [...song.pageOrder]
    for (const f of files) for (let p = 0; p < f.pageCount; p++) next.pageOrder.push({ fileId: f.id, page: p })
  }
  return next
}

export function removeFile(song: Song, fileId: string): Song {
  const files = song.files.filter((f) => f.id !== fileId)
  const order = song.pageOrder?.filter((r) => r.fileId !== fileId)
  return {
    ...song,
    files,
    pageOrder: order?.length ? normalizePageOrder(order, files) : undefined,
    pageSettings: Object.fromEntries(Object.entries(song.pageSettings).filter(([k]) => !k.startsWith(fileId + ':'))),
  }
}

/** Swap a file's content, keeping its id (so the page order and settings of surviving pages remain). */
export function replaceFile(song: Song, fileId: string, repl: SongFile): Song {
  const files = song.files.map((f) => (f.id === fileId ? { ...repl, id: fileId } : f))
  const keep = (page: number) => page < repl.pageCount
  const order = song.pageOrder?.filter((r) => r.fileId !== fileId || keep(r.page))
  return {
    ...song,
    files,
    pageOrder: order?.length ? normalizePageOrder(order, files) : undefined,
    pageSettings: Object.fromEntries(
      Object.entries(song.pageSettings).filter(([k]) => {
        const [fid, p] = k.split(':')
        return fid !== fileId || (keep(Number(p)) && repl.kind === song.files.find((f) => f.id === fileId)?.kind)
      }),
    ),
  }
}

export function reorderFiles(song: Song, files: SongFile[]): Song {
  // With a default order the display simply follows file order; a custom order is kept as is.
  return { ...song, files, pageOrder: song.pageOrder ? normalizePageOrder(song.pageOrder, files) : undefined }
}

/** Keys of the pages a crop change applies to. */
export function scopeKeys(song: Song, ref: PageRef, scope: 'page' | 'file' | 'song'): string[] {
  if (scope === 'page') return [pageKey(ref)]
  const files = scope === 'file' ? song.files.filter((f) => f.id === ref.fileId) : song.files
  return files.filter((f) => f.kind === 'pdf' || f.kind === 'image').flatMap((f) => Array.from({ length: f.pageCount }, (_, p) => `${f.id}:${p}`))
}

/** Unique PDF/image pages of the song in display order (for the crop editor). */
export function croppablePages(song: Song): PageRef[] {
  const kinds = new Map(song.files.map((f) => [f.id, f.kind]))
  const seen = new Set<string>()
  return resolvePageRefs(song).filter((r) => {
    const k = kinds.get(r.fileId)
    if ((k !== 'pdf' && k !== 'image') || seen.has(pageKey(r))) return false
    seen.add(pageKey(r))
    return true
  })
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
