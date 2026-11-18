/**
 * Automatic page-curvature ("bend") estimate for photographed sheet music.
 *
 * Staff lines are long, evenly spaced and should be straight, so they make a strong probe of how a
 * bound page bows. The photo is rectified through the user's quad, the staves are found as 5-line
 * combs and traced strip by strip across the page, and the top/bottom side bends (see `Bend` in
 * geometry.ts) are fitted to the traced lines by linear least squares, with a free offset per staff.
 * The corners stay pinned: on a page bowed over a cylinder the lines meet the (straight) left and right
 * paper edges exactly where a flat page's would, so a correct quad leaves no tilt. A free tilt term was
 * tried and rejected: it soaks up the asymmetric bow near the spine and leaves lines straight but sloped.
 * The fit is repeated on the image re-rendered with the current estimate, where the lines are nearly
 * straight and trace cleanly to the spine. The result is checked against the measurements themselves:
 * it is only returned when the bend is well determined and the traced lines would come out clearly
 * straighter than they are now (which also catches misplaced corners, whose tilt a pinned bend can't fix).
 *
 * Pure typed-array code: runs in the scan worker and under vitest.
 */
import { BEND_POINTS, bendAt, bendWeights, homography, NO_BEND, paperAspect, quadEdges, rotateBend, rotateQuad, type Bend, type Mat3, type Quad } from './geometry'
import { estimateBackground } from './image'

export interface BendEstimate {
  /** Bend for the quad as passed in (unrotated); only the two sides along the staff lines are set. */
  bend: Bend
  /** True when the staff lines are already straight: `bend` then leaves those sides straight. */
  flat: boolean
  /** 0…1, how clearly the measurements support the result. */
  confidence: number
  /** Staves traced. */
  staves: number
  /** Worst traced staff-line deviation from straight before / after applying `bend`, in staff spaces. */
  before: number
  after: number
  /** Leftover tilt of the lines across the page (staff spaces), a hint that a corner is off. */
  tilt: number
  ms: number
}

/** Internal measurements, for evaluation and debugging. */
export interface BendDebug {
  W: number
  H: number
  spacing: number
  passes: number
  tracks: { u: number[]; y: number[]; v: number }[]
  reason?: string
  before?: number
  after?: number
  effect?: number
  unsure?: number
  tilt?: number
  /** The fitted bend (quad frame), even when it isn't returned. */
  fitted?: Bend
}

const UNIT = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

/** Working height of the rectified page in pixels. */
const WORK_H = 1300
const STRIPS = 44
const MAX_PASSES = 4
/** Below this (staff spaces of straightening on the traced lines) the page counts as flat. */
const FLAT = 0.15
/** Largest standard error (staff spaces) of the bend at its knots that still counts as measured. */
const UNSURE = 0.25

/**
 * Estimate the page bend from a greyscale photo (one byte per pixel) and the paper quad in that photo's
 * pixel coordinates. `rotation` is the output's quarter turns (staff lines run along the page's top as
 * read). `base` is the page's current bend: its other two sides are kept and used while measuring.
 * Returns null when the photo doesn't show enough clear staves to tell.
 */
