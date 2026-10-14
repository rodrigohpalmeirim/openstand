/** Pure geometry of the snipping tool (kept free of pdf.js/DOM imports so it is unit-testable). */
import type { Rect } from './geometry'

/** Longest side of a snippet in pixels: sharp when enlarged, still small enough to store and sync. */
export const SNIP_MAX_SIDE = 2000

/**
 * Map a rectangle on the displayed (user-rotated) page to the unrotated source, both normalised.
 * Rotation is clockwise in degrees (0/90/180/270), as applied by the page renderer.
 */
export function rotatedToSource(r: Rect, rotation: number): Rect {
  const rot = ((rotation % 360) + 360) % 360
  // Inverse of the clockwise rotation, applied to both corners.
  const inv = (x: number, y: number) => (rot === 90 ? { x: y, y: 1 - x } : rot === 180 ? { x: 1 - x, y: 1 - y } : rot === 270 ? { x: 1 - y, y: x } : { x, y })
  const a = inv(r.x0, r.y0)
  const b = inv(r.x1, r.y1)
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
}

/**
 * Output size of a snippet of the normalised rect `r` on a page `aspect` (h/w) tall, rendered as if the
 * whole page were `pagePx` wide. Scales down so the longest side fits `max`. Returns the effective page
 * width in pixels and the region's pixel box (left/top offsets in that page).
 */
export function snipPixels(r: Rect, aspect: number, pagePx: number, max = SNIP_MAX_SIDE) {
  const rw = Math.max(1e-6, r.x1 - r.x0)
  const rh = Math.max(1e-6, (r.y1 - r.y0) * aspect)
  const k = Math.min(1, max / (Math.max(rw, rh) * pagePx))
  const P = pagePx * k
  return {
    pageW: P,
    pageH: P * aspect,
    x: Math.floor(r.x0 * P),
    y: Math.floor(r.y0 * P * aspect),
    w: Math.max(1, Math.round(rw * P)),
    h: Math.max(1, Math.round(rh * P)),
  }
}

/** Page width to render from: ~2.5x what is on screen, at least print-ish quality, bounded. */
export const snipPageWidth = (screenW: number, dpr: number) => Math.min(6000, Math.max(1800, screenW * Math.max(1, dpr) * 2.5))
