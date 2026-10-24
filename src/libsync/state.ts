/**
 * Typed access to the library-sync tables (docs/SYNC.md §6.2). Every function takes the database, so two
 * devices can live in one process (tests) and the engine never depends on the global `db` binding.
 */
import { setPruneFilter, type OpenStandDB, type PruneFilter } from '../db/db'
import { isCaptureOn, setCaptureOn, setKvFilter, SYNCED_TABLES } from '../db/capture'
import { syncedKv } from './fields'
import type { Song } from '../db/schema'
import type { Collection, Hlc, SyncConfig, SyncStateKey, SyncStateValues } from './model'

/** `syncDirty` primary key: `${c}/${recordId}`. (`syncShadow` is keyed by the plain record id, as `ShadowRecord.id`.) */
export const recKey = (c: Collection, id: string) => `${c}/${id}`

export function parseRecKey(k: string): { c: Collection; id: string } {
  const i = k.indexOf('/')
  return { c: k.slice(0, i) as Collection, id: k.slice(i + 1) }
}

/** Collection -> table name. */
export const TABLE_OF: Record<Collection, 'songs' | 'setlists' | 'annotations' | 'kv'> = {
  song: 'songs',
  setlist: 'setlists',
  ann: 'annotations',
  kv: 'kv',
}
export const COLLECTIONS = Object.keys(TABLE_OF) as Collection[]
export const RECORD_TABLES = Object.keys(SYNCED_TABLES) as ('songs' | 'setlists' | 'annotations' | 'kv')[]

export async function getState<K extends SyncStateKey>(db: OpenStandDB, key: K): Promise<SyncStateValues[K] | undefined> {
  const row = await db.syncState.get(key)
  return row?.value as SyncStateValues[K] | undefined
}

export function putState<K extends SyncStateKey>(db: OpenStandDB, key: K, value: SyncStateValues[K]) {
  return db.syncState.put({ key, value } as never)
}

export function deleteState(db: OpenStandDB, key: SyncStateKey) {
  return db.syncState.delete(key)
}

export const getConfig = (db: OpenStandDB) => getState(db, 'config')

/** Sync is set up for this database (config present). */
export async function isConfigured(db: OpenStandDB) {
  return !!(await getConfig(db))
}

export const captureOn = (db: OpenStandDB) => isCaptureOn(db.name)
export const setCapture = (db: OpenStandDB, on: boolean) => setCaptureOn(db.name, on)

/** Mark records dirty (own transaction unless called inside one that holds `syncDirty`). */
export async function markDirty(db: OpenStandDB, keys: string[], at = Date.now()) {
  if (keys.length) await db.syncDirty.bulkPut(keys.map((id) => ({ id, at })))
}

/** All record keys currently in the synced tables (kv filtered by `keep`). */
export async function allRecordKeys(db: OpenStandDB, keepKv: (key: string) => boolean): Promise<string[]> {
  const out: string[] = []
  for (const c of COLLECTIONS) {
    const keys = (await db.table(TABLE_OF[c]).toCollection().primaryKeys()) as string[]
    for (const k of keys) if (c !== 'kv' || keepKv(k)) out.push(recKey(c, k))
  }
  return out
}

/** Clears every `sync*` table (leave / reset). Library rows stay. */
export async function clearSyncTables(db: OpenStandDB) {
  await db.transaction('rw', [db.syncState, db.syncDirty, db.syncShadow, db.syncOutbox, db.syncTransfers, db.syncChunks], async () => {
    await Promise.all([db.syncState.clear(), db.syncDirty.clear(), db.syncShadow.clear(), db.syncOutbox.clear(), db.syncTransfers.clear(), db.syncChunks.clear()])
  })
}

/**
 * Prune guard (§8.6): with sync on, only pages that were never synced, or whose song is dead in the
 * shadow, may be pruned. Synced orphan pages (annotations that arrived before their song, or pages of
 * files removed from a song) stay: deleting them would tombstone them on every device.
 */
// Same as merge.isDead; merge.ts (the bulk of the sync model) stays out of the startup bundle.
const isDead = (s: { a?: [Hlc, boolean] } | undefined) => !!s?.a && !s.a[1]

export const pruneFilter: PruneFilter = async (d, ids) => {
  if (!(await getConfig(d))) return ids
  const songOf = (id: string) => id.slice(0, id.indexOf(':'))
  const pages = await d.syncShadow.bulkGet(ids)
  const songIds = [...new Set(ids.map(songOf))]
  const songShadows = new Map((await d.syncShadow.bulkGet(songIds)).map((s, i) => [songIds[i], s]))
  return ids.filter((id, i) => !pages[i] || isDead(songShadows.get(songOf(id))))
}

/** Hooks db.ts and capture.ts expose for libsync (they don't import it): the kv allow-list and the prune guard. */
export function registerDbHooks() {
  setKvFilter(syncedKv)
  setPruneFilter(pruneFilter)
}

/**
 * Song editor save (§8.4): `edited` (a draft opened as `base`) applied onto the song as stored now at
 * field, sub-field and element granularity, so edits synced meanwhile aren't reverted. `'deleted'` when the
 * song is gone (deleted elsewhere meanwhile).
 */
export async function rebaseOnLatest(d: OpenStandDB, base: Song, edited: Song): Promise<Song | 'deleted'> {
  const latest = await d.songs.get(edited.id)
  if (!latest) return 'deleted'
  const { rebase } = await import('./merge')
  return { ...rebase('song', base, edited, latest), modifiedAt: edited.modifiedAt }
}

export type { SyncConfig }
