import { looksLikeChordPro, metaFirst, parseChordPro, stripMarkup, textToChordPro } from '../chordpro/parse'
import { db, getBlob, putBlob, uid } from '../db/db'
import { emptySong, GROUP_FIELDS, type FileKind, type GroupField, type Song, type SongFile } from '../db/schema'
import { parseAbcHeader } from './abcMeta'
import { kindOf, mimeOf, stripExt } from './kinds'

/**
 * Filename metadata pattern, e.g. "%artist% - %title%". Tokens (case-insensitive): %title% %artist%
 * %composer% %album% %genre% %key% %year% %collection% %source% (%source_type%) %custom% (%custom_group%)
 * %custom2% %tag% %signature% %ignore%. Folder patterns use the same tokens, one per folder level,
 * joined by "/" ("%genre%/%artist%"); each level may itself be a pattern ("%artist% - %album%").
 */
export interface ImportOptions {
  filePattern?: string
  folderPattern?: string
  /**
   * Align the folder pattern with the folders at the END of the path (default) instead of the first
   * folders below the import root.
   */
  folderFromEnd?: boolean
  /** Combine all selected files into one song (multi-file song). */
  combine?: boolean
  /** Put imported songs into this collection. */
  collection?: string
  /** Extra group values added to every imported song. */
  groups?: Partial<Record<GroupField, string[]>>
  /** Skip files whose content is already in the library. */
  skipDuplicates?: boolean
  /** When a song with the same title already exists (case-insensitive). Default 'create'. */
  conflict?: 'create' | 'update' | 'skip'
  /** Text files: read title/artist/key… from ChordPro directives or plain-text headers. Default true. */
  detectChordPro?: boolean
  /** Use the PDF's metadata title when the filename pattern gives none. */
  pdfTitle?: boolean
  /** Detect page margins after import (needs a DOM; slow for big PDFs). */
  autoCrop?: boolean | 'aggressive'
  onProgress?: (done: number, total: number, name: string) => void
  signal?: AbortSignal
}

export interface ImportSource {
  file: File
  /** Relative path including folders, e.g. "Jazz/Miles Davis/So What.pdf" */
  path?: string
}

export interface ImportResult {
  /** Newly created songs. */
  songs: Song[]
  /** Existing songs updated (conflict = 'update'). */
  updated: Song[]
  skipped: { name: string; reason: string }[]
}

export const FILE_PATTERN_PRESETS = ['%title%', '%artist% - %title%', '%title% - %artist%', '%composer% - %title%', '%title% - %composer%', '%title% (%key%)', '%ignore% - %title%']
export const FOLDER_PATTERN_PRESETS = ['%artist%', '%genre%/%artist%', '%artist%/%album%', '%composer%', '%collection%']
export const PATTERN_TOKENS = ['title', 'artist', 'composer', 'album', 'genre', 'key', 'year', 'collection', 'source', 'custom', 'custom2', 'tag', 'signature', 'ignore']

