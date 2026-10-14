import { describe, expect, it } from 'vitest'
import { bboxLocal } from './geometry'
import { itemNodes } from './render'
import { clampMeasures, STAFF_SPACES, staffLayout, staffPaths } from './staff'

describe('piano staff layout', () => {
  const box = { x0: 100, y0: 200, x1: 900, y1: 200 + 10 * STAFF_SPACES }
  const L = staffLayout(box, 4)

  it('derives the staff space from the height', () => {
    expect(L.s).toBeCloseTo(10)
  })

  it('has two five-line staves inside the box, treble above bass', () => {
    expect(L.treble).toHaveLength(5)
    expect(L.bass).toHaveLength(5)
    for (let i = 1; i < 5; i++) {
      expect(L.treble[i] - L.treble[i - 1]).toBeCloseTo(10)
      expect(L.bass[i] - L.bass[i - 1]).toBeCloseTo(10)
    }
    expect(L.treble[0]).toBeGreaterThan(box.y0)
    expect(L.bass[4]).toBeLessThan(box.y1)
    expect(L.bass[0]).toBeGreaterThan(L.treble[4])
  })

  it('splits the system into equal measures after the clefs', () => {
    expect(L.measures).toBe(4)
    expect(L.bars).toHaveLength(3)
    expect(L.clefX).not.toBeNull()
    const widths = [L.bars[1] - L.bars[0], L.bars[2] - L.bars[1], L.x1 - L.bars[2]]
    widths.forEach((w) => expect(w).toBeCloseTo(widths[0]))
    expect(L.bars[0] - L.xs).toBeGreaterThan(widths[0]) // first measure also holds the clefs
  })

  it('puts the brace left of the system line and the final barline at the right edge', () => {
    expect(L.brace.x0).toBe(100)
    expect(L.brace.x1).toBeLessThan(L.xs)
    expect(L.brace.y0).toBe(L.treble[0])
    expect(L.brace.y1).toBe(L.bass[4])
    expect(L.x1).toBe(900)
    expect(L.thin).toBeLessThan(L.thick0)
    expect(L.thick0).toBeLessThan(900)
  })

  it('normalises reversed corners and clamps the measure count', () => {
    const R = staffLayout({ x0: box.x1, y0: box.y1, x1: box.x0, y1: box.y0 }, 4)
    expect(R.treble).toEqual(L.treble)
    expect(clampMeasures(0)).toBe(1)
    expect(clampMeasures(99)).toBe(12)
    expect(clampMeasures(undefined)).toBe(4)
  })

  it('drops the clefs when the system is too short for them', () => {
    const S = staffLayout({ x0: 0, y0: 0, x1: 80, y1: 10 * STAFF_SPACES }, 4)
    expect(S.clefX).toBeNull()
    expect(staffPaths({ x0: 0, y0: 0, x1: 80, y1: 10 * STAFF_SPACES }, 4, 1).clef).toBe('')
  })

  it('renders as vector paths and has the rectangle as its box', () => {
    const it0 = { id: 's', layer: 'l', color: '#123456', opacity: 0.5, createdAt: 0, type: 'staff' as const, width: 0.001, a: { x: 0.1, y: 0.1 }, b: { x: 0.9, y: 0.25 }, measures: 3 }
    const nodes = itemNodes(it0, 1000, 1300)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].attrs.opacity).toBe(0.5)
    const kids = nodes[0].children!
    expect(kids.every((k) => k.tag === 'path')).toBe(true)
    expect(kids.some((k) => k.attrs.fill === '#123456')).toBe(true)
    const p = staffPaths({ x0: 100, y0: 130, x1: 900, y1: 325 }, 3, 1)
    expect(p.lines.match(/M/g)).toHaveLength(10)
    expect(p.bars.match(/M/g)).toHaveLength(4) // start, 2 inner, thin final
    const bb = bboxLocal(it0, 1.3)
    expect(bb.x0).toBeCloseTo(0.1 - 0.0005)
    expect(bb.y1).toBeCloseTo(0.25 * 1.3 + 0.0005)
  })
})
