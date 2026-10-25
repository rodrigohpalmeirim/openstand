import { describe, expect, it } from 'vitest'
import type { Annotation, ShapeAnnotation, StampAnnotation, StrokeAnnotation, TextAnnotation } from '../db/schema'
import {
  bboxNorm,
  distToSegment,
  eraseStroke,
  fromLocal,
  HAIRPIN_HEIGHT,
  hitTest,
  hitTopmost,
  itemIntersectsRect,
  lassoSelect,
  pointInPolygon,
  pressureWidth,
  rotateItem,
  scaleItem,
  simplify,
  smoothPath,
  streamline,
  strokeOutline,
  textBoxLocal,
  toLocal,
  translateItem,
} from './geometry'

const base = { layer: 'default', color: '#000', opacity: 1, createdAt: 0 }
const stroke = (points: { x: number; y: number; p?: number }[], width = 0.004, id = 's'): StrokeAnnotation => ({ ...base, id, type: 'pen', width, points })
let n = 0
const newId = () => `n${++n}`

describe('normalisation', () => {
  it('round-trips between normalised and local units', () => {
    const p = { x: 0.3, y: 0.5 }
    const l = toLocal(p, 1.4)
    expect(l).toMatchObject({ x: 0.3, y: 0.7 })
    expect(fromLocal(l, 1.4).y).toBeCloseTo(0.5)
  })

  it('measures distances uniformly regardless of page aspect', () => {
    // A horizontal and a vertical stroke 0.1 page-width long must have the same local length.
    const aspect = 1.5
    const a = toLocal({ x: 0, y: 0 }, aspect)
    const b = toLocal({ x: 0.1, y: 0 }, aspect)
    const c = toLocal({ x: 0, y: 0.1 / aspect }, aspect)
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(Math.hypot(c.x - a.x, c.y - a.y))
  })
})

describe('smoothing & simplification', () => {
  it('keeps endpoints and drops collinear points', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: 0.5 }))
    const s = simplify(pts, 0.001)
    expect(s).toHaveLength(2)
    expect(s[0]).toBe(pts[0])
    expect(s[1]).toBe(pts[49])
  })

  it('keeps corners above tolerance', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.001 },
      { x: 1, y: 0 },
      { x: 1, y: 0.5 },
      { x: 1.001, y: 1 },
    ]
    const s = simplify(pts, 0.01)
    expect(s.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [1, 0],
      [1.001, 1],
    ])
  })

  it('zero tolerance returns a copy', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]
    expect(simplify(pts, 0)).toEqual(pts)
  })

  it('streamline moves toward the raw point', () => {
    const p = streamline({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.4)
    expect(p.x).toBeCloseTo(6)
    expect(streamline({ x: 0, y: 0 }, { x: 10, y: 0 }, 0).x).toBe(10)
  })

  it('builds quadratic midpoint paths', () => {
    expect(smoothPath([{ x: 1, y: 1 }])).toMatch(/^M1 1l/)
    expect(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M0 0L10 0')
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }])
    expect(d).toBe('M0 0Q10 10 15 5Q20 0 25 5L30 10')
  })

  it('pressure varies width by ±60 %', () => {
    expect(pressureWidth(10, 0.5)).toBeCloseTo(10)
    expect(pressureWidth(10, 0)).toBeCloseTo(4)
    expect(pressureWidth(10, 1)).toBeCloseTo(16)
  })

  it('outlines variable-width strokes as a closed path', () => {
    const d = strokeOutline([
      { x: 0, y: 0, w: 2 },
      { x: 10, y: 0, w: 4 },
      { x: 20, y: 0, w: 2 },
    ])
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    // The outline reaches the width at the middle point on both sides.
    expect(d).toContain('10 2')
    expect(d).toContain('10 -2')
    // A dot becomes a circle.
    expect(strokeOutline([{ x: 5, y: 5, w: 4 }])).toContain('a2 2 0 1 0 4 0')
  })
})

