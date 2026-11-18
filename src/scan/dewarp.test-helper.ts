/**
 * Synthetic "photos" of curved pages for testing and evaluating the curvature detector (dewarp.ts).
 *
 * The physical model is deliberately NOT the correction model: a flat page (staves, notes, beams, slurs,
 * lyrics, title…) is laid on a generalised cylinder whose cross-section rises steeply from the spine and
 * flattens out (tangent angle θ(d) = θ0·e^(−d/λ) + κ·(d − W/2), d = distance from the spine), then
 * photographed through a tilted pinhole camera with uneven lighting, a spine shadow, blur and noise.
 * Units are millimetres on the page.
 */
import { applyH, homography, invert3, orderQuad, type Pt, type Quad } from './geometry'

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------------------------
// Flat page raster (ink coverage 0…1) drawn with signed distance functions.

export class Canvas {
  readonly ink: Float32Array
  readonly w: number
  readonly h: number
  readonly ppm: number
  constructor(mmW: number, mmH: number, ppm: number) {
    this.ppm = ppm
    this.w = Math.round(mmW * ppm)
    this.h = Math.round(mmH * ppm)
    this.ink = new Float32Array(this.w * this.h)
  }
  /** Rasterise an SDF (mm in, mm out) over a bounding box, anti-aliased by the distance. */
  private fill(x0: number, y0: number, x1: number, y1: number, sdf: (x: number, y: number) => number, dark = 1) {
    const p = this.ppm
    const px = 1 / p
    const i0 = Math.max(0, Math.floor(x0 * p) - 1)
    const i1 = Math.min(this.w - 1, Math.ceil(x1 * p) + 1)
    const j0 = Math.max(0, Math.floor(y0 * p) - 1)
    const j1 = Math.min(this.h - 1, Math.ceil(y1 * p) + 1)
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * px
      for (let i = i0; i <= i1; i++) {
        const d = sdf((i + 0.5) * px, y)
        const c = 0.5 - d * p
        if (c <= 0) continue
        const k = j * this.w + i
        const v = Math.min(1, c) * dark
        if (v > this.ink[k]) this.ink[k] = v
      }
    }
  }
  line(ax: number, ay: number, bx: number, by: number, t: number, dark = 1) {
    const dx = bx - ax
    const dy = by - ay
    const l2 = dx * dx + dy * dy || 1e-9
    const r = t / 2
    this.fill(Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r, (x, y) => {
      const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
      return Math.hypot(x - ax - h * dx, y - ay - h * dy) - r
    }, dark)
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, angle: number, dark = 1) {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const m = Math.max(rx, ry)
    this.fill(cx - m, cy - m, cx + m, cy + m, (x, y) => {
      const u = ((x - cx) * c + (y - cy) * s) / rx
      const v = (-(x - cx) * s + (y - cy) * c) / ry
      const k = Math.hypot(u, v)
      return (k - 1) * Math.min(rx, ry)
    }, dark)
  }
  ring(cx: number, cy: number, rx: number, ry: number, t: number, dark = 1) {
    const m = Math.max(rx, ry) + t
    this.fill(cx - m, cy - m, cx + m, cy + m, (x, y) => {
      const k = Math.hypot((x - cx) / rx, (y - cy) / ry)
      return Math.abs(k - 1) * Math.min(rx, ry) - t / 2
    }, dark)
  }
  /** Parallelogram from (ax,ay)→(bx,by) with vertical thickness t (a beam). */
  beam(ax: number, ay: number, bx: number, by: number, t: number, dark = 1) {
    const slope = (by - ay) / (bx - ax || 1e-9)
    this.fill(Math.min(ax, bx), Math.min(ay, by) - t, Math.max(ax, bx), Math.max(ay, by) + t, (x, y) => {
      const yc = ay + slope * (x - ax)
      const dyv = Math.abs(y - yc) - t / 2
      const dxv = Math.max(Math.min(ax, bx) - x, x - Math.max(ax, bx))
      return Math.max(dyv, dxv)
    }, dark)
  }
  /** Thin circular arc through a→b sagging by `sag` (a slur or tie), thickest in the middle. */
  slur(ax: number, ay: number, bx: number, by: number, sag: number, t: number, dark = 1) {
    const n = 24
    let px = ax
    let py = ay
    for (let k = 1; k <= n; k++) {
      const f = k / n
      const x = ax + (bx - ax) * f
      const y = ay + (by - ay) * f + sag * 4 * f * (1 - f)
      this.line(px, py, x, y, t * (0.4 + 0.6 * Math.sin(Math.PI * (k - 0.5) / n)), dark)
      px = x
      py = y
    }
  }
  /** Pseudo text: words of small strokes and bowls at x-height `xh`, from x0 to x1 on baseline y. */
  text(x0: number, x1: number, y: number, xh: number, r: () => number, dark = 1) {
    let x = x0
    const t = xh * 0.16
    while (x < x1) {
      const letters = 2 + Math.floor(r() * 7)
      for (let k = 0; k < letters && x < x1; k++) {
        const kind = r()
        const w = xh * (0.55 + r() * 0.3)
        if (kind < 0.35) this.ring(x + w / 2, y - xh / 2, w / 2 - t / 2, xh / 2 - t / 2, t, dark)
        else if (kind < 0.6) {
          const asc = r() < 0.5 ? xh * 0.7 : 0
          this.line(x + t, y - xh - asc, x + t, y, t, dark)
          if (r() < 0.6) this.line(x + t, y - xh * 0.9, x + w, y - xh * 0.6, t, dark)
        } else if (kind < 0.8) {
          this.line(x, y - xh, x + w / 2, y, t, dark)
          this.line(x + w / 2, y, x + w, y - xh, t, dark)
        } else {
          this.line(x + t, y - xh, x + t, y + (r() < 0.4 ? xh * 0.6 : 0), t, dark)
          this.line(x + t, y - xh, x + w, y - xh, t, dark)
        }
        x += w + xh * 0.18
      }
      x += xh * (0.8 + r() * 0.5)
    }
  }
}

