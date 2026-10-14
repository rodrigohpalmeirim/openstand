/** Library mutations (songs, groups, setlists, collections). UI-free so menus and dialogs can share them. */
import { collectGarbage, db, getKV, setKV, uid } from '../../db/db'
import type { GroupField, Setlist, SetlistEntry, Song } from '../../db/schema'
import { useViewer } from '../../state/viewer'
import { addToList, normalize, removeFromList, renameInList, songHasValue, uniqueTitle } from './logic'

/* ------------------------------------------------------------------ Songs */

export async function setFavorite(ids: string[], favorite: boolean) {
  // Not a content change: leave modifiedAt alone so "sort by modified" stays meaningful.
  await db.songs
    .where('id')
    .anyOf(ids)
    .modify((s) => {
      s.favorite = favorite
    })
}

/** Delete songs, their thumbnails and annotations, drop them from setlists, then free unused file data. */
export async function deleteSongs(ids: string[]) {
  const set = new Set(ids)
  await db.transaction('rw', [db.songs, db.thumbs, db.annotations, db.setlists], async () => {
    await db.songs.bulkDelete(ids)
    await db.thumbs.bulkDelete(ids)
    await db.annotations.where('songId').anyOf(ids).delete()
    await db.setlists.toCollection().modify((sl) => {
      if (sl.entries.some((e) => set.has(e.songId))) sl.entries = sl.entries.filter((e) => !set.has(e.songId))
    })
  })
  await collectGarbage()
}

/** Copy a song (files are shared by content hash; annotations are copied). Returns the new song. */
/** Duplicating lives with the other song operations in the editor module. */
export { duplicateSong } from '../editor/songOps'

export interface BatchOp {
  kind: 'group'
  field: GroupField
  mode: 'set' | 'add' | 'remove'
  value: string
}
export interface BatchEdit {
  groups: BatchOp[]
  rating?: number
  difficulty?: number
  key?: string
}

export function applyBatch(s: Song, edit: BatchEdit): Song {
  const next = { ...s }
  for (const op of edit.groups) {
    const v = op.value.trim()
    const cur = next[op.field] ?? []
    if (op.mode === 'set') next[op.field] = v ? v.split(/\s*;\s*/).filter(Boolean) : []
    else if (op.mode === 'add' && v) next[op.field] = addToList(cur, v) ?? cur
    else if (op.mode === 'remove' && v) next[op.field] = removeFromList(cur, v) ?? cur
  }
  if (edit.rating !== undefined) next.rating = edit.rating
  if (edit.difficulty !== undefined) next.difficulty = edit.difficulty
  if (edit.key !== undefined) next.keys = edit.key ? [edit.key] : []
  return next
}

export async function batchEdit(ids: string[], edit: BatchEdit) {
  const now = Date.now()
  await db.songs
    .where('id')
    .anyOf(ids)
    .modify((s) => {
      Object.assign(s, applyBatch(s, edit), { modifiedAt: now })
    })
}

/* ----------------------------------------------------------------- Groups */

/** Rename a group value in every song; when `to` already exists the two groups merge. */
export async function renameGroup(field: GroupField, from: string, to: string) {
  const now = Date.now()
  await db.songs
    .filter((s) => songHasValue(s, field, from))
    .modify((s) => {
      s[field] = renameInList(s[field], from, to) ?? s[field]
      s.modifiedAt = now
    })
  if (field === 'collections') {
    const extra = await getExtraCollections()
    await setExtraCollections(extra.map((c) => (normalize(c) === normalize(from) ? to : c)))
  }
}

/** Remove a group value from every song (songs themselves stay). */
export async function deleteGroup(field: GroupField, name: string) {
  const now = Date.now()
  await db.songs
    .filter((s) => songHasValue(s, field, name))
    .modify((s) => {
      s[field] = removeFromList(s[field], name) ?? s[field]
      s.modifiedAt = now
    })
  if (field === 'collections') await setExtraCollections((await getExtraCollections()).filter((c) => normalize(c) !== normalize(name)))
}

export async function addToGroup(field: GroupField, name: string, ids: string[]) {
  const now = Date.now()
  await db.songs
    .where('id')
    .anyOf(ids)
    .modify((s) => {
      const next = addToList(s[field] ?? [], name)
      if (next) {
        s[field] = next
        s.modifiedAt = now
      }
    })
}

