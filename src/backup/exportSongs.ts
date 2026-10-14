/**
 * Song/setlist sharing & export entry points used by library menus: song packages (.ospkg), original
 * or flattened files, title lists (.txt/.pdf), printing, and package import.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib'
import { db, getBlob } from '../db/db'
import type { Setlist, SetlistEntry, Song } from '../db/schema'
import { confirmDialog, toast } from '../ui/primitives'
import { findTitleConflicts, importPackageArchive, openArchive, restoreArchive, writeArchive, type OnProgress } from './archive'
import { dateStamp, deliverFiles, safeName } from './deliver'
import { FontCache, appendSongPages, encodable } from './pdfExport'
import { MemorySink, ZipWriter } from './zip'

export const PACKAGE_EXT = '.ospkg'
export const PACKAGE_MIME = 'application/x-openstand-package'

async function loadSongs(ids: string[]): Promise<Song[]> {
  return (await db.songs.bulkGet(ids)).filter(Boolean) as Song[]
}

async function defaultName(songs: Song[], setlists: Setlist[], fallback: string) {
  if (setlists.length === 1) return safeName(setlists[0].name)
  if (songs.length === 1) return safeName(songs[0].title)
  return `${fallback}-${dateStamp()}`
}

/* --------------------------------------------------------------- packages */

export interface PackageOptions {
  setlistIds?: string[]
  name?: string
  includeAnnotations?: boolean
  includeAudio?: boolean
  share?: boolean
  onProgress?: OnProgress
}

/** Export songs (and setlists with their songs) as a .ospkg file other OpenStand users can import. */
export async function exportSongsPackage(songIds: string[], opts: PackageOptions = {}): Promise<void> {
  const setlists = opts.setlistIds?.length ? ((await db.setlists.bulkGet(opts.setlistIds)).filter(Boolean) as Setlist[]) : []
  const songs = await loadSongs(songIds)
  if (!songs.length && !setlists.length) return void toast('Nothing to export')
  const sink = new MemorySink()
  const manifest = await writeArchive(sink, {
    kind: 'package',
    songIds,
    setlistIds: opts.setlistIds,
    includeAnnotations: opts.includeAnnotations,
    includeAudio: opts.includeAudio,
    onProgress: opts.onProgress,
  })
  const name = `${opts.name ? safeName(opts.name) : await defaultName(songs, setlists, 'OpenStand-songs')}${PACKAGE_EXT}`
  const file = new File([sink.blob(PACKAGE_MIME)], name, { type: PACKAGE_MIME })
  const ok = await deliverFiles([file], { share: opts.share, title: name, description: 'OpenStand song package' })
  if (ok) toast(`Exported ${manifest.counts.songs} song${manifest.counts.songs === 1 ? '' : 's'}`, 'ok')
}

/**
 * Import a .ospkg (or merge a .osbackup). Songs whose title (and first artist) already exist can
 * update those songs or come in as copies; without `onConflict` the user is asked.
 */
export async function importPackage(
  file: File,
  opts: { onConflict?: 'copy' | 'update'; onProgress?: OnProgress } = {},
): Promise<{ songs: number; setlists: number }> {
  const archive = await openArchive(file)
  if (archive.manifest.kind === 'backup') {
    const ok = await confirmDialog({
      title: 'Merge a full backup?',
      message: `“${file.name}” is a full library backup (${archive.manifest.counts.songs} songs). Merge it into this library? Newer versions of songs win. To replace the library instead, use Settings › Backup.`,
      confirmLabel: 'Merge',
    })
    if (!ok) return { songs: 0, setlists: 0 }
    const r = await restoreArchive(archive, { mode: 'merge', conflict: 'newer', onProgress: opts.onProgress })
    return { songs: r.songsAdded + r.songsUpdated, setlists: r.setlists }
  }
  let onConflict = opts.onConflict
  if (!onConflict) {
    const conflicts = await findTitleConflicts(archive.library.songs)
    onConflict = 'copy'
    if (conflicts.size) {
      const n = conflicts.size
      const update = await confirmDialog({
        title: `${n} song${n === 1 ? ' is' : 's are'} already in your library`,
        message: `Update ${n === 1 ? 'it' : 'them'} with the version from the package (keeps play history), or cancel to import ${n === 1 ? 'a copy' : 'copies'} alongside?`,
        confirmLabel: 'Update existing',
      })
      onConflict = update ? 'update' : 'copy'
    }
  }
  const r = await importPackageArchive(archive, { onConflict, onProgress: opts.onProgress })
  return { songs: r.songs, setlists: r.setlists }
}

