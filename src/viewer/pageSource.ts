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

/**
 * Whole-page bitmaps never exceed this many pixels (~32 MB each). Zooming further shows the bitmap
 * scaled up with a sharp render of just the visible region on top (see PageView), because mobile
 * browsers blank every canvas once total canvas memory runs out.
 */
export const MAX_PAGE_PIXELS = 8_000_000
const MAX_SIDE = 4096
/** Total decoded size of cached bitmaps. */
const MAX_BYTES = 160 * 1024 * 1024
const MAX_ENTRIES = 28
/** Renders at or below this width (thumbnails, previews, crop probes) don't replace full-size ones. */
const SMALL = 512

interface CacheEntry {
  bmp: ImageBitmap
  width: number
  bytes: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ImageBitmap>>()
let cachedBytes = 0

function evict(k: string) {
  const e = cache.get(k)
  if (!e) return
  cache.delete(k)
  cachedBytes -= e.bytes
  e.bmp.close()
}

function touch(k: string, e: CacheEntry) {
  if (cache.get(k) !== e) {
    evict(k)
    cachedBytes += e.bytes
  } else cache.delete(k)
  cache.set(k, e)
  while (cache.size > 1 && (cache.size > MAX_ENTRIES || cachedBytes > MAX_BYTES)) evict(cache.keys().next().value!)
}

/** Drop every cached render (e.g. after the browser discarded canvas memory). */
export function clearRenderCache() {
  for (const k of [...cache.keys()]) evict(k)
}

/** Width buckets avoid re-rendering on tiny size changes. */
function bucket(px: number) {
  return Math.ceil(px / 128) * 128
}

/** Widest whole-page render allowed for a page of this aspect (width / height). */
export function maxRenderWidth(aspect: number): number {
  return Math.floor(Math.min(MAX_SIDE, MAX_SIDE * aspect, Math.sqrt(MAX_PAGE_PIXELS * aspect)))
}

/** Best cached bitmap for a page, regardless of resolution (for instant display while re-rendering). */
export function cachedBitmap(file: SongFile, page: number, rotation: number): ImageBitmap | null {
  let best: CacheEntry | null = null
  const prefix = `${file.blobId}:${page}:${rotation}:`
  for (const [k, e] of cache) if (k.startsWith(prefix) && (!best || e.width > best.width)) best = e
  return best?.bmp ?? null
}

/**
 * Render a page `widthPx` device pixels wide (bucketed, and capped at `maxRenderWidth`). Images are
 * decoded once at their own resolution (capped the same way) whatever width is asked for.
 */
export async function renderPage(file: SongFile, page: number, widthPx: number, rotation = 0): Promise<ImageBitmap> {
  let w = 0
  if (file.kind === 'pdf') {
    const size = await pageSize(file, page)
    const swap = rotation === 90 || rotation === 270
    w = Math.min(bucket(widthPx), maxRenderWidth(swap ? size.height / size.width : size.width / size.height))
  }
  const prefix = `${file.blobId}:${page}:${rotation}:`
  const k = prefix + w
  const hit = cache.get(k)
  if (hit) {
    touch(k, hit)
    return hit.bmp
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
        const size = await pageSize(file, page)
        const fit = Math.min(1, maxRenderWidth(size.width / size.height) / size.width)
        const src =
          fit < 1
            ? await createImageBitmap(blob, { resizeWidth: Math.round(size.width * fit), resizeHeight: Math.round(size.height * fit), resizeQuality: 'high' })
            : await createImageBitmap(blob)
        bmp = rotation ? await rotateBitmap(src, rotation) : src
      }
      // One full-size render per page: a new resolution replaces the old one instead of piling up.
      if (w === 0 || w > SMALL) for (const [ok, e] of [...cache]) if (ok.startsWith(prefix) && ok !== k && e.width > SMALL) evict(ok)
      touch(k, { bmp, width: w || bmp.width, bytes: bmp.width * bmp.height * 4 })
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
  const out = await createImageBitmap(c)
  c.width = c.height = 0
  return out
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