export interface MusicOptions {
  seed: number
  /** Staff spacing in mm (distance between neighbouring staff lines). */
  spacing?: number
  /** Number of systems; each has 1 or 2 staves. */
  systems?: number
  staves?: 1 | 2
  lyrics?: boolean
  title?: boolean
  /** The last system stops at this fraction of the width. */
  lastPartial?: number
  /** Notes per bar (density). */
  density?: number
  ppm?: number
}

/** Page content plus the ground-truth staff lines (y and x span in mm). */
export interface FlatPage {
  canvas: Canvas
  lines: { y: number; x0: number; x1: number }[]
  spacing: number
}

export const PAGE_W = 210
export const PAGE_H = 297

export function musicPage(o: MusicOptions): FlatPage {
  const r = rng(o.seed)
  const sp = o.spacing ?? 1.75
  const ppm = o.ppm ?? 8
  const c = new Canvas(PAGE_W, PAGE_H, ppm)
  const lines: FlatPage['lines'] = []
  const left = 16 + r() * 4
  const right = PAGE_W - 14 - r() * 4
  const lt = 0.13
  let y = 22
  if (o.title !== false) {
    c.text(PAGE_W / 2 - 40, PAGE_W / 2 + 40, y, 5.5, r)
    c.text(right - 45, right, y + 9, 2.2, r)
    y += 18
  }
  const staves = o.staves ?? 2
  const systemH = staves * 4 * sp + (staves - 1) * 7 * sp
  const nSys = o.systems ?? Math.max(1, Math.floor((PAGE_H - y - 14) / (systemH + (o.lyrics ? 13 : 9) * sp)))
  const gap = (PAGE_H - y - 14 - nSys * systemH) / Math.max(1, nSys)
  const density = o.density ?? 4
  for (let s = 0; s < nSys; s++) {
    const top = y + gap * 0.5 + s * (systemH + gap)
    const x1 = s === nSys - 1 && o.lastPartial ? left + (right - left) * o.lastPartial : right
    const staffTops: number[] = []
    for (let k = 0; k < staves; k++) {
      const st = top + k * 11 * sp
      staffTops.push(st)
      for (let l = 0; l < 5; l++) {
        c.line(left, st + l * sp, x1, st + l * sp, lt)
        lines.push({ y: st + l * sp, x0: left, x1 })
      }
      // Clef: a blob with a curl.
      c.ellipse(left + 3, st + 2.6 * sp, sp * 0.9, sp * 1.3, 0.3)
      c.slur(left + 2, st - sp, left + 4, st + 4.6 * sp, sp, 0.35)
      // Key / time signature digits.
      c.ellipse(left + 8, st + sp, sp * 0.55, sp * 0.8, 0)
      c.ellipse(left + 8, st + 3 * sp, sp * 0.55, sp * 0.8, 0)
    }
    const sysBottom = staffTops[staves - 1] + 4 * sp
    // System barline (and a brace for two staves).
    c.line(left, top, left, sysBottom, 0.25)
    if (staves > 1) c.slur(left - 1.5, top, left - 1.5, sysBottom, -1.2, 0.5)
    const bars = 3 + Math.floor(r() * 3)
    const barW = (x1 - left - 14) / bars
    for (let b = 0; b <= bars; b++) {
      const bx = left + 14 + b * barW
      for (const st of staffTops) c.line(bx, st, bx, st + 4 * sp, b === bars ? 0.45 : 0.16)
      if (b === bars) break
      for (const st of staffTops) {
        const n = Math.max(1, Math.round(density * (0.6 + r() * 0.8)))
        const step = barW / (n + 0.5)
        let prev: { x: number; y: number }[] = []
        const flush = () => {
          if (prev.length >= 2) {
            const a = prev[0]
            const z = prev[prev.length - 1]
            c.beam(a.x, a.y, z.x, z.y, sp * 0.5)
            if (r() < 0.4) c.beam(a.x, a.y + sp * 0.75, z.x, z.y + sp * 0.75, sp * 0.5)
          }
          prev = []
        }
        for (let k = 0; k < n; k++) {
          const nx = bx + step * (k + 0.75)
          const pitch = Math.floor(r() * 15) - 3 // half-spaces below the top line
          const ny = st + pitch * sp * 0.5
          const chord = r() < 0.25
          for (const dp of chord ? [0, 2, 4] : [0]) {
            const yy = ny + dp * sp * 0.5
            if (r() < 0.15) c.ring(nx, yy, sp * 0.62, sp * 0.45, 0.18)
            else c.ellipse(nx, yy, sp * 0.65, sp * 0.47, -0.35)
            // Ledger lines.
            for (let lp = -2; lp >= pitch + dp; lp -= 2) c.line(nx - sp, st + lp * sp * 0.5, nx + sp, st + lp * sp * 0.5, lt)
            for (let lp = 10; lp <= pitch + dp; lp += 2) c.line(nx - sp, st + lp * sp * 0.5, nx + sp, st + lp * sp * 0.5, lt)
          }
          const up = pitch > 4
          const sx = nx + (up ? sp * 0.6 : -sp * 0.6)
          const tipY = ny + (up ? -3.5 * sp : 3.5 * sp)
          c.line(sx, ny, sx, tipY, 0.13)
          if (r() < 0.55) prev.push({ x: sx, y: tipY })
          else flush()
          if (r() < 0.08) c.text(nx - 1, nx + 2, ny - sp * 0.2, sp * 0.9, r) // accidental-ish
        }
        flush()
        // Slurs, hairpins and dynamics.
        if (r() < 0.6) {
          const a = bx + barW * 0.1
          const z = bx + barW * (0.5 + r() * 0.45)
          const above = r() < 0.5
          const yy = above ? st - sp * (1 + r() * 2) : st + 4 * sp + sp * (1 + r() * 2)
          c.slur(a, yy, z, yy + (r() - 0.5) * sp * 2, (above ? -1 : 1) * sp * (0.8 + r()), 0.22)
        }
        if (r() < 0.25) {
          const a = bx + barW * 0.2
          const z = a + barW * 0.6
          const yy = st + 4 * sp + 3 * sp
          c.line(a, yy, z, yy - sp * 0.6, 0.12)
          c.line(a, yy, z, yy + sp * 0.6, 0.12)
        }
      }
    }
    if (o.lyrics) c.text(left + 14, x1 - 3, sysBottom + 4.5 * sp, 1.7, r)
  }
  return { canvas: c, lines, spacing: sp }
}

