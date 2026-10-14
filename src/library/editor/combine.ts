/**
 * "Combine files": merge several PDF/image files of a song into one new PDF that takes the place of
 * the first one. Everything keyed by file + page (page order, crop/rotation, annotations) is moved
 * onto the new file; the shown page sequence stays identical, so bookmarks, link points and smart
 * buttons (which use indexes into that sequence) keep pointing at the same pages.
 *
 * The originals are left untouched: other songs may share their blobs, and the editor draft can be
 * cancelled. Crop and rotation stay page settings and annotations stay editable (nothing is burned in).
 */
import { PDFDocument } from 'pdf-lib'
import { flush as flushAnnotations } from '../../annotations/store'
import { db, getBlob, putBlob, uid } from '../../db/db'
import type { PageAnnotations, PageRef, PageSettings, Song, SongFile } from '../../db/schema'
import { resolvePageRefs } from '../../files/pageRefs'
import { addImagePage, embedImageBlob } from '../../files/imagePage'
import { normalizePageOrder } from './pageOrder'

export const combinable = (f: Pick<SongFile, 'kind'>) => f.kind === 'pdf' || f.kind === 'image'

export interface CombinePlan {
  /** Selected files in song order (= page order inside the new PDF). */
  files: SongFile[]
  /** First page of each selected file inside the new PDF. */
  offsets: Map<string, number>
  pageCount: number
}

export function planCombine(song: Song, ids: Iterable<string>): CombinePlan {
  const want = new Set(ids)
  const files = song.files.filter((f) => want.has(f.id))
  if (files.length < 2) throw new Error('Choose at least two files to combine')
  const bad = files.find((f) => !combinable(f))
  if (bad) throw new Error(`“${bad.name}” is a text file and can’t be combined into a PDF`)
  const offsets = new Map<string, number>()
  let pageCount = 0
  for (const f of files) {
    offsets.set(f.id, pageCount)
    pageCount += f.pageCount
  }
  return { files, offsets, pageCount }
}

/** Where page `page` of `fileId` lands in the combined file, or undefined if that file isn't merged. */
export function mapPage(plan: CombinePlan, fileId: string, page: number): number | undefined {
  const off = plan.offsets.get(fileId)
  return off === undefined ? undefined : off + page
}

/**
 * Pure: the song with `merged` (the new PDF, `merged.pageCount === plan.pageCount`) in place of the
 * selected files. Page order and page settings are re-keyed; index-based data needs no change.
 */
export function applyCombine(song: Song, plan: CombinePlan, merged: SongFile): Song {
  if (merged.pageCount !== plan.pageCount) throw new Error('Combined page count mismatch')
  const first = plan.files[0].id
  const files = song.files.flatMap((f) => (f.id === first ? [merged] : plan.offsets.has(f.id) ? [] : [f]))
  const map = (r: PageRef): PageRef => {
    const p = mapPage(plan, r.fileId, r.page)
    return p === undefined ? r : { fileId: merged.id, page: p }
  }
  // Without a custom order the old default sequence may not be the new default (e.g. files 1 and 3
  // merged around file 2), so always derive the order from what was shown and drop it if it's default.
  const shown = song.pageOrder?.length ? song.pageOrder : resolvePageRefs(song)
  const pageSettings: Record<string, PageSettings> = {}
  for (const [k, v] of Object.entries(song.pageSettings)) {
    const i = k.lastIndexOf(':')
    const p = mapPage(plan, k.slice(0, i), Number(k.slice(i + 1)))
    pageSettings[p === undefined ? k : `${merged.id}:${p}`] = v
  }
  return { ...song, files, pageOrder: normalizePageOrder(shown.map(map), files), pageSettings }
}

/** Annotation records of the merged pages, re-keyed onto the new file (the originals are kept). */
export function remapAnnotations(recs: PageAnnotations[], songId: string, plan: CombinePlan, mergedId: string): PageAnnotations[] {
  return recs.flatMap((r) => {
    const page = r.songId === songId ? mapPage(plan, r.fileId, r.page) : undefined
    return page === undefined || !r.items.length ? [] : [{ ...r, id: `${songId}:${mergedId}:${page}`, fileId: mergedId, page }]
  })
}

/** Merge the files into one PDF (pdf-lib). Throws rather than silently dropping pages. */
export async function mergeToPdf(files: SongFile[], opts: { title?: string; load?: (blobId: string) => Promise<Blob> } = {}): Promise<Uint8Array> {
  const load = opts.load ?? getBlob
  const out = await PDFDocument.create()
  if (opts.title) out.setTitle(opts.title)
  out.setProducer('OpenStand')
  for (const f of files) {
    const blob = await load(f.blobId)
    if (f.kind === 'pdf') {
      let src: PDFDocument
      try {
        src = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true })
      } catch {
        throw new Error(`Could not read “${f.name}”`)
      }
      if (src.isEncrypted) throw new Error(`“${f.name}” is encrypted and can’t be combined`)
      const n = src.getPageCount()
      if (n !== f.pageCount) throw new Error(`“${f.name}” has ${n} pages but the song expects ${f.pageCount}`)
      for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p)
    } else if (f.kind === 'image') {
      const img = await embedImageBlob(out, blob).catch(() => null)
      if (!img) throw new Error(`Could not read the image “${f.name}”`)
      addImagePage(out, img)
    } else throw new Error(`“${f.name}” can’t be combined into a PDF`)
  }
  return out.save()
}

/** Default name for the merged file: "<song title>.pdf", else the first file's name. */
export function combinedName(song: Song, files: SongFile[]): string {
  const base = (song.title.trim() || files[0]?.name.replace(/\.[^.]+$/, '') || 'Combined').replace(/[\\/:*?"<>|]+/g, '-')
  return `${base}.pdf`
}

/**
 * Build and store the merged PDF and copy the merged pages' annotations onto it. Returns the new
 * file and the plan; apply it to the editor draft with `applyCombine`. The blob is stored right away
 * (like any added file) and is garbage-collected if the draft is never saved.
 */
export async function combineFiles(song: Song, ids: Iterable<string>, name?: string, onProgress?: (msg: string) => void) {
  const plan = planCombine(song, ids)
  onProgress?.('Merging pages…')
  const bytes = await mergeToPdf(plan.files, { title: song.title.trim() || undefined })
  onProgress?.('Saving…')
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const { id: blobId, size } = await putBlob(buf, 'application/pdf')
  let fileName = (name?.trim() || combinedName(song, plan.files)).replace(/[\\/]+/g, '-')
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf'
  const file: SongFile = { id: uid(), name: fileName, kind: 'pdf', blobId, pageCount: plan.pageCount, size }
  // Unsaved strokes still sit in the annotation store's write buffer.
  await flushAnnotations()
  const fileIds = plan.files.map((f) => f.id)
  const recs = await db.annotations.where('fileId').anyOf(fileIds).toArray()
  const moved = remapAnnotations(recs, song.id, plan, file.id)
  if (moved.length) await db.annotations.bulkPut(moved)
  return { file, plan }
}
