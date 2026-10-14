/**
 * Snap-to-grid math. The grid is square in page space: its cell is a fraction of the page width, so it
 * scales with zoom and stays aligned with the page on every device. Points are normalised (0..1 on both
 * axes); `aspect` = page height / width converts y to the same units as x.
 */
import type { Annotation } from '../db/schema'
import { bboxNorm, round, type Vec } from './geometry'

export const GRID_RANGE: [min: number, max: number, step: number] = [5, 80, 1]

export const snapValue = (v: number, cell: number) => (cell > 0 ? Math.round(v / cell) * cell : v)

/** Nearest grid intersection to a normalised point. */
export function snapPoint<T extends Vec>(p: T, cell: number, aspect: number): T {
  if (!(cell > 0)) return p
  return { ...p, x: round(snapValue(p.x, cell)), y: round(snapValue(p.y * aspect, cell) / aspect) }
}

/**
 * The point of an item that lands on the grid when it is moved: the start point of lines and
 * hairpins, the top-left corner of boxes, text and pictures, the centre of stamps, the top-left of
 * the bounding box of ink.
 */
export function itemAnchor(it: Annotation, aspect: number): Vec {
  switch (it.type) {
    case 'line':
    case 'arrow':
    case 'crescendo':
    case 'decrescendo':
      return it.a
    case 'rect':
    case 'ellipse':
    case 'staff':
    case 'image':
      return { x: Math.min(it.a.x, it.b.x), y: Math.min(it.a.y, it.b.y) }
    case 'text':
    case 'stamp':
      return it.at
    default: {
      const b = bboxNorm(it, aspect)
      return { x: b.x0, y: b.y0 }
    }
  }
}

/** Adjust a move delta so that `anchor + delta` sits on the grid. */
export function snapDelta(anchor: Vec, dx: number, dy: number, cell: number, aspect: number): { dx: number; dy: number } {
  if (!(cell > 0)) return { dx, dy }
  const t = snapPoint({ x: anchor.x + dx, y: anchor.y + dy }, cell, aspect)
  return { dx: t.x - anchor.x, dy: t.y - anchor.y }
}

/**
 * Snap a uniform scale around `anchor` so the dragged `corner` lands on a grid line along the axis
 * where the selection is larger. Never returns less than one cell of extent.
 */
export function snapScale(anchor: Vec, corner: Vec, scale: number, cell: number, aspect: number): number {
  if (!(cell > 0)) return scale
  const ex = corner.x - anchor.x
  const ey = (corner.y - anchor.y) * aspect
  const useX = Math.abs(ex) >= Math.abs(ey)
  const extent = useX ? ex : ey
  const origin = useX ? anchor.x : anchor.y * aspect
  if (Math.abs(extent) < 1e-9) return scale
  const target = origin + extent * scale
  let snapped = snapValue(target, cell)
  if (Math.abs(snapped - origin) < cell) snapped = origin + Math.sign(extent) * cell
  return (snapped - origin) / extent
}

/** Grid lines as one SVG path in a W-wide viewBox (height H); cells are `cell * W` square. */
export function gridPath(cell: number, W: number, H: number): string {
  if (!(cell > 0)) return ''
  const step = cell * W
  let d = ''
  for (let x = step; x < W - 0.01; x += step) d += `M${x.toFixed(2)} 0V${H.toFixed(2)}`
  for (let y = step; y < H - 0.01; y += step) d += `M0 ${y.toFixed(2)}H${W}`
  return d
}
