/**
 * Scan pipeline on canvases: decode photos (EXIF-oriented), detect the page, render previews and
 * full-resolution output. Runs inside the scan worker, or in-process where workers can't use
 * OffscreenCanvas.
 */
import { detectQuad } from './detect'
import { outputSize, rotateQuad, scaleQuad, type Quad } from './geometry'
import { applyFilter, downscaleGrey, greyToRgba, packBits, toGrey, warpPerspective, type FilterParams, type Rgba } from './image'
import type { EncodedPage } from './pdf'

export interface RenderParams extends FilterParams {
  /** Paper corners, normalized to the (oriented) photo. */
  quad: Quad
  /** Quarter turns clockwise applied to the output. */
  rotation: number
}

export type Request =
  | { op: 'load'; page: string; blob: Blob }
  | { op: 'render'; page: string; params: RenderParams; maxLong: number }
  | { op: 'export'; page: string; params: RenderParams }
  | { op: 'drop'; page: string }

export interface LoadResult {
  width: number
  height: number
  quad: Quad | null
}

/** Proxy (working copy for previews) and full-resolution working limits, in pixels on the long side. */
const PROXY_LONG = 2200
// iOS caps canvases at 16.7 MP; 48 MP photos are decoded at this size instead.
const FULL_LONG = 4400
/** Output long side: B&W is upsampled a little (smoother threshold edges), photos are kept lean. */
const OUT_LONG = { bw: 3300, grey: 2600, color: 2600 }
const OUT_MIN_LONG = { bw: 2400, grey: 0, color: 0 }
const JPEG_QUALITY = { color: 0.82, grey: 0.8 }
const MAX_PROXIES = 4

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function newCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
const ctx2d = (c: AnyCanvas) => c.getContext('2d', { willReadFrequently: true }) as Ctx

function toBlob(c: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality })
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, quality))
}

async function toBitmap(img: Rgba): Promise<ImageBitmap> {
  const c = newCanvas(img.width, img.height)
  ctx2d(c).putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
  return 'transferToImageBitmap' in c ? c.transferToImageBitmap() : createImageBitmap(c)
}

/** Draw a bitmap scaled to fit `maxLong` and read its pixels. */
function rasterize(bmp: ImageBitmap, maxLong: number): Rgba {
  const s = Math.min(1, maxLong / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * s))
  const h = Math.max(1, Math.round(bmp.height * s))
  const c = newCanvas(w, h)
  const ctx = ctx2d(c)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h)
  return { data: d.data, width: w, height: h }
}

const decode = (blob: Blob) => createImageBitmap(blob, { imageOrientation: 'from-image' })

interface Entry {
  blob: Blob
  width: number
  height: number
  proxy?: Rgba
}
const pages = new Map<string, Entry>()
const recent: string[] = []

function touch(id: string) {
  const i = recent.indexOf(id)
  if (i >= 0) recent.splice(i, 1)
  recent.push(id)
  while (recent.length > MAX_PROXIES) {
    const old = pages.get(recent.shift()!)
    if (old) old.proxy = undefined
  }
}

async function proxyOf(id: string): Promise<{ e: Entry; proxy: Rgba }> {
  const e = pages.get(id)
  if (!e) throw new Error('Page not loaded')
  if (!e.proxy) {
    const bmp = await decode(e.blob)
    e.proxy = rasterize(bmp, PROXY_LONG)
    bmp.close()
  }
  touch(id)
  return { e, proxy: e.proxy }
}

export async function load(id: string, blob: Blob): Promise<LoadResult> {
  const bmp = await decode(blob)
  const e: Entry = { blob, width: bmp.width, height: bmp.height, proxy: rasterize(bmp, PROXY_LONG) }
  bmp.close()
  pages.set(id, e)
  touch(id)
  const p = e.proxy!
  const small = downscaleGrey(toGrey(p), p.width, p.height, 360)
  const q = detectQuad(small.grey, small.width, small.height)
  // The downscale drops partial blocks at the right/bottom edge; map back to proxy proportions.
  const sx = (small.width * small.factor) / p.width
  const sy = (small.height * small.factor) / p.height
  return { width: e.width, height: e.height, quad: q && (q.map((pt) => ({ x: pt.x * sx, y: pt.y * sy })) as Quad) }
}

/** Corrected size of the page in full-resolution pixels, and the quad in `img` pixel coordinates. */
function geometry(e: Entry, img: Rgba, params: RenderParams, maxLong: number, minLong = 0) {
  const q = rotateQuad(params.quad, params.rotation)
  const size = outputSize(scaleQuad(q, e.width, e.height), e.width, e.height, maxLong, minLong)
  return { size, quad: scaleQuad(q, img.width, img.height) }
}

function process(img: Rgba, quad: Quad, w: number, h: number, params: FilterParams) {
  return applyFilter(warpPerspective(img, quad, w, h), params)
}

export async function render(id: string, params: RenderParams, maxLong: number): Promise<ImageBitmap> {
  const { e, proxy } = await proxyOf(id)
  const { size, quad } = geometry(e, proxy, params, maxLong)
  const r = process(proxy, quad, size.w, size.h, params)
  return toBitmap('rgba' in r ? r.rgba : greyToRgba(r.grey, size.w, size.h))
}

export async function exportPage(id: string, params: RenderParams): Promise<EncodedPage> {
  const e = pages.get(id)
  if (!e) throw new Error('Page not loaded')
  const bmp = await decode(e.blob)
  const full = rasterize(bmp, FULL_LONG)
  bmp.close()
  const f = params.filter
  const { size, quad } = geometry(e, full, params, OUT_LONG[f], OUT_MIN_LONG[f])
  const r = process(full, quad, size.w, size.h, params)
  if ('grey' in r && r.binary) return { kind: 'bits', bytes: packBits(r.grey, size.w, size.h), width: size.w, height: size.h }
  const rgba = 'rgba' in r ? r.rgba : greyToRgba(r.grey, size.w, size.h)
  const c = newCanvas(size.w, size.h)
  ctx2d(c).putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, size.w, size.h), 0, 0)
  const blob = await toBlob(c, 'image/jpeg', f === 'color' ? JPEG_QUALITY.color : JPEG_QUALITY.grey)
  return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), width: size.w, height: size.h }
}

export function drop(id: string) {
  pages.delete(id)
  const i = recent.indexOf(id)
  if (i >= 0) recent.splice(i, 1)
}

/** Dispatch a request; returns the result and the buffers/bitmaps to transfer back. */
export async function handle(req: Request): Promise<{ result: unknown; transfer: Transferable[] }> {
  switch (req.op) {
    case 'load':
      return { result: await load(req.page, req.blob), transfer: [] }
    case 'render': {
      const bmp = await render(req.page, req.params, req.maxLong)
      return { result: bmp, transfer: [bmp] }
    }
    case 'export': {
      const p = await exportPage(req.page, req.params)
      return { result: p, transfer: [p.bytes.buffer] }
    }
    case 'drop':
      drop(req.page)
      return { result: null, transfer: [] }
  }
}
