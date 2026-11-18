/**
 * "Correct pages": open the scanner's page editor on the pages of a song's existing PDF or image file
 * and put the corrected PDF in its place in the song draft (see correctPlan.ts for the rules).
 *
 * The new file data is stored right away (like "Replace with another file…"); the song only points at
 * it once the song editor is saved. Cancelling the editor leaves the original file in use, and the
 * unreferenced copy is removed by the usual clean-up (collectGarbage).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { db, getBlob, MissingBlobError, putBlob, uid } from '../../db/db'
import type { Song, SongFile } from '../../db/schema'
import type { CorrectSaveContext, CorrectSource } from '../../scan/correct'
import type { EncodedPage } from '../../scan/pdf'
import { Button, confirmDialog, Dialog, toast } from '../../ui/primitives'
import { useTerms } from '../browse/terms'
import type { SongPatch } from './FieldsTab'
import { applyCorrection, correctedName, geometryChanged, pageList, planCorrection, startTurns } from './correctPlan'

export const correctable = (f: Pick<SongFile, 'kind'>) => f.kind === 'pdf' || f.kind === 'image'

/**
 * PDF pages are rendered at the scanner's output resolution: B&W pages come out at up to 3300 px on the
 * long side (about 400 dpi on A4), colour and grey at 2600. Rendering more would only cost memory.
 */
const RENDER_LONG = 3300
const RENDER_JPEG_QUALITY = 0.92
/** Long side of an image's page in the new PDF (A4 height in points). */
const IMAGE_PAGE_LONG = 841.89

interface Size {
  width: number
  height: number
}

/** Each page as a JPEG plus its size in PDF points (as shown, i.e. with the page's own /Rotate). */
async function renderPdfPages(blob: Blob, signal: AbortSignal, onProgress: (done: number, total: number) => void) {
  const { pdfPageSize, renderPdfPage, withPdf } = await import('../../files/pdf')
  return withPdf(blob, async (doc) => {
    const out: { blob: Blob; size: Size }[] = []
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    onProgress(0, doc.numPages)
    try {
      for (let i = 0; i < doc.numPages; i++) {
        signal.throwIfAborted()
        const size = await pdfPageSize(doc, i)
        const k = RENDER_LONG / Math.max(size.width, size.height)
        const bmp = await renderPdfPage(doc, i, size.width * k, 0, signal)
        canvas.width = bmp.width
        canvas.height = bmp.height
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        const jpeg = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), 'image/jpeg', RENDER_JPEG_QUALITY))
        out.push({ blob: jpeg, size })
        onProgress(i + 1, doc.numPages)
      }
    } finally {
      canvas.width = canvas.height = 0
    }
    return out
  })
}

async function imageSize(blob: Blob): Promise<Size> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const s = { width: bmp.width, height: bmp.height }
  bmp.close()
  return s
}

/**
 * The corrected PDF: redrawn pages from the scanner, the others copied from the original. Redrawn
 * pages with an unchanged outline get the original page size, so they line up exactly as before.
 */
async function buildCorrectedPdf(opts: {
  count: number
  rendered: Map<number, { page: EncodedPage; size?: Size }>
  /** The original PDF, for the pages that are copied. */
  source: import('pdf-lib').PDFDocument | null
  title?: string
}): Promise<Uint8Array> {
  const [{ PDFDocument }, { buildScanPdf }] = await Promise.all([import('pdf-lib'), import('../../scan/pdf')])
  const order = [...opts.rendered.keys()].sort((a, b) => a - b)
  const keep = Array.from({ length: opts.count }, (_, i) => i).filter((i) => !opts.rendered.has(i))
  if (keep.length && !opts.source) throw new Error('Original pages unavailable')
  const scan = order.length ? await PDFDocument.load(await buildScanPdf(order.map((i) => opts.rendered.get(i)!.page))) : null
  const out = await PDFDocument.create()
  const title = opts.source?.getTitle() ?? opts.title
  if (title) out.setTitle(title)
  out.setCreator('OpenStand image correction')
  out.setProducer('OpenStand')
  const redrawn = scan ? await out.copyPages(scan, scan.getPageIndices()) : []
  const copied = opts.source && keep.length ? await out.copyPages(opts.source, keep) : []
  let r = 0
  let c = 0
  for (let i = 0; i < opts.count; i++) {
    if (!opts.rendered.has(i)) {
      out.addPage(copied[c++])
      continue
    }
    const p = redrawn[r++]
    const want = opts.rendered.get(i)!.size
    if (want) p.scale(want.width / p.getWidth(), want.height / p.getHeight())
    out.addPage(p)
  }
  return out.save()
}

async function annotatedPages(songId: string, fileId: string): Promise<Set<number>> {
  const rows = await db.annotations.where('songId').equals(songId).toArray()
  return new Set(rows.filter((a) => a.fileId === fileId && a.items.length > 0).map((a) => a.page))
}

type Progress = { file: SongFile; done: number; total: number; abort: AbortController }