/** A page of prose (or chord-sheet-like short lines): no staves. */
export function textPage(seed: number, opts: { ppm?: number; short?: boolean; ruled?: boolean } = {}): FlatPage {
  const r = rng(seed)
  const c = new Canvas(PAGE_W, PAGE_H, opts.ppm ?? 8)
  c.text(50, 160, 26, 6, r)
  for (let y = 45; y < PAGE_H - 18; y += 6.2) {
    if (opts.ruled) c.line(18, y + 0.8, PAGE_W - 18, y + 0.8, 0.12)
    const end = opts.short ? 20 + r() * 90 : PAGE_W - 20 - r() * 12
    c.text(20, end, y, 2.4, r)
  }
  return { canvas: c, lines: [], spacing: 6.2 }
}

// ---------------------------------------------------------------------------------------------
// The curved surface and camera.

export interface SceneOptions {
  /** Tangent angle at the spine, degrees (0 = flat). */
  theta0?: number
  /** Decay length of the spine curl, mm. */
  lambda?: number
  /** Uniform bow: change in tangent angle per mm, degrees (a cylinder arc). */
  kappa?: number
  spine?: 'left' | 'right'
  /** Camera tilt (degrees) about the photo's x and y axes, and roll about the view axis. */
  pitch?: number
  yaw?: number
  roll?: number
  /** Camera height above the table, mm. */
  height?: number
  /** Camera offset from above the page centre, mm. */
  offsetX?: number
  offsetY?: number
  imgW?: number
  imgH?: number
  /** Fraction of the photo's shorter side filled by the page width (sets the focal length). */
  fill?: number
  blur?: number
  noise?: number
  /** 0…1: strength of uneven lighting (gradient + spine shadow). */
  lighting?: number
  seed?: number
}

