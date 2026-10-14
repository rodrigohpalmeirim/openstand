/**
 * Pixel processing for scans, on plain typed arrays so it runs in a worker or under vitest:
 * perspective warp, colour adjustments, illumination flattening and the sheet-music B&W filter.
 */
import { homography, type Quad } from './geometry'

/** RGBA image (same layout as ImageData). */
export interface Rgba {
  data: Uint8ClampedArray
  width: number
  height: number
}

export type Filter = 'color' | 'grey' | 'bw'

export interface FilterParams {
  filter: Filter
  /** −100…100, 0 = unchanged (colour and greyscale). */
  brightness: number
  /** −100…100, 0 = unchanged (colour and greyscale). */
  contrast: number
  /** 0…100: how dark a pixel must be (relative to the paper) to turn black; higher keeps fainter lines. */
  threshold: number
}

export const DEFAULT_PARAMS: FilterParams = { filter: 'bw', brightness: 0, contrast: 0, threshold: 50 }

/**
 * Warp the region `quad` (pixel coordinates in `src`) onto an outW×outH rectangle, bilinear sampling.
 * The inverse mapping is evaluated incrementally along each row (two adds per pixel and a divide).
 */
export function warpPerspective(src: Rgba, quad: Quad, outW: number, outH: number): Rgba {
  const out = new Uint8ClampedArray(outW * outH * 4)
  const rect = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ]
  // Maps output pixel coordinates to source pixel coordinates.
  const h = homography(rect, quad)
  if (!h) return { data: out.fill(255), width: outW, height: outH }
  const { data: s, width: sw, height: sh } = src
  const maxX = sw - 1
  const maxY = sh - 1
  let o = 0
  for (let y = 0; y < outH; y++) {
    const py = y + 0.5
    // Pixel centres: sample at (x+0.5, y+0.5) and shift by −0.5 into source pixel-centre space.
    let nx = h[0] * 0.5 + h[1] * py + h[2]
    let ny = h[3] * 0.5 + h[4] * py + h[5]
    let d = h[6] * 0.5 + h[7] * py + h[8]
    for (let x = 0; x < outW; x++) {
      let fx = nx / d - 0.5
      let fy = ny / d - 0.5
      nx += h[0]
      ny += h[3]
      d += h[6]
      if (fx < 0) fx = 0
      else if (fx > maxX) fx = maxX
      if (fy < 0) fy = 0
      else if (fy > maxY) fy = maxY
      const x0 = fx | 0
      const y0 = fy | 0
      const ax = fx - x0
      const ay = fy - y0
      const x1 = x0 < maxX ? 1 : 0
      const y1 = y0 < maxY ? sw : 0
      const i00 = (y0 * sw + x0) * 4
      const i01 = i00 + x1 * 4
      const i10 = i00 + y1 * 4
      const i11 = i10 + x1 * 4
      const w00 = (1 - ax) * (1 - ay)
      const w01 = ax * (1 - ay)
      const w10 = (1 - ax) * ay
      const w11 = ax * ay
      out[o] = s[i00] * w00 + s[i01] * w01 + s[i10] * w10 + s[i11] * w11
      out[o + 1] = s[i00 + 1] * w00 + s[i01 + 1] * w01 + s[i10 + 1] * w10 + s[i11 + 1] * w11
      out[o + 2] = s[i00 + 2] * w00 + s[i01 + 2] * w01 + s[i10 + 2] * w10 + s[i11 + 2] * w11
      out[o + 3] = 255
      o += 4
    }
  }
  return { data: out, width: outW, height: outH }
}

/** Rec. 601 luma, one byte per pixel. */
export function toGrey(img: Rgba): Uint8Array {
  const { data } = img
  const n = img.width * img.height
  const g = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8
  return g
}

/** Brightness/contrast lookup table for −100…100 sliders. */
export function levelsLut(brightness: number, contrast: number): Uint8Array {
  const lut = new Uint8Array(256)
  const c = contrast >= 0 ? 1 + contrast / 40 : 1 + contrast / 125
  const b = brightness * 1.1
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round((v - 128) * c + 128 + b)))
  return lut
}

export function applyLutRgba(img: Rgba, lut: Uint8Array) {
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]
    d[i + 1] = lut[d[i + 1]]
    d[i + 2] = lut[d[i + 2]]
  }
}

