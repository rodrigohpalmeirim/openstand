/**
 * Song-level helpers shared by the editor, the importers and the library browser.
 * Files are shared by content (blob ids), so copies and snippets never duplicate file data.
 */
import { db, uid } from '../../db/db'
import { emptySong, type GroupField, type PageRef, type Song, type SongFile } from '../../db/schema'
import { resolvePageRefs } from '../../viewer/pageSource'
import type { IndexEntry } from '../../files/indexImport'
import { parseDuration } from '../../files/import'
import { uniqueTitle } from '../browse/logic'

async function takenTitles() {
  const t: string[] = []
  await db.songs.each((s) => void t.push(s.title))
  return t
}

async function copyAnnotations(fromSongId: string, toSongId: string, keep?: (fileId: string, page: number) => boolean) {
  const anns = await db.annotations.where('songId').equals(fromSongId).toArray()
  const picked = anns.filter((a) => !keep || keep(a.fileId, a.page))
  if (picked.length) await db.annotations.bulkPut(picked.map((a) => ({ ...a, songId: toSongId, id: `${toSongId}:${a.fileId}:${a.page}` })))
}

/** Copy a song with all its settings and annotations under a unique title, e.g. "Song (2)". */
export async function duplicateSong(id: string, title?: string): Promise<Song | undefined> {
  const src = await db.songs.get(id)
  if (!src) return
  const now = Date.now()
  const copy: Song = {
    ...structuredClone(src),
    id: uid(),
    title: title?.trim() || uniqueTitle(src.title, await takenTitles()),
    createdAt: now,
    modifiedAt: now,
    lastPlayedAt: undefined,
    playCount: 0,
  }
  await db.transaction('rw', db.songs, db.annotations, async () => {
    await db.songs.add(copy)
    await copyAnnotations(src.id, copy.id)
  })
  return copy
}

/**
 * New song showing pages `from..to` (inclusive, 0-based indexes into the song's resolved page list,
 * i.e. after its page order). Metadata, crop/rotation and annotations of those pages are kept;
 * bookmarks/links that fall inside the range are re-based.
 */
export async function createSnippet(songId: string, from: number, to: number, title?: string): Promise<Song | undefined> {
  const src = await db.songs.get(songId)
  if (!src) return
  const refs = resolvePageRefs(src)
  const a = Math.max(0, Math.min(from, to))
  const b = Math.min(refs.length - 1, Math.max(from, to))
  if (a > b) return
  const order = refs.slice(a, b + 1)
  const fileIds = new Set(order.map((r) => r.fileId))
  const keys = new Set(order.map((r) => `${r.fileId}:${r.page}`))
  const now = Date.now()
  const snip: Song = {
    ...structuredClone(src),
    id: uid(),
    title: title?.trim() || uniqueTitle(`${src.title} (pages ${a + 1}-${b + 1})`, await takenTitles()),
    files: src.files.filter((f) => fileIds.has(f.id)),
    pageOrder: order,
    pageSettings: Object.fromEntries(Object.entries(src.pageSettings).filter(([k]) => keys.has(k))),
    bookmarks: src.bookmarks.filter((x) => x.pageIndex >= a && x.pageIndex <= b).map((x) => ({ ...x, id: uid(), pageIndex: x.pageIndex - a })),
    links: src.links
      .filter((l) => [l.from.pageIndex, l.to.pageIndex].every((p) => p >= a && p <= b))
      .map((l) => ({ ...l, id: uid(), from: { ...l.from, pageIndex: l.from.pageIndex - a }, to: { ...l.to, pageIndex: l.to.pageIndex - a } })),
    createdAt: now,
    modifiedAt: now,
    lastPlayedAt: undefined,
    playCount: 0,
  }
  await db.transaction('rw', db.songs, db.annotations, async () => {
    await db.songs.add(snip)
    await copyAnnotations(src.id, snip.id, (f, p) => keys.has(`${f}:${p}`))
  })
  return snip
}

const LIST_FIELDS: GroupField[] = ['artists', 'composers', 'albums', 'genres', 'collections', 'keys', 'signatures', 'sources', 'years', 'tags', 'custom', 'custom2']

/** Apply CSV column values (canonical names from indexImport.COLUMNS) to a song. */
export function applyIndexFields(song: Song, fields: Record<string, string>) {
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue
    if ((LIST_FIELDS as string[]).includes(k)) {
      const arr = song[k as GroupField]
      for (const part of v.split(/\s*[,|]\s*/)) if (part && !arr.includes(part)) arr.push(part)
    } else if (k === 'sortTitle') song.sortTitle = v
    else if (k === 'songNumber' && Number.isFinite(Number(v))) song.songNumber = Number(v)
    else if (k === 'keywords') song.keywords = v
    else if (k === 'notes') song.notes = v
    else if (k === 'rating') song.rating = Math.max(0, Math.min(5, Math.round(Number(v)) || 0))
    else if (k === 'difficulty') song.difficulty = Math.max(0, Math.min(15, Math.round(Number(v)) || 0))
    else if (k === 'duration') song.duration = parseDuration(v)
    else if (k === 'tempos') song.tempos = v.split(/[,\s]+/).map(Number).filter((n) => n > 0)
  }
}

/**
 * Create one song per index entry, all referencing the same stored file (one SongFile per song with
 * the same blob id), each restricted to its pages through `pageOrder`.
 */
export async function createIndexSongs(
  file: Omit<SongFile, 'id'>,
  entries: IndexEntry[],
  extra: { collection?: string } = {},
): Promise<Song[]> {
  const songs = entries.map((e) => {
    const f: SongFile = { ...file, id: uid() }
    const s = emptySong({ id: uid(), title: e.title })
    s.files = [f]
    s.pageOrder = e.pages.map((page): PageRef => ({ fileId: f.id, page }))
    if (e.pages.length) s.sourcePage = e.pages[0] + 1
    applyIndexFields(s, e.fields)
    if (extra.collection && !s.collections.includes(extra.collection)) s.collections.push(extra.collection)
    return s
  })
  await db.songs.bulkPut(songs)
  return songs
}
