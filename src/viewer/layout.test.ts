import { describe, expect, it } from 'vitest'
import { computeStops, fitPage, fitSpread, stopForPage } from './layout'

describe('layout', () => {
  it('single and double stops', () => {
    expect(computeStops(3, 'single')).toHaveLength(3)
    expect(computeStops(3, 'double')).toEqual([
      { kind: 'spread', pages: [0, 1] },
      { kind: 'spread', pages: [2] },
    ])
  })
  it('half page stops interleave', () => {
    const s = computeStops(3, 'halfPage')
    expect(s.map((x) => x.kind)).toEqual(['spread', 'half', 'spread', 'half', 'spread'])
    expect(s[1]).toMatchObject({ top: 1, bottom: 0 })
    expect(stopForPage(s, 2)).toBe(4)
  })
  it('fits pages', () => {
    expect(fitPage(0.5, { width: 1000, height: 1000 }, 'page')).toEqual({ width: 500, height: 1000 })
    expect(fitPage(2, { width: 1000, height: 1000 }, 'page')).toEqual({ width: 1000, height: 500 })
    expect(fitPage(0.5, { width: 1000, height: 1000 }, 'width')).toEqual({ width: 1000, height: 2000 })
    const [a, b] = fitSpread([0.75, 0.75], { width: 1500, height: 1000 }, 'page', 0)
    expect(a.height).toBe(1000)
    expect(a.width + b.width).toBeCloseTo(1500)
  })
})