const TOKEN_FIELDS: Record<string, 'title' | GroupField | 'ignore'> = {
  title: 'title',
  artist: 'artists',
  composer: 'composers',
  album: 'albums',
  genre: 'genres',
  key: 'keys',
  year: 'years',
  collection: 'collections',
  source: 'sources',
  source_type: 'sources',
  book: 'sources',
  custom: 'custom',
  custom_group: 'custom',
  custom2: 'custom2',
  tag: 'tags',
  signature: 'signatures',
  ignore: 'ignore',
  setlist: 'ignore',
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match `value` against a pattern like "%artist% - %title%" and return field → value. */
export function matchPattern(pattern: string, value: string): Record<string, string> | null {
  const names: string[] = []
  const re = pattern
    .split(/(%[a-z0-9_]+%)/i)
    .map((part) => {
      const m = /^%([a-z0-9_]+)%$/i.exec(part)
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

/**
 * Field values from the folders of `path` ("a/b/c/file.pdf"). With `fromEnd` the LAST pattern level
 * maps to the folder containing the file; otherwise the first level maps to the first folder.
 */
export function folderFields(path: string, pattern: string, fromEnd = true): Record<string, string> {
  const folders = path.split('/').slice(0, -1).filter(Boolean)
  const parts = pattern.split('/').filter((p) => p.trim())
  const out: Record<string, string> = {}
  const n = Math.min(folders.length, parts.length)
  for (let i = 0; i < n; i++) {
    const part = fromEnd ? parts[parts.length - n + i] : parts[i]
    const folder = fromEnd ? folders[folders.length - n + i] : folders[i]
    const m = matchPattern(part, folder)
    if (m) for (const [k, v] of Object.entries(m)) if (v && !(k in out)) out[k] = v
  }
  return out
}

/** "the long and winding road" → "The Long And Winding Road" (only first letters are touched). */
export function capitalizeWords(s: string): string {
  return s.replace(/(^|[\s(\-/"“])(\p{Ll})/gu, (_, pre, ch) => pre + ch.toUpperCase())
}

export function applyFields(song: Song, fields: Record<string, string>) {
  for (const [token, value] of Object.entries(fields)) {
    const field = TOKEN_FIELDS[token]
    if (!field || field === 'ignore' || !value) continue
    if (field === 'title') song.title = value
    else {
      const arr = song[field]
      for (const v of value.split(/\s*[,;&]\s*/)) if (v && !arr.includes(v)) arr.push(v)
    }
  }
}

/** Title + field values that the patterns would give a source (pure; used for the import preview). */
export function previewSource(src: ImportSource, opts: Pick<ImportOptions, 'filePattern' | 'folderPattern' | 'folderFromEnd'>) {
  const song = emptySong({ id: '', title: stripExt(src.file.name) })
  if (opts.folderPattern && src.path) applyFields(song, folderFields(src.path, opts.folderPattern, opts.folderFromEnd ?? true))
  let matched = !opts.filePattern
  if (opts.filePattern) {
    const m = matchPattern(opts.filePattern, stripExt(src.file.name))
    if (m) {
      applyFields(song, m)
      matched = true
    }
  }
  return { song, matched }
}

export interface SourceContent {
  /** Decoded text of a ChordPro/text/ABC file. */
  text?: string
  /** Title from the PDF's document properties. */
  pdfTitle?: string
}

type PreviewOptions = Pick<ImportOptions, 'filePattern' | 'folderPattern' | 'folderFromEnd' | 'pdfTitle' | 'detectChordPro'>

/**
 * Title + fields a source gets on import, including what is read from its content (ChordPro/text/ABC
 * headers, PDF title). Pure: `importFiles` and the import preview both use it so they always agree.
 */
export function previewWithContent(src: ImportSource, opts: PreviewOptions, content: SourceContent = {}) {
  const p = previewSource(src, opts)
  const kind = kindOf(src.file.name, src.file.type)
  const before = p.song.title
  if (opts.pdfTitle && content.pdfTitle && (!opts.filePattern || !p.matched)) p.song.title = content.pdfTitle
  if (kind && content.text !== undefined && opts.detectChordPro !== false) metadataFromText(kind, content.text, p.song)
  return { ...p, titleFromContent: p.song.title !== before }
}

/** Decoded text of a text-format source (for the preview), or undefined for PDFs/images/huge files. */
export async function readSourceText(src: ImportSource, maxBytes = 512 * 1024): Promise<string | undefined> {
  const kind = kindOf(src.file.name, src.file.type)
  if (!kind || kind === 'pdf' || kind === 'image' || src.file.size > maxBytes) return undefined
  return (await src.file.text()).replace(/^\uFEFF/, '')
}

/** Fill song fields from ChordPro directives, plain-text "Title: …" headers or an ABC header. */
export function metadataFromText(kind: FileKind, text: string, song: Song) {
  if (kind === 'abc') {
    const h = parseAbcHeader(text)
    if (h.title) song.title = h.title
    if (h.composer && !song.composers.includes(h.composer)) song.composers.push(h.composer)
    if (h.key && !song.keys.includes(h.key)) song.keys.push(h.key)
    if (h.meter && !song.signatures.includes(h.meter)) song.signatures.push(h.meter)
    const bpm = Number(/(\d+)\s*$/.exec(h.tempo ?? '')?.[1])
    if (bpm > 0 && !song.tempos?.length) song.tempos = [bpm]
    return
  }
  const isCp = kind === 'chordpro' || looksLikeChordPro(text)
  const cp = parseChordPro(isCp ? text : textToChordPro(text))
  const t = metaFirst(cp, 'title')
  if (t) song.title = stripMarkup(t)
  const add = (field: GroupField, key: string) => {
    for (const raw of cp.meta[key] ?? []) {
      const v = stripMarkup(raw)
      if (v && !song[field].includes(v)) song[field].push(v)
    }
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
  if (tempo > 0) {
    song.metronome = { ...song.metronome, bpm: tempo }
    if (!song.tempos?.length) song.tempos = [tempo]
  }
}

export function parseDuration(s: string): number {
  const parts = s.trim().split(':').map(Number)
  if (!s.trim() || parts.some(isNaN)) return 0
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

export function formatDuration(sec: number): string {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export type ReadFileResult = { file: SongFile; text?: string; pdfTitle?: string } | { error: string }

/** Store a file's content and describe it as a SongFile (does not touch any song). */
export async function readImportFile(src: ImportSource): Promise<ReadFileResult> {
  const { file } = src
  const kind = kindOf(file.name, file.type)
  if (!kind) return { error: 'Unsupported file type' }
  if (!file.size) return { error: 'Empty file' }
  const buf = await file.arrayBuffer()
  let pageCount = 1
  let text: string | undefined
  let pdfTitle: string | undefined
  if (kind === 'pdf') {
    try {
      // pdf.js is loaded on demand so the library starts without it.
      const { pdfMetaTitle, withPdf } = await import('./pdf')
      ;[pageCount, pdfTitle] = await withPdf(buf, async (doc) => [doc.numPages, await pdfMetaTitle(doc)] as const)
    } catch (e) {
      const msg = String((e as Error)?.name ?? e)
      return { error: /Password/i.test(msg) ? 'PDF is password protected' : 'Could not read PDF' }
    }
  } else if (kind !== 'image') {
    text = new TextDecoder().decode(buf).replace(/^﻿/, '')
  }
  const { id: blobId, size } = await putBlob(buf, mimeOf(kind, file.name))
  return {
    file: { id: uid(), name: file.name, kind, blobId, pageCount, size, sourcePath: src.path },
    text,
    pdfTitle,
  }
}

function mergeInto(target: Song, src: Song) {
  for (const g of GROUP_FIELDS) for (const v of src[g]) if (!target[g].includes(v)) target[g].push(v)
}

export async function importFiles(sources: ImportSource[], opts: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = { songs: [], updated: [], skipped: [] }
  const existingBlobs = new Set<string>()
  if (opts.skipDuplicates) await db.songs.each((s) => s.files.forEach((f) => existingBlobs.add(f.blobId)))
  const byTitle = new Map<string, Song>()
  if (opts.conflict && opts.conflict !== 'create')
    await db.songs.each((s) => {
      const k = s.title.trim().toLowerCase()
      if (!byTitle.has(k)) byTitle.set(k, s)
    })
  let combined: Song | null = null
  let done = 0
  for (const src of sources) {
    if (opts.signal?.aborted) break
    opts.onProgress?.(done++, sources.length, src.file.name)
    const r = await readImportFile(src)
    if ('error' in r) {
      result.skipped.push({ name: src.file.name, reason: r.error })
      continue
    }
    // Combining: every picked file is a page of the new song, so library duplicates are kept.
    const duplicate = opts.skipDuplicates && !opts.combine && existingBlobs.has(r.file.blobId)
    if (duplicate && opts.conflict !== 'update') {
      result.skipped.push({ name: src.file.name, reason: 'Already in library' })
      continue
    }
    existingBlobs.add(r.file.blobId)
    if (opts.combine && combined) {
      combined.files.push(r.file)
      continue
    }
    const { song } = previewWithContent(src, opts, r)
    song.id = uid()
    song.files.push(r.file)
    if (opts.collection && !song.collections.includes(opts.collection)) song.collections.push(opts.collection)
    for (const [g, vals] of Object.entries(opts.groups ?? {}) as [GroupField, string[]][])
      for (const v of vals) if (v && !song[g].includes(v)) song[g].push(v)

    const match = !opts.combine && opts.conflict && opts.conflict !== 'create' ? byTitle.get(song.title.trim().toLowerCase()) : undefined
    if (duplicate && !match) {
      // Same content already in the library under another title: still a duplicate.
      result.skipped.push({ name: src.file.name, reason: 'Already in library' })
      continue
    }
    if (match) {
      if (opts.conflict === 'skip') {
        result.skipped.push({ name: src.file.name, reason: `"${match.title}" already exists` })
        continue
      }
      const next = result.updated.find((s) => s.id === match.id) ?? structuredClone(match)
      mergeInto(next, song)
      if (!next.files.some((f) => f.blobId === r.file.blobId)) {
        next.files = [r.file]
        next.pageOrder = undefined
        next.pageSettings = {}
      }
      next.modifiedAt = Date.now()
      if (!result.updated.includes(next)) result.updated.push(next)
      byTitle.set(song.title.trim().toLowerCase(), next)
      continue
    }
    result.songs.push(song)
    if (opts.conflict && opts.conflict !== 'create') byTitle.set(song.title.trim().toLowerCase(), song)
    if (opts.combine) combined = song
  }
  if (opts.autoCrop) {
    const { autoCropSong } = await import('./cropPages')
    for (const s of [...result.songs, ...result.updated]) {
      if (opts.signal?.aborted) break
      opts.onProgress?.(sources.length, sources.length, `Cropping ${s.title}`)
      try {
        s.pageSettings = await autoCropSong(s, { aggressive: opts.autoCrop === 'aggressive' })
      } catch (e) {
        console.warn('auto-crop failed', e)
      }
    }
  }
  await db.songs.bulkPut([...result.songs, ...result.updated])
  opts.onProgress?.(sources.length, sources.length, '')
  return result
}

/** Add files to an existing song (saves it). */
export async function addFilesToSong(song: Song, files: File[]): Promise<Song> {
  const next = structuredClone(song)
  for (const f of files) {
    const r = await readImportFile({ file: f })
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

/** Store a text body as a new SongFile (not attached to any song yet). */
export async function makeTextFile(name: string, body: string, kind: FileKind): Promise<SongFile> {
  const buf = new TextEncoder().encode(body).buffer as ArrayBuffer
  const { id: blobId, size } = await putBlob(buf, 'text/plain;charset=utf-8')
  return { id: uid(), name, kind, blobId, pageCount: 1, size }
}

/** Starter content for "New ChordPro / text / ABC file". */
export function textTemplate(kind: FileKind, song: Pick<Song, 'title' | 'artists' | 'keys'>): string {
  const title = song.title || 'Untitled'
  if (kind === 'abc') return `X:1\nT:${title}\nM:4/4\nL:1/8\nK:${song.keys[0] ?? 'C'}\n|: CDEF GABc | c2B2 A2G2 :|\n`
  if (kind === 'text') return `${title}\n${song.artists[0] ?? ''}\n\nC        G\nType your lyrics here\n`
  return [
    `{title: ${title}}`,
    song.artists[0] ? `{artist: ${song.artists[0]}}` : '{artist: }',
    `{key: ${song.keys[0] ?? 'C'}}`,
    '',
    '{start_of_verse: Verse 1}',
    '[C]Type your [G]lyrics with [Am]chords in [F]brackets',
    '{end_of_verse}',
    '',
    '{start_of_chorus}',
    '[F]This is the [G]chorus',
    '{end_of_chorus}',
    '',
  ].join('\n')
}

/** Create a new text (ChordPro) song from scratch. */
export async function createTextSong(title: string, body: string, kind: FileKind = 'chordpro'): Promise<Song> {
  const ext = kind === 'abc' ? 'abc' : kind === 'text' ? 'txt' : 'cho'
  const song = emptySong({ id: uid(), title })
  song.files.push(await makeTextFile(`${title}.${ext}`, body, kind))
  metadataFromText(kind, body, song)
  await db.songs.put(song)
  return song
}

const META_FIELDS: GroupField[] = ['artists', 'composers', 'albums', 'keys', 'signatures', 'years', 'genres', 'sources']
const sameValues = (a: readonly unknown[] = [], b: readonly unknown[] = []) =>
  a.length === b.length && a.every((v) => b.some((w) => String(w).toLowerCase() === String(v).toLowerCase()))

/**
 * After a song's text file was edited, carry metadata changes from the file into the song — but only
 * for values that still come from the file (equal to what the old content gave, or empty), so values
 * the user edited in the song itself are never overwritten. Mutates and returns `song`.
 */
export function refreshMetaFromText(song: Song, kind: FileKind, oldText: string, newText: string, fileName = ''): Song {
  const read = (text: string) => {
    const s = emptySong({ id: '', title: '' })
    try {
      metadataFromText(kind, text, s)
    } catch {
      /* unparsable: treat as no metadata */
    }
    return s
  }
  const was = read(oldText)
  const now = read(newText)
  const title = song.title.trim()
  if (now.title && now.title !== was.title && (!title || title === was.title || (!was.title && (title === stripExt(fileName) || title === 'Untitled'))))
    song.title = now.title
  for (const f of META_FIELDS) if (!sameValues(now[f], was[f]) && (!song[f].length || sameValues(song[f], was[f]))) song[f] = [...now[f]]
  if (now.duration !== was.duration && (!song.duration || song.duration === was.duration)) song.duration = now.duration
  if (!sameValues(now.tempos, was.tempos) && (!song.tempos?.length || sameValues(song.tempos, was.tempos))) song.tempos = now.tempos?.length ? [...now.tempos] : undefined
  const bpm = (s: Song) => s.metronome?.bpm
  if (bpm(now) !== bpm(was) && (bpm(song) === undefined || bpm(song) === bpm(was))) {
    if (bpm(now) !== undefined) song.metronome = { ...song.metronome, bpm: bpm(now) }
    else if (song.metronome) delete song.metronome.bpm
  }
  return song
}

/**
 * Replace the contents of a text file inside a song (text/ChordPro/ABC editors), refreshing song
 * metadata that was derived from the file (see `refreshMetaFromText`).
 */
export async function updateTextFile(song: Song, fileId: string, body: string, kind?: FileKind): Promise<Song> {
  const buf = new TextEncoder().encode(body).buffer as ArrayBuffer
  const { id: blobId, size } = await putBlob(buf, 'text/plain;charset=utf-8')
  const next = structuredClone(song)
  const f = next.files.find((x) => x.id === fileId)
  if (f) {
    const k = kind ?? f.kind
    if (k === 'chordpro' || k === 'text' || k === 'abc') {
      const old = await getBlob(f.blobId)
        .then((b) => b.text())
        .catch(() => '')
      refreshMetaFromText(next, k, old, body, f.name)
    }
    f.blobId = blobId
    f.size = size
  }
  next.modifiedAt = Date.now()
  await db.songs.put(next)
  return next
}

/** Recursively collect files from a directory handle (File System Access API). Paths exclude the root. */
export async function collectDirectory(dir: FileSystemDirectoryHandle, prefix = ''): Promise<ImportSource[]> {
  const out: ImportSource[] = []
  for await (const [name, handle] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith('.')) continue
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') out.push(...(await collectDirectory(handle as FileSystemDirectoryHandle, path)))
    else if (kindOf(name)) out.push({ file: await (handle as FileSystemFileHandle).getFile(), path })
  }
  return out.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '', undefined, { numeric: true }))
}

/** Files from an <input webkitdirectory> selection carry webkitRelativePath (which includes the root folder). */
export function sourcesFromFileList(list: FileList | File[]): ImportSource[] {
  return [...list]
    .filter((f) => kindOf(f.name, f.type))
    .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
}

/** Drop the shared first folder (the picked root) from relative paths, so levels match collectDirectory. */
export function stripCommonRoot(srcs: ImportSource[]): ImportSource[] {
  const firsts = new Set(srcs.map((s) => (s.path?.includes('/') ? s.path.split('/')[0] : '')))
  if (firsts.size !== 1 || firsts.has('')) return srcs
  return srcs.map((s) => ({ ...s, path: s.path!.split('/').slice(1).join('/') }))
}

/** Files (and dropped folders, recursively) from a drag-and-drop DataTransfer. */
export async function sourcesFromDataTransfer(dt: DataTransfer): Promise<ImportSource[]> {
  const entries = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[]
  if (!entries.length) return sourcesFromFileList(dt.files)
  const out: ImportSource[] = []
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.name.startsWith('.')) return
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      if (kindOf(file.name, file.type)) out.push({ file, path })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // readEntries returns batches; call until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const e of batch) await walk(e, path)
      }
    }
  }
  for (const e of entries) await walk(e, '')
  return out.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '', undefined, { numeric: true }))
}
