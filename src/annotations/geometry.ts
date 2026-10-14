/**
 * Pure geometry for annotations.
 *
 * Stored coordinates are normalised to the page box (0..1 on both axes). Distances only make sense
 * in a uniform space, so most functions convert to "local" units where the page is 1 wide and
 * `aspect` (= height / width) tall. Widths are fractions of page width, which are local units.
 */
import type { Annotation, Point, StrokeAnnotation, TextAnnotation } from '../db/schema'
import { getStamp, STAMP_FONTS } from './stamps'

export interface Vec {
  x: number
  y: number
  p?: number
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const toLocal = (p: Vec, aspect: number): Vec => ({ x: p.x, y: p.y * aspect, p: p.p })
export const fromLocal = (p: Vec, aspect: number): Vec => ({ x: p.x, y: p.y / aspect, p: p.p })

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export const round = (v: number, d = 5) => {
  const f = 10 ** d
  return Math.round(v * f) / f
}

/* -------------------------------------------------------------- Smoothing */

/** Ramer–Douglas–Peucker simplification (iterative). Keeps the first and last points. */
export function simplify<T extends Vec>(points: T[], tolerance: number): T[] {
  if (points.length < 3 || tolerance <= 0) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let maxD = 0
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** Exponential "streamline" filter applied while drawing: 0 = raw, 0.6 = strong smoothing. */
export function streamline(prev: Vec, raw: Vec, amount: number): Vec {
  const k = 1 - amount
  return { x: prev.x + (raw.x - prev.x) * k, y: prev.y + (raw.y - prev.y) * k, p: raw.p }
}

const f = (v: number) => (Math.round(v * 100) / 100).toString()

/** SVG path through points using quadratic curves between midpoints (smooth, passes near points). */
export function smoothPath(pts: Vec[]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M${f(pts[0].x)} ${f(pts[0].y)}l0.01 0`
  if (n === 2) return `M${f(pts[0].x)} ${f(pts[0].y)}L${f(pts[1].x)} ${f(pts[1].y)}`
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`
  for (let i = 1; i < n - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    d += `Q${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`
  }
  d += `L${f(pts[n - 1].x)} ${f(pts[n - 1].y)}`
  return d
}

/** Pressure → width multiplier: ±60 % around the base width, as in the reference app. */
export const pressureWidth = (base: number, p: number | undefined) => base * (0.4 + 1.2 * Math.max(0, Math.min(1, p ?? 0.5)))

/**
 * Filled outline of a variable-width stroke. `pts` carry a diameter `w`. Round caps are
 * approximated with short polylines, the sides are quadratic-smoothed.
 */
export function strokeOutline(pts: { x: number; y: number; w: number }[]): string {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1 || pts.every((p) => p.x === pts[0].x && p.y === pts[0].y)) {
    const r = pts[0].w / 2
    return `M${f(pts[0].x - r)} ${f(pts[0].y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`
  }
  const left: Vec[] = []
  const right: Vec[] = []
  const tangents: Vec[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    let tx = b.x - a.x
    let ty = b.y - a.y
    const len = Math.hypot(tx, ty) || 1
    tx /= len
    ty /= len
    tangents.push({ x: tx, y: ty })
    const r = pts[i].w / 2
    left.push({ x: pts[i].x - ty * r, y: pts[i].y + tx * r })
    right.push({ x: pts[i].x + ty * r, y: pts[i].y - tx * r })
  }
  const cap = (c: { x: number; y: number; w: number }, t: Vec, sign: 1 | -1) => {
    // Semicircle from +normal (θ=0) through the tip (θ=π/2) to −normal (θ=π).
    const r = c.w / 2
    const nx = -t.y * sign
    const ny = t.x * sign
    const tx = t.x * sign
    const ty = t.y * sign
    let s = ''
    for (let k = 1; k <= 6; k++) {
      const th = (k / 6) * Math.PI
      s += `L${f(c.x + r * (Math.cos(th) * nx + Math.sin(th) * tx))} ${f(c.y + r * (Math.cos(th) * ny + Math.sin(th) * ty))}`
    }
    return s
  }
  const side = (s: Vec[]) => {
    let d = ''
    for (let i = 1; i < s.length - 1; i++) d += `Q${f(s[i].x)} ${f(s[i].y)} ${f((s[i].x + s[i + 1].x) / 2)} ${f((s[i].y + s[i + 1].y) / 2)}`
    d += `L${f(s[s.length - 1].x)} ${f(s[s.length - 1].y)}`
    return d
  }
  let d = `M${f(left[0].x)} ${f(left[0].y)}`
  d += side(left)
  d += cap(pts[n - 1], tangents[n - 1], 1)
  const rr = right.slice().reverse()
  d += side(rr)
  d += cap(pts[0], tangents[0], -1)
  return d + 'Z'
}

/** True when a stroke was drawn with pressure (every point carries `p`). */
export function hasPressure(points: Point[]): boolean {
  return points.length > 0 && points.every((p) => p.p !== undefined)
}

/* ------------------------------------------------------------ Measurement */

let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
const measureCache = new Map<string, number>()

/** Width of a line of text in em. Uses canvas when available, falls back to an estimate. */
export function measureEm(text: string, family: string, bold = false, italic = false): number {
  const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}|${family}|${text}`
  const hit = measureCache.get(key)
  if (hit !== undefined) return hit
  if (measureCtx === undefined) {
    measureCtx = null
    try {
      if (typeof navigator !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) {
        if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d')
        else if (typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d')
      }
    } catch {
      measureCtx = null
    }
  }
  let w: number
  if (measureCtx) {
    measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}100px ${family}`
    w = measureCtx.measureText(text).width / 100
  } else w = text.length * (bold ? 0.6 : 0.55)
  if (measureCache.size > 2000) measureCache.clear()
  measureCache.set(key, w)
  return w
}