describe('hit testing', () => {
  it('distance to segment', () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3)
    expect(distToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5)
  })

  it('hits ink near the line, including its width', () => {
    const s = stroke([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], 0.01)
    expect(hitTest(s, { x: 0.5, y: 0.5 }, 0, 1)).toBe(true)
    expect(hitTest(s, { x: 0.5, y: 0.504 }, 0, 1)).toBe(true) // within half width
    expect(hitTest(s, { x: 0.5, y: 0.52 }, 0.005, 1)).toBe(false)
    expect(hitTest(s, { x: 0.5, y: 0.52 }, 0.02, 1)).toBe(true)
  })

  it('respects page aspect in tolerance', () => {
    const s = stroke([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], 0.002)
    // 0.01 normalised y on a page 2x taller than wide = 0.02 local units.
    expect(hitTest(s, { x: 0.5, y: 0.51 }, 0.015, 2)).toBe(false)
    expect(hitTest(s, { x: 0.5, y: 0.51 }, 0.025, 2)).toBe(true)
  })

  it('outlined rect hits only near its border unless filled', () => {
    const r: ShapeAnnotation = { ...base, id: 'r', type: 'rect', width: 0.004, a: { x: 0.2, y: 0.2 }, b: { x: 0.6, y: 0.6 } }
    expect(hitTest(r, { x: 0.4, y: 0.4 }, 0.005, 1)).toBe(false)
    expect(hitTest(r, { x: 0.2, y: 0.4 }, 0.005, 1)).toBe(true)
    expect(hitTest({ ...r, fill: true }, { x: 0.4, y: 0.4 }, 0.005, 1)).toBe(true)
  })

  it('ellipse border hit', () => {
    const e: ShapeAnnotation = { ...base, id: 'e', type: 'ellipse', width: 0.004, a: { x: 0.2, y: 0.2 }, b: { x: 0.6, y: 0.4 } }
    expect(hitTest(e, { x: 0.6, y: 0.3 }, 0.005, 1)).toBe(true)
    expect(hitTest(e, { x: 0.4, y: 0.3 }, 0.005, 1)).toBe(false)
  })

  it('text and stamps hit inside their box', () => {
    const t: TextAnnotation = { ...base, id: 't', type: 'text', at: { x: 0.1, y: 0.1 }, text: 'Hello', size: 0.03 }
    const bb = bboxNorm(t, 1.3)
    expect(bb.x1).toBeGreaterThan(0.1)
    expect(hitTest(t, { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 }, 0, 1.3)).toBe(true)
    expect(hitTest(t, { x: 0.9, y: 0.9 }, 0, 1.3)).toBe(false)
    const s: StampAnnotation = { ...base, id: 'st', type: 'stamp', at: { x: 0.5, y: 0.5 }, stamp: 'fermata', size: 0.04 }
    expect(hitTest(s, { x: 0.5, y: 0.5 }, 0, 1.3)).toBe(true)
    expect(hitTest(s, { x: 0.5, y: 0.6 }, 0, 1.3)).toBe(false)
  })

  it('finds the topmost item', () => {
    const a = stroke([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], 0.01, 'a')
    const b = stroke([{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }], 0.01, 'b')
    expect(hitTopmost([a, b], { x: 0.5, y: 0.5 }, 0.001, 1)?.id).toBe('b')
    expect(hitTopmost([a, b], { x: 0.2, y: 0.5 }, 0.001, 1)?.id).toBe('a')
    expect(hitTopmost([a, b], { x: 0.2, y: 0.2 }, 0.001, 1)).toBeUndefined()
  })

  it('lasso selects items mostly inside', () => {
    const inside = stroke([{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }], 0.004, 'in')
    const across = stroke([{ x: 0.3, y: 0.3 }, { x: 0.9, y: 0.9 }], 0.004, 'across')
    const poly = [
      { x: 0.2, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.2, y: 0.5 },
    ]
    expect(pointInPolygon({ x: 0.3, y: 0.3 }, poly)).toBe(true)
    expect(pointInPolygon({ x: 0.6, y: 0.3 }, poly)).toBe(false)
    expect(lassoSelect([inside, across], poly, 1).map((i) => i.id)).toEqual(['in'])
  })

  it('box intersection uses the stroke path, not just its bbox', () => {
    const diag = stroke([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.001)
    expect(itemIntersectsRect(diag, { x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 }, 1)).toBe(true)
    // Inside the bbox but away from the diagonal.
    expect(itemIntersectsRect(diag, { x0: 0.7, y0: 0.1, x1: 0.8, y1: 0.2 }, 1)).toBe(false)
  })
})