/**
 * Estimate the paper's illumination: the local brightest level, ignoring ink. Block maxima remove
 * thin dark strokes, a small dilation removes larger marks (note heads, beams, titles), and a blur
 * smooths the result. Returned at low resolution with its block size; sample with `bgSampler`.
 */
export function estimateBackground(grey: Uint8Array, w: number, h: number): { bg: Float32Array; bw: number; bh: number; block: number } {
  const block = Math.max(4, Math.round(Math.max(w, h) / 120))
  const bw = Math.ceil(w / block)
  const bh = Math.ceil(h / block)
  let bg = new Float32Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    const y1 = Math.min(h, (by + 1) * block)
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * block
      const x1 = Math.min(w, x0 + block)
      // A high percentile rather than the max: one hot pixel shouldn't brighten the whole block.
      let m1 = 0
      let m2 = 0
      for (let y = by * block; y < y1; y++) {
        const row = y * w
        for (let x = x0; x < x1; x++) {
          const v = grey[row + x]
          if (v > m1) {
            m2 = m1
            m1 = v
          } else if (v > m2) m2 = v
        }
      }
      bg[by * bw + bx] = m2 || m1
    }
  }
  const pass = (src: Float32Array, op: 'max' | 'mean') => {
    const dst = new Float32Array(src.length)
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        let acc = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= bh) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= bw) continue
            const v = src[yy * bw + xx]
            if (op === 'max') acc = v > acc ? v : acc
            else acc += v
            n++
          }
        }
        dst[y * bw + x] = op === 'max' ? acc : acc / n
      }
    return dst
  }
  bg = pass(pass(bg, 'max'), 'max')
  bg = pass(pass(pass(bg, 'mean'), 'mean'), 'mean')
  for (let i = 0; i < bg.length; i++) if (bg[i] < 16) bg[i] = 16
  return { bg, bw, bh, block }
}

/**
 * Divide each pixel by the (bilinearly upsampled) background: paper → ~1, ink → its contrast
 * against the paper. Shadows and gradients disappear. Returns values in 0…1 (clamped).
 */
export function flatten(grey: Uint8Array, w: number, h: number): Float32Array {
  const { bg, bw, bh, block } = estimateBackground(grey, w, h)
  const out = new Float32Array(w * h)
  const xi0 = new Int32Array(w)
  const xi1 = new Int32Array(w)
  const xf = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const f = Math.max(0, Math.min(bw - 1, (x + 0.5) / block - 0.5))
    xi0[x] = f | 0
    xi1[x] = Math.min(bw - 1, xi0[x] + 1)
    xf[x] = f - xi0[x]
  }
  for (let y = 0; y < h; y++) {
    const f = Math.max(0, Math.min(bh - 1, (y + 0.5) / block - 0.5))
    const r0 = (f | 0) * bw
    const r1 = Math.min(bh - 1, (f | 0) + 1) * bw
    const fy = f - (f | 0)
    for (let x = 0; x < w; x++) {
      const a = bg[r0 + xi0[x]] + (bg[r0 + xi1[x]] - bg[r0 + xi0[x]]) * xf[x]
      const b = bg[r1 + xi0[x]] + (bg[r1 + xi1[x]] - bg[r1 + xi0[x]]) * xf[x]
      const v = grey[y * w + x] / (a + (b - a) * fy)
      out[y * w + x] = v > 1 ? 1 : v
    }
  }
  return out
}

/** Separable box blur (running sums), edges clamped. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const n = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

/** Relative darkness below which a pixel becomes ink, for the 0…100 threshold slider. */
export function thresholdLevel(slider: number): number {
  return 0.62 + (Math.max(0, Math.min(100, slider)) / 100) * 0.3
}

/**
 * "Clean B&W" for printed music: flatten illumination, then a global threshold on the relative
 * darkness. Thin staff lines only need to be a little darker than their local paper to survive,
 * while shadows, paper texture and gradients go white. Isolated specks are removed.
 * Returns 0 (ink) / 255 (paper) per pixel.
 */