export function estimateBend(grey: Uint8Array, width: number, height: number, quad: Quad, rotation = 0, base: Bend = NO_BEND, debug?: BendDebug): BendEstimate | null {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const fail = (reason: string) => {
    if (debug) debug.reason = reason
    return null
  }
  const q = rotateQuad(quad, rotation)
  const hm = homography(UNIT, q)
  if (!hm) return fail('degenerate quad')
  const edges = quadEdges(q)
  const aspect = paperAspect(q, width, height)
  const H = Math.round(Math.max(400, Math.min(WORK_H, edges.h * 1.1)))
  const W = Math.max(200, Math.round(H * aspect))
  const rb = rotateBend(base, rotation)
  let bend: Bend = [[], rb[1], [], rb[3]]
  let spacing = 0
  let fit: Fit | null = null
  let tracks: Track[] = []
  let passes = 0
  let bg: Background | null = null
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    passes++
    const img = rectify(grey, width, height, hm, bend, W, H)
    // The paper's illumination is smooth, and the bend moves it by a few pixels at most: estimate it once.
    bg ??= estimateBackground(img, W, H)
    const dark: Img = { px: img, bg }
    if (pass === 0) {
      spacing = estimateSpacing(dark, W, H)
      if (!spacing) return fail('no regular line spacing')
    }
    tracks = traceStaves(dark, W, H, spacing)
    // Back to the plain (unbent) rectified square, where the fit is done.
    for (const t of tracks) {
      t.Y = t.y.map((y, k) => mapY(bend, t.u[k], (y + 0.5) / H))
    }
    const next = fitBend(tracks, spacing / H)
    if (!next) return fail(`too few staves (${tracks.length})`)
    const prev = fit
    fit = next
    bend = [fit.top, rb[1], fit.bottom, rb[3]]
    if (prev && maxChange(prev, fit) * H < 0.15) break
  }
  if (!fit) return fail('no fit')
  if (debug) {
    debug.W = W
    debug.H = H
    debug.spacing = spacing
    debug.passes = passes
    debug.tracks = tracks.filter((t) => t.ok).map((t) => ({ u: t.u, y: t.Y, v: t.v }))
  }
  const good = tracks.filter((t) => t.ok)
  const sp = spacing / H
  const f = fit
  // How far the traced lines are from straight (each against its own best-fit line, inlying points only),
  // before and after the correction, and how much the correction itself bends them; in staff spaces.
  const dev = (fn: (t: Track, k: number) => number) =>
    Math.max(0, ...good.map((t) => {
      const ks = t.u.map((_, k) => k).filter((k) => t.inl[k])
      return lineDeviation(ks.map((k) => t.u[k]), ks.map((k) => fn(t, k)))
    })) / sp
  const before = dev((t, k) => t.Y[k])
  const after = dev((t, k) => unbendY(f, t.u[k], t.Y[k]))
  const effect = dev((t, k) => mapY([f.top, [], f.bottom, []], t.u[k], t.v) - t.v)
  let vMin = 1
  let vMax = 0
  let covered = 0
  for (const t of good) {
    vMin = Math.min(vMin, t.v)
    vMax = Math.max(vMax, t.v)
    covered = Math.max(covered, t.u[t.u.length - 1] - t.u[0])
  }
  // Median slope of the corrected lines, as the rise across the full page width.
  const slopes = good.map((t) => lineSlope(t.u, t.Y.map((y, k) => unbendY(f, t.u[k], y)))).sort((a, b) => a - b)
  const tilt = Math.abs(slopes[slopes.length >> 1] ?? 0) / sp
  // How uncertain the bend is where it matters most (its knots), in staff spaces.
  const unsure = Math.max(...f.se) / sp
  if (debug) Object.assign(debug, { before, after, effect, unsure, tilt, fitted: rotateBend([f.top, rb[1], f.bottom, rb[3]], -rotation) })
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  const result = (b: Bend, flat: boolean, confidence: number): BendEstimate => ({
    bend: rotateBend(b, -rotation),
    flat,
    confidence: Math.round(confidence * 100) / 100,
    staves: good.length,
    before: round3(before),
    after: round3(flat ? before : after),
    tilt: round3(tilt),
    ms: Math.round(ms),
  })
  if (good.length < 3 || vMax - vMin < 0.25 || covered < 0.35) return fail(`weak evidence: ${good.length} staves over v ${vMin.toFixed(2)}…${vMax.toFixed(2)}, width ${covered.toFixed(2)}`)
  // Absolute for small bends (and "flat" verdicts); a large bend may be uncertain by a small fraction of itself.
  if (unsure > Math.max(UNSURE, 0.15 * effect)) return fail(`bend poorly determined (±${unsure.toFixed(2)} staff spaces)`)
  if (effect < FLAT) return result([[], rb[1], [], rb[3]], true, Math.min(1, good.length / 6))
  if (after > before * 0.55) return fail(`no clear improvement: ${before.toFixed(2)} → ${after.toFixed(2)} staff spaces`)
  const confidence = Math.min(1, good.length / 6) * Math.max(0, Math.min(1, 1 - after / before)) * Math.min(1, covered / 0.6)
  const out: Bend = [f.top.map(round4), rb[1], f.bottom.map(round4), rb[3]]
  return result(out, false, confidence)
}

