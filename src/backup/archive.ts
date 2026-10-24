/**
 * Library archives: full backups (.osbackup) and song packages (.ospkg). Both are ZIP files with
 *   manifest.json  – format, version, app version, createdAt, counts
 *   library.json   – songs, setlists, annotations, blob metadata (+ settings and kv for backups)
 *   blobs/<id>     – raw file contents, stored uncompressed, one entry per blob
 * Blobs are streamed one at a time on export, and come back as slices of the picked file on import.
 */
import { collectGarbage, db, uid } from '../db/db'
import { sha256Blob } from '../libsync/crypto'
import type { BlobRecord, KV, PageAnnotations, Setlist, Song } from '../db/schema'
import { ZipReader, ZipWriter, type ZipSink } from './zip'

export const APP_VERSION = '0.1.0'
export const ARCHIVE_VERSION = 1
export type ArchiveKind = 'backup' | 'package'

export interface Manifest {
  format: 'openstand'
  kind: ArchiveKind
  version: number
  appVersion: string
  createdAt: number
  library?: string
  counts: { songs: number; setlists: number; annotations: number; blobs: number; bytes: number }
}

export interface BlobMeta {
  id: string
  hash: string
  mime: string
  size: number
}

export interface LibraryJson {
  songs: Song[]
  setlists: Setlist[]
  annotations: PageAnnotations[]
  blobs: BlobMeta[]
  /** Raw localStorage value of 'openstand-settings' */
  settings?: string
  kv?: KV[]
}

export interface Progress {
  phase: 'preparing' | 'files' | 'library' | 'finishing'
  done: number
  total: number
  /** Bytes of file data processed / total, for a smoother bar */
  bytes?: number
  totalBytes?: number
}
export type OnProgress = (p: Progress) => void

/** kv keys that describe this device's backup state; never exported or restored. */
const LOCAL_KV = (k: string) => k.startsWith('backup.')

export function songBlobIds(s: Song): string[] {
  return [...s.files.map((f) => f.blobId), ...s.audio.flatMap((a) => (a.blobId ? [a.blobId] : []))]
}

/* ------------------------------------------------------------------ write */

export interface WriteOptions {
  kind: ArchiveKind
  /** Package only: songs to include (default all) */
  songIds?: string[]
  /** Package only: setlists to include */
  setlistIds?: string[]
  includeAnnotations?: boolean
  includeAudio?: boolean
  /** Backup only: raw settings JSON to embed */
  settings?: string | null
  libraryName?: string
  onProgress?: OnProgress
  signal?: AbortSignal
}

export async function writeArchive(sink: ZipSink, opts: WriteOptions): Promise<Manifest> {
  const report = opts.onProgress ?? (() => {})
  report({ phase: 'preparing', done: 0, total: 1 })
  const backup = opts.kind === 'backup'
  let songs: Song[]
  let setlists: Setlist[]
  if (backup) {
    songs = await db.songs.toArray()
    setlists = await db.setlists.toArray()
  } else {
    setlists = opts.setlistIds?.length ? ((await db.setlists.bulkGet(opts.setlistIds)).filter(Boolean) as Setlist[]) : []
    const ids = new Set(opts.songIds ?? [])
    for (const sl of setlists) for (const e of sl.entries) if (e.songId) ids.add(e.songId)
    songs = (await db.songs.bulkGet([...ids])).filter(Boolean) as Song[]
  }
  if (opts.includeAudio === false) songs = songs.map((s) => ({ ...s, audio: s.audio.filter((a) => !a.blobId) }))

  const songIds = new Set(songs.map((s) => s.id))
  const annotations =
    opts.includeAnnotations === false
      ? []
      : backup
        ? await db.annotations.toArray()
        : await db.annotations.where('songId').anyOf([...songIds]).toArray()

  const blobIds = [...new Set(songs.flatMap(songBlobIds))]
  const blobs: BlobMeta[] = []
  for (const id of blobIds) {
    const rec = await db.blobs.get(id)
    if (rec) blobs.push({ id: rec.id, hash: rec.hash, mime: rec.mime, size: rec.size })
  }
  const totalBytes = blobs.reduce((n, b) => n + b.size, 0)

  const library: LibraryJson = { songs, setlists, annotations, blobs }
  if (backup) {
    if (opts.settings) library.settings = opts.settings
    library.kv = (await db.kv.toArray()).filter((k) => !LOCAL_KV(k.key) && isPlainData(k.value))
  }

  const manifest: Manifest = {
    format: 'openstand',
    kind: opts.kind,
    version: ARCHIVE_VERSION,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    library: opts.libraryName,
    counts: { songs: songs.length, setlists: setlists.length, annotations: annotations.length, blobs: blobs.length, bytes: totalBytes },
  }

  const zip = new ZipWriter(sink)
  await zip.addText('manifest.json', JSON.stringify(manifest, null, 2))
  await zip.addText('library.json', JSON.stringify(library))
  let bytes = 0
  for (let i = 0; i < blobs.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const rec = await db.blobs.get(blobs[i].id)
    if (rec) await zip.addBlob(`blobs/${rec.id}`, rec.data)
    bytes += blobs[i].size
    report({ phase: 'files', done: i + 1, total: blobs.length, bytes, totalBytes })
  }
  report({ phase: 'finishing', done: 1, total: 1 })
  await zip.finish()
  return manifest
}

