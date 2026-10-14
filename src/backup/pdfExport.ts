/**
 * Build PDFs from songs with pdf-lib: page order, crop and rotation applied, and annotations burned
 * in as vector graphics. Annotations come from the shared node tree in annotations/render.ts so the
 * output matches what is drawn on screen.
 *
 * Coordinate model: the viewer shows a page with its own /Rotate plus the user rotation, then crops
 * it; annotations are normalised to that rotated, uncropped page. Here we set the PDF page rotation
 * to the same total, and draw in a "display space" (W x H points, y up) mapped onto the page's
 * user space with one transformation matrix per rotation.
 */
import {
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineJoin,
  type Color,
} from 'pdf-lib'
import { getLayers } from '../annotations/layers'
import { isHighlight, itemNodes, visibleItems, type SvgNode } from '../annotations/render'
import { db, getBlob } from '../db/db'
import { addImagePage, embedImageBlob, type EmbeddedImage } from '../files/imagePage'
import type { Annotation, Crop, PageRef, Song, SongFile } from '../db/schema'

/* ------------------------------------------------------------------ colours */

export function parseColor(c: string | number | undefined): { color: Color; alpha: number } | null {
  if (c === undefined || c === 'none' || c === 'transparent') return null
  const s = String(c).trim()
  let m = /^#([0-9a-f]{3,8})$/i.exec(s)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
    return { color: rgb(n(0), n(2), n(4)), alpha: h.length === 8 ? n(6) : 1 }
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (m) {
    const [r, g, b, a] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { color: rgb((r || 0) / 255, (g || 0) / 255, (b || 0) / 255), alpha: a === undefined || Number.isNaN(a) ? 1 : a }
  }
  return { color: rgb(0, 0, 0), alpha: 1 }
}

/* -------------------------------------------------------------- text fonts */

type FontKey = `${'sans' | 'serif' | 'mono'}${'' | 'B'}${'' | 'I'}`
const STD: Record<FontKey, StandardFonts> = {
  sans: StandardFonts.Helvetica,
  sansB: StandardFonts.HelveticaBold,
  sansI: StandardFonts.HelveticaOblique,
  sansBI: StandardFonts.HelveticaBoldOblique,
  serif: StandardFonts.TimesRoman,
  serifB: StandardFonts.TimesRomanBold,
  serifI: StandardFonts.TimesRomanItalic,
  serifBI: StandardFonts.TimesRomanBoldItalic,
  mono: StandardFonts.Courier,
  monoB: StandardFonts.CourierBold,
  monoI: StandardFonts.CourierOblique,
  monoBI: StandardFonts.CourierBoldOblique,
}

export class FontCache {
  private fonts = new Map<string, Promise<PDFFont>>()
  private doc: PDFDocument
  constructor(doc: PDFDocument) {
    this.doc = doc
  }
  get(family: string, bold: boolean, italic: boolean): Promise<PDFFont> {
    const f = /mono|courier|consolas|menlo/i.test(family) ? 'mono' : /serif/i.test(family.replace(/sans-serif/gi, '')) || /times|georgia/i.test(family) ? 'serif' : 'sans'
    const key = `${f}${bold ? 'B' : ''}${italic ? 'I' : ''}` as FontKey
    let p = this.fonts.get(key)
    if (!p) this.fonts.set(key, (p = this.doc.embedFont(STD[key])))
    return p
  }
}

/** Standard PDF fonts only cover WinAnsi; replace anything else so drawing never throws. */
export function encodable(font: PDFFont, text: string): string {
  let out = ''
  for (const ch of text) {
    try {
      font.encodeText(ch)
      out += ch
    } catch {
      out += '?'
    }
  }
  return out
}

/* ------------------------------------------------------- display transform */

export type Rot = 0 | 90 | 180 | 270

export const normRot = (r: number): Rot => ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as Rot

/** Box of the visible page in user space (pdf.js shows the CropBox). */
export interface PageBox {
  x: number
  y: number
  width: number
  height: number
}

/** Display size (points) of a page box shown at rotation `r`. */
export const displaySize = (b: PageBox, r: Rot) => (r === 90 || r === 270 ? { W: b.height, H: b.width } : { W: b.width, H: b.height })

/** Matrix [a b c d e f] mapping y-up display coordinates (X, Y) to page user space. */
export function displayMatrix(b: PageBox, r: Rot): [number, number, number, number, number, number] {
  switch (r) {
    case 90:
      return [0, 1, -1, 0, b.x + b.width, b.y]
    case 180:
      return [-1, 0, 0, -1, b.x + b.width, b.y + b.height]
    case 270:
      return [0, -1, 1, 0, b.x, b.y + b.height]
    default:
      return [1, 0, 0, 1, b.x, b.y]
  }
}

export function applyMatrix(m: number[], X: number, Y: number) {
  return { x: m[0] * X + m[2] * Y + m[4], y: m[1] * X + m[3] * Y + m[5] }
}

