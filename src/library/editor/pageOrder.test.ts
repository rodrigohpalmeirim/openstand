import { describe, expect, it } from 'vitest'
import { defaultPageOrder, formatPageOrder, normalizePageOrder, parsePageOrder } from './pageOrder'

const one = [{ id: 'a', pageCount: 8 }]
const two = [
  { id: 'a', pageCount: 5 },
  { id: 'b', pageCount: 4 },
]
const pages = (r: ReturnType<typeof parsePageOrder>) => (r.ok ? r.refs.map((x) => `${x.fileId}${x.page + 1}`).join(' ') : r.error)

describe('parsePageOrder', () => {
  it('parses single pages and ranges', () => {
    expect(pages(parsePageOrder('1-3, 5', one))).toBe('a1 a2 a3 a5')
    expect(pages(parsePageOrder(' 2 ,4-4,', one))).toBe('a2 a4')
  })
  it('allows descending ranges and repeats', () => {
    expect(pages(parsePageOrder('1-3,2-1,3', one))).toBe('a1 a2 a3 a2 a1 a3')
    expect(pages(parsePageOrder('5-3', one))).toBe('a5 a4 a3')
  })
  it('normalizes double and typographic dashes', () => {
    expect(pages(parsePageOrder('1--2, 3–4', one))).toBe('a1 a2 a3 a4')
  })
  it('validates', () => {
    expect(pages(parsePageOrder('1-9', one))).toBe('The maximum allowed page is 8')
    expect(pages(parsePageOrder('1-2-3', one))).toBe('"1-2-3" is not a valid page ordering')
    expect(pages(parsePageOrder('x', one))).toBe('"x" is not a valid page ordering')
    expect(pages(parsePageOrder('0', one))).toMatch(/numbered from 1/)
    expect(pages(parsePageOrder('', one))).toMatch(/at least one page/)
    expect(pages(parsePageOrder('3:1', two))).toMatch(/File 3 does not exist/)
    expect(pages(parsePageOrder('2:5', two))).toBe('The maximum allowed page in file 2 is 4')
  })
  it('handles multi-file prefixes with sticky file selection', () => {
    expect(pages(parsePageOrder('1-2, 2:1-2, 4, 1:5', two))).toBe('a1 a2 b1 b2 b4 a5')
  })
})

describe('formatPageOrder', () => {
  it('compresses runs', () => {
    expect(formatPageOrder(defaultPageOrder(one), one)).toBe('1-8')
    const r = parsePageOrder('1-3,2-1,3,7', one)
    expect(r.ok && formatPageOrder(r.refs, one)).toBe('1-3, 2-1, 3, 7')
  })
  it('round-trips multi-file orders', () => {
    for (const t of ['1-5, 2:1-4', '2:4-1, 1:1, 3', '1, 2:1, 1:2']) {
      const r = parsePageOrder(t, two)
      expect(r.ok).toBe(true)
      if (r.ok) expect(formatPageOrder(r.refs, two)).toBe(t)
    }
  })
  it('drops refs to missing files', () => {
    expect(formatPageOrder([{ fileId: 'zz', page: 0 }, { fileId: 'a', page: 1 }], one)).toBe('2')
  })
  it('normalizes the default order to undefined', () => {
    expect(normalizePageOrder(defaultPageOrder(two), two)).toBeUndefined()
    expect(normalizePageOrder([{ fileId: 'a', page: 0 }], two)).toHaveLength(1)
  })
})
