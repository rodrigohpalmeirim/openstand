import { describe, expect, it } from 'vitest'
import { clampPalette, DEFAULT_PALETTE_POS, normalisePalette, placePalette, type Area } from './palettePos'

const size = { width: 300, height: 52 }
const tablet: Area = { left: 8, top: 8, width: 1008, height: 752 }
const phone: Area = { left: 8, top: 8, width: 344, height: 724 }

describe('placePalette', () => {
  it('puts the default at the top centre', () => {
    expect(placePalette(DEFAULT_PALETTE_POS, tablet, size)).toEqual({ left: 8 + (1008 - 300) / 2, top: 8 })
  })

  it('keeps the same relative place at another screen size', () => {
    const right = { x: 1, y: 1 }
    expect(placePalette(right, tablet, size)).toEqual({ left: 8 + 1008 - 300, top: 8 + 752 - 52 })
    expect(placePalette(right, phone, size)).toEqual({ left: 8 + 344 - 300, top: 8 + 724 - 52 })
  })

  it('moves out of the way of the bars only when it would overlap them', () => {
    const safe: Area = { ...tablet, top: 64, height: 640 }
    expect(placePalette({ x: 0.5, y: 0 }, tablet, size, safe).top).toBe(64)
    expect(placePalette({ x: 0.5, y: 1 }, tablet, size, safe).top).toBe(64 + 640 - 52)
    expect(placePalette({ x: 0.5, y: 0.5 }, tablet, size, safe).top).toBe(placePalette({ x: 0.5, y: 0.5 }, tablet, size).top)
  })

  it('tolerates out-of-range and broken values', () => {
    expect(placePalette({ x: 7, y: -3 }, tablet, size)).toEqual({ left: 8 + 1008 - 300, top: 8 })
    expect(placePalette({ x: NaN, y: NaN }, tablet, size)).toEqual(placePalette(DEFAULT_PALETTE_POS, tablet, size))
  })

  it('sticks to the left edge when wider than the area', () => {
    expect(placePalette({ x: 1, y: 0 }, { left: 8, top: 8, width: 200, height: 400 }, size).left).toBe(8)
  })
})

describe('clampPalette', () => {
  it('keeps every edge inside the area', () => {
    expect(clampPalette({ left: -50, top: -50 }, phone, size)).toEqual({ left: 8, top: 8 })
    expect(clampPalette({ left: 5000, top: 5000 }, phone, size)).toEqual({ left: 8 + 344 - 300, top: 8 + 724 - 52 })
    expect(clampPalette({ left: 20, top: 100 }, phone, size)).toEqual({ left: 20, top: 100 })
  })
})

describe('normalisePalette', () => {
  it('round-trips with placePalette', () => {
    for (const p of [
      { left: 8, top: 8 },
      { left: 400, top: 300 },
      { left: 716, top: 708 },
    ]) {
      expect(placePalette(normalisePalette(p, tablet, size), tablet, size)).toEqual(p)
    }
  })

  it('stays within 0..1', () => {
    expect(normalisePalette({ left: -100, top: 9999 }, tablet, size)).toEqual({ x: 0, y: 1 })
  })

  it('keeps the previous value on an axis without free travel', () => {
    const narrow: Area = { left: 8, top: 8, width: 300, height: 724 }
    expect(normalisePalette({ left: 8, top: 8 + (724 - 52) / 2 }, narrow, size, { x: 0.8, y: 0 })).toEqual({ x: 0.8, y: 0.5 })
  })
})
