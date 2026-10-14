import { getBlob } from '../db/db'
import type { Crop, SongFile } from '../db/schema'
import { loadPdf, pdfPageSize, renderPdfPage } from '../files/pdf'

/** A single displayable page (PDF page, image, or a paginated slice of a text file). */
export interface PageItem {
  key: string
  file: SongFile
  /** PDF page index / text page index / 0 for images */
  page: number
  crop?: Crop
  rotation: number
}

export { pageSettingsKey, resolvePageRefs } from '../files/pageRefs'

/* ------------------------------------------------------------ size cache */

const sizeCache = new Map<string, { width: number; height: number }>()

export async function pageSize(file: SongFile, page: number): Promise<{ width: number; height: number }> {
  const k = `${file.blobId}:${page}`
  const hit = sizeCache.get(k)
  if (hit) return hit
  let size = { width: 612, height: 792 }
  if (file.kind === 'pdf') {
    const doc = await loadPdf(file.blobId, () => getBlob(file.blobId))
    size = await pdfPageSize(doc, Math.min(page, doc.numPages - 1))
  } else if (file.kind === 'image') {
    const bmp = await createImageBitmap(await getBlob(file.blobId))
    size = { width: bmp.width, height: bmp.height }
    bmp.close()
  }
  sizeCache.set(k, size)
  return size
}

/* ----------------------------------------------------------- render cache */

interface CacheEntry {
  bmp: ImageBitmap
  width: number
}

const MAX_ENTRIES = 28
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ImageBitmap>>()

function touch(k: string, e: CacheEntry) {
  cache.delete(k)
  cache.set(k, e)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value!
    cache.get(oldest)?.bmp.close()
    cache.delete(oldest)
  }
}

/** Width buckets avoid re-rendering on tiny size changes. */
function bucket(px: number) {
  return Math.min(4096, Math.ceil(px / 128) * 128)
}

/** Best cached bitmap for a page, regardless of resolution (for instant display while re-rendering). */
export function cachedBitmap(file: SongFile, page: number, rotation: number): ImageBitmap | null {
  let best: CacheEntry | null = null
  const prefix = `${file.blobId}:${page}:${rotation}:`
  for (const [k, e] of cache) if (k.startsWith(prefix) && (!best || e.width > best.width)) best = e
  return best?.bmp ?? null
}

export function renderPage(file: SongFile, page: number, widthPx: number, rotation = 0): Promise<ImageBitmap> {
  const w = bucket(widthPx)
  const k = `${file.blobId}:${page}:${rotation}:${w}`
  const hit = cache.get(k)
  if (hit) {
    touch(k, hit)
    return Promise.resolve(hit.bmp)
  }
  let p = inflight.get(k)
  if (!p) {
    p = (async () => {
      let bmp: ImageBitmap
      if (file.kind === 'pdf') {
        const doc = await loadPdf(file.blobId, () => getBlob(file.blobId))
        bmp = await renderPdfPage(doc, page, w, rotation)
      } else {
        const blob = await getBlob(file.blobId)
        const src = await createImageBitmap(blob)
        bmp = rotation ? await rotateBitmap(src, rotation) : src
      }
      touch(k, { bmp, width: w })
      return bmp
    })().finally(() => inflight.delete(k))
    inflight.set(k, p)
  }
  return p
}

async function rotateBitmap(src: ImageBitmap, rotation: number): Promise<ImageBitmap> {
  const swap = rotation === 90 || rotation === 270
  const c = document.createElement('canvas')
  c.width = swap ? src.height : src.width
  c.height = swap ? src.width : src.height
  const ctx = c.getContext('2d')!
  ctx.translate(c.width / 2, c.height / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  src.close()
  return createImageBitmap(c)
}

/** Size of a page after user rotation and crop, used for layout. */
export function displayAspect(size: { width: number; height: number }, rotation: number, crop?: Crop): number {
  const swap = rotation === 90 || rotation === 270
  let w = swap ? size.height : size.width
  let h = swap ? size.width : size.height
  if (crop) {
    w *= Math.max(0.05, 1 - crop.left - crop.right)
    h *= Math.max(0.05, 1 - crop.top - crop.bottom)
  }
  return w / h
}