/** "Correct pages" for the song editor's Files tab: `start(file)` runs it, `dialog` shows the preparation. */
export function useCorrectPages(song: Song, update: (p: SongPatch) => void): { start: (f: SongFile) => void; busy: boolean; dialog: ReactNode } {
  const [prep, setPrep] = useState<Progress | null>(null)
  const running = useRef(false)
  const terms = useTerms()
  const songRef = useRef(song)
  useLayoutEffect(() => {
    songRef.current = song
  })

  const start = async (file: SongFile) => {
    if (running.current || !correctable(file)) return
    running.current = true
    const abort = new AbortController()
    try {
      const s = songRef.current
      let blob: Blob
      try {
        blob = await getBlob(file.blobId)
      } catch (e) {
        toast(e instanceof MissingBlobError ? 'This file is still downloading. Try again when it has arrived.' : `Couldn't open ${file.name}`, 'error')
        return
      }
      let pages: { blob: Blob; size: Size }[]
      if (file.kind === 'image') {
        const size = await imageSize(blob).catch(() => null)
        if (!size) return toast(`Couldn't read ${file.name}`, 'error')
        // Passed through as is: the editor decodes it like a photo.
        pages = [{ blob, size: { width: (size.width / Math.max(size.width, size.height)) * IMAGE_PAGE_LONG, height: (size.height / Math.max(size.width, size.height)) * IMAGE_PAGE_LONG } }]
      } else {
        setPrep({ file, done: 0, total: file.pageCount, abort })
        try {
          pages = await renderPdfPages(blob, abort.signal, (done, total) => setPrep((p) => p && { ...p, done, total }))
        } catch (e) {
          if (!abort.signal.aborted) toast(`Couldn't read ${file.name}: ${(e as Error).message}`, 'error')
          return
        } finally {
          setPrep(null)
        }
      }
      const annotated = await annotatedPages(s.id, file.id).catch(() => new Set<number>())
      const sources: CorrectSource[] = pages.map((p, i) => ({ blob: p.blob, rotation: startTurns(s.pageSettings[`${file.id}:${i}`]) }))
      const { openCorrector } = await import('../../scan/launch')
      await openCorrector({
        title: `Correct pages · ${file.name}`,
        saveLabel: 'Replace file',
        pages: sources,
        save: (ctx) => saveCorrection(ctx, { song: s, file, blob, sizes: pages.map((p) => p.size), annotated, update, songTerm: terms.song }),
      })
    } finally {
      running.current = false
    }
  }

  const dialog = prep && (
    <Dialog open onClose={() => prep.abort.abort()} title={`Preparing ${prep.file.name}`} size="sm" backdropCloses={false} footer={<Button variant="ghost" onClick={() => prep.abort.abort()}>Cancel</Button>}>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={prep.total} aria-valuenow={prep.done} aria-label="Pages prepared">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${prep.total ? (prep.done / prep.total) * 100 : 0}%` }} />
        </div>
        <p className="text-sm tabular-nums text-muted">
          Page {Math.min(prep.done + 1, prep.total)} of {prep.total}
        </p>
        <p className="text-xs text-faint">Pages you change are saved as images, like a scan. The others stay exactly as they are.</p>
      </div>
    </Dialog>
  )

  return { start: (f) => void start(f), busy: !!prep, dialog }
}

async function saveCorrection(
  ctx: CorrectSaveContext,
  o: { song: Song; file: SongFile; blob: Blob; sizes: Size[]; annotated: Set<number>; update: (p: SongPatch) => void; songTerm: string },
): Promise<boolean> {
  const { song, file, edits } = { ...o, edits: ctx.edits }
  const plan = planCorrection(file.id, song.pageSettings, edits, ctx.params, o.annotated)
  if (
    plan.warn.length &&
    !(await confirmDialog({
      title: 'Annotations may no longer line up',
      message: `You changed the outline of ${pageList(plan.warn)}, which ${plan.warn.length === 1 ? 'has' : 'have'} annotations. They stay where they are on the page, so they may no longer sit on the right notes.`,
      confirmLabel: 'Replace anyway',
      cancelLabel: 'Keep editing',
    }))
  )
    return false

  if (!plan.render.length) {
    const next = applyCorrection(song, file.id, null, edits)
    const changed = JSON.stringify(next.pageSettings) !== JSON.stringify(song.pageSettings)
    o.update((s) => applyCorrection(s, file.id, null, edits))
    toast(changed ? `Page rotation updated · save the ${o.songTerm} to keep it` : 'Nothing to change: the pages are as they were', changed ? 'ok' : 'info')
    return true
  }

  // Pages that aren't redrawn are copied from the original PDF; if pdf-lib can't read it, redraw them all.
  let source: import('pdf-lib').PDFDocument | null = null
  let render = plan.render
  if (file.kind === 'pdf' && render.length < edits.length) {
    const { PDFDocument } = await import('pdf-lib')
    source = await PDFDocument.load(await o.blob.arrayBuffer(), { ignoreEncryption: true }).catch(() => null)
    if (!source) {
      if (edits.some((e) => !e.ready)) throw new Error(`some pages of ${file.name} couldn't be read`)
      render = edits.map((_, i) => i)
    }
  }

  const rendered = new Map<number, { page: EncodedPage; size?: Size }>()
  ctx.progress(0, render.length)
  for (const i of render) {
    const keepsShape = !geometryChanged(edits[i])
    const size = o.sizes[i]
    // Same outline: keep the exact page proportions (no snapping to A4/Letter) and size.
    const page = await ctx.exportPage(i, keepsShape ? { aspect: size.width / size.height } : undefined)
    rendered.set(i, { page, size: keepsShape ? size : undefined })
    ctx.progress(rendered.size, render.length)
  }
  const bytes = await buildCorrectedPdf({ count: edits.length, rendered, source, title: song.title || undefined })
  const name = correctedName(file)
  const { id: blobId, size } = await putBlob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'application/pdf')
  const repl: SongFile = { id: uid(), name, kind: 'pdf', blobId, pageCount: edits.length, size }
  o.update((s) => applyCorrection(s, file.id, repl, edits))
  const n = render.length
  const notes = [
    `${n} page${n === 1 ? '' : 's'} of ${name} corrected${file.kind === 'pdf' ? ' (now images)' : ''}`,
    plan.cropsDropped.length ? `crop removed from ${pageList(plan.cropsDropped)}` : '',
    `save the ${o.songTerm} to keep it`,
  ]
  toast(notes.filter(Boolean).join(' · '), 'ok')
  return true
}
