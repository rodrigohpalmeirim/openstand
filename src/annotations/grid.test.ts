import { describe, expect, it } from 'vitest'
import type { Annotation } from '../db/schema'
import { gridPath, itemAnchor, snapDelta, snapPoint, snapScale, snapValue } from './grid'

const base = { id: 'x', layer: 'l', color: '#000', opacity: 1, createdAt: 0 }

describe('snapping', () => {
  it('snaps values to the nearest multiple', () => {
    expect(snapValue(0.031, 0.02)).toBeCloseTo(0.04)
    expect(snapValue(0.029, 0.02)).toBeCloseTo(0.02)
    expect(snapValue(0.5, 0)).toBe(0.5)
  })

  it('uses square cells in page space (y scaled by the aspect)', () => {
    // Page 1.5x as tall as wide: a 0.1-wide cell is 0.1/1.5 of the height.
    const p = snapPoint({ x: 0.26, y: 0.21 }, 0.1, 1.5)
    expect(p.x).toBeCloseTo(0.3)
    expect(p.y * 1.5).toBeCloseTo(0.3)
  })

  it('keeps extra point fields', () => {
    expect(snapPoint({ x: 0.11, y: 0.11, p: 0.7 }, 0.1, 1).p).toBe(0.7)
  })

  it('adjusts a move so the anchor lands on the grid', () => {
    const d = snapDelta({ x: 0.13, y: 0.27 }, 0.05, 0.04, 0.1, 1)
    expect(0.13 + d.dx).toBeCloseTo(0.2)
    expect(0.27 + d.dy).toBeCloseTo(0.3)
    expect(snapDelta({ x: 0.13, y: 0.27 }, 0.05, 0.04, 0, 1)).toEqual({ dx: 0.05, dy: 0.04 })
  })

  it('anchors boxes at their top-left, lines at their start, stamps at their centre', () => {
    const rect = { ...base, type: 'rect', width: 0.002, a: { x: 0.5, y: 0.6 }, b: { x: 0.2, y: 0.3 } } as Annotation
    expect(itemAnchor(rect, 1.3)).toEqual({ x: 0.2, y: 0.3 })
    const line = { ...base, type: 'line', width: 0.002, a: { x: 0.5, y: 0.6 }, b: { x: 0.2, y: 0.3 } } as Annotation
    expect(itemAnchor(line, 1.3)).toEqual({ x: 0.5, y: 0.6 })
    const stamp = { ...base, type: 'stamp', stamp: 'fermata', size: 0.03, at: { x: 0.4, y: 0.4 } } as Annotation
    expect(itemAnchor(stamp, 1.3)).toEqual({ x: 0.4, y: 0.4 })
  })

  it('snaps a resize so the dragged corner lands on a grid line', () => {
    // Box from 0.1 to 0.33 wide, dragged to scale 1.1 → corner at 0.353 → snaps to 0.4.
    const s = snapScale({ x: 0.1, y: 0.1 }, { x: 0.33, y: 0.2 }, 1.1, 0.1, 1)
    expect(0.1 + (0.33 - 0.1) * s).toBeCloseTo(0.4)
    // Never collapses below one cell.
    const tiny = snapScale({ x: 0.1, y: 0.1 }, { x: 0.33, y: 0.2 }, 0.01, 0.1, 1)
    expect(0.1 + 0.23 * tiny).toBeCloseTo(0.2)
    expect(snapScale({ x: 0, y: 0 }, { x: 1, y: 1 }, 1.234, 0, 1)).toBe(1.234)
  })

  it('draws grid lines every cell', () => {
    const d = gridPath(0.25, 1000, 1500)
    expect(d.match(/V/g)).toHaveLength(3)
    expect(d.match(/H/g)).toHaveLength(5)
    expect(gridPath(0, 1000, 1000)).toBe('')
  })
})