export interface Scene {
  W: number
  H: number
  /** Arc length s ∈ [0,W] across the page, y ∈ [0,H] down → world point. */
  world(s: number, y: number): [number, number, number]
  /** Page point → photo pixel. */
  project(s: number, y: number): Pt
  imgW: number
  imgH: number
}

export function makeScene(o: SceneOptions = {}): Scene {
  const W = PAGE_W
  const H = PAGE_H
  const theta0 = ((o.theta0 ?? 0) * Math.PI) / 180
  const lambda = o.lambda ?? 30
  const kappa = ((o.kappa ?? 0) * Math.PI) / 180
  const spineLeft = (o.spine ?? 'right') === 'left'
  // Integrate the cross-section by distance from the spine d: X along the table, Z up.
  const N = 2100
  const ds = W / N
  const X = new Float64Array(N + 1)
  const Z = new Float64Array(N + 1)
  for (let k = 0; k < N; k++) {
    const d = (k + 0.5) * ds
    const th = theta0 * Math.exp(-d / lambda) + kappa * (d - W / 2)
    X[k + 1] = X[k] + Math.cos(th) * ds
    Z[k + 1] = Z[k] + Math.sin(th) * ds
  }
  const chord = X[N]
  const zMax = Z.reduce((a, b) => Math.max(a, b), -Infinity)
  const lerp = (a: Float64Array, d: number) => {
    const f = Math.max(0, Math.min(N, d / ds))
    const i = Math.min(N - 1, Math.floor(f))
    return a[i] + (a[i + 1] - a[i]) * (f - i)
  }
  const world = (s: number, y: number): [number, number, number] => {
    const d = spineLeft ? s : W - s
    const xd = lerp(X, d)
    return [spineLeft ? xd : chord - xd, y, lerp(Z, d)]
  }
  const imgW = o.imgW ?? 1650
  const imgH = o.imgH ?? 2200
  const cam = [chord / 2 + (o.offsetX ?? 0), H / 2 + (o.offsetY ?? 0), (o.height ?? 420) + zMax]
  const deg = Math.PI / 180
  const rx = (o.pitch ?? 0) * deg
  const ry = (o.yaw ?? 0) * deg
  const rz = (o.roll ?? 0) * deg
  // Camera axes in world coordinates (right, down, forward), starting straight down with image x = world X.
  let axes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ]
  // Tilt the camera: rotate the axes about the camera's own right / down / forward axes.
  const spin = (a: number, about: number) => {
    const [i, j] = about === 0 ? [1, 2] : about === 1 ? [2, 0] : [0, 1]
    const ai = axes[i]
    const aj = axes[j]
    axes = [...axes]
    axes[i] = ai.map((v, k) => v * Math.cos(a) + aj[k] * Math.sin(a))
    axes[j] = aj.map((v, k) => -ai[k] * Math.sin(a) + v * Math.cos(a))
  }
  spin(rx, 0)
  spin(ry, 1)
  spin(rz, 2)
  // Aim at the page centre after tilting: move the camera so the centre stays in view.
  const centre = world(W / 2, H / 2)
  const dist = cam[2] - centre[2]
  for (let k = 0; k < 3; k++) cam[k] = centre[k] - axes[2][k] * dist
  cam[0] += o.offsetX ?? 0
  cam[1] += o.offsetY ?? 0
  const f = ((o.fill ?? 0.82) * Math.min(imgW, imgH) * dist) / chord
  const project = (s: number, y: number): Pt => {
    const p = world(s, y)
    const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]]
    const xc = d[0] * axes[0][0] + d[1] * axes[0][1] + d[2] * axes[0][2]
    const yc = d[0] * axes[1][0] + d[1] * axes[1][1] + d[2] * axes[1][2]
    const zc = d[0] * axes[2][0] + d[1] * axes[2][1] + d[2] * axes[2][2]
    return { x: imgW / 2 + (f * xc) / zc, y: imgH / 2 + (f * yc) / zc }
  }
  return { W, H, world, project, imgW, imgH }
}

