/**
 * Snipping tool: copy a region of a page as a picture. PDF regions are re-rendered from the source
 * with pdf.js at high resolution (only the region is rasterised), image pages are cropped from the
 * original bitmap, and text/ABC pages are rasterised from the DOM as a best effort.
 */
import { db, getBlob, uid } from '../db/db'
import type { ImageAnnotation } from '../db/schema'
import { loadPdf } from '../files/pdf'
import type { Rect } from './geometry'
import { round } from './geometry'
import { rotatedToSource, SNIP_MAX_SIDE, snipPageWidth, snipPixels } from './snipMath'
import { parseKey } from './store'

const toBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the snippet'))), 'image/png'))

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(fr.error)
    fr.readAsDataURL(b)
  })

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  return { c, ctx }
}

async function snipPdf(blobId: string, pageIndex: number, rotation: number, r: Rect, aspect: number, screenW: number): Promise<HTMLCanvasElement> {
  const doc = await loadPdf(blobId, () => getBlob(blobId))
  const page = await doc.getPage(Math.min(pageIndex, doc.numPages - 1) + 1)
  const rot = (((page.rotate + rotation) % 360) + 360) % 360
  const base = page.getViewport({ scale: 1, rotation: rot })
  const px = snipPixels(r, aspect, snipPageWidth(screenW, window.devicePixelRatio || 1))
  const viewport = page.getViewport({ scale: px.pageW / base.width, rotation: rot, offsetX: -px.x, offsetY: -px.y })
  const { c } = canvas(px.w, px.h)
  await page.render({ canvas: c, viewport, background: 'white' }).promise
  return c
}

async function snipImage(blobId: string, rotation: number, r: Rect): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(await getBlob(blobId))
  try {
    const s = rotatedToSource(r, rotation)
    const sx = s.x0 * bmp.width
    const sy = s.y0 * bmp.height
    const sw = Math.max(1, (s.x1 - s.x0) * bmp.width)
    const sh = Math.max(1, (s.y1 - s.y0) * bmp.height)
    const k = Math.min(1, SNIP_MAX_SIDE / Math.max(sw, sh))
    const swap = rotation === 90 || rotation === 270
    const dw = Math.max(1, Math.round(sw * k))
    const dh = Math.max(1, Math.round(sh * k))
    const { c, ctx } = canvas(swap ? dh : dw, swap ? dw : dh)
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate((rotation * Math.PI) / 180)
    ctx.drawImage(bmp, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh)
    return c
  } finally {
    bmp.close()
  }
}

/** Copy computed styles onto a deep clone so it renders standalone inside an SVG foreignObject. */
function inlineStyles(src: Element, dst: Element) {
  if (src instanceof HTMLElement || src instanceof SVGElement) {
    const cs = getComputedStyle(src)
    let css = ''
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i]
      css += `${p}:${cs.getPropertyValue(p)};`
    }
    ;(dst as HTMLElement).setAttribute('style', css)
  }
  for (let i = 0; i < src.children.length; i++) if (dst.children[i]) inlineStyles(src.children[i], dst.children[i])
}