const round3 = (v: number) => Math.round(v * 1000) / 1000
const round4 = (v: number) => Math.round(v * 10000) / 10000

/** y in the rectified square of flat-page point (u, v) under the bend (only T and B affect y). */
function mapY(b: Bend, u: number, v: number): number {
  return v - (1 - v) * bendAt(b[0], u) + v * bendAt(b[2], 1 - u)
}

/** Corrected-page v of a rectified y at u, under the fitted bend (inverse of mapY). */
function unbendY(f: Fit, u: number, y: number): number {
  const T = bendAt(f.top, u)
  const B = bendAt(f.bottom, 1 - u)
  return (y + T) / (1 + T + B)
}

function maxChange(a: Fit, b: Fit): number {
  let m = 0
  for (let k = 0; k < BEND_POINTS; k++) m = Math.max(m, Math.abs(a.top[k] - b.top[k]), Math.abs(a.bottom[k] - b.bottom[k]))
  return m
}

function lineSlope(u: number[], y: number[]): number {
  const n = u.length
  const mu = u.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let suu = 0
  let suy = 0
  for (let k = 0; k < n; k++) {
    suu += (u[k] - mu) ** 2
    suy += (u[k] - mu) * (y[k] - my)
  }
  return suu > 0 ? suy / suu : 0
}

/** Largest distance of the points from their least-squares line. */
function lineDeviation(u: number[], y: number[]): number {
  const n = u.length
  let su = 0
  let sy = 0
  for (let k = 0; k < n; k++) {
    su += u[k]
    sy += y[k]
  }
  su /= n
  sy /= n
  let suu = 0
  let suy = 0
  for (let k = 0; k < n; k++) {
    suu += (u[k] - su) ** 2
    suy += (u[k] - su) * (y[k] - sy)
  }
  const b = suu > 0 ? suy / suu : 0
  let m = 0
  for (let k = 0; k < n; k++) m = Math.max(m, Math.abs(y[k] - sy - b * (u[k] - su)))
  return m
}

// ---------------------------------------------------------------------------------------------
// Rectification.

type Background = ReturnType<typeof estimateBackground>

/** The rectified grey page and its paper brightness. */
interface Img {
  px: Uint8Array
  bg: Background
}

/** Paper brightness (grey level) at a point, bilinear in the background grid (as image.ts `flatten`). */
function paperAt({ bg, bw, bh, block }: Background, x: number, y: number): number {
  const fx = Math.max(0, Math.min(bw - 1, (x + 0.5) / block - 0.5))
  const fy = Math.max(0, Math.min(bh - 1, (y + 0.5) / block - 0.5))
  const x0 = fx | 0
  const y0 = fy | 0
  const x1 = Math.min(bw - 1, x0 + 1)
  const y1 = Math.min(bh - 1, y0 + 1)
  const ax = fx - x0
  const top = bg[y0 * bw + x0] + (bg[y0 * bw + x1] - bg[y0 * bw + x0]) * ax
  const bot = bg[y1 * bw + x0] + (bg[y1 * bw + x1] - bg[y1 * bw + x0]) * ax
  return top + (bot - top) * (fy - y0)
}