export interface Photo {
  grey: Uint8Array
  width: number
  height: number
  /** True paper corners (TL, TR, BR, BL of the page as read). */
  quad: Quad
}

/** Render the page onto the curved surface through the camera (mesh rasteriser, 1 mm cells). */
export function photograph(page: FlatPage, scene: Scene, o: SceneOptions = {}): Photo {
  const { imgW, imgH } = scene
  const r = rng((o.seed ?? 1) * 7919 + 13)
  const out = new Float32Array(imgW * imgH)
  // Table: dark, slightly textured.
  for (let i = 0; i < out.length; i++) out[i] = 70 + r() * 12
  const { canvas } = page
  const cw = canvas.w
  const ch = canvas.h
  const p = canvas.ppm
  const sample = (s: number, y: number) => {
    const fx = Math.max(0, Math.min(cw - 1.001, s * p - 0.5))
    const fy = Math.max(0, Math.min(ch - 1.001, y * p - 0.5))
    const x0 = fx | 0
    const y0 = fy | 0
    const ax = fx - x0
    const ay = fy - y0
    const k = y0 * cw + x0
    const a = canvas.ink
    return (a[k] * (1 - ax) + a[k + 1] * ax) * (1 - ay) + (a[k + cw] * (1 - ax) + a[k + cw + 1] * ax) * ay
  }
  const light = o.lighting ?? 0.5
  const spineLeft = (o.spine ?? 'right') === 'left'
  // Surface normal from the world mapping (finite differences), lit from above-left.
  const L = [-0.35, -0.45, 0.82]
  const shade = (s: number, y: number) => {
    const a = scene.world(Math.max(0, s - 0.5), y)
    const b = scene.world(Math.min(scene.W, s + 0.5), y)
    const tx = b[0] - a[0]
    const tz = b[2] - a[2]
    const n = Math.hypot(tx, tz)
    // Normal of the cross-section (perpendicular to the tangent, pointing up), y-component 0.
    const nx = -tz / n
    const nz = tx / n
    const lam = Math.max(0, nx * L[0] + nz * L[2]) / Math.hypot(L[0], L[2])
    const d = spineLeft ? s : scene.W - s
    const spineShadow = 1 - 0.45 * Math.exp(-d / 7)
    const grad = 1 - 0.35 * (y / scene.H) * (s / scene.W)
    return 238 * (1 - light + light * (0.25 + 0.75 * lam) * spineShadow * grad)
  }
  const step = 1
  const nx = Math.round(scene.W / step)
  const ny = Math.round(scene.H / step)
  const P: Pt[] = []
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) P.push(scene.project(i * step, j * step))
  const tri = (a: number, b: number, c: number, sa: Pt, sb: Pt, sc: Pt) => {
    const A = P[a]
    const B = P[b]
    const C = P[c]
    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)))
    const x1 = Math.min(imgW - 1, Math.ceil(Math.max(A.x, B.x, C.x)))
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)))
    const y1 = Math.min(imgH - 1, Math.ceil(Math.max(A.y, B.y, C.y)))
    const det = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y)
    if (Math.abs(det) < 1e-12) return
    const shA = shade(sa.x, sa.y)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const l1 = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / det
        const l2 = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / det
        const l3 = 1 - l1 - l2
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
        const s = l1 * sa.x + l2 * sb.x + l3 * sc.x
        const yy = l1 * sa.y + l2 * sb.y + l3 * sc.y
        out[y * imgW + x] = shA * (1 - 0.9 * sample(s, yy))
      }
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i
      const sa = { x: i * step, y: j * step }
      const sb = { x: (i + 1) * step, y: j * step }
      const sc = { x: (i + 1) * step, y: (j + 1) * step }
      const sd = { x: i * step, y: (j + 1) * step }
      tri(a, a + 1, a + nx + 2, sa, sb, sc)
      tri(a, a + nx + 2, a + nx + 1, sa, sc, sd)
    }
  let img: Float32Array = out
  const blur = o.blur ?? 0.8
  if (blur > 0) img = gaussian(img, imgW, imgH, blur)
  const noise = o.noise ?? 3
  const grey = new Uint8Array(imgW * imgH)
  for (let i = 0; i < grey.length; i++) {
    // Box–Muller noise.
    const n = noise ? Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()) * noise : 0
    grey[i] = Math.max(0, Math.min(255, Math.round(img[i] + n)))
  }
  const quad = [scene.project(0, 0), scene.project(scene.W, 0), scene.project(scene.W, scene.H), scene.project(0, scene.H)] as Quad
  return { grey, width: imgW, height: imgH, quad }
}

