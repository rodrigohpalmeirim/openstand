import Dexie, { type EntityTable } from 'dexie'
import type { BlobRecord, KV, PageAnnotations, Setlist, Song, ThumbRecord } from './schema'

export class OpenStandDB extends Dexie {
  songs!: EntityTable<Song, 'id'>
  setlists!: EntityTable<Setlist, 'id'>
  blobs!: EntityTable<BlobRecord, 'id'>
  annotations!: EntityTable<PageAnnotations, 'id'>
  thumbs!: EntityTable<ThumbRecord, 'id'>
  kv!: EntityTable<KV, 'key'>

  constructor(name = 'openstand') {
    super(name)
    this.version(1).stores({
      songs:
        'id, title, sortTitle, createdAt, modifiedAt, lastPlayedAt, playCount, rating, difficulty, duration, favorite, ' +
        '*artists, *composers, *albums, *genres, *collections, *keys, *signatures, *sources, *years, *tags, *custom, *custom2',
      setlists: 'id, name, modifiedAt, lastPlayedAt',
      blobs: 'id, hash',
      annotations: 'id, songId, fileId',
      thumbs: 'id',
      kv: 'key',
    })
  }
}

export let db = new OpenStandDB()

/** Library switching: each library is its own IndexedDB database. */
export function openLibrary(name: string) {
  db.close()
  db = new OpenStandDB(name === 'default' ? 'openstand' : `openstand-${name}`)
  return db
}

export function uid(): string {
  return crypto.randomUUID()
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Store binary content, de-duplicated by hash. Returns the blob id. */
export async function putBlob(data: ArrayBuffer, mime: string): Promise<{ id: string; size: number }> {
  const hash = await sha256(data)
  const existing = await db.blobs.where('hash').equals(hash).first()
  if (existing) return { id: existing.id, size: existing.size }
  const id = uid()
  await db.blobs.put({ id, hash, mime, size: data.byteLength, data: new Blob([data], { type: mime }) })
  return { id, size: data.byteLength }
}

export async function getBlob(id: string): Promise<Blob> {
  const rec = await db.blobs.get(id)
  if (!rec) throw new Error(`Missing file data (${id})`)
  return rec.data
}

/** Remove blobs that no song references any more. */
export async function collectGarbage(): Promise<number> {
  const used = new Set<string>()
  await db.songs.each((s) => {
    for (const f of s.files) used.add(f.blobId)
    for (const a of s.audio) if (a.blobId) used.add(a.blobId)
  })
  const unused = (await db.blobs.toCollection().primaryKeys()).filter((k) => !used.has(k))
  await db.blobs.bulkDelete(unused)
  await pruneAnnotations()
  return unused.length
}

/**
 * Delete annotation pages whose song is gone or whose file the song no longer has (e.g. after
 * removing or combining files). Pass a song id to only tidy that song.
 */
export async function pruneAnnotations(songId?: string): Promise<number> {
  const files = new Map<string, Set<string>>()
  const songs = songId ? [await db.songs.get(songId)] : await db.songs.toArray()
  for (const s of songs) if (s) files.set(s.id, new Set(s.files.map((f) => f.id)))
  const pages = songId ? db.annotations.where('songId').equals(songId) : db.annotations.toCollection()
  const dead: string[] = []
  await pages.each((a) => {
    if (!files.get(a.songId)?.has(a.fileId)) dead.push(a.id)
  })
  await db.annotations.bulkDelete(dead)
  return dead.length
}

export async function getKV<T>(key: string, fallback: T): Promise<T> {
  const r = await db.kv.get(key)
  return (r?.value as T) ?? fallback
}

export async function setKV<T>(key: string, value: T) {
  await db.kv.put({ key, value })
}

/**
 * Patch a song's top-level fields. Prefer this over `db.songs.update` for nested values: Dexie's
 * key-path typing recurses through Song and fails on self-referencing types (e.g. batch MIDI commands).
 */
export function updateSong(id: string, patch: Partial<import('./schema').Song>) {
  return db.table('songs').update(id, patch as Record<string, unknown>)
}