/** Warp the quad (through the bend) onto a W×H grey grid. */
function rectify(grey: Uint8Array, sw: number, sh: number, h: Mat3, bend: Bend, W: number, H: number): Uint8Array {
  const T = new Float64Array(W)
  const B = new Float64Array(W)
  for (let i = 0; i < W; i++) {
    const u = (i + 0.5) / W
    T[i] = bendAt(bend[0], u)
    B[i] = bendAt(bend[2], 1 - u)
  }
  const out = new Uint8Array(W * H)
  const maxX = sw - 1
  const maxY = sh - 1
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H
    const R = bendAt(bend[1], v)
    const L = bendAt(bend[3], 1 - v)
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W
      const x = u + u * R - (1 - u) * L
      const y = v - (1 - v) * T[i] + v * B[i]
      const d = h[6] * x + h[7] * y + h[8]
      let fx = (h[0] * x + h[1] * y + h[2]) / d - 0.5
      let fy = (h[3] * x + h[4] * y + h[5]) / d - 0.5
      if (fx < 0) fx = 0
      else if (fx > maxX) fx = maxX
      if (fy < 0) fy = 0
      else if (fy > maxY) fy = maxY
      const x0 = fx | 0
      const y0 = fy | 0
      const ax = fx - x0
      const ay = fy - y0
      const k = y0 * sw + x0
      const x1 = x0 < maxX ? 1 : 0
      const y1 = y0 < maxY ? sw : 0
      const top = grey[k] + (grey[k + x1] - grey[k]) * ax
      const bot = grey[k + y1] + (grey[k + y1 + x1] - grey[k + y1]) * ax
      out[j * W + i] = top + (bot - top) * ay + 0.5
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Staff finding and tracing.

/** Ridge radius: wider than a (blurred) staff line, narrower than a note head. */
const ridgeRadius = (s: number) => Math.max(2, Math.round(s * 0.38))

/**
 * Thin-dark-line response averaged over columns x0…x1−1, sampled along a line of the given slope through
 * (xc, y0 + k): in each column, how much darker a pixel is than both pixels r above and below, relative to
 * the local paper brightness (so shadows don't weaken lines; the paper is smooth over a strip). Taking the
 * response per column before averaging keeps a staff line visible where note heads, beams or stems
 * cover some of the columns (an average profile would raise the line's neighbours and hide it).
 */
function ridgeProfile(d: Img, W: number, H: number, x0: number, x1: number, y0: number, n: number, xc: number, slope: number, r: number): Float32Array {
  const px = d.px
  const out = new Float32Array(n)
  const col = new Float32Array(n + 2 * r)
  const m = n + 2 * r
  for (let x = x0; x < x1; x++) {
    const off = y0 - r + slope * (x - xc)
    const base = Math.floor(off)
    const f = off - base
    for (let k = 0; k < m; k++) {
      const y = base + k
      if (y < 0 || y + 1 >= H) {
        col[k] = 0
        continue
      }
      const i = y * W + x
      col[k] = px[i] + (px[i + W] - px[i]) * f
    }
    for (let k = 0; k < n; k++) {
      const v = (col[k] < col[k + 2 * r] ? col[k] : col[k + 2 * r]) - col[k + r]
      if (v > 0) out[k] += v
    }
  }
  const cols = Math.max(1, x1 - x0)
  const xm = (x0 + x1) / 2
  for (let k = 0; k < n; k++) out[k] /= cols * paperAt(d.bg, xm, y0 + k + slope * (xm - xc))
  return out
}

/** Staff spacing (pixels) from the autocorrelation of thin-line responses in the middle of the page; 0 if none. */
function estimateSpacing(d: Img, W: number, H: number): number {
  const maxLag = Math.min(60, Math.floor(H / 25))
  const n = 9
  const sw = Math.max(8, Math.round(W / STRIPS))
  let found = 0
  let quality = 0
  // Sharp photos respond best to a narrow line detector, blurred ones to a wider one.
  for (const rad of [3, 4]) {
    const acc = new Float64Array(maxLag + 2)
    for (let k = 0; k < n; k++) {
      const xc = Math.round(W * (0.25 + (0.5 * k) / (n - 1)))
      const r = ridgeProfile(d, W, H, xc - sw, xc + sw, 0, H, xc, 0, rad)
      let mean = 0
      for (let y = 0; y < H; y++) mean += r[y]
      mean /= H
      for (let lag = 0; lag <= maxLag + 1; lag++) {
        let s = 0
        for (let y = 0; y + lag < H; y++) s += (r[y] - mean) * (r[y + lag] - mean)
        acc[lag] += s
      }
    }
    let best = 0
    for (let lag = rad + 2; lag <= maxLag; lag++) if (acc[lag] > acc[lag - 1] && acc[lag] >= acc[lag + 1] && (!best || acc[lag] > acc[best])) best = lag
    if (!best || acc[best] < 0.2 * acc[0] || acc[best] / acc[0] <= quality) continue
    quality = acc[best] / acc[0]
    const a = acc[best - 1]
    const b = acc[best]
    const c = acc[best + 1]
    const den = a - 2 * b + c
    found = best + (den < 0 ? (0.5 * (a - c)) / den : 0)
  }
  return found
}

interface StaffHit {
  y: number
  sp: number
  score: number
}

/** Linear interpolation into an array at a fractional index. */
function at(a: Float32Array, f: number): number {
  if (f < 0 || f >= a.length - 1) return 0
  const i = Math.floor(f)
  return a[i] + (a[i + 1] - a[i]) * (f - i)
}

/**
 * Find a 5-line staff centred within ±search of yPred in the strip x0…x1, sampling along `slope`.
 * Returns the centre (sub-pixel), the local spacing and the mean line strength.
 */
function measureStaff(d: Img, W: number, H: number, x0: number, x1: number, xc: number, slope: number, yPred: number, search: number, s: number): StaffHit | null {
  const r = ridgeRadius(s)
  const reach = 3.3 * s + search + r + 2
  const y0 = Math.floor(yPred - reach)
  const n = Math.ceil(2 * reach)
  if (y0 + n < 0 || y0 > H) return null
  const R = ridgeProfile(d, W, H, x0, x1, y0, n, xc, slope, r)
  let best = -Infinity
  let bc = 0
  let bs = s
  for (const f of [0.96, 1, 1.04]) {
    const sl = s * f
    for (let dlt = -search; dlt <= search; dlt += 0.25) {
      const c = yPred + dlt - y0
      let sc = 0
      for (let t = -2; t <= 2; t++) sc += at(R, c + t * sl)
      sc -= 0.8 * (at(R, c - 3 * sl) + at(R, c + 3 * sl))
      if (sc > best) {
        best = sc
        bc = c
        bs = sl
      }
    }
  }
  // Refine each line: local peak within ±0.3 spacing, parabolic sub-pixel.
  const pos: number[] = []
  const idx: number[] = []
  const str: number[] = []
  for (let t = -2; t <= 2; t++) {
    const c = bc + t * bs
    let pk = -1
    let pv = 0
    for (let k = Math.max(1, Math.round(c - 0.3 * bs)); k <= Math.min(n - 2, Math.round(c + 0.3 * bs)); k++)
      if (R[k] > pv && R[k] >= R[k - 1] && R[k] >= R[k + 1]) {
        pv = R[k]
        pk = k
      }
    if (pk < 0) continue
    const a = R[pk - 1]
    const b = R[pk]
    const cc = R[pk + 1]
    const den = a - 2 * b + cc
    pos.push(pk + (den < 0 ? (0.5 * (a - cc)) / den : 0))
    idx.push(t)
    str.push(pv)
  }
  if (pos.length < 4) return null
  const top = Math.max(...str)
  const keep = str.map((v) => v >= Math.max(0.02, 0.3 * top))
  const P = pos.filter((_, k) => keep[k])
  const I = idx.filter((_, k) => keep[k])
  const S = str.filter((_, k) => keep[k])
  if (P.length < 4) return null
  // Least-squares centre and spacing through the found lines.
  const m = P.length
  const mi = I.reduce((a, b) => a + b, 0) / m
  const mp = P.reduce((a, b) => a + b, 0) / m
  let sii = 0
  let sip = 0
  for (let k = 0; k < m; k++) {
    sii += (I[k] - mi) ** 2
    sip += (I[k] - mi) * (P[k] - mp)
  }
  const spc = sip / sii
  if (!(spc > 0.85 * s && spc < 1.15 * s)) return null
  for (let k = 0; k < m; k++) if (Math.abs(mp + (I[k] - mi) * spc - P[k]) > 0.18 * s) return null
  const mean = S.reduce((a, b) => a + b, 0) / m
  // Lines just outside the staff (one spacing beyond the outer lines) must be clearly weaker: rules out ruled paper.
  const outer = Math.max(at(R, mp - mi * spc - 3 * spc), at(R, mp - mi * spc + 3 * spc))
  if (outer > 0.5 * mean) return null
  return { y: y0 + mp - mi * spc, sp: spc, score: mean }
}

export interface Track {
  /** Strip centres (u in 0…1) and traced staff centres (pixel rows in the image measured). */
  u: number[]
  y: number[]
  w: number[]
  /** Same points in the plain rectified square (filled in by the caller). */
  Y: number[]
  v: number
  ok: boolean
  /** Points the robust fit kept. */
  inl: boolean[]
}

function traceStaves(d: Img, W: number, H: number, s: number): Track[] {
  const sw = W / STRIPS
  const half = Math.max(4, Math.round(sw * 0.75))
  const stripX = (j: number) => (j + 0.5) * sw - 0.5
  const tracks: { pts: Map<number, StaffHit> }[] = []
  for (const seedFrac of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    const js = Math.min(STRIPS - 1, Math.floor(seedFrac * STRIPS))
    const xc = stripX(js)
    const x0 = Math.max(0, Math.round(xc - half * 1.6))
    const x1 = Math.min(W, Math.round(xc + half * 1.6))
    // Candidate staff centres: comb score maxima over the full height.
    const R = ridgeProfile(d, W, H, x0, x1, 0, H, xc, 0, ridgeRadius(s))
    const cand: { y: number; sc: number }[] = []
    for (let y = Math.ceil(3 * s); y < H - 3 * s; y++) {
      let sc = 0
      for (let t = -2; t <= 2; t++) sc += at(R, y + t * s)
      sc -= 0.8 * (at(R, y - 3 * s) + at(R, y + 3 * s))
      cand.push({ y, sc })
    }
    const peak = cand.reduce((m, c) => Math.max(m, c.sc), 0)
    const picks = cand.filter((c, k) => c.sc > 0.25 * peak && c.sc > 0.15 && (k === 0 || c.sc >= cand[k - 1].sc) && (k === cand.length - 1 || c.sc > cand[k + 1].sc)).sort((a, b) => b.sc - a.sc)
    const chosen: number[] = []
    for (const c of picks) if (chosen.every((y) => Math.abs(y - c.y) > 4 * s)) chosen.push(c.y)
    for (const y of chosen) {
      // Skip staves an earlier seed already traced through this strip.
      if (tracks.some((t) => {
        const h = t.pts.get(js)
        return h && Math.abs(h.y - y) < 2 * s
      })) continue
      const hit = measureStaff(d, W, H, x0, x1, xc, 0, y, 0.5 * s, s)
      if (!hit) continue
      const pts = new Map<number, StaffHit>([[js, hit]])
      for (const dir of [1, -1]) {
        let misses = 0
        for (let j = js + dir; j >= 0 && j < STRIPS; j += dir) {
          // Predict from the last accepted points: linear, plus half the quadratic trend.
          const known = [...pts.keys()].filter((k) => (dir > 0 ? k < j : k > j)).sort((a, b) => (dir > 0 ? b - a : a - b)).slice(0, 3)
          const p0 = pts.get(known[0])!
          let slope = 0
          let yp = p0.y
          if (known.length >= 2) {
            const p1 = pts.get(known[1])!
            slope = (p0.y - p1.y) / (stripX(known[0]) - stripX(known[1]))
            if (known.length >= 3) {
              const p2 = pts.get(known[2])!
              const s2 = (p1.y - p2.y) / (stripX(known[1]) - stripX(known[2]))
              const curv = (slope - s2) / ((stripX(known[0]) - stripX(known[2])) / 2)
              slope += 0.5 * curv * (stripX(j) - stripX(known[0]))
            }
            yp = p0.y + slope * (stripX(j) - stripX(known[0]))
          }
          const xc2 = stripX(j)
          const a = Math.max(0, Math.round(xc2 - half))
          const b = Math.min(W, Math.round(xc2 + half))
          const m = measureStaff(d, W, H, a, b, xc2, slope, yp, 0.6 * s, s)
          if (m && Math.abs(m.y - yp) < 0.6 * s) {
            pts.set(j, m)
            misses = 0
          } else if (++misses > 6) break
        }
      }
      if (pts.size < 5) continue
      // The same staff traced from another seed: keep the longer trace.
      const dup = tracks.findIndex((t) => {
        const d: number[] = []
        for (const [j, h] of pts) {
          const o = t.pts.get(j)
          if (o) d.push(Math.abs(o.y - h.y))
        }
        d.sort((a, b) => a - b)
        return d.length > 0 && d[d.length >> 1] < 2 * s
      })
      if (dup < 0) tracks.push({ pts })
      else if (tracks[dup].pts.size < pts.size) tracks[dup] = { pts }
    }
  }
  return tracks.map((t) => {
    const keys = [...t.pts.keys()].sort((a, b) => a - b)
    return {
      u: keys.map((j) => (stripX(j) + 0.5) / W),
      y: keys.map((j) => t.pts.get(j)!.y),
      w: keys.map((j) => t.pts.get(j)!.score),
      Y: [],
      v: 0,
      ok: true,
      inl: [],
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Fitting.

export interface Fit {
  top: number[]
  bottom: number[]
  /** Standard errors of the top then bottom values (from the least-squares covariance). */
  se: number[]
}

/** Solve the symmetric positive system A·x = b (Gaussian elimination, partial pivoting). */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = new Float64Array(A)
  const x = new Float64Array(b)
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[p * n + c])) p = r
    if (Math.abs(m[p * n + c]) < 1e-14) return null
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        const t = m[c * n + k]
        m[c * n + k] = m[p * n + k]
        m[p * n + k] = t
      }
      const t = x[c]
      x[c] = x[p]
      x[p] = t
    }
    for (let r = c + 1; r < n; r++) {
      const f = m[r * n + c] / m[c * n + c]
      if (!f) continue
      for (let k = c; k < n; k++) m[r * n + k] -= f * m[c * n + k]
      x[r] -= f * x[c]
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]
    for (let k = r + 1; k < n; k++) s -= m[r * n + k] * x[k]
    x[r] = s / m[r * n + r]
  }
  return x
}

