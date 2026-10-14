/** Plane geometry for document scanning: quads, homographies, paper aspect and output sizes. */

export interface Pt {
  x: number
  y: number
}
/** Corners in order top-left, top-right, bottom-right, bottom-left (as seen in the photo). */
export type Quad = [Pt, Pt, Pt, Pt]
/** Row-major 3×3 matrix. */
export type Mat3 = number[]

export const FULL_QUAD: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

/** Solve A·x = b (n×n, Gaussian elimination with partial pivoting). Returns null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r
    if (Math.abs(m[p][c]) < 1e-12) return null
    ;[m[c], m[p]] = [m[p], m[c]]
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c]
      if (!f) continue
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n]
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k]
    x[r] = s / m[r][r]
  }
  return x
}

/** Homography H (h33 = 1) mapping each src[i] onto dst[i]. Null for degenerate input (3 collinear points). */
export function homography(src: readonly Pt[], dst: readonly Pt[]): Mat3 | null {
  const a: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(a, b)
  return h ? [...h, 1] : null
}

export function applyH(h: Mat3, p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-15) return null
  const k = 1 / det
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k]
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** Signed area (positive when the points run clockwise in y-down image coordinates). */
export function polygonArea(pts: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

/** Strictly convex with a consistent clockwise winding (TL→TR→BR→BL in image coordinates). */
export function isConvexQuad(q: readonly Pt[]): boolean {
  for (let i = 0; i < 4; i++) if (cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) <= 0) return false
  return true
}

/** Put four arbitrary points into TL, TR, BR, BL order (by angle around the centroid). */
export function orderQuad(pts: readonly Pt[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  // atan2 order in y-down coordinates runs clockwise; start at the corner with the smallest x+y.
  let start = 0
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i
  return [0, 1, 2, 3].map((k) => ({ ...sorted[(start + k) % 4] })) as Quad
}

/** Rotate the output by quarter turns clockwise: the corner that ends up top-left changes. */
export function rotateQuad(q: Quad, quarterTurns: number): Quad {
  const k = ((quarterTurns % 4) + 4) % 4
  return [0, 1, 2, 3].map((i) => q[(i - k + 4) % 4]) as Quad
}

export function scaleQuad(q: readonly Pt[], sx: number, sy: number): Quad {
  return q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad
}

/** Width and height of the quad measured along its edges (the longer of each opposite pair). */
export function quadEdges(q: Quad): { w: number; h: number } {
  return { w: Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h: Math.max(dist(q[0], q[3]), dist(q[1], q[2])) }
}

/**
 * Width/height ratio of the real rectangle photographed as `q` (pixel coordinates in an image of
 * size imgW×imgH), assuming a pinhole camera with its principal point at the image centre and
 * square pixels (Zhang & He, "Whiteboard scanning and image enhancement"). Falls back to the
 * edge-length ratio when the perspective is too weak to estimate the focal length, or when the
 * estimate disagrees wildly with it (e.g. a cropped photo whose centre isn't the principal point).
 */
export function paperAspect(q: Quad, imgW: number, imgH: number): number {
  const e = quadEdges(q)
  const naive = (dist(q[0], q[1]) + dist(q[3], q[2])) / (dist(q[0], q[3]) + dist(q[1], q[2]))
  if (!(e.w > 0 && e.h > 0)) return 1
  const u0 = imgW / 2
  const v0 = imgH / 2
  // m1..m4 = TL, TR, BL, BR, centred on the principal point, homogeneous.
  const m = [q[0], q[1], q[3], q[2]].map((p) => [p.x - u0, p.y - v0, 1])
  const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const [m1, m2, m3, m4] = m
  const k2 = dot(cr(m1, m4), m3) / dot(cr(m2, m4), m3)
  const k3 = dot(cr(m1, m4), m2) / dot(cr(m3, m4), m2)
  const n2 = m2.map((v, i) => k2 * v - m1[i])
  const n3 = m3.map((v, i) => k3 * v - m1[i])
  const scale = Math.max(imgW, imgH)
  let ratio: number
  if (Math.abs(n2[2]) < 1e-6 || Math.abs(n3[2]) < 1e-6) {
    // Opposite sides (nearly) parallel: affine case, the focal length drops out.
    ratio = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1])
  } else {
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2])
    // Implausible focal lengths (wider than ~150° or longer than a 10× tele) mean the estimate is noise.
    if (!(f2 > (scale * 0.15) ** 2 && f2 < (scale * 10) ** 2)) return naive
    ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2))
  }
  if (!Number.isFinite(ratio) || ratio <= 0) return naive
  return Math.abs(Math.log(ratio / naive)) > Math.log(1.35) ? naive : ratio
}

/** Common paper sizes in PDF points (portrait). */
export const PAPER = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
}

/** Snap a width/height ratio to A4 or Letter (either orientation) when within `tol`. */
export function snapAspect(ratio: number, tol = 0.04): { ratio: number; paper: keyof typeof PAPER | null; landscape: boolean } {
  const landscape = ratio > 1
  const r = landscape ? 1 / ratio : ratio
  let best: keyof typeof PAPER | null = null
  let bestErr = tol
  for (const k of Object.keys(PAPER) as (keyof typeof PAPER)[]) {
    const pr = PAPER[k].w / PAPER[k].h
    const err = Math.abs(r / pr - 1)
    if (err < bestErr) {
      best = k
      bestErr = err
    }
  }
  if (!best) return { ratio, paper: null, landscape }
  const pr = PAPER[best].w / PAPER[best].h
  return { ratio: landscape ? 1 / pr : pr, paper: best, landscape }
}

/** PDF page size (points) for a scan with this width/height ratio. Unknown sizes get A4's long side. */
export function pageSizeFor(ratio: number): { w: number; h: number } {
  const s = snapAspect(ratio, 0.005)
  if (s.paper) {
    const p = PAPER[s.paper]
    return s.landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h }
  }
  const long = PAPER.a4.h
  return ratio >= 1 ? { w: long, h: long / ratio } : { w: long * ratio, h: long }
}

/**
 * Output raster size for a quad (pixel coords in an imgW×imgH photo): the corrected paper aspect,
 * about as many pixels as the photo really has across the paper, capped at `maxLong`.
 */
export function outputSize(q: Quad, imgW: number, imgH: number, maxLong: number, minLong = 0): { w: number; h: number; ratio: number } {
  const ratio = snapAspect(paperAspect(q, imgW, imgH)).ratio
  const e = quadEdges(q)
  // Measured resolution along the longer paper dimension.
  const measured = ratio >= 1 ? Math.max(e.w, e.h * ratio) : Math.max(e.h, e.w / ratio)
  const long = Math.round(Math.max(minLong, Math.min(maxLong, measured)))
  return ratio >= 1 ? { w: long, h: Math.max(1, Math.round(long / ratio)), ratio } : { w: Math.max(1, Math.round(long * ratio)), h: long, ratio }
}