const fontData = new Map<string, Promise<string>>()
const norm = (v: string) => v.replace(/["'\s]/g, '').toLowerCase()

/**
 * @font-face rules of the web fonts the page has actually loaded, with their files inlined: an SVG
 * drawn as an image can't fetch anything, and a fallback font would break the fixed text layout.
 */
async function loadedFontCss(): Promise<string> {
  const loaded = [...document.fonts].filter((f) => f.status === 'loaded')
  const jobs: Promise<string>[] = []
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of [...rules]) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      const fam = norm(rule.style.getPropertyValue('font-family'))
      const range = norm(rule.style.getPropertyValue('unicode-range') || 'U+0-10FFFF')
      if (!loaded.some((f) => norm(f.family) === fam && norm(f.unicodeRange) === range)) continue
      const m = /url\((["']?)([^"')]+)\1\)/.exec(rule.style.getPropertyValue('src'))
      if (!m) continue
      const url = new URL(m[2], sheet.href ?? location.href).href
      let data = fontData.get(url)
      if (!data) {
        data = fetch(url)
          .then((r) => r.blob())
          .then(blobToDataUrl)
        fontData.set(url, data)
      }
      const css = rule.cssText
      jobs.push(data.then((d) => css.replace(/src:[^;}]+/, `src: url(${d})`), () => ''))
    }
  }
  return (await Promise.all(jobs)).join('\n')
}

/** Rasterise a text/ABC page from the DOM, with the loaded web fonts embedded. */
async function snipDom(pageEl: HTMLElement, overlay: Element | null, r: Rect, aspect: number, screenW: number): Promise<HTMLCanvasElement> {
  const clone = pageEl.cloneNode(true) as HTMLElement
  inlineStyles(pageEl, clone)
  // Drop the annotation overlay and the night-mode inversion.
  if (overlay) {
    const idx = [...pageEl.children].indexOf(overlay)
    if (idx >= 0) clone.children[idx]?.remove()
  }
  clone.style.filter = 'none'
  clone.style.boxShadow = 'none'
  const w = pageEl.clientWidth
  const h = pageEl.clientHeight
  const xml = new XMLSerializer().serializeToString(clone)
  const fonts = (await loadedFontCss()).replace(/</g, '\\3c ')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><style>${fonts}</style><foreignObject x="0" y="0" width="${w}" height="${h}">${xml}</foreignObject></svg>`
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const px = snipPixels(r, aspect, Math.min(4000, Math.max(screenW * 3, 1200)))
  const { c, ctx } = canvas(px.w, px.h)
  const k = px.pageW / w
  ctx.drawImage(img, -px.x, -px.y, w * k, h * k)
  return c
}

export interface Snippet {
  item: ImageAnnotation
  blob: Blob
}

/**
 * Snip the normalised rect `r` of page `key`. `root` is the page's annotation layer element (its box
 * is the uncropped page). Resolves to an image annotation placed exactly over the region.
 */
export async function snipRegion(key: string, r: Rect, root: HTMLElement): Promise<Snippet> {
  const { songId, fileId, page } = parseKey(key)
  const song = await db.songs.get(songId)
  const file = song?.files.find((f) => f.id === fileId)
  if (!song || !file) throw new Error('Page not found')
  const aspect = root.clientHeight / Math.max(1, root.clientWidth)
  const screenW = root.getBoundingClientRect().width
  let c: HTMLCanvasElement
  if (page < 1000 && (file.kind === 'pdf' || file.kind === 'image')) {
    const rotation = song.pageSettings[`${fileId}:${page}`]?.rotation ?? 0
    c = file.kind === 'pdf' ? await snipPdf(file.blobId, page, rotation, r, aspect, screenW) : await snipImage(file.blobId, rotation, r)
  } else {
    // Text and ABC pages: the overlay wrapper's parent is the page box.
    const overlay = root.parentElement
    const pageEl = overlay?.parentElement
    if (!pageEl) throw new Error('Page not found')
    c = await snipDom(pageEl, overlay, r, aspect, screenW)
  }
  const blob = await toBlob(c)
  c.width = c.height = 0
  const item: ImageAnnotation = {
    id: uid(),
    type: 'image',
    layer: '',
    color: '#000000',
    opacity: 1,
    createdAt: Date.now(),
    a: { x: round(r.x0), y: round(r.y0) },
    b: { x: round(r.x1), y: round(r.y1) },
    src: await blobToDataUrl(blob),
  }
  return { item, blob }
}

/** Also offer the snippet to the system clipboard; silently skipped where not permitted. */
export function writeSystemClipboard(blob: Promise<Blob>) {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return
    // Passing the promise keeps the user-activation of the gesture that started the snip.
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {})
  } catch {
    /* unsupported */
  }
}
