import type { Crop } from '../db/schema'

/** Minimal ImageData shape (RGBA, row-major) so the detector runs in workers and tests. */
export interface Pixels {
  data: ArrayLike<number>
  width: number
  height: number
}

export interface DetectOptions {
  /** Ignore sparse specks and dark scan borders along the edges. */
  aggressive?: boolean
  /** Luminance drop (0..255) from the background that counts as ink. */
  tolerance?: number
  /** Margin kept around the detected content, as a fraction of the page size. */
  padding?: number
}

export const NO_CROP: Crop = { top: 0, bottom: 0, left: 0, right: 0 }

export function isNoCrop(c?: Crop) {
  return !c || (c.top === 0 && c.bottom === 0 && c.left === 0 && c.right === 0)
}

/**
 * Detect uniform page margins. The background is the median luminance of the outermost pixel ring
 * (handles cream/grey scans); a pixel is ink when it is `tolerance` darker. Normal mode keeps any row or
 * column with ink; aggressive mode requires a minimum ink density (so dust and page-number specks in
 * the margin are ignored) and skips nearly-solid dark bands touching the edges (scanner borders).
 */
export function detectCrop(img: Pixels, opts: DetectOptions = {}): Crop {
  const { width: w, height: h, data } = img
  if (w < 4 || h < 4) return { ...NO_CROP }
  const aggressive = !!opts.aggressive
  const tol = opts.tolerance ?? 48
  const pad = opts.padding ?? 0.012

  const lum = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
    const a = data[j + 3] / 255
    const l = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
    lum[i] = l * a + 255 * (1 - a)
  }

  const ring: number[] = []
  for (let x = 0; x < w; x++) ring.push(lum[x], lum[(h - 1) * w + x])
  for (let y = 0; y < h; y++) ring.push(lum[y * w], lum[y * w + w - 1])
  ring.sort((a, b) => a - b)
  // In aggressive mode dark scan borders may dominate the ring; use the brighter quartile instead.
  const bg = ring[Math.floor(ring.length * (aggressive ? 0.75 : 0.5))]
  const cut = Math.max(0, bg - tol)
  const ink = (i: number) => lum[i] < cut

  // Aggressive: dark bands glued to an edge (scanner borders) are excluded before profiling.
  let x0 = 0
  let x1 = w - 1
  let y0 = 0
  let y1 = h - 1
  if (aggressive) {
    const rowFull = (y: number) => {
      let n = 0
      for (let x = 0, i = y * w; x < w; x++, i++) if (ink(i)) n++
      return n >= w * 0.85
    }
    const colFull = (x: number) => {
      let n = 0
      for (let y = 0; y < h; y++) if (ink(y * w + x)) n++
      return n >= h * 0.85
    }
    while (y0 < y1 && rowFull(y0)) y0++
    while (y1 > y0 && rowFull(y1)) y1--
    while (x0 < x1 && colFull(x0)) x0++
    while (x1 > x0 && colFull(x1)) x1--
  }

  const rowInk = new Uint32Array(h)
  for (let y = y0; y <= y1; y++) {
    let n = 0
    for (let x = x0, i = y * w + x0; x <= x1; x++, i++) if (ink(i)) n++
    rowInk[y] = n
  }

  const span = (counts: Uint32Array, lo: number, hi: number, other: number): [number, number] | null => {
    const len = hi - lo + 1
    const minInk = aggressive ? Math.max(2, Math.ceil(other * 0.006)) : 1
    let a = lo
    let b = hi
    while (a <= b && counts[a] < minInk) a++
    while (b >= a && counts[b] < minInk) b--
    if (aggressive) {
      // Drop thin isolated islands at the edges (specks, page numbers far from the music).
      const island = Math.max(2, Math.round(len * 0.02))
      const gap = Math.max(3, Math.round(len * 0.03))
      const trim = (from: number, to: number, dir: 1 | -1) => {
        let k = from
        while (k !== to + dir && counts[k] >= minInk) k += dir
        const thick = Math.abs(k - from)
        let g = k
        while (g !== to + dir && counts[g] < minInk) g += dir
        return thick <= island && Math.abs(g - k) >= gap && g !== to + dir ? g : from
      }
      if (a <= b) a = trim(a, b, 1)
      if (a <= b) b = trim(b, a, -1)
    }
    return a <= b ? [a, b] : null
  }

  const rows = span(rowInk, y0, y1, x1 - x0 + 1)
  if (!rows) return { ...NO_CROP }
  const colInk = new Uint32Array(w)
  for (let y = rows[0]; y <= rows[1]; y++) for (let x = x0, i = y * w + x0; x <= x1; x++, i++) if (ink(i)) colInk[x]++
  const cols = span(colInk, x0, x1, rows[1] - rows[0] + 1)
  if (!cols) return { ...NO_CROP }

  const r = (v: number) => Math.max(0, Math.round(v * 10000) / 10000)
  return {
    top: r(rows[0] / h - pad),
    bottom: r((h - 1 - rows[1]) / h - pad),
    left: r(cols[0] / w - pad),
    right: r((w - 1 - cols[1]) / w - pad),
  }
}

/** Crop expressed in the frame of the page after an extra clockwise rotation by `deg`. */
export function rotateCrop(c: Crop, deg: number): Crop {
  let out = c
  for (let k = ((Math.round(deg / 90) % 4) + 4) % 4; k > 0; k--)
    out = { top: out.left, right: out.top, bottom: out.right, left: out.bottom }
  return out
}

/** Clamp a crop so at least `min` of each dimension remains. */
export function clampCrop(c: Crop, min = 0.1): Crop {
  const cl = (v: number) => Math.min(1, Math.max(0, v))
  let { top, bottom, left, right } = { top: cl(c.top), bottom: cl(c.bottom), left: cl(c.left), right: cl(c.right) }
  if (1 - top - bottom < min) {
    const over = min - (1 - top - bottom)
    const t = top / (top + bottom || 1)
    top -= over * t
    bottom -= over * (1 - t)
  }
  if (1 - left - right < min) {
    const over = min - (1 - left - right)
    const t = left / (left + right || 1)
    left -= over * t
    right -= over * (1 - t)
  }
  return { top, bottom, left, right }
}
