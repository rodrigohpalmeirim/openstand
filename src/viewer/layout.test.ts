import { describe, expect, it } from 'vitest'
import { anchorOffset, computeStops, fitPage, fitSpread, pageAtOffset, prefetchPages, SCROLL_MAX_WIDTH, scrollPageSize, stopForPage, stripAnchor, type StripItem } from './layout'

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

describe('scrollPageSize', () => {
  const portrait = 612 / 792
  it('keeps pages within the viewport height for fit page on landscape screens', () => {
    const s = scrollPageSize(portrait, { width: 1280, height: 800 }, 'page')
    expect(s.height).toBeCloseTo(800)
    expect(s.width).toBeLessThan(700)
  })
  it('fills phone width for fit page', () => {
    expect(scrollPageSize(portrait, { width: 390, height: 844 }, 'page').width).toBeCloseTo(390)
  })
  it('caps fit width unless zoomed', () => {
    expect(scrollPageSize(portrait, { width: 1600, height: 900 }, 'width').width).toBe(SCROLL_MAX_WIDTH)
    expect(scrollPageSize(portrait, { width: 800, height: 900 }, 'width').width).toBe(800)
    expect(scrollPageSize(portrait, { width: 1600, height: 900 }, 'width', 1.5).width).toBe(SCROLL_MAX_WIDTH * 1.5)
  })
})

describe('scroll strip anchor', () => {
  // Three pages after a 50px top pad, 8px seams.
  const strip = (h: number): StripItem[] => [0, 1, 2].map((page) => ({ page, start: 50 + page * (h + 8), size: h }))
  it('keeps the same spot of the same page when page sizes change', () => {
    const before = strip(1000)
    const a = stripAnchor(before, 50 + 1008 + 250)
    expect(a).toEqual({ page: 1, frac: 0.25 })
    // Rotated to landscape: pages fit a shorter screen.
    expect(anchorOffset(strip(400), a!)).toBe(50 + 408 + 100)
  })
  it('stays at the top when at the top', () => {
    expect(stripAnchor(strip(1000), 0)).toBeNull()
  })
  it('reports the page at an offset', () => {
    expect(pageAtOffset(strip(1000), 20)).toBe(0)
    expect(pageAtOffset(strip(1000), 1100)).toBe(1)
    expect(pageAtOffset([], 10)).toBe(0)
  })
})
