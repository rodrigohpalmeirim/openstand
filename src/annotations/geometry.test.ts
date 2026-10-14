import { describe, expect, it } from 'vitest'
import type { Annotation, ShapeAnnotation, StampAnnotation, StrokeAnnotation, TextAnnotation } from '../db/schema'
import {
  bboxNorm,
  distToSegment,
  eraseStroke,
  fromLocal,
  hitTest,
  hitTopmost,
  itemIntersectsRect,
  lassoSelect,
  pointInPolygon,
  pressureWidth,
  scaleItem,
  simplify,
  smoothPath,
  streamline,
  strokeOutline,
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