/** Visible rectangle in user space after cropping a display-space fraction from each edge. */
export function cropToUserBox(b: PageBox, r: Rot, crop: Crop): PageBox {
  const { W, H } = displaySize(b, r)
  const m = displayMatrix(b, r)
  // y-down crop edges -> y-up display coordinates
  const p1 = applyMatrix(m, crop.left * W, H - crop.top * H)
  const p2 = applyMatrix(m, (1 - crop.right) * W, crop.bottom * H)
  const x = Math.min(p1.x, p2.x)
  const y = Math.min(p1.y, p2.y)
  return { x, y, width: Math.max(1, Math.abs(p2.x - p1.x)), height: Math.max(1, Math.abs(p2.y - p1.y)) }
}

/* ------------------------------------------------------ annotation drawing */

interface Ctx {
  page: PDFPage
  doc: PDFDocument
  fonts: FontCache
  images: Map<string, PDFImage | null>
  H: number
}

const num = (v: string | number | undefined, d = 0) => (v === undefined ? d : Number(v))

async function embedDataUrl(doc: PDFDocument, src: string): Promise<PDFImage | null> {
  try {
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer())
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes)
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes)
  } catch {
    /* unsupported image */
  }
  return null
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  if (!r) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
}

/** Draw one node; `tf` is the accumulated translate+scale in y-down display units. */
async function drawNode(c: Ctx, n: SvgNode, tf: { tx: number; ty: number; s: number }, opacity: number, blend?: BlendMode) {
  const op = opacity * num(n.attrs.opacity, 1)
  const t = n.tf ? { tx: tf.tx + n.tf.tx * tf.s, ty: tf.ty + n.tf.ty * tf.s, s: tf.s * n.tf.s } : tf
  const at = (x: number, y: number) => ({ x: t.tx + x * t.s, y: c.H - (t.ty + y * t.s) })
  switch (n.tag) {
    case 'g':
      for (const ch of n.children ?? []) await drawNode(c, ch, t, op, blend)
      return
    case 'path':
    case 'rect': {
      const d =
        n.tag === 'rect'
          ? roundedRectPath(num(n.attrs.x), num(n.attrs.y), num(n.attrs.width), num(n.attrs.height), num(n.attrs.rx))
          : String(n.attrs.d ?? '')
      if (!d) return
      const fill = n.tag === 'rect' ? parseColor(n.attrs.fill ?? '#000') : parseColor(n.attrs.fill)
      const stroke = n.tag === 'rect' ? null : parseColor(n.attrs.stroke)
      const origin = at(0, 0)
      const dash = n.attrs['stroke-dasharray'] ? String(n.attrs['stroke-dasharray']).split(/[ ,]+/).map(Number) : undefined
      const cap = n.attrs['stroke-linecap'] === 'round' ? LineCapStyle.Round : n.attrs['stroke-linecap'] === 'square' ? LineCapStyle.Projecting : undefined
      if (fill) {
        c.page.drawSvgPath(d, { x: origin.x, y: origin.y, scale: t.s, color: fill.color, opacity: op * fill.alpha * num(n.attrs['fill-opacity'], 1), blendMode: blend })
      }
      if (stroke) {
        c.page.drawSvgPath(d, {
          x: origin.x,
          y: origin.y,
          scale: t.s,
          borderColor: stroke.color,
          borderWidth: num(n.attrs['stroke-width'], 1),
          borderOpacity: op * stroke.alpha,
          borderLineCap: cap,
          borderDashArray: dash,
          blendMode: blend,
        })
      }
      return
    }
    case 'text': {
      const text = n.text ?? ''
      if (!text.trim()) return
      const font = await c.fonts.get(String(n.attrs['font-family'] ?? ''), n.attrs['font-weight'] === 'bold', n.attrs['font-style'] === 'italic')
      const safe = encodable(font, text)
      const size = num(n.attrs['font-size'], 12) * t.s
      const col = parseColor(n.attrs.fill ?? '#000')
      let p = at(num(n.attrs.x), num(n.attrs.y))
      if (n.attrs['text-anchor'] === 'middle') p = { x: p.x - font.widthOfTextAtSize(safe, size) / 2, y: p.y }
      c.page.drawText(safe, { x: p.x, y: p.y, size, font, color: col?.color, opacity: op * (col?.alpha ?? 1), blendMode: blend })
      return
    }
    case 'image': {
      const src = String(n.attrs.href ?? '')
      if (!c.images.has(src)) c.images.set(src, await embedDataUrl(c.doc, src))
      const img = c.images.get(src)
      if (!img) return
      const w = num(n.attrs.width) * t.s
      const h = num(n.attrs.height) * t.s
      const p = at(num(n.attrs.x), num(n.attrs.y))
      c.page.drawImage(img, { x: p.x, y: p.y - h, width: w, height: h, opacity: op })
      return
    }
  }
}