export const TEXT_FONTS: Record<NonNullable<TextAnnotation['font']>, string> = {
  sans: "'Inter Variable', system-ui, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, Menlo, Consolas, monospace",
}

export const TEXT_LINE_HEIGHT = 1.25

/** Text box size in local units (page width = 1). */
export function textBoxLocal(t: TextAnnotation, aspect: number) {
  const fs = t.size * aspect
  const lines = (t.text || ' ').split('\n')
  const em = Math.max(0.3, ...lines.map((l) => measureEm(l || ' ', TEXT_FONTS[t.font ?? 'sans'], t.bold, t.italic)))
  return { w: em * fs, h: lines.length * fs * TEXT_LINE_HEIGHT, fs, lines }
}

/** Stamp box size in local units. */
export function stampBoxLocal(stampId: string, size: number, aspect: number) {
  const s = getStamp(stampId)
  const h = size * aspect
  if (s.kind === 'path') return { w: (h * s.w) / s.h, h }
  const font = STAMP_FONTS[s.font]
  return { w: Math.max(0.4, measureEm(s.text, font.family, font.bold, font.italic)) * h, h }
}

/* ---------------------------------------------------------- Bounding boxes */

const emptyRect = (): Rect => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
const grow = (r: Rect, x: number, y: number, pad = 0) => {
  if (x - pad < r.x0) r.x0 = x - pad
  if (y - pad < r.y0) r.y0 = y - pad
  if (x + pad > r.x1) r.x1 = x + pad
  if (y + pad > r.y1) r.y1 = y + pad
}

/** Bounding box in local units, including stroke width. */
export function bboxLocal(it: Annotation, aspect: number): Rect {
  const r = emptyRect()
  switch (it.type) {
    case 'pen':
    case 'highlighter': {
      const pad = (it.width * (it.type === 'pen' && hasPressure(it.points) ? 1.6 : 1)) / 2
      for (const p of it.points) grow(r, p.x, p.y * aspect, pad)
      break
    }
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
    case 'crescendo':
    case 'decrescendo': {
      const extra = it.type === 'arrow' ? arrowHeadLen(it.width) : it.type === 'crescendo' || it.type === 'decrescendo' ? (it.height ?? 0.018) / 2 : 0
      const pad = it.width / 2 + extra
      grow(r, it.a.x, it.a.y * aspect, pad)
      grow(r, it.b.x, it.b.y * aspect, pad)
      break
    }
    case 'text': {
      const b = textBoxLocal(it, aspect)
      const pad = it.background ? b.fs * 0.2 : 0
      grow(r, it.at.x - pad, it.at.y * aspect - pad)
      grow(r, it.at.x + b.w + pad, it.at.y * aspect + b.h + pad)
      break
    }
    case 'stamp': {
      const b = stampBoxLocal(it.stamp, it.size, aspect)
      grow(r, it.at.x - b.w / 2, it.at.y * aspect - b.h / 2)
      grow(r, it.at.x + b.w / 2, it.at.y * aspect + b.h / 2)
      break
    }
    case 'image':
      grow(r, it.a.x, it.a.y * aspect)
      grow(r, it.b.x, it.b.y * aspect)
      break
  }
  return r
}