/* ------------------------------------------------------------------ files */

export interface FileExportOptions {
  /** Burn annotations into PDF/image pages */
  withAnnotations?: boolean
  /** Join everything into one PDF */
  merge?: boolean
  /** Apply crop and rotation (default: same as withAnnotations) */
  cropRotate?: boolean
  /** Name files after song titles instead of original file names */
  useTitles?: boolean
  /** Base name for merged/zip output */
  name?: string
  share?: boolean
  /** Bundle several files into one .zip instead of handing over many files */
  zip?: boolean
  onProgress?: OnProgress
}

function extOf(name: string) {
  const m = /\.[^.]+$/.exec(name)
  return m ? m[0] : ''
}

/**
 * Export song files: originals, or PDFs with crop/rotation/annotations applied, optionally merged.
 * Called without options (library menus) it first asks the user how to export.
 */
export async function exportSongFiles(songIds: string[], options?: FileExportOptions): Promise<void> {
  const songs = await loadSongs(songIds)
  if (!songs.length) return
  let opts = options
  if (!opts) {
    const { askFileExportOptions } = await import('./ExportDialog')
    const picked = await askFileExportOptions(songs.length)
    if (!picked) return
    opts = picked
  }
  const report = opts.onProgress ?? (() => {})
  const render = !!(opts.withAnnotations || opts.merge || opts.cropRotate)
  const files: File[] = []
  const used = new Set<string>()
  const unique = (n: string) => {
    let name = n
    for (let i = 2; used.has(name.toLowerCase()); i++) name = n.replace(/(\.[^.]+)?$/, ` (${i})$1`)
    used.add(name.toLowerCase())
    return name
  }
  let textOnly = 0

  if (render) {
    const merged = opts.merge ? await PDFDocument.create() : null
    const fonts = merged ? new FontCache(merged) : null
    for (let i = 0; i < songs.length; i++) {
      const s = songs[i]
      report({ phase: 'files', done: i, total: songs.length })
      const doc = merged ?? (await PDFDocument.create())
      const r = await appendSongPages(doc, s, { annotations: opts.withAnnotations, cropRotate: opts.cropRotate ?? true }, fonts ?? undefined)
      // Text/ChordPro/ABC files can't be flattened into PDF here; ship them as they are.
      for (const f of r.skipped) {
        files.push(new File([await getBlob(f.blobId)], unique(opts.useTitles ? `${safeName(s.title)}${extOf(f.name)}` : f.name)))
        textOnly++
      }
      if (!merged && r.pages) {
        doc.setTitle(s.title)
        files.push(new File([(await doc.save()) as BlobPart], unique(`${safeName(s.title)}.pdf`), { type: 'application/pdf' }))
      }
    }
    if (merged && merged.getPageCount()) {
      merged.setTitle(opts.name ?? 'OpenStand')
      merged.setProducer('OpenStand')
      const name = `${opts.name ? safeName(opts.name) : songs.length === 1 ? safeName(songs[0].title) : `OpenStand-${dateStamp()}`}.pdf`
      files.unshift(new File([(await merged.save()) as BlobPart], unique(name), { type: 'application/pdf' }))
    }
  } else {
    for (const s of songs) {
      for (let i = 0; i < s.files.length; i++) {
        const f = s.files[i]
        const b = await getBlob(f.blobId)
        const name = opts.useTitles ? `${safeName(s.title)}${s.files.length > 1 ? ` ${i + 1}` : ''}${extOf(f.name)}` : f.name
        files.push(new File([b], unique(name), { type: b.type }))
      }
    }
  }
  report({ phase: 'finishing', done: 1, total: 1 })
  if (!files.length) return void toast('These songs have no files to export')

  let out = files
  const bundle = opts.zip ?? (files.length > 1 && !(opts.share ?? false))
  if (bundle && files.length > 1) {
    const sink = new MemorySink()
    const zip = new ZipWriter(sink)
    for (const f of files) await zip.addBlob(f.name, f)
    await zip.finish()
    const name = `${opts.name ? safeName(opts.name) : `OpenStand-files-${dateStamp()}`}.zip`
    out = [new File([sink.blob()], name, { type: 'application/zip' })]
  }
  const ok = await deliverFiles(out, { share: opts.share, title: opts.name, description: out[0].type === 'application/pdf' ? 'PDF document' : 'Files' })
  if (ok && textOnly && render) toast(`${textOnly} text/ChordPro file${textOnly === 1 ? ' was' : 's were'} exported as-is`)
}

