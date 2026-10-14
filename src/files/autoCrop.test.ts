import { describe, expect, it } from 'vitest'
import { clampCrop, detectCrop, rotateCrop, type Pixels } from './autoCrop'

function page(w: number, h: number, bg = 255): Pixels & { fill: (x0: number, y0: number, x1: number, y1: number, v?: number) => void } {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set([bg, bg, bg, 255], i * 4)
  return {
    data,
    width: w,
    height: h,
    fill(x0, y0, x1, y1, v = 0) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([v, v, v, 255], (y * w + x) * 4)
    },
  }
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.002)

describe('detectCrop', () => {
  it('finds uniform white margins', () => {
    const p = page(100, 200)
    p.fill(10, 20, 90, 170)
    const c = detectCrop(p, { padding: 0 })
    near(c.top, 0.1)
    near(c.bottom, 0.15)
    near(c.left, 0.1)
    near(c.right, 0.1)
  })
  it('applies padding and never goes negative', () => {
    const p = page(100, 100)
    p.fill(0, 0, 100, 50)
    const c = detectCrop(p, { padding: 0.02 })
    expect(c.top).toBe(0)
    near(c.bottom, 0.48)
  })
  it('returns no crop for an empty page', () => {
    expect(detectCrop(page(50, 50))).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  })
  it('works on a tinted background', () => {
    const p = page(100, 100, 225)
    p.fill(30, 30, 70, 70, 40)
    const c = detectCrop(p, { padding: 0 })
    near(c.top, 0.3)
    near(c.left, 0.3)
  })
  it('treats transparent pixels as white', () => {
    const p = page(40, 40)
    for (let i = 0; i < 40 * 40; i++) (p.data as Uint8ClampedArray)[i * 4 + 3] = 0
    expect(detectCrop(p).top).toBe(0)
  })
  it('normal mode keeps specks; aggressive ignores them', () => {
    const p = page(200, 200)
    p.fill(40, 40, 160, 160)
    p.fill(5, 5, 6, 6) // dust speck in the corner
    const normal = detectCrop(p, { padding: 0 })
    near(normal.top, 0.025)
    const agg = detectCrop(p, { padding: 0, aggressive: true })
    near(agg.top, 0.2)
    near(agg.left, 0.2)
  })
  it('aggressive mode skips dark scan borders', () => {
    const p = page(200, 200)
    p.fill(0, 0, 200, 6) // black band at the top edge
    p.fill(0, 0, 4, 200) // and on the left
    p.fill(50, 60, 150, 140)
    const agg = detectCrop(p, { padding: 0, aggressive: true })
    near(agg.top, 0.3)
    near(agg.left, 0.25)
    near(agg.right, 0.25)
    expect(detectCrop(p, { padding: 0 }).top).toBe(0)
  })
  it('aggressive mode drops a small isolated page number far below the music', () => {
    const p = page(200, 200)
    p.fill(30, 20, 170, 120)
    p.fill(95, 185, 105, 188) // page number
    near(detectCrop(p, { padding: 0 }).bottom, 12 / 200)
    near(detectCrop(p, { padding: 0, aggressive: true }).bottom, 80 / 200)
  })
})

describe('crop helpers', () => {
  it('rotates crops clockwise', () => {
    const c = { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 }
    expect(rotateCrop(c, 90)).toEqual({ top: 0.4, right: 0.1, bottom: 0.2, left: 0.3 })
    expect(rotateCrop(c, 360)).toEqual(c)
    expect(rotateCrop(rotateCrop(c, 90), -90)).toEqual(c)
  })
  it('clamps crops to keep a minimum area', () => {
    const c = clampCrop({ top: 0.6, bottom: 0.6, left: -1, right: 0 })
    expect(c.left).toBe(0)
    near(1 - c.top - c.bottom, 0.1)
  })
})
