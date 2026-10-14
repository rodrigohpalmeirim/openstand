/**
 * Cheap paper detection on a small greyscale image: the page is usually the largest bright region.
 * Otsu threshold → largest bright connected component → convex hull → reduced to 4 corners →
 * refined by fitting a line to each side's boundary pixels. Good enough as a starting point for
 * the manual corner editor; returns null when nothing plausible is found.
 */
import { isConvexQuad, orderQuad, polygonArea, type Pt, type Quad } from './geometry'

export function otsu(grey: Uint8Array): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < grey.length; i++) hist[grey[i]]++
  const total = grey.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) ** 2
    if (v > bestVar) {
      bestVar = v
      best = t
    }
  }
  return best
}

/** Label the largest 4-connected component of `mask`; returns its pixel indices' membership mask. */
function largestComponent(mask: Uint8Array, w: number, h: number): { comp: Uint8Array; size: number } | null {
  const label = new Int32Array(w * h)
  const stack = new Int32Array(w * h)
  let bestLabel = 0
  let bestScore = 0
  let bestSize = 0
  let next = 0
  const cx = w / 2
  const cy = h / 2
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue
    const id = ++next
    let sp = 0
    stack[sp++] = start
    label[start] = id
    let size = 0
    let central = 0
    const visit = (j: number) => {
      if (mask[j] && !label[j]) {
        label[j] = id
        stack[sp++] = j
      }
    }
    while (sp) {
      const i = stack[--sp]
      size++
      const x = i % w
      const y = (i - x) / w
      if (Math.abs(x - cx) < w / 4 && Math.abs(y - cy) < h / 4) central++
      if (x > 0) visit(i - 1)
      if (x < w - 1) visit(i + 1)
      if (y > 0) visit(i - w)
      if (y < h - 1) visit(i + w)
    }
    // Prefer regions covering the centre of the frame: that's where people aim the camera.
    const score = size + central * 2
    if (score > bestScore) {
      bestScore = score
      bestLabel = id
      bestSize = size
    }
  }
  if (!bestLabel) return null
  const comp = new Uint8Array(w * h)
  for (let i = 0; i < comp.length; i++) if (label[i] === bestLabel) comp[i] = 1
  return { comp, size: bestSize }
}

/** Andrew's monotone chain; returns the hull clockwise in y-down coordinates (TL→TR→…). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  // Counter-clockwise with y up = clockwise on screen (y down).
  return lower.concat(upper)
}

/** Visvalingam–Whyatt: drop the vertex spanning the smallest triangle until `n` remain. */
export function simplifyTo(poly: Pt[], n: number): Pt[] {
  const p = [...poly]
  const tri = (a: Pt, b: Pt, c: Pt) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
  while (p.length > n) {
    let bi = 0
    let ba = Infinity
    for (let i = 0; i < p.length; i++) {
      const a = tri(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length])
      if (a < ba) {
        ba = a
        bi = i
      }
    }
    p.splice(bi, 1)
  }
  return p
}

/** Total-least-squares line through points: returns a point on it and its unit direction. */
function fitLine(pts: Pt[]): { p: Pt; d: Pt } {
  let mx = 0
  let my = 0
  for (const q of pts) {
    mx += q.x
    my += q.y
  }
  mx /= pts.length
  my /= pts.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const q of pts) {
    const dx = q.x - mx
    const dy = q.y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { p: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } }
}

function intersect(a: { p: Pt; d: Pt }, b: { p: Pt; d: Pt }): Pt | null {
  const den = a.d.x * b.d.y - a.d.y * b.d.x
  if (Math.abs(den) < 1e-9) return null
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t }
}

/** Move each side onto the line best fitting the region's outline near it (straightens rounded corners). */
function refine(q: Quad, boundary: Pt[], w: number, h: number): Quad {
  const lines = q.map((a, i) => {
    const b = q[(i + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    const tol = Math.max(2, Math.max(w, h) * 0.012)
    const near = boundary.filter((p) => {
      const t = (p.x - a.x) * ux + (p.y - a.y) * uy
      const d = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux)
      return t > len * 0.1 && t < len * 0.9 && d <= tol
    })
    return near.length >= 6 ? fitLine(near) : { p: a, d: { x: ux, y: uy } }
  })
  const out: Pt[] = []
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i])
    if (!p) return q
    // Corners may land a little outside the frame (paper cut off); keep them nearby.
    if (p.x < -w * 0.05 || p.x > w * 1.05 || p.y < -h * 0.05 || p.y > h * 1.05) return q
    if (Math.hypot(p.x - q[i].x, p.y - q[i].y) > Math.max(w, h) * 0.08) return q
    out.push(p)
  }
  return isConvexQuad(out) ? (out as Quad) : q
}

/**
 * Find the paper in a small greyscale image (w×h, ideally ≤ 400px). Returns corners normalized to
 * 0…1 (TL, TR, BR, BL), or null.
 */
export function detectQuad(grey: Uint8Array, w: number, h: number): Quad | null {
  if (w < 16 || h < 16) return null
  const t = otsu(grey)
  // A low-contrast frame (white page on a white desk, or no page at all) has no usable split.
  let lo = 0
  let hi = 0
  let nlo = 0
  let nhi = 0
  for (let i = 0; i < grey.length; i++) {
    if (grey[i] > t) {
      hi += grey[i]
      nhi++
    } else {
      lo += grey[i]
      nlo++
    }
  }
  if (!nlo || !nhi || hi / nhi - lo / nlo < 25) return null
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = grey[i] > t ? 1 : 0
  const found = largestComponent(mask, w, h)
  if (!found || found.size < w * h * 0.08) return null
  const { comp } = found
  // Outline samples: the first/last region pixel of every row and column.
  const boundary: Pt[] = []
  for (let y = 0; y < h; y++) {
    let l = -1
    let r = -1
    for (let x = 0; x < w; x++)
      if (comp[y * w + x]) {
        if (l < 0) l = x
        r = x
      }
    if (l >= 0) boundary.push({ x: l, y: y + 0.5 }, { x: r + 1, y: y + 0.5 })
  }
  for (let x = 0; x < w; x++) {
    let t0 = -1
    let b = -1
    for (let y = 0; y < h; y++)
      if (comp[y * w + x]) {
        if (t0 < 0) t0 = y
        b = y
      }
    if (t0 >= 0) boundary.push({ x: x + 0.5, y: t0 }, { x: x + 0.5, y: b + 1 })
  }
  const hull = convexHull(boundary)
  if (hull.length < 4) return null
  let q = orderQuad(simplifyTo(hull, 4))
  if (!isConvexQuad(q)) return null
  q = refine(q, boundary, w, h)
  const area = Math.abs(polygonArea(q))
  if (area < w * h * 0.1) return null
  // A page is at least roughly rectangular: reject slivers and wild angles.
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4]
    const b = q[i]
    const c = q[(i + 1) % 4]
    const v1 = { x: a.x - b.x, y: a.y - b.y }
    const v2 = { x: c.x - b.x, y: c.y - b.y }
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y))
    if (Math.abs(cos) > 0.6) return null
  }
  return q.map((p) => ({ x: Math.max(0, Math.min(1, p.x / w)), y: Math.max(0, Math.min(1, p.y / h)) })) as Quad
}