/**
 * Fit top/bottom bends to the traced staff centres (rectified u, Y): Y = v_c − (1 − v_c)·T(u) + v_c·B(u), with a
 * free v_c per trace (held fixed inside the products, updated between rounds) and robust reweighting. Marks tracks that don't follow the fit as not ok. `sp` is the staff spacing in page heights.
 */
export function fitBend(tracks: Track[], sp: number): Fit | null {
  const live = tracks.filter((t) => t.u.length >= 5)
  if (live.length < 2) return null
  const nb = BEND_POINTS
  const nt = live.length
  const n = 2 * nb + nt
  for (const t of live) {
    const s = [...t.Y].sort((a, b) => a - b)
    t.v = s[s.length >> 1]
    t.ok = true
  }
  const wT = new Array<number>(nb)
  const wB = new Array<number>(nb)
  const rw = live.map((t) => t.u.map(() => 1))
  let sol: Float64Array | null = null
  let A = new Float64Array(0)
  let noise = 0
  for (let it = 0; it < 6; it++) {
    A = new Float64Array(n * n)
    const b = new Float64Array(n)
    const row = new Float64Array(n)
    for (let c = 0; c < nt; c++) {
      const t = live[c]
      if (!t.ok) {
        // Keep the system regular: pin the offset of a rejected track.
        A[(2 * nb + c) * n + 2 * nb + c] += 1
        b[2 * nb + c] += t.v
        continue
      }
      const v = t.v
      for (let k = 0; k < t.u.length; k++) {
        const w = rw[c][k] * Math.min(1, t.w[k] / 0.1)
        if (w <= 0) continue
        const u = t.u[k]
        bendWeights(nb, u, wT)
        bendWeights(nb, 1 - u, wB)
        row.fill(0)
        for (let j = 0; j < nb; j++) {
          row[j] = -(1 - v) * wT[j]
          row[nb + j] = v * wB[j]
        }
        row[2 * nb + c] = 1
        for (let i = 0; i < n; i++) {
          if (!row[i]) continue
          b[i] += w * row[i] * t.Y[k]
          for (let j = 0; j < n; j++) if (row[j]) A[i * n + j] += w * row[i] * row[j]
        }
      }
    }
    // A whisper of ridge regularisation keeps the system solvable when traces barely constrain one side.
    // (Anything stronger biases the split between top and bottom, which is only weakly determined.)
    for (let j = 0; j < 2 * nb; j++) A[j * n + j] += 1e-6 * live.length
    sol = solve(A, b, n)
    if (!sol) return null
    // Residuals → robust weights, track rejection and offset update.
    const res: number[] = []
    const per: number[][] = []
    for (let c = 0; c < nt; c++) {
      const t = live[c]
      const r = t.u.map((u, k) => t.Y[k] - predict(sol!, nb, u, sol![2 * nb + c], t.v))
      per.push(r)
      if (t.ok) for (const x of r) res.push(Math.abs(x))
    }
    res.sort((a, b) => a - b)
    const sigma = Math.max(0.12 * sp, 1.4826 * (res[res.length >> 1] ?? 0))
    // Weighted residual RMS with the weights this solve used, for the parameter uncertainty below.
    let ss = 0
    let sw = 0
    for (let c = 0; c < nt; c++) {
      if (!live[c].ok) continue
      for (let k = 0; k < per[c].length; k++) {
        const w = rw[c][k] * Math.min(1, live[c].w[k] / 0.1)
        ss += w * per[c][k] ** 2
        sw += w
      }
    }
    noise = Math.sqrt(ss / Math.max(1, sw - n))
    for (let c = 0; c < nt; c++) {
      const t = live[c]
      const r = per[c]
      t.v = sol[2 * nb + c]
      rw[c] = r.map((x) => {
        const z = x / (4.685 * sigma)
        return Math.abs(z) < 1 ? (1 - z * z) ** 2 : 0
      })
      t.inl = rw[c].map((w) => w > 0)
      // A trace that jumped a line or followed something else: most of its points are outliers.
      const kept = rw[c].filter((w) => w > 0).length
      t.ok = kept >= Math.max(5, 0.6 * r.length)
    }
    if (live.filter((t) => t.ok).length < 2) return null
  }
  for (const t of tracks) if (t.u.length < 5) t.ok = false
  // Neighbouring points along a trace share pixels and errors, so count them as fewer: inflate by √3.
  const sigma = Math.max(noise, 0.04 * sp) * Math.sqrt(3)
  const se: number[] = []
  for (let j = 0; j < 2 * nb; j++) {
    const e = new Float64Array(n)
    e[j] = 1
    const col = solve(A, e, n)
    se.push(col ? sigma * Math.sqrt(Math.max(0, col[j])) : Infinity)
  }
  return { top: Array.from(sol!.subarray(0, nb)), bottom: Array.from(sol!.subarray(nb, 2 * nb)), se }
}

function predict(sol: Float64Array, nb: number, u: number, off: number, v: number): number {
  const T = bendAt(Array.from(sol.subarray(0, nb)), u)
  const B = bendAt(Array.from(sol.subarray(nb, 2 * nb)), 1 - u)
  return off - (1 - v) * T + v * B
}
