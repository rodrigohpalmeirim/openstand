import type { PageRef, Song } from '../db/schema'

/*
 * Page-order helpers without any pdf.js dependency, so library code (thumbnails, editors) can use them
 * without pulling the PDF renderer into the startup bundle. Same behaviour as viewer/pageSource.
 */

/** Resolve the ordered list of file pages for a song (text files are expanded later by pagination). */
export function resolvePageRefs(song: Song): PageRef[] {
  if (song.pageOrder?.length) {
    const ids = new Set(song.files.map((f) => f.id))
    return song.pageOrder.filter((r) => ids.has(r.fileId))
  }
  const refs: PageRef[] = []
  for (const f of song.files) for (let p = 0; p < f.pageCount; p++) refs.push({ fileId: f.id, page: p })
  return refs
}

export function pageSettingsKey(fileId: string, page: number) {
  return `${fileId}:${page}`
}