export function bboxNorm(it: Annotation, aspect: number): Rect {
  const r = bboxLocal(it, aspect)
  return { x0: r.x0, y0: r.y0 / aspect, x1: r.x1, y1: r.y1 / aspect }
}

export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  const r = emptyRect()
  for (const b of rects) {
    r.x0 = Math.min(r.x0, b.x0)
    r.y0 = Math.min(r.y0, b.y0)
    r.x1 = Math.max(r.x1, b.x1)
    r.y1 = Math.max(r.y1, b.y1)
  }
  return r
}

export const rectsIntersect = (a: Rect, b: Rect) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0
export const inRect = (p: Vec, r: Rect) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1
export const normRect = (a: Vec, b: Vec): Rect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) })

export const arrowHeadLen = (width: number) => Math.max(width * 5, 0.014)

/* ------------------------------------------------------------ Hit testing */

function polylineDist(p: Vec, pts: Vec[]): number {
  if (pts.length === 1) return dist(p, pts[0])
  let best = Infinity
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]))
  return best
}

function ellipseDist(p: Vec, c: Vec, rx: number, ry: number): number {
  // Distance to a 48-gon approximation of the ellipse outline.
  let best = Infinity
  let prev = { x: c.x + rx, y: c.y }
  for (let k = 1; k <= 48; k++) {
    const t = (k / 48) * Math.PI * 2
    const q = { x: c.x + rx * Math.cos(t), y: c.y + ry * Math.sin(t) }
    best = Math.min(best, distToSegment(p, prev, q))
    prev = q
  }
  return best
}

/** Geometry outline of a shape in local units (used for hit testing and erasing). */
export function shapeLines(it: Extract<Annotation, { a: Point; b: Point }>, aspect: number): Vec[][] {
  const a = toLocal(it.a, aspect)
  const b = toLocal(it.b, aspect)
  switch (it.type) {
    case 'line':
    case 'image':
      return [[a, b]]
    case 'arrow': {
      const [h1, h2] = arrowHead(a, b, arrowHeadLen(it.width))
      return [[a, b], [h1, b, h2]]
    }
    case 'rect':
      return [[a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]]
    case 'ellipse':
      return []
    case 'crescendo':
    case 'decrescendo': {
      const [apex, open] = it.type === 'crescendo' ? [a, b] : [b, a]
      const [u1, u2] = hairpinEnds(apex, open, it.height ?? 0.018)
      return [[u1, apex, u2]]
    }
  }
}

export function arrowHead(a: Vec, b: Vec, len: number): [Vec, Vec] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const spread = 0.45
  return [
    { x: b.x - len * Math.cos(ang - spread), y: b.y - len * Math.sin(ang - spread) },
    { x: b.x - len * Math.cos(ang + spread), y: b.y - len * Math.sin(ang + spread) },
  ]
}

export function hairpinEnds(apex: Vec, open: Vec, height: number): [Vec, Vec] {
  const dx = open.x - apex.x
  const dy = open.y - apex.y
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * (height / 2)
  const ny = (dx / len) * (height / 2)
  return [
    { x: open.x + nx, y: open.y + ny },
    { x: open.x - nx, y: open.y - ny },
  ]
}

