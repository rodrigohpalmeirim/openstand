import { describe, expect, it } from 'vitest'
import { computeStops, fitPage, fitSpread, prefetchPages, stopForPage } from './layout'

describe('layout', () => {
  it('single and double stops', () => {
    expect(computeStops(3, 'single')).toHaveLength(3)
    expect(computeStops(3, 'double')).toEqual([
      { kind: 'spread', pages: [0, 1] },
      { kind: 'spread', pages: [2] },
    ])
  })
  it('two-page turn variants', () => {
    expect(computeStops(4, 'double', 0.5, 'single').map((s) => (s.kind === 'spread' ? s.pages : []))).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
    expect(computeStops(5, 'double', 0.5, 'alternate').map((s) => (s.kind === 'spread' ? s.pages : []))).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
      [4, 3],
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
  it('keeps the same page when the layout changes', () => {
    // Page 33 (index 32) of a 40-page book: the stop showing it in every mode.
    expect(stopForPage(computeStops(40, 'single'), 32)).toBe(32)
    expect(stopForPage(computeStops(40, 'double'), 32)).toBe(16)
    expect(stopForPage(computeStops(40, 'double'), 33)).toBe(16)
    expect(stopForPage(computeStops(40, 'double', 0.5, 'single'), 32)).toBe(32)
    expect(stopForPage(computeStops(40, 'halfPage'), 32)).toBe(64)
  })
  it('prefetches each neighbouring page once', () => {
    const one = computeStops(5, 'double', 0.5, 'single') // [0,1] [1,2] [2,3] [3,4]
    expect(prefetchPages(one, 1).map((p) => p.page)).toEqual([3, 0, 4])
    const alt = computeStops(5, 'double', 0.5, 'alternate') // [0,1] [2,1] [2,3] [4,3]
    expect(prefetchPages(alt, 0).map((p) => p.page)).toEqual([2, 3])
    expect(prefetchPages(computeStops(4, 'double'), 0)).toEqual([
      { stop: 1, slot: 0, page: 2 },
      { stop: 1, slot: 1, page: 3 },
    ])
    expect(prefetchPages(computeStops(3, 'halfPage'), 0).map((p) => p.page)).toEqual([1])
  })
})
