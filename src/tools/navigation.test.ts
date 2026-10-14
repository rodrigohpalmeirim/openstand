import { describe, expect, it } from 'vitest'
import type { Bookmark, LinkPoint, SetlistEntry } from '../db/schema'
import { linkColor, linkToActivate, nextBookmark, prevBookmark, queueRows, removeFromQueue, reorderQueue, visiblePages } from './navigation'

const bm = (id: string, pageIndex: number): Bookmark => ({ id, name: id, pageIndex })
const link = (id: string, from: number, to: number): LinkPoint => ({ id, from: { pageIndex: from, x: 0.5, y: 0.5 }, to: { pageIndex: to, x: 0, y: 0 } })

describe('bookmark navigation', () => {
  const list = [bm('c', 6), bm('a', 1), bm('b', 3)]
  it('finds the next bookmark after the current page', () => {
    expect(nextBookmark(list, 0)?.id).toBe('a')
    expect(nextBookmark(list, 1)?.id).toBe('b')
    expect(nextBookmark(list, 6)).toBeUndefined()
  })
  it('finds the previous bookmark before the current page', () => {
    expect(prevBookmark(list, 6)?.id).toBe('b')
    expect(prevBookmark(list, 4)?.id).toBe('b')
    expect(prevBookmark(list, 1)).toBeUndefined()
  })
})

describe('link points', () => {
  const links = [link('repeat', 1, 0), link('ds', 3, 2), link('coda', 3, 5)]
  it('activates links in list order when their page is visible', () => {
    expect(linkToActivate(links, 0, [1])).toBe(0)
    expect(linkToActivate(links, 1, [1])).toBe(-1)
    expect(linkToActivate(links, 1, [3])).toBe(1)
    expect(linkToActivate(links, 2, [3])).toBe(2)
    expect(linkToActivate(links, 3, [3])).toBe(-1)
  })
  it('skips links whose page was passed without taking them', () => {
    expect(linkToActivate(links, 0, [3])).toBe(1)
  })
  it('considers both pages of a spread', () => {
    expect(linkToActivate(links, 0, [2, 3])).toBe(1)
  })
  it('wraps colours', () => {
    expect(linkColor(20)).toBe(linkColor(0))
  })
  it('lists the visible pages of a stop', () => {
    expect(visiblePages([{ kind: 'spread', pages: [2, 3] }], 0, true, 2)).toEqual([2, 3])
    expect(visiblePages([{ kind: 'half', top: 1, bottom: 2, split: 0.5 }], 0, true, 1)).toEqual([1, 2])
    expect(visiblePages([], 0, false, 4)).toEqual([4])
  })
})

describe('queue editing', () => {
  it('keeps the current song current when reordering', () => {
    expect(reorderQueue(['a', 'b', 'c', 'd'], 1, 1, 3)).toEqual({ queue: ['a', 'c', 'd', 'b'], index: 3 })
    expect(reorderQueue(['a', 'b', 'c', 'd'], 1, 0, 2)).toEqual({ queue: ['b', 'c', 'a', 'd'], index: 0 })
    expect(reorderQueue(['a', 'b', 'c', 'd'], 1, 3, 0)).toEqual({ queue: ['d', 'a', 'b', 'c'], index: 2 })
    expect(reorderQueue(['a', 'b', 'c', 'd'], 1, 2, 3)).toEqual({ queue: ['a', 'b', 'd', 'c'], index: 1 })
  })
  it('removes entries keeping the current song', () => {
    expect(removeFromQueue(['a', 'b', 'c'], 1, 0)).toEqual({ queue: ['b', 'c'], index: 0 })
    expect(removeFromQueue(['a', 'b', 'c'], 1, 2)).toEqual({ queue: ['a', 'b'], index: 1 })
  })
  it('shows set breaks while the queue follows the setlist', () => {
    const entries: SetlistEntry[] = [
      { key: '1', songId: 'a' },
      { key: 'x', songId: '', isBreak: true, breakLabel: 'Interval' },
      { key: '2', songId: 'b', note: 'segue' },
    ]
    expect(queueRows(['a', 'b'], entries)).toEqual([
      { kind: 'song', songId: 'a', qi: 0, note: undefined },
      { kind: 'break', label: 'Interval', key: 'x' },
      { kind: 'song', songId: 'b', qi: 1, note: 'segue' },
    ])
    expect(queueRows(['b', 'a'], entries).every((r) => r.kind === 'song')).toBe(true)
  })
})