/** Does point `pn` (normalised) hit the item, with tolerance `tol` in local units? */
export function hitTest(it: Annotation, pn: Vec, tol: number, aspect: number): boolean {
  const p = toLocal(pn, aspect)
  const bb = bboxLocal(it, aspect)
  if (p.x < bb.x0 - tol || p.x > bb.x1 + tol || p.y < bb.y0 - tol || p.y > bb.y1 + tol) return false
  switch (it.type) {
    case 'pen':
    case 'highlighter': {
      const pts = it.points.map((q) => toLocal(q, aspect))
      const half = (it.width * (it.type === 'pen' && hasPressure(it.points) ? 1.3 : 1)) / 2
      return polylineDist(p, pts) <= tol + half
    }
    case 'rect':
      if (it.fill) return true
      return shapeLines(it, aspect).some((l) => polylineDist(p, l) <= tol + it.width / 2)
    case 'ellipse': {
      const a = toLocal(it.a, aspect)
      const b = toLocal(it.b, aspect)
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const rx = Math.abs(b.x - a.x) / 2
      const ry = Math.abs(b.y - a.y) / 2
      if (it.fill && rx > 0 && ry > 0 && ((p.x - c.x) / rx) ** 2 + ((p.y - c.y) / ry) ** 2 <= 1) return true
      return ellipseDist(p, c, rx, ry) <= tol + it.width / 2
    }
    case 'line':
    case 'arrow':
    case 'crescendo':
    case 'decrescendo':
      return shapeLines(it, aspect).some((l) => polylineDist(p, l) <= tol + it.width / 2)
    case 'text':
    case 'stamp':
    case 'image':
      return true // inside the (tolerance-padded) box
  }
}

/** Topmost item under the point. */
export function hitTopmost(items: Annotation[], pn: Vec, tol: number, aspect: number): Annotation | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (hitTest(items[i], pn, tol, aspect)) return items[i]
  return undefined
}

/** Representative points of an item (normalised), used for lasso and box tests. */
export function samplePoints(it: Annotation, aspect: number): Vec[] {
  switch (it.type) {
    case 'pen':
    case 'highlighter': {
      if (it.points.length <= 64) return it.points
      const step = it.points.length / 64
      const out: Vec[] = []
      for (let i = 0; i < it.points.length; i += step) out.push(it.points[Math.floor(i)])
      out.push(it.points[it.points.length - 1])
      return out
    }
    case 'line':
    case 'arrow':
    case 'crescendo':
    case 'decrescendo':
      return [it.a, { x: (it.a.x + it.b.x) / 2, y: (it.a.y + it.b.y) / 2 }, it.b]
    default: {
      const b = bboxNorm(it, aspect)
      return [
        { x: b.x0, y: b.y0 },
        { x: b.x1, y: b.y0 },
        { x: b.x1, y: b.y1 },
        { x: b.x0, y: b.y1 },
        { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 },
      ]
    }
  }
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Items mostly (≥ 70 % of sample points) inside the lasso polygon (normalised coords). */
export function lassoSelect(items: Annotation[], poly: Vec[], aspect: number): Annotation[] {
  if (poly.length < 3) return []
  return items.filter((it) => {
    const s = samplePoints(it, aspect)
    let n = 0
    for (const q of s) if (pointInPolygon(q, poly)) n++
    return n / s.length >= 0.7
  })
}

function segmentIntersectsRect(a: Vec, b: Vec, r: Rect): boolean {
  // Liang–Barsky clip.
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, a.x - r.x0) && clip(dx, r.x1 - a.x) && clip(-dy, a.y - r.y0) && clip(dy, r.y1 - a.y)
}

/** Does the item touch the rectangle (normalised coords)? */
export function itemIntersectsRect(it: Annotation, r: Rect, aspect: number): boolean {
  if (!rectsIntersect(bboxNorm(it, aspect), r)) return false
  if (it.type === 'pen' || it.type === 'highlighter') {
    const pts = it.points
    if (pts.length === 1) return inRect(pts[0], r)
    for (let i = 1; i < pts.length; i++) if (segmentIntersectsRect(pts[i - 1], pts[i], r)) return true
    return false
  }
  return true
}

/* ----------------------------------------------------------------- Eraser */

/**
 * Erase a circle (center normalised, radius local) from an ink stroke.
 * Returns null when the stroke is untouched, otherwise the remaining pieces (possibly none).
 */
