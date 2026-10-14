import { metaFirst, parseChordPro } from '../chordpro/parse'
import { db, putBlob, uid } from '../db/db'
import { emptySong, type FileKind, type Song, type SongFile } from '../db/schema'
import { parseAbcHeader } from './abcMeta'
import { kindOf, mimeOf, stripExt } from './kinds'
import { pdfPageCount } from './pdf'

/**
 * Filename metadata pattern, e.g. "%artist% - %title%". Tokens: %title% %artist% %composer% %album%
 * %genre% %key% %year% %collection% %source% %custom% %ignore%. Folder tokens use the same names and
 * are matched against each folder level from the right ("%genre%/%artist%").
 */
export interface ImportOptions {
  filePattern?: string
  folderPattern?: string
  /** Combine all selected files into one song (multi-file song). */
  combine?: boolean
  /** Put imported songs into this collection. */
  collection?: string
  /** Skip files whose content is already in the library. */
  skipDuplicates?: boolean
  /** Text files: treat as ChordPro when they contain chord markup. Default true. */
  detectChordPro?: boolean
}

export interface ImportSource {
  file: File
  /** Relative path including folders, e.g. "Jazz/Miles Davis/So What.pdf" */
  path?: string
}

export interface ImportResult {
  songs: Song[]
  skipped: { name: string; reason: string }[]
}