/* ------------------------------------------------------------- title list */

export interface TitleListOptions {
  /** Use this setlist's entries (breaks, notes) instead of `songIds` */
  setlistId?: string
  numbered?: boolean
  /** Show artist, key and duration */
  details?: boolean
  share?: boolean
}

const fmtDuration = (sec: number) => {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.round(sec % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export interface ListRow {
  kind: 'song' | 'break'
  n?: number
  title: string
  artist?: string
  key?: string
  duration?: number
  note?: string
}

/** Rows for a title list; pure so it can be tested. */
export function buildListRows(entries: Pick<SetlistEntry, 'songId' | 'isBreak' | 'breakLabel' | 'note'>[], songs: Map<string, Song>): ListRow[] {
  const rows: ListRow[] = []
  let n = 0
  for (const e of entries) {
    if (e.isBreak) {
      rows.push({ kind: 'break', title: e.breakLabel || 'Break' })
      continue
    }
    const s = songs.get(e.songId)
    if (!s) continue
    rows.push({ kind: 'song', n: ++n, title: s.title, artist: s.artists[0], key: s.keys[0], duration: s.duration || undefined, note: e.note })
  }
  return rows
}

export function listToText(heading: string, rows: ListRow[], opts: { numbered?: boolean; details?: boolean } = {}): string {
  const numbered = opts.numbered ?? true
  const details = opts.details ?? true
  const lines: string[] = []
  if (heading) lines.push(heading, '='.repeat(Math.min(60, heading.length)), '')
  for (const r of rows) {
    if (r.kind === 'break') {
      lines.push('', `— ${r.title} —`, '')
      continue
    }
    let line = `${numbered ? `${r.n}. ` : ''}${r.title}`
    if (details) {
      if (r.artist) line += ` — ${r.artist}`
      const extra = [r.key, r.duration ? fmtDuration(r.duration) : ''].filter(Boolean).join(', ')
      if (extra) line += ` (${extra})`
    }
    if (r.note) line += `  [${r.note}]`
    lines.push(line)
  }
  const total = rows.reduce((t, r) => t + (r.duration ?? 0), 0)
  const count = rows.filter((r) => r.kind === 'song').length
  lines.push('', `${count} song${count === 1 ? '' : 's'}${details && total ? ` · ${fmtDuration(total)}` : ''}`)
  return lines.join('\n') + '\n'
}

async function listToPdf(heading: string, rows: ListRow[], opts: { numbered?: boolean; details?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(heading || 'Song list')
  doc.setProducer('OpenStand')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const [W, H] = [595.28, 841.89]
  const M = 56
  const numbered = opts.numbered ?? true
  const details = opts.details ?? true
  let page = doc.addPage([W, H])
  let y = H - M
  const muted = rgb(0.42, 0.4, 0.37)
  const text = (s: string, x: number, size: number, f: PDFFont = font, color = rgb(0.1, 0.1, 0.1)) => page.drawText(encodable(f, s), { x, y, size, font: f, color })
  const fit = (s: string, f: PDFFont, size: number, max: number) => {
    let t = encodable(f, s)
    if (f.widthOfTextAtSize(t, size) <= max) return t
    while (t.length > 1 && f.widthOfTextAtSize(t + '…', size) > max) t = t.slice(0, -1)
    return t + '…'
  }
  const ensure = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([W, H])
      y = H - M
    }
  }
  if (heading) {
    text(fit(heading, bold, 20, W - 2 * M), M, 20, bold)
    y -= 18
    text(new Date().toLocaleDateString(), M, 9, font, muted)
    y -= 26
  }
  const rowH = 20
  const rightCol = W - M
  for (const r of rows) {
    if (r.kind === 'break') {
      ensure(rowH * 2)
      y -= 6
      text(r.title.toUpperCase(), M, 9, bold, muted)
      page.drawLine({ start: { x: M + bold.widthOfTextAtSize(encodable(bold, r.title.toUpperCase()), 9) + 8, y: y + 3 }, end: { x: rightCol, y: y + 3 }, thickness: 0.5, color: muted })
      y -= rowH
      continue
    }
    ensure(rowH)
    const num = numbered ? `${r.n}.` : ''
    if (num) text(num, M + 18 - font.widthOfTextAtSize(num, 12), 12, font, muted)
    const x = M + (numbered ? 26 : 0)
    const extra = details ? [r.key, r.duration ? fmtDuration(r.duration) : ''].filter(Boolean).join('   ') : ''
    const extraW = extra ? font.widthOfTextAtSize(encodable(font, extra), 10) : 0
    const maxTitle = rightCol - x - extraW - 16
    const title = fit(r.title, bold, 12, maxTitle)
    text(title, x, 12, bold)
    let cx = x + bold.widthOfTextAtSize(title, 12)
    const sub = [details ? r.artist : '', r.note].filter(Boolean).join(' · ')
    if (sub && cx + 20 < x + maxTitle) {
      const t = fit(`  ${sub}`, font, 10, x + maxTitle - cx)
      text(t, cx, 10, font, muted)
      cx += font.widthOfTextAtSize(t, 10)
    }
    if (extra) text(extra, rightCol - extraW, 10, font, muted)
    y -= rowH
  }
  const total = rows.reduce((t, r) => t + (r.duration ?? 0), 0)
  const count = rows.filter((r) => r.kind === 'song').length
  ensure(rowH * 2)
  y -= 8
  page.drawLine({ start: { x: M, y: y + 12 }, end: { x: rightCol, y: y + 12 }, thickness: 0.5, color: rgb(0.85, 0.84, 0.8) })
  text(`${count} song${count === 1 ? '' : 's'}${details && total ? `  ·  ${fmtDuration(total)}` : ''}`, M, 10, font, muted)
  return doc.save()
}

/** Export a list of song titles (in order) as .txt or a simple PDF. */
export async function exportTitleList(songIds: string[], title: string, format: 'txt' | 'pdf', opts: TitleListOptions = {}): Promise<void> {
  let entries: Pick<SetlistEntry, 'songId' | 'isBreak' | 'breakLabel' | 'note'>[] = songIds.map((songId) => ({ songId }))
  if (opts.setlistId) {
    const sl = await db.setlists.get(opts.setlistId)
    if (sl) {
      entries = sl.entries
      title ||= sl.name
    }
  }
  const ids = [...new Set(entries.filter((e) => !e.isBreak).map((e) => e.songId))]
  const songs = new Map((await loadSongs(ids)).map((s) => [s.id, s]))
  const rows = buildListRows(entries, songs)
  const base = safeName(title || `Songs-${dateStamp()}`)
  const file =
    format === 'txt'
      ? new File([listToText(title, rows, opts)], `${base}.txt`, { type: 'text/plain;charset=utf-8' })
      : new File([(await listToPdf(title, rows, opts)) as BlobPart], `${base}.pdf`, { type: 'application/pdf' })
  await deliverFiles([file], { share: opts.share, title, description: format === 'txt' ? 'Text file' : 'PDF document' })
}

/* ------------------------------------------------------------------ print */

/**
 * Print songs: builds one PDF (crop, rotation and annotations applied) and opens the browser's print
 * dialog for it via a hidden iframe; falls back to opening the PDF in a new tab.
 */
export async function printSongs(songIds: string[], opts: { withAnnotations?: boolean; title?: string } = {}): Promise<void> {
  const songs = await loadSongs(songIds)
  const doc = await PDFDocument.create()
  const fonts = new FontCache(doc)
  let skipped = 0
  for (const s of songs) skipped += (await appendSongPages(doc, s, { annotations: opts.withAnnotations ?? true }, fonts)).skipped.length
  if (!doc.getPageCount()) return void toast(skipped ? 'Text songs can’t be printed from here yet — open them and use the browser’s print' : 'Nothing to print')
  doc.setTitle(opts.title ?? (songs.length === 1 ? songs[0].title : 'OpenStand'))
  const url = URL.createObjectURL(new Blob([(await doc.save()) as BlobPart], { type: 'application/pdf' }))
  // iOS Safari (and some embedded PDF viewers) never print from an iframe: open the PDF instead.
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 120_000)
    return
  }
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0'
  frame.src = url
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } catch {
      window.open(url, '_blank')
    }
    setTimeout(() => {
      frame.remove()
      URL.revokeObjectURL(url)
    }, 120_000)
  }
  document.body.appendChild(frame)
}
