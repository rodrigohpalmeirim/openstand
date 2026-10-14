import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const base = import.meta.env.BASE_URL + 'pdfjs/'

/** Open documents keyed by file id. Documents are expensive to parse, so they are shared. */
const docs = new Map<string, { task?: pdfjs.PDFDocumentLoadingTask; doc: Promise<PDFDocumentProxy> }>()

const docOptions = () => ({
  cMapUrl: base + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: base + 'standard_fonts/',
  wasmUrl: base + 'wasm/',
  iccUrl: base + 'iccs/',
})

export function loadPdf(key: string, getData: () => Promise<ArrayBuffer | Blob>): Promise<PDFDocumentProxy> {
  let entry = docs.get(key)
  if (!entry) {
    const e: { task?: pdfjs.PDFDocumentLoadingTask; doc: Promise<PDFDocumentProxy> } = { doc: Promise.resolve(null!) }
    e.doc = (async () => {
      const raw = await getData()
      const data = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw)
      e.task = pdfjs.getDocument({ data, ...docOptions() })
      return e.task.promise
    })()
    e.doc.catch(() => docs.delete(key))
    docs.set(key, e)
    entry = e
  }
  return entry.doc
}

export function closePdf(key: string) {
  const e = docs.get(key)
  if (e) {
    docs.delete(key)
    e.task?.destroy().catch(() => {})
  }
}

export async function pdfPageCount(data: ArrayBuffer): Promise<number> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), ...docOptions() })
  try {
    return (await task.promise).numPages
  } finally {
    task.destroy().catch(() => {})
  }
}

export interface PageSize {
  width: number
  height: number
}

export async function pdfPageSize(doc: PDFDocumentProxy, pageIndex: number): Promise<PageSize> {
  const page = await doc.getPage(pageIndex + 1)
  const vp = page.getViewport({ scale: 1 })
  return { width: vp.width, height: vp.height }
}

/**
 * Render a PDF page into a new ImageBitmap at the requested CSS-pixel width (device pixel ratio applied).
 * Rotation is the extra user rotation in degrees (multiple of 90).
 */
export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  targetWidthPx: number,
  rotation = 0,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  const page = await doc.getPage(pageIndex + 1)
  const unscaled = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 })
  const scale = Math.max(0.1, targetWidthPx / unscaled.width)
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  const task = page.render({ canvas, viewport, background: 'white' })
  const onAbort = () => task.cancel()
  signal?.addEventListener('abort', onAbort)
  try {
    await task.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  const bmp = await createImageBitmap(canvas)
  canvas.width = canvas.height = 0
  return bmp
}

export { pdfjs }