/** Burn annotations into a page. `box`/`rot` describe how the page is displayed (before crop). */
export async function drawAnnotations(doc: PDFDocument, page: PDFPage, items: Annotation[], box: PageBox, rot: Rot, fonts = new FontCache(doc)) {
  if (!items.length) return
  const { W, H } = displaySize(box, rot)
  const ctx: Ctx = { page, doc, fonts, images: new Map(), H }
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...displayMatrix(box, rot)), setLineJoin(LineJoinStyle.Round))
  // Highlights first with multiply so they sit "behind" the ink, like on screen.
  for (const it of items) if (isHighlight(it)) for (const nd of itemNodes(it, W, H)) await drawNode(ctx, nd, { tx: 0, ty: 0, s: 1 }, 1, BlendMode.Multiply)
  for (const it of items) if (!isHighlight(it)) for (const nd of itemNodes(it, W, H)) await drawNode(ctx, nd, { tx: 0, ty: 0, s: 1 }, 1)
  page.pushOperators(popGraphicsState())
}

/* --------------------------------------------------------------- songs */

export interface SongPdfOptions {
  annotations?: boolean
  /** Apply crop and rotation from the song's page settings */
  cropRotate?: boolean
  /** Follow the song's custom page order (default true) */
  pageOrder?: boolean
}

export interface SongPdfResult {
  pages: number
  /** Files that can't go into a PDF (text/ChordPro/ABC) */
  skipped: SongFile[]
}

function pageRefs(song: Song, useOrder: boolean): PageRef[] {
  if (useOrder && song.pageOrder?.length) {
    const ids = new Set(song.files.map((f) => f.id))
    return song.pageOrder.filter((r) => ids.has(r.fileId))
  }
  return song.files.flatMap((f) => Array.from({ length: f.pageCount }, (_, page) => ({ fileId: f.id, page })))
}

/** Append a song's PDF/image pages to `out`. */
export async function appendSongPages(out: PDFDocument, song: Song, opts: SongPdfOptions = {}, fonts = new FontCache(out)): Promise<SongPdfResult> {
  const result: SongPdfResult = { pages: 0, skipped: song.files.filter((f) => f.kind !== 'pdf' && f.kind !== 'image') }
  const sources = new Map<string, PDFDocument | null>()
  const images = new Map<string, EmbeddedImage | null>()
  const layers = opts.annotations ? await getLayers(song.id) : null
  const byId = new Map(song.files.map((f) => [f.id, f]))

  for (const ref of pageRefs(song, opts.pageOrder !== false)) {
    const file = byId.get(ref.fileId)
    if (!file || (file.kind !== 'pdf' && file.kind !== 'image')) continue
    const ps = opts.cropRotate !== false ? song.pageSettings[`${file.id}:${ref.page}`] : undefined
    let page: PDFPage
    if (file.kind === 'pdf') {
      if (!sources.has(file.blobId)) {
        try {
          const bytes = await (await getBlob(file.blobId)).arrayBuffer()
          sources.set(file.blobId, await PDFDocument.load(bytes, { ignoreEncryption: true }))
        } catch (e) {
          console.warn('cannot read PDF', file.name, e)
          sources.set(file.blobId, null)
        }
      }
      const src = sources.get(file.blobId)
      if (!src || ref.page >= src.getPageCount()) continue
      ;[page] = await out.copyPages(src, [ref.page])
      out.addPage(page)
    } else {
      if (!images.has(file.blobId)) images.set(file.blobId, await embedImageBlob(out, await getBlob(file.blobId)).catch(() => null))
      const img = images.get(file.blobId)
      if (!img) continue
      page = addImagePage(out, img)
    }

    const cb = page.getCropBox()
    const box: PageBox = { x: cb.x, y: cb.y, width: cb.width, height: cb.height }
    const rot = normRot(page.getRotation().angle + (ps?.rotation ?? 0))
    if (opts.annotations) {
      const rec = await db.annotations.get(`${song.id}:${file.id}:${ref.page}`)
      const items = rec ? visibleItems(rec.items, layers?.layers) : []
      if (items.length) await drawAnnotations(out, page, items, box, rot, fonts)
    }
    if (rot !== normRot(page.getRotation().angle)) page.setRotation(degrees(rot))
    const crop = ps?.crop
    if (crop && (crop.top || crop.bottom || crop.left || crop.right)) {
      const c = cropToUserBox(box, rot, crop)
      page.setCropBox(c.x, c.y, c.width, c.height)
      page.setMediaBox(c.x, c.y, c.width, c.height)
    }
    result.pages++
  }
  return result
}

export async function songPdf(song: Song, opts: SongPdfOptions = {}): Promise<{ bytes: Uint8Array; result: SongPdfResult } | null> {
  const doc = await PDFDocument.create()
  doc.setTitle(song.title)
  if (song.artists.length) doc.setAuthor(song.artists.join(', '))
  doc.setProducer('OpenStand')
  const result = await appendSongPages(doc, song, opts)
  if (!result.pages) return null
  return { bytes: await doc.save(), result }
}