export async function removeFromGroup(field: GroupField, name: string, ids: string[]) {
  const now = Date.now()
  await db.songs
    .where('id')
    .anyOf(ids)
    .modify((s) => {
      const next = removeFromList(s[field] ?? [], name)
      if (next) {
        s[field] = next
        s.modifiedAt = now
      }
    })
}

/* Collections are values of Song.collections; empty ones (just created) are remembered in KV. */
const EXTRA_KEY = 'library:emptyCollections'
export const getExtraCollections = () => getKV<string[]>(EXTRA_KEY, [])
export const setExtraCollections = (names: string[]) => setKV(EXTRA_KEY, [...new Set(names)])
export async function createCollection(name: string, ids: string[] = []) {
  if (ids.length) await addToGroup('collections', name, ids)
  else await setExtraCollections([...(await getExtraCollections()), name])
}

/* --------------------------------------------------------------- Setlists */

export function entryFor(songId: string): SetlistEntry {
  return { key: uid(), songId }
}

export async function createSetlist(name: string, songIds: string[] = []): Promise<string> {
  const now = Date.now()
  const id = uid()
  await db.setlists.add({ id, name, entries: songIds.map(entryFor), notes: '', createdAt: now, modifiedAt: now })
  return id
}

export async function updateSetlist(id: string, patch: Partial<Setlist>) {
  await db.setlists.update(id, { ...patch, modifiedAt: Date.now() })
}

/** Insert songs into a setlist at `at` (default: end). Duplicates are allowed on purpose. */
export async function addToSetlist(id: string, songIds: string[], at?: number) {
  const sl = await db.setlists.get(id)
  if (!sl) return
  const entries = [...sl.entries]
  entries.splice(at ?? entries.length, 0, ...songIds.map(entryFor))
  await updateSetlist(id, { entries })
}

export async function duplicateSetlist(id: string): Promise<string | undefined> {
  const sl = await db.setlists.get(id)
  if (!sl) return
  const names = (await db.setlists.toArray()).map((s) => s.name)
  const now = Date.now()
  const nid = uid()
  await db.setlists.add({
    ...structuredClone(sl),
    id: nid,
    name: uniqueTitle(sl.name, names),
    entries: sl.entries.map((e) => ({ ...e, key: uid() })),
    createdAt: now,
    modifiedAt: now,
    lastPlayedAt: undefined,
  })
  return nid
}

/** Delete a setlist; returns a function that restores it (for the undo toast). */
export async function deleteSetlist(id: string): Promise<() => Promise<void>> {
  const sl = await db.setlists.get(id)
  await db.setlists.delete(id)
  return async () => {
    if (sl) await db.setlists.put(sl)
  }
}

/* ------------------------------------------------------------- Performing */

/** Start performing. Setlist breaks are skipped; the setlist's lastPlayedAt is recorded. */
export function perform(queue: string[], index = 0, opts: { setlistId?: string; position?: number } = {}) {
  if (!queue.length) return
  useViewer.getState().open(queue, Math.max(0, Math.min(index, queue.length - 1)), opts)
  if (opts.setlistId) db.setlists.update(opts.setlistId, { lastPlayedAt: Date.now() })
}

/** Perform a setlist starting at entry `fromEntry` (a break starts at the next song). */
export function performSetlist(sl: Setlist, fromEntry = 0, songsExist: (id: string) => boolean = () => true) {
  const queue: string[] = []
  let index = -1
  sl.entries.forEach((e, i) => {
    if (e.isBreak || !e.songId || !songsExist(e.songId)) return
    if (index < 0 && i >= fromEntry) index = queue.length
    queue.push(e.songId)
  })
  perform(queue, index < 0 ? 0 : index, { setlistId: sl.id })
}

/* ----------------------------------------------------------------- Recent */

const RECENT_KEY = 'library:recentClearedAt'
export const getRecentClearedAt = () => getKV<number>(RECENT_KEY, 0)
/** Clearing hides older plays from Recent without erasing play history (used by sorting). */
export const clearRecent = () => setKV(RECENT_KEY, Date.now())

/* ---------------------------------------------------------- Saved filters */

export interface SavedFilter {
  name: string
  query: string
  field: string
  filter: import('./logic').LibraryFilter
}
const FILTERS_KEY = 'library:savedFilters'
export const getSavedFilters = () => getKV<SavedFilter[]>(FILTERS_KEY, [])
export const setSavedFilters = (f: SavedFilter[]) => setKV(FILTERS_KEY, f)