export function cleanBW(grey: Uint8Array, w: number, h: number, threshold: number): Uint8Array {
  const norm = flatten(grey, w, h)
  // Unsharp mask: a soft photo smears thin staff lines into faint grey; restore their depth relative to
  // the surroundings so they don't break up at the threshold. Flat paper is unaffected.
  const blur = boxBlur(norm, w, h, Math.max(2, Math.round(Math.max(w, h) / 900)))
  const t = thresholdLevel(threshold)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = norm[i] + 0.7 * (norm[i] - blur[i]) < t ? 0 : 255
  despeckle(out, w, h)
  clearBorder(out, w, h, Math.round(Math.max(w, h) * 0.004))
  return out
}

/** Whiten a thin frame: the paper's own edge (or a sliver of table) would otherwise print as a black line. */
export function clearBorder(bin: Uint8Array, w: number, h: number, n: number) {
  for (let y = 0; y < h; y++) {
    if (y < n || y >= h - n) bin.fill(255, y * w, (y + 1) * w)
    else {
      bin.fill(255, y * w, y * w + n)
      bin.fill(255, (y + 1) * w - n, (y + 1) * w)
    }
  }
}

/** Clear black pixels that have no black 8-neighbour (sensor noise). */
export function despeckle(bin: Uint8Array, w: number, h: number) {
  const kill: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (bin[i]) continue
      let lonely = true
      for (let dy = -1; dy <= 1 && lonely; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if ((dx || dy) && xx >= 0 && xx < w && !bin[yy * w + xx]) {
            lonely = false
            break
          }
        }
      }
      if (lonely) kill.push(i)
    }
  for (const i of kill) bin[i] = 255
}

/**
 * Greyscale with the paper flattened to white (shadows removed) but ink kept anti-aliased; the
 * brightness/contrast sliders then apply on top.
 */
export function cleanGrey(grey: Uint8Array, w: number, h: number, brightness: number, contrast: number): Uint8Array {
  const norm = flatten(grey, w, h)
  const lut = levelsLut(brightness, contrast)
  const out = new Uint8Array(w * h)
  // Map relative darkness 0.15…0.87 onto 0…255 so paper (and its noise) becomes white and ink stays dark.
  for (let i = 0; i < out.length; i++) {
    const v = (norm[i] - 0.15) / 0.72
    out[i] = lut[v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255)]
  }
  return out
}

/** Run the chosen filter. Colour returns RGBA (adjusted in place); grey/B&W return one byte per pixel. */
export function applyFilter(img: Rgba, p: FilterParams): { rgba: Rgba } | { grey: Uint8Array; binary: boolean } {
  if (p.filter === 'color') {
    if (p.brightness || p.contrast) applyLutRgba(img, levelsLut(p.brightness, p.contrast))
    return { rgba: img }
  }
  const g = toGrey(img)
  if (p.filter === 'grey') return { grey: cleanGrey(g, img.width, img.height, p.brightness, p.contrast), binary: false }
  return { grey: cleanBW(g, img.width, img.height, p.threshold), binary: true }
}

/** Expand one byte per pixel into RGBA (for display / canvas encoding). */
export function greyToRgba(g: Uint8Array, w: number, h: number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    data[j] = data[j + 1] = data[j + 2] = g[i]
    data[j + 3] = 255
  }
  return { data, width: w, height: h }
}

/** Pack a 0/255 image into 1 bit per pixel, MSB first, rows padded to whole bytes (PDF DeviceGray: 1 = white). */
export function packBits(bin: Uint8Array, w: number, h: number): Uint8Array {
  const stride = (w + 7) >> 3
  const out = new Uint8Array(stride * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    const o = y * stride
    for (let x = 0; x < w; x++) if (bin[row + x]) out[o + (x >> 3)] |= 0x80 >> (x & 7)
  }
  return out
}

/** Box-average downscale of a grey image so its longer side is at most `max` (for quad detection). */
export function downscaleGrey(g: Uint8Array, w: number, h: number, max: number): { grey: Uint8Array; width: number; height: number; factor: number } {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / max))
  if (f === 1) return { grey: g, width: w, height: h, factor: 1 }
  const ow = Math.floor(w / f)
  const oh = Math.floor(h / f)
  const out = new Uint8Array(ow * oh)
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      let s = 0
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w + x * f
        for (let dx = 0; dx < f; dx++) s += g[row + dx]
      }
      out[y * ow + x] = Math.round(s / (f * f))
    }
  return { grey: out, width: ow, height: oh, factor: f }
}
