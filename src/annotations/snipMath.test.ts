import { describe, expect, it } from 'vitest'
import { rotatedToSource, snipPageWidth, snipPixels } from './snipMath'

const r = { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.3 }

describe('snip region mapping', () => {
  it('is the identity without rotation', () => {
    expect(rotatedToSource(r, 0)).toEqual(r)
  })

  it('maps a region of a 180° page to the opposite corner', () => {
    const s = rotatedToSource(r, 180)
    expect(s.x0).toBeCloseTo(0.6)
    expect(s.x1).toBeCloseTo(0.9)
    expect(s.y0).toBeCloseTo(0.7)
    expect(s.y1).toBeCloseTo(0.8)
  })

  it('maps through 90° and 270° clockwise rotations', () => {
    // Displayed top-right corner of a 90° page is the source's top-left.
    const tl = rotatedToSource({ x0: 0.9, y0: 0, x1: 1, y1: 0.1 }, 90)
    expect(tl.x0).toBeCloseTo(0)
    expect(tl.y0).toBeCloseTo(0)
    expect(tl.x1).toBeCloseTo(0.1)
    expect(tl.y1).toBeCloseTo(0.1)
    // Displayed bottom-left of a 270° page is the source's top-left.
    const bl = rotatedToSource({ x0: 0, y0: 0.9, x1: 0.1, y1: 1 }, 270)
    expect(bl.x0).toBeCloseTo(0)
    expect(bl.y0).toBeCloseTo(0)
    expect(rotatedToSource(r, -90)).toEqual(rotatedToSource(r, 270))
  })

  it('computes the source pixel box of the region', () => {
    const px = snipPixels(r, 1.5, 2000, 10000)
    expect(px.pageW).toBe(2000)
    expect(px.x).toBe(200)
    expect(px.y).toBe(600) // 0.2 * 2000 * 1.5
    expect(px.w).toBe(600)
    expect(px.h).toBe(300) // 0.1 * 1.5 * 2000
  })

  it('scales big regions down to the size cap, keeping proportions', () => {
    const px = snipPixels({ x0: 0, y0: 0, x1: 1, y1: 0.5 }, 1.4, 4000, 2000)
    expect(px.w).toBe(2000)
    expect(px.h).toBe(1400)
    expect(px.pageW).toBe(2000)
  })

  it('renders from well above screen resolution', () => {
    expect(snipPageWidth(500, 1)).toBe(1800)
    expect(snipPageWidth(1000, 2)).toBe(5000)
    expect(snipPageWidth(3000, 3)).toBe(6000)
  })
})