describe('eraser', () => {
  it('leaves untouched strokes alone', () => {
    const s = stroke([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }])
    expect(eraseStroke(s, { x: 0.8, y: 0.8 }, 0.01, 1, newId)).toBeNull()
  })

  it('splits a stroke erased in the middle — even across a long segment', () => {
    const s = stroke([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], 0.002)
    const pieces = eraseStroke(s, { x: 0.5, y: 0.5 }, 0.02, 1, newId)!
    expect(pieces).toHaveLength(2)
    const [l, r] = pieces
    expect(l.points[0].x).toBeCloseTo(0.1)
    expect(Math.max(...l.points.map((p) => p.x))).toBeLessThan(0.48)
    expect(Math.min(...r.points.map((p) => p.x))).toBeGreaterThan(0.52)
    expect(r.points[r.points.length - 1].x).toBeCloseTo(0.9)
    // Densified collinear points are simplified away again.
    expect(l.points.length).toBeLessThanOrEqual(3)
    expect(l.id).not.toBe(s.id)
    expect(l.color).toBe(s.color)
  })

  it('trims an end and removes a fully covered stroke', () => {
    const s = stroke([{ x: 0.1, y: 0.5 }, { x: 0.3, y: 0.5 }], 0.002)
    const trimmed = eraseStroke(s, { x: 0.3, y: 0.5 }, 0.05, 1, newId)!
    expect(trimmed).toHaveLength(1)
    expect(Math.max(...trimmed[0].points.map((p) => p.x))).toBeLessThan(0.26)
    expect(eraseStroke(s, { x: 0.2, y: 0.5 }, 0.2, 1, newId)).toEqual([])
  })

  it('interpolates pressure on split points', () => {
    const s = stroke([{ x: 0.1, y: 0.5, p: 0.2 }, { x: 0.9, y: 0.5, p: 1 }], 0.002)
    const [l] = eraseStroke(s, { x: 0.5, y: 0.5 }, 0.02, 1, newId)!
    const last = l.points[l.points.length - 1]
    expect(last.p).toBeGreaterThan(0.2)
    expect(last.p).toBeLessThan(0.6)
  })

  it('erases dots', () => {
    const dot = stroke([{ x: 0.5, y: 0.5 }])
    expect(eraseStroke(dot, { x: 0.505, y: 0.5 }, 0.01, 1, newId)).toEqual([])
  })
})

describe('transforms', () => {
  it('translates every kind of item', () => {
    const items: Annotation[] = [
      stroke([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]),
      { ...base, id: 'l', type: 'line', width: 0.002, a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } },
      { ...base, id: 't', type: 'text', at: { x: 0.1, y: 0.1 }, text: 'x', size: 0.02 },
    ]
    const moved = items.map((i) => translateItem(i, 0.1, -0.05))
    expect((moved[0] as StrokeAnnotation).points[0]).toEqual({ x: 0.2, y: 0.05 })
    expect((moved[1] as ShapeAnnotation).b).toEqual({ x: 0.3, y: 0.15 })
    expect((moved[2] as TextAnnotation).at).toEqual({ x: 0.2, y: 0.05 })
    expect(items[0]).not.toBe(moved[0])
  })

  it('scales around an origin, including widths and sizes', () => {
    const s = scaleItem(stroke([{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }], 0.004), { x: 0.2, y: 0.2 }, 2)
    expect(s.points[1]).toEqual({ x: 0.6, y: 0.6 })
    expect(s.width).toBeCloseTo(0.008)
    const t = scaleItem({ ...base, id: 't', type: 'text', at: { x: 0.5, y: 0.5 }, text: 'x', size: 0.02 } as TextAnnotation, { x: 0, y: 0 }, 0.5)
    expect(t.at).toEqual({ x: 0.25, y: 0.25 })
    expect(t.size).toBeCloseTo(0.01)
  })
})

describe('simplify with pressure', () => {
  // A straight stroke whose pressure swells in the middle.
  const pts = Array.from({ length: 21 }, (_, i) => ({ x: i / 20, y: 0.5, p: 0.2 + 0.6 * Math.sin((Math.PI * i) / 20) }))

  it('drops straight-line points when pressure is ignored', () => {
    expect(simplify(pts, 0.001)).toHaveLength(2)
  })

  it('keeps the points where the pressure changes', () => {
    const s = simplify(pts, 0.001, 0.06)
    expect(s.length).toBeGreaterThan(4)
    // Pressure interpolated between kept points stays within the tolerance.
    for (let i = 0; i < pts.length; i++) {
      const j = s.findIndex((q) => q.x >= pts[i].x)
      if (s[j].x === pts[i].x) continue
      const a = s[j - 1]
      const b = s[j]
      const t = (pts[i].x - a.x) / (b.x - a.x)
      expect(Math.abs(a.p! + (b.p! - a.p!) * t - pts[i].p)).toBeLessThanOrEqual(0.06 + 1e-9)
    }
  })

  it('leaves strokes without pressure alone', () => {
    const flat = pts.map(({ x, y }) => ({ x, y }))
    expect(simplify(flat, 0.001, 0.06)).toHaveLength(2)
  })
})