const TOKEN_FIELDS: Record<string, keyof Song | 'ignore'> = {
  title: 'title',
  artist: 'artists',
  composer: 'composers',
  album: 'albums',
  genre: 'genres',
  key: 'keys',
  year: 'years',
  collection: 'collections',
  source: 'sources',
  book: 'sources',
  custom: 'custom',
  custom2: 'custom2',
  tag: 'tags',
  signature: 'signatures',
  ignore: 'ignore',
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match `value` against a pattern like "%artist% - %title%" and return field → value. */
export function matchPattern(pattern: string, value: string): Record<string, string> | null {
  const names: string[] = []
  const re = pattern
    .split(/(%[a-z0-9]+%)/i)
    .map((part) => {
      const m = /^%([a-z0-9]+)%$/i.exec(part)
      if (m) {
        names.push(m[1].toLowerCase())
        return '(.+?)'
      }
      return escapeRe(part)
    })
    .join('')
  const m = new RegExp('^' + re + '$', 'i').exec(value.trim())
  if (!m) return null
  const out: Record<string, string> = {}
  names.forEach((n, i) => (out[n] = m[i + 1].trim()))
  return out
}

function applyFields(song: Song, fields: Record<string, string>) {
  for (const [token, value] of Object.entries(fields)) {
    const field = TOKEN_FIELDS[token]
    if (!field || field === 'ignore' || !value) continue
    if (field === 'title') song.title = value
    else {
      const arr = song[field] as string[]
      for (const v of value.split(/\s*[,;&]\s*/)) if (v && !arr.includes(v)) arr.push(v)
    }
  }
}

function metadataFromText(kind: FileKind, text: string, song: Song) {
  if (kind === 'abc') {
    const h = parseAbcHeader(text)
    if (h.title) song.title = h.title
    if (h.composer) song.composers = [h.composer]
    if (h.key) song.keys = [h.key]
    if (h.meter) song.signatures = [h.meter]
    return
  }
  const cp = parseChordPro(text)
  const t = metaFirst(cp, 'title')
  if (t) song.title = t
  const add = (field: keyof Song, key: string) => {
    const vals = cp.meta[key]
    if (vals?.length) (song[field] as string[]).push(...vals.filter((v) => !(song[field] as string[]).includes(v)))
  }
  add('artists', 'artist')
  add('composers', 'composer')
  add('albums', 'album')
  add('keys', 'key')
  add('signatures', 'time')
  add('years', 'year')
  add('genres', 'genre')
  add('sources', 'book')
  const dur = metaFirst(cp, 'duration')
  if (dur) song.duration = parseDuration(dur)
  const tempo = Number(metaFirst(cp, 'tempo'))
  if (tempo > 0) song.metronome = { ...song.metronome, bpm: tempo }
}

export function parseDuration(s: string): number {
  const parts = s.trim().split(':').map(Number)
  if (parts.some(isNaN)) return 0
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

async function readFile(src: ImportSource): Promise<{ file: SongFile; text?: string } | { error: string }> {
  const { file } = src
  const kind = kindOf(file.name, file.type)
  if (!kind) return { error: 'Unsupported file type' }
  const buf = await file.arrayBuffer()
  let pageCount = 1
  let text: string | undefined
  if (kind === 'pdf') {
    try {
      pageCount = await pdfPageCount(buf)
    } catch {
      return { error: 'Could not read PDF' }
    }
  } else if (kind !== 'image') {
    text = new TextDecoder().decode(buf)
  }
  const { id: blobId, size } = await putBlob(buf, mimeOf(kind, file.name))
  return {
    file: { id: uid(), name: file.name, kind, blobId, pageCount, size, sourcePath: src.path },
    text,
  }
}

export async function importFiles(sources: ImportSource[], opts: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { songs: [], skipped: [] }
  const existingBlobs = new Set<string>()
  if (opts.skipDuplicates) {
    const used = new Set<string>()
    await db.songs.each((s) => s.files.forEach((f) => used.add(f.blobId)))
    for (const id of used) existingBlobs.add(id)
  }
  let combined: Song | null = null
  for (const src of sources) {
    const r = await readFile(src)
    if ('error' in r) {
      result.skipped.push({ name: src.file.name, reason: r.error })
      continue
    }
    if (opts.skipDuplicates && existingBlobs.has(r.file.blobId)) {
      result.skipped.push({ name: src.file.name, reason: 'Already in library' })
      continue
    }
    existingBlobs.add(r.file.blobId)
    if (opts.combine && combined) {
      combined.files.push(r.file)
      continue
    }
    const song = emptySong({ id: uid(), title: stripExt(src.file.name) })
    song.files.push(r.file)
    if (opts.folderPattern && src.path) {
      const folders = src.path.split('/').slice(0, -1)
      const patParts = opts.folderPattern.split('/').filter(Boolean)
      const tail = folders.slice(-patParts.length)
      if (tail.length === patParts.length) {
        patParts.forEach((p, i) => {
          const m = matchPattern(p, tail[i])
          if (m) applyFields(song, m)
        })
      }
    }
    if (opts.filePattern) {
      const m = matchPattern(opts.filePattern, stripExt(src.file.name))
      if (m) applyFields(song, m)
    }
    if (r.text !== undefined && opts.detectChordPro !== false) metadataFromText(r.file.kind, r.text, song)
    if (opts.collection && !song.collections.includes(opts.collection)) song.collections.push(opts.collection)
    result.songs.push(song)
    if (opts.combine) combined = song
  }
  await db.songs.bulkPut(result.songs)
  return result
}

/** Add files to an existing song. */
export async function addFilesToSong(song: Song, files: File[]): Promise<Song> {
  const next = structuredClone(song)
  for (const f of files) {
    const r = await readFile({ file: f })
    if ('file' in r) next.files.push(r.file)
  }
  if (next.pageOrder) {
    for (const f of next.files.slice(song.files.length))
      for (let p = 0; p < f.pageCount; p++) next.pageOrder.push({ fileId: f.id, page: p })
  }
  next.modifiedAt = Date.now()
  await db.songs.put(next)
  return next
}

/** Create a new text (ChordPro) song from scratch. */
export async function createTextSong(title: string, body: string, kind: FileKind = 'chordpro'): Promise<Song> {
  const buf = new TextEncoder().encode(body).buffer as ArrayBuffer
  const { id: blobId, size } = await putBlob(buf, 'text/plain;charset=utf-8')
  const ext = kind === 'abc' ? 'abc' : kind === 'text' ? 'txt' : 'cho'
  const song = emptySong({ id: uid(), title })
  song.files.push({ id: uid(), name: `${title}.${ext}`, kind, blobId, pageCount: 1, size })
  metadataFromText(kind, body, song)
  await db.songs.put(song)
  return song
}

/** Replace the contents of a text file inside a song (text/ChordPro/ABC editors). */
export async function updateTextFile(song: Song, fileId: string, body: string): Promise<Song> {
  const buf = new TextEncoder().encode(body).buffer as ArrayBuffer
  const { id: blobId, size } = await putBlob(buf, 'text/plain;charset=utf-8')
  const next = structuredClone(song)
  const f = next.files.find((x) => x.id === fileId)
  if (f) {
    f.blobId = blobId
    f.size = size
  }
  next.modifiedAt = Date.now()
  await db.songs.put(next)
  return next
}

/** Recursively collect files from a directory handle (File System Access API). */
export async function collectDirectory(dir: FileSystemDirectoryHandle, prefix = ''): Promise<ImportSource[]> {
  const out: ImportSource[] = []
  for await (const [name, handle] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') out.push(...(await collectDirectory(handle as FileSystemDirectoryHandle, path)))
    else if (kindOf(name)) out.push({ file: await (handle as FileSystemFileHandle).getFile(), path })
  }
  return out.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '', undefined, { numeric: true }))
}

/** Files from an <input webkitdirectory> selection carry webkitRelativePath. */
export function sourcesFromFileList(list: FileList | File[]): ImportSource[] {
  return [...list]
    .filter((f) => kindOf(f.name, f.type))
    .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
}
