/**
 * Where the quick pen palette floats. The position is stored as fractions of the palette's free travel
 * across and down the screen (0 = flush left/top, 1 = flush right/bottom), so it stays on screen and in
 * the same relative place at any window size or orientation.
 */

export interface PalettePos {
  x: number
  y: number
}

export interface Area {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Px {
  left: number
  top: number
}

/** Top centre. */
export const DEFAULT_PALETTE_POS: PalettePos = { x: 0.5, y: 0 }

const unit = (n: number, fallback: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback)

/** Keep a palette of `size` inside `area`; one larger than the area sticks to its left/top edge. */
export function clampPalette(p: Px, area: Area, size: Size): Px {
  return {
    left: Math.round(Math.min(Math.max(p.left, area.left), area.left + Math.max(0, area.width - size.width))),
    top: Math.round(Math.min(Math.max(p.top, area.top), area.top + Math.max(0, area.height - size.height))),
  }
}

/**
 * Pixel position for a stored position. `full` is the area the fractions refer to; `safe` (inside it) is
 * what is free right now, e.g. without the viewer's bars: the palette only moves when it would overlap them.
 */
export function placePalette(pos: PalettePos, full: Area, size: Size, safe: Area = full): Px {
  const p = {
    left: full.left + unit(pos.x, DEFAULT_PALETTE_POS.x) * Math.max(0, full.width - size.width),
    top: full.top + unit(pos.y, DEFAULT_PALETTE_POS.y) * Math.max(0, full.height - size.height),
  }
  return clampPalette(p, safe, size)
}

/** The stored form of a pixel position. An axis without free travel keeps its previous value. */
export function normalisePalette(p: Px, full: Area, size: Size, prev: PalettePos = DEFAULT_PALETTE_POS): PalettePos {
  const fx = full.width - size.width
  const fy = full.height - size.height
  const r = (n: number) => Math.round(n * 10000) / 10000
  return {
    x: fx > 0 ? r(unit((p.left - full.left) / fx, prev.x)) : prev.x,
    y: fy > 0 ? r(unit((p.top - full.top) / fy, prev.y)) : prev.y,
  }
}