describe('rotateItem', () => {
  // A 600 x 800 portrait page: aspect 4/3.
  const A = 4 / 3
  // Pixel comparisons; coordinates are stored rounded to 5 decimals.
  const close = (a: number, b: number, digits = 2) => expect(a).toBeCloseTo(b, digits)

  it('keeps a hairpin’s default opening in pixels by giving it an explicit height', () => {
    const h: ShapeAnnotation = { id: 'h', type: 'crescendo', layer: 'default', color: '#000', opacity: 1, createdAt: 0, width: 0.003, a: { x: 0.1, y: 0.5 }, b: { x: 0.4, y: 0.5 } }
    const r = rotateItem(h, 1, A) as ShapeAnnotation
    // 0.018 × 600 px = 10.8 px on the 800 px wide turned page.
    close((r.height ?? 0) * 800, HAIRPIN_HEIGHT * 600)
    expect(rotateItem({ ...h, type: 'line' }, 1, A)).not.toHaveProperty('height')
  })

  it('turns ink clockwise and keeps its pixel width', () => {
    const s = stroke([{ x: 0.1, y: 0.2, p: 0.5 }, { x: 0.4, y: 0.3, p: 0.7 }], 0.006)
    const r = rotateItem(s, 1, A)
    expect(r.points[0]).toEqual({ x: 0.8, y: 0.1, p: 0.5 })
    expect(r.points[1]).toEqual({ x: 0.7, y: 0.4, p: 0.7 })
    // 0.006 × 600 px = 3.6 px; the turned page is 800 px wide.
    close(r.width * 800, 3.6)
    const back = rotateItem(r, -1, 1 / A)
    expect(back.points).toEqual(s.points)
    close(back.width, s.width, 8)
  })

  it('maps a pixel point the way the page bitmap turns', () => {
    // Pixel (60, 160) on the 600 x 800 page → (800 − 160, 60) on the 800 x 600 page.
    const s = stroke([{ x: 60 / 600, y: 160 / 800 }])
    const r = rotateItem(s, 1, A)
    close(r.points[0].x * 800, 640)
    close(r.points[0].y * 600, 60)
    const half = rotateItem(s, 2, A)
    close(half.points[0].x * 600, 540)
    close(half.points[0].y * 800, 640)
  })

  it('returns every kind of item to where it was after a full turn', () => {
    const items: Annotation[] = [
      stroke([{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.6 }]),
      { ...base, id: 'l', type: 'crescendo', width: 0.003, a: { x: 0.2, y: 0.3 }, b: { x: 0.6, y: 0.35 }, height: 0.02 },
      { ...base, id: 't', type: 'text', at: { x: 0.2, y: 0.7 }, text: 'rit.', size: 0.025 },
      { ...base, id: 'st', type: 'stamp', at: { x: 0.5, y: 0.5 }, stamp: 'fermata', size: 0.04 },
      { ...base, id: 'i', type: 'image', a: { x: 0.1, y: 0.1 }, b: { x: 0.4, y: 0.2 }, src: 'data:,' },
      { ...base, id: 'p', type: 'staff', width: 0.0012, a: { x: 0.1, y: 0.4 }, b: { x: 0.9, y: 0.55 }, measures: 4 },
    ]
    for (const it of items) {
      let r: Annotation = it
      let a = A
      for (let k = 0; k < 4; k++) {
        r = rotateItem(r, 1, a)
        a = 1 / a
      }
      expect(JSON.parse(JSON.stringify(r), (_, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v))).toEqual(
        JSON.parse(JSON.stringify(it), (_, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)),
      )
      expect(rotateItem(it, 4, A)).toBe(it)
    }
  })

  it('keeps text upright and centred, at the same font size in pixels', () => {
    const t: TextAnnotation = { ...base, id: 't', type: 'text', at: { x: 0.2, y: 0.7 }, text: 'cresc.', size: 0.025 }
    const r = rotateItem(t, 1, A)
    // Font px: 0.025 × 800 before, size × 600 after.
    close(r.size * 600, 20)
    const b0 = textBoxLocal(t, A)
    const b1 = textBoxLocal(r, 1 / A)
    close(b1.w * 800, b0.w * 600)
    // The centre moves like a point: (cx, cy) → (1 − cy, cx).
    const c0 = { x: t.at.x + b0.w / 2, y: t.at.y + b0.h / A / 2 }
    close(r.at.x + b1.w / 2, 1 - c0.y)
    close(r.at.y + (b1.h * A) / 2, c0.x)
  })

  it('swaps a picture box but keeps its pixel size', () => {
    const img: Annotation = { ...base, id: 'i', type: 'image', a: { x: 0.1, y: 0.1 }, b: { x: 0.4, y: 0.2 }, src: 'data:,' }
    const r = rotateItem(img, 1, A) as Extract<Annotation, { type: 'image' }>
    // 180 x 80 px stays 180 x 80 px on the 800 x 600 page.
    close((r.b.x - r.a.x) * 800, 180)
    close((r.b.y - r.a.y) * 600, 80)
  })
})