export function eraseStroke(stroke: StrokeAnnotation, center: Vec, radius: number, aspect: number, newId: () => string): StrokeAnnotation[] | null {
  const c = toLocal(center, aspect)
  const reach = radius + stroke.width / 2
  const bb = bboxLocal(stroke, aspect)
  if (c.x < bb.x0 - radius || c.x > bb.x1 + radius || c.y < bb.y0 - radius || c.y > bb.y1 + radius) return null
  const src = stroke.points.map((p) => toLocal(p, aspect))
  if (src.length === 1) return dist(src[0], c) <= reach ? [] : null
  // Densify so a segment crossing the circle between two outside points is cut too.
  const step = Math.max(reach / 2, 1e-4)
  const pts: Vec[] = [src[0]]
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1]
    const b = src[i]
    const d = dist(a, b)
    if (d > step && distToSegment(c, a, b) <= reach) {
      const n = Math.ceil(d / step)
      for (let k = 1; k < n; k++) {
        const t = k / n
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p !== undefined && b.p !== undefined ? a.p + (b.p - a.p) * t : a.p })
      }
    }
    pts.push(b)
  }
  const inside = pts.map((p) => dist(p, c) <= reach)
  if (!inside.some(Boolean)) return null
  const pieces: StrokeAnnotation[] = []
  let run: Vec[] = []
  const flush = () => {
    if (run.length >= 2) {
      const simplified = simplify(run, 1e-5)
      pieces.push({ ...stroke, id: newId(), points: simplified.map((p) => roundPoint(fromLocal(p, aspect))) })
    }
    run = []
  }
  pts.forEach((p, i) => {
    if (inside[i]) flush()
    else run.push(p)
  })
  flush()
  return pieces
}

export const roundPoint = (p: Vec): Point => (p.p === undefined ? { x: round(p.x), y: round(p.y) } : { x: round(p.x), y: round(p.y), p: round(p.p, 2) })

/* ------------------------------------------------------------- Transforms */

const mv = (p: Point, dx: number, dy: number): Point => ({ ...p, x: round(p.x + dx), y: round(p.y + dy) })

export function translateItem<T extends Annotation>(it: T, dx: number, dy: number): T {
  switch (it.type) {
    case 'pen':
    case 'highlighter':
      return { ...it, points: it.points.map((p) => mv(p, dx, dy)) }
    case 'text':
    case 'stamp':
      return { ...it, at: mv(it.at, dx, dy) }
    default:
      return { ...it, a: mv((it as { a: Point }).a, dx, dy), b: mv((it as { b: Point }).b, dx, dy) }
  }
}

/** Uniform scale by `s` around origin `o` (normalised). Widths and sizes scale too. */
export function scaleItem<T extends Annotation>(it: T, o: Vec, s: number): T {
  const sc = (p: Point): Point => ({ ...p, x: round(o.x + (p.x - o.x) * s), y: round(o.y + (p.y - o.y) * s) })
  switch (it.type) {
    case 'pen':
    case 'highlighter':
      return { ...it, points: it.points.map(sc), width: it.width * s }
    case 'text':
      return { ...it, at: sc(it.at), size: it.size * s }
    case 'stamp':
      return { ...it, at: sc(it.at), size: it.size * s }
    case 'image':
      return { ...it, a: sc(it.a), b: sc(it.b) }
    default: {
      const sh = it as Extract<Annotation, { a: Point }> & { width: number; height?: number }
      return { ...sh, a: sc(sh.a), b: sc(sh.b), width: sh.width * s, ...(sh.height !== undefined ? { height: sh.height * s } : {}) } as T
    }
  }
}

/** Scale a size-like property (width / font size / stamp size) by a factor. */
export function resizeItem<T extends Annotation>(it: T, factor: number): T {
  switch (it.type) {
    case 'text':
    case 'stamp':
      return { ...it, size: it.size * factor }
    case 'image':
      return it
    default:
      return { ...it, width: (it as { width: number }).width * factor }
  }
}

/** Size of an item in toolbar units (thousandths). */
export function itemSize(it: Annotation): number | undefined {
  switch (it.type) {
    case 'text':
    case 'stamp':
      return it.size * 1000
    case 'image':
      return undefined
    default:
      return it.width * 1000
  }
}