/** Gaussian blur approximated by three box passes (σ in pixels). */
export function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5))
  let a: Float32Array = src
  for (let k = 0; k < 3; k++) {
    const tmp = new Float32Array(w * h)
    const o = new Float32Array(w * h)
    const n = 2 * r + 1
    for (let y = 0; y < h; y++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += a[y * w + Math.min(w - 1, Math.max(0, i))]
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / n
        acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)]
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]
      for (let y = 0; y < h; y++) {
        o[y * w + x] = acc / n
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
      }
    }
    a = o
  }
  return a
}

/** Rotate a photo a quarter turn clockwise (as if the phone was held sideways). */
export function rotatePhotoCW(ph: Photo): Photo {
  const { width: w, height: h, grey } = ph
  const out = new Uint8Array(w * h)
  // New image is h wide, w tall; old (x,y) → new (h−1−y, x).
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = grey[y * w + x]
  const quad = ph.quad.map((q) => ({ x: h - q.y, y: q.x })) as Quad
  return { grey: out, width: h, height: w, quad }
}

/** The photo-ordered quad (TL…BL as seen in the photo) and the quarter turns that make the page upright. */
export function photoQuad(pageQuad: Quad): { quad: Quad; rotation: number } {
  const q = orderQuad(pageQuad)
  // rotateQuad(q, k)[0] = q[(−k) mod 4] must be the page's top-left corner.
  const i = q.findIndex((p) => Math.hypot(p.x - pageQuad[0].x, p.y - pageQuad[0].y) < 1e-6)
  return { quad: q, rotation: (4 - i) % 4 }
}

// ---------------------------------------------------------------------------------------------
// Ground-truth straightness of the staff lines after a correction.

export interface Straightness {
  /** Worst deviation of any staff line from its best-fit straight line, output pixels. */
  worstPx: number
  /** Same, in staff spaces. */
  worstSp: number
  /** 90th percentile of per-line worst deviations, staff spaces. */
  p90Sp: number
  /** Largest end-to-end tilt of a staff line (straight but sloped), staff spaces. */
  tiltSp: number
}