/** Directory handles and other non-JSON values in kv can't go into library.json. */
function isPlainData(v: unknown): boolean {
  try {
    return JSON.stringify(v) !== undefined && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------- read */

export interface OpenedArchive {
  zip: ZipReader
  manifest: Manifest
  library: LibraryJson
}

export async function openArchive(file: Blob, expect?: ArchiveKind): Promise<OpenedArchive> {
  let zip: ZipReader
  try {
    zip = await ZipReader.open(file)
  } catch {
    throw new Error('This file is not an OpenStand backup or package.')
  }
  if (!zip.has('manifest.json') || !zip.has('library.json')) throw new Error('This file is not an OpenStand backup or package.')
  const manifest = await zip.json<Manifest>('manifest.json')
  if (manifest.format !== 'openstand') throw new Error('This file is not an OpenStand backup or package.')
  if (manifest.version > ARCHIVE_VERSION) throw new Error('This file was made by a newer OpenStand. Update the app to open it.')
  if (expect === 'backup' && manifest.kind !== 'backup') throw new Error('This is a song package, not a full backup. Import it from the library instead.')
  const library = await zip.json<LibraryJson>('library.json')
  library.songs ??= []
  library.setlists ??= []
  library.annotations ??= []
  library.blobs ??= []
  return { zip, manifest, library }
}

/**
 * Bring the archive's blobs into the DB. Blob ids are random or content hashes, and contents immutable, so
 * an existing id is the same file. Otherwise the content's SHA-256 is computed (streamed for large files):
 * the archive's `hash` and hash-shaped ids are claims, never trusted, because library sync names and
 * encrypts files by hash. New rows are keyed by the computed hash; an existing hash is de-duplicated.
 * Returns old id -> local id.
 */
async function importBlobs(a: OpenedArchive, needed: Set<string>, report: OnProgress, signal?: AbortSignal): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const metas = a.library.blobs.filter((b) => needed.has(b.id))
  const totalBytes = metas.reduce((n, b) => n + b.size, 0)
  let bytes = 0
  for (let i = 0; i < metas.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const m = metas[i]
    const name = `blobs/${m.id}`
    if (await db.blobs.get(m.id)) map.set(m.id, m.id)
    else if (!a.zip.has(name)) {
      /* missing in archive: leave unmapped, file shows as missing */
    } else {
      const data = await a.zip.blob(name, m.mime)
      const hash = await sha256Blob(data)
      if (m.hash && m.hash !== hash) console.warn(`[archive] ${name}: content hash differs from the archive's claim; using the real one`)
      const same = (await db.blobs.get(hash)) ?? (await db.blobs.where('hash').equals(hash).first())
      if (same) map.set(m.id, same.id)
      else {
        const rec: BlobRecord = { id: hash, hash, mime: m.mime, size: data.size, data }
        await db.blobs.put(rec)
        map.set(m.id, hash)
      }
    }
    bytes += m.size
    report({ phase: 'files', done: i + 1, total: metas.length, bytes, totalBytes })
  }
  return map
}

function remapSongBlobs(s: Song, map: Map<string, string>): Song {
  return {
    ...s,
    files: s.files.map((f) => ({ ...f, blobId: map.get(f.blobId) ?? f.blobId })),
    audio: s.audio.map((t) => (t.blobId ? { ...t, blobId: map.get(t.blobId) ?? t.blobId } : t)),
  }
}

function remapAnnotation(a: PageAnnotations, songId: string): PageAnnotations {
  return { ...a, songId, id: `${songId}:${a.fileId}:${a.page}` }
}

export interface RestoreOptions {
  mode: 'replace' | 'merge'
  /** merge: on id conflict keep the most recently modified copy, or keep both */
  conflict?: 'newer' | 'keepBoth'
  restoreSettings?: boolean
  /** Called with the raw settings JSON when restoreSettings is on */
  applySettings?: (raw: string) => void
  onProgress?: OnProgress
  signal?: AbortSignal
}

export interface RestoreResult {
  songsAdded: number
  songsUpdated: number
  songsKept: number
  setlists: number
  missingFiles: number
  settingsRestored: boolean
}

export async function restoreArchive(a: OpenedArchive, opts: RestoreOptions): Promise<RestoreResult> {
  const report = opts.onProgress ?? (() => {})
  const lib = a.library
  const result: RestoreResult = { songsAdded: 0, songsUpdated: 0, songsKept: 0, setlists: 0, missingFiles: 0, settingsRestored: false }

  // Decide per song first so we only import the blobs we will use.
  const existing = new Map((await db.songs.bulkGet(lib.songs.map((s) => s.id))).filter(Boolean).map((s) => [s!.id, s!]))
  const songIdMap = new Map<string, string>()
  /** Songs to write, with the archive id they came from (annotations follow them). */
  const incoming: { from: string; song: Song }[] = []
  for (const s of lib.songs) {
    const mine = opts.mode === 'merge' ? existing.get(s.id) : undefined
    if (!mine) {
      songIdMap.set(s.id, s.id)
      incoming.push({ from: s.id, song: s })
      result.songsAdded++
    } else if (opts.conflict === 'keepBoth') {
      if ((mine.modifiedAt ?? 0) === (s.modifiedAt ?? 0)) {
        songIdMap.set(s.id, s.id)
        result.songsKept++
      } else {
        const id = uid()
        songIdMap.set(s.id, id)
        incoming.push({ from: s.id, song: { ...s, id } })
        result.songsAdded++
      }
    } else if ((s.modifiedAt ?? 0) > (mine.modifiedAt ?? 0)) {
      songIdMap.set(s.id, s.id)
      incoming.push({ from: s.id, song: s })
      result.songsUpdated++
    } else {
      songIdMap.set(s.id, s.id)
      result.songsKept++
    }
  }

  const needed = new Set(incoming.flatMap((i) => songBlobIds(i.song)))
  const blobMap = await importBlobs(a, needed, report, opts.signal)
  for (const id of needed) if (!blobMap.has(id)) result.missingFiles++

  report({ phase: 'library', done: 0, total: 1 })
  const songs = incoming.map((i) => remapSongBlobs(i.song, blobMap))
  const takenFrom = new Map(incoming.map((i) => [i.from, i.song.id]))
  const annotations: PageAnnotations[] = []
  for (const an of lib.annotations) {
    const target = takenFrom.get(an.songId)
    if (target) annotations.push(remapAnnotation(an, target))
  }

  const existingSetlists = new Map((await db.setlists.bulkGet(lib.setlists.map((s) => s.id))).filter(Boolean).map((s) => [s!.id, s!]))
  const setlists: Setlist[] = []
  for (const sl of lib.setlists) {
    const mapped = { ...sl, entries: sl.entries.map((e) => (e.songId ? { ...e, songId: songIdMap.get(e.songId) ?? e.songId } : e)) }
    const mine = opts.mode === 'merge' ? existingSetlists.get(sl.id) : undefined
    if (!mine) setlists.push(mapped)
    else if (opts.conflict === 'keepBoth') {
      if (mine.modifiedAt !== sl.modifiedAt) setlists.push({ ...mapped, id: uid(), name: `${sl.name} (restored)` })
    } else if (sl.modifiedAt > mine.modifiedAt) setlists.push(mapped)
  }
  result.setlists = setlists.length

  await db.transaction('rw', [db.songs, db.setlists, db.annotations, db.thumbs, db.kv], async () => {
    if (opts.mode === 'replace') {
      await Promise.all([db.songs.clear(), db.setlists.clear(), db.annotations.clear(), db.thumbs.clear()])
      const keep = (await db.kv.toArray()).filter((k) => LOCAL_KV(k.key))
      await db.kv.clear()
      await db.kv.bulkPut([...(lib.kv ?? []).filter((k) => !LOCAL_KV(k.key)), ...keep])
    } else {
      // Replaced songs get the archive's annotations; drop their old ones first.
      const replaced = songs.filter((s) => existing.has(s.id)).map((s) => s.id)
      if (replaced.length) await db.annotations.where('songId').anyOf(replaced).delete()
      if (replaced.length) await db.thumbs.bulkDelete(replaced)
      const have = new Set((await db.kv.toCollection().primaryKeys()) as string[])
      await db.kv.bulkPut((lib.kv ?? []).filter((k) => !LOCAL_KV(k.key) && !have.has(k.key)))
    }
    await db.songs.bulkPut(songs)
    await db.setlists.bulkPut(setlists)
    await db.annotations.bulkPut(annotations)
  })

  if (opts.mode === 'replace') {
    report({ phase: 'finishing', done: 0, total: 1 })
    await collectGarbage()
  }
  if (opts.restoreSettings && lib.settings && opts.applySettings) {
    opts.applySettings(lib.settings)
    result.settingsRestored = true
  }
  report({ phase: 'finishing', done: 1, total: 1 })
  return result
}

/* ---------------------------------------------------------------- packages */

export interface PackageImportOptions {
  /** Songs whose title (and first artist, when both have one) match an existing song */
  onConflict: 'copy' | 'update'
  onProgress?: OnProgress
}

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

export function songMatchKey(s: Pick<Song, 'title' | 'artists'>) {
  return norm(s.title)
}

/** Existing songs that would be updated by title when importing these songs. */
export async function findTitleConflicts(songs: Song[]): Promise<Map<string, Song>> {
  const byTitle = new Map<string, Song[]>()
  const wanted = new Set(songs.map(songMatchKey))
  await db.songs.each((s) => {
    const k = songMatchKey(s)
    if (wanted.has(k)) byTitle.set(k, [...(byTitle.get(k) ?? []), s])
  })
  const out = new Map<string, Song>()
  for (const s of songs) {
    const cands = byTitle.get(songMatchKey(s)) ?? []
    const artist = s.artists[0] && norm(s.artists[0])
    const hit = cands.find((c) => !artist || !c.artists[0] || norm(c.artists[0]) === artist)
    if (hit) out.set(s.id, hit)
  }
  return out
}

export async function importPackageArchive(a: OpenedArchive, opts: PackageImportOptions): Promise<{ songs: number; setlists: number; updated: number }> {
  const report = opts.onProgress ?? (() => {})
  const lib = a.library
  const conflicts = opts.onConflict === 'update' ? await findTitleConflicts(lib.songs) : new Map<string, Song>()
  const blobMap = await importBlobs(a, new Set(lib.songs.flatMap(songBlobIds)), report)
  const idMap = new Map<string, string>()
  const now = Date.now()
  const songs: Song[] = []
  const replacedIds: string[] = []
  for (const s of lib.songs) {
    const mine = conflicts.get(s.id)
    const remapped = remapSongBlobs(s, blobMap)
    if (mine) {
      idMap.set(s.id, mine.id)
      replacedIds.push(mine.id)
      songs.push({
        ...remapped,
        id: mine.id,
        createdAt: mine.createdAt,
        playCount: mine.playCount,
        lastPlayedAt: mine.lastPlayedAt,
        favorite: mine.favorite || s.favorite,
        modifiedAt: now,
      })
    } else {
      const id = uid()
      idMap.set(s.id, id)
      songs.push({ ...remapped, id, createdAt: now, modifiedAt: now, playCount: 0, lastPlayedAt: undefined })
    }
  }
  const annotations = lib.annotations.filter((an) => idMap.has(an.songId)).map((an) => remapAnnotation(an, idMap.get(an.songId)!))
  const setlists: Setlist[] = lib.setlists.map((sl) => ({
    ...sl,
    id: uid(),
    createdAt: now,
    modifiedAt: now,
    lastPlayedAt: undefined,
    entries: sl.entries.filter((e) => !e.songId || idMap.has(e.songId)).map((e) => ({ ...e, key: uid(), songId: e.songId ? idMap.get(e.songId)! : '' })),
  }))
  report({ phase: 'library', done: 0, total: 1 })
  await db.transaction('rw', [db.songs, db.setlists, db.annotations, db.thumbs], async () => {
    if (replacedIds.length) {
      await db.annotations.where('songId').anyOf(replacedIds).delete()
      await db.thumbs.bulkDelete(replacedIds)
    }
    await db.songs.bulkPut(songs)
    await db.setlists.bulkPut(setlists)
    await db.annotations.bulkPut(annotations)
  })
  report({ phase: 'finishing', done: 1, total: 1 })
  return { songs: songs.length, setlists: setlists.length, updated: replacedIds.length }
}