/**
 * Map each ground-truth staff line through the photo and into the corrected output (upright quad `q`,
 * flat→rectified mapping `toRect`; identity = plain perspective warp), and measure how straight it is.
 * `outH` is the output height in pixels.
 */
export function straightness(
  page: FlatPage,
  scene: Scene,
  q: Quad,
  toRect: (u: number, v: number) => Pt,
  outH: number,
  mapPhoto: (p: Pt) => Pt = (p) => p,
): Straightness {
  const unit = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
  const Hm = homography(unit, q)!
  const Hi = invert3(Hm)!
  const per: number[] = []
  let tilt = 0
  let spPx = 0
  const vs: number[][] = []
  for (const l of page.lines) {
    const us: number[] = []
    const v: number[] = []
    const n = 60
    for (let k = 0; k <= n; k++) {
      const s = l.x0 + ((l.x1 - l.x0) * k) / n
      const r = applyH(Hi, mapPhoto(scene.project(s, l.y)))
      const f = invertBend(toRect, r)
      us.push(f.x)
      v.push(f.y * outH)
    }
    vs.push(v)
    // Least-squares line through (u·outH, v).
    const m = us.length
    let su = 0
    let sv = 0
    for (let k = 0; k < m; k++) {
      su += us[k]
      sv += v[k]
    }
    su /= m
    sv /= m
    let suu = 0
    let suv = 0
    for (let k = 0; k < m; k++) {
      suu += (us[k] - su) ** 2
      suv += (us[k] - su) * (v[k] - sv)
    }
    const b = suv / suu
    let worst = 0
    for (let k = 0; k < m; k++) worst = Math.max(worst, Math.abs(v[k] - sv - b * (us[k] - su)))
    per.push(worst)
    tilt = Math.max(tilt, Math.abs(b * (us[m - 1] - us[0])))
  }
  // Output staff spacing: mean distance between neighbouring lines of the same staff.
  let cnt = 0
  for (let i = 0; i + 1 < vs.length; i++) {
    const d = vs[i + 1][30] - vs[i][30]
    if (Math.abs(page.lines[i + 1].y - page.lines[i].y - page.spacing) < 1e-6) {
      spPx += d
      cnt++
    }
  }
  spPx /= cnt || 1
  per.sort((a, b) => a - b)
  const worstPx = per[per.length - 1] ?? 0
  return { worstPx, worstSp: worstPx / spPx, p90Sp: (per[Math.floor(per.length * 0.9)] ?? 0) / spPx, tiltSp: tilt / spPx }
}

/** Solve toRect(u,v) = r by Newton's method (toRect is close to the identity). */
export function invertBend(toRect: (u: number, v: number) => Pt, r: Pt): Pt {
  let u = r.x
  let v = r.y
  for (let it = 0; it < 20; it++) {
    const p = toRect(u, v)
    const ex = p.x - r.x
    const ey = p.y - r.y
    if (Math.abs(ex) + Math.abs(ey) < 1e-10) break
    const e = 1e-6
    const pu = toRect(u + e, v)
    const pv = toRect(u, v + e)
    const a = (pu.x - p.x) / e
    const b = (pv.x - p.x) / e
    const c = (pu.y - p.y) / e
    const d = (pv.y - p.y) / e
    const det = a * d - b * c
    u -= (d * ex - b * ey) / det
    v -= (-c * ex + a * ey) / det
  }
  return { x: u, y: v }
}

/** Rectified position of the true paper edge (top: y of side 0; bottom: y of side 2) at x, for "perfect manual" bends. */
export function edgeAt(scene: Scene, q: Quad, side: 'top' | 'bottom', x: number, mapPhoto: (p: Pt) => Pt = (p) => p): number {
  const unit = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
  const Hi = invert3(homography(unit, q)!)!
  const y = side === 'top' ? 0 : scene.H
  // Find s with rectified x = target by bisection (x is monotonic in s).
  let lo = 0
  let hi = scene.W
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2
    const rx = applyH(Hi, mapPhoto(scene.project(mid, y))).x
    if (rx < x) lo = mid
    else hi = mid
  }
  return applyH(Hi, mapPhoto(scene.project((lo + hi) / 2, y))).y
}
