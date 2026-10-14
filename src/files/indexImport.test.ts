import { describe, expect, it } from 'vitest'
import { decodeText, outlineToEntries, parseIndexCsv, splitCsvLine } from './indexImport'

describe('parseIndexCsv', () => {
  it('reads an optional PDF line, a header and rows', () => {
    const r = parseIndexCsv('Real Book.pdf\ntitle;pages;artist;key\nAutumn Leaves;12-13;Kosma;Gm\nBlue Bossa;14;Dorham;\n', { pageCount: 100 })
    expect(r.error).toBeUndefined()
    expect(r.pdfName).toBe('Real Book.pdf')
    expect(r.entries).toEqual([
      { title: 'Autumn Leaves', pages: [11, 12], fields: { artists: 'Kosma', keys: 'Gm' } },
      { title: 'Blue Bossa', pages: [13], fields: { artists: 'Dorham' } },
    ])
  })
  it('falls back to positional columns without a header', () => {
    const r = parseIndexCsv('So What;3-4;Miles Davis\nFreddie;5')
    expect(r.pdfName).toBeUndefined()
    expect(r.entries.map((e) => [e.title, e.pages, e.fields.artists])).toEqual([
      ['So What', [2, 3], 'Miles Davis'],
      ['Freddie', [4], undefined],
    ])
  })
  it('handles quotes, CRLF, other delimiters and header aliases', () => {
    const r = parseIndexCsv('"Name","Page Range","Composer"\r\n"Hello; ""World""",7,"A, B"\r\n')
    expect(r.entries[0]).toEqual({ title: 'Hello; "World"', pages: [6], fields: { composers: 'A, B' } })
  })
  it('reports missing required columns', () => {
    expect(parseIndexCsv('artist;pages\nX;1').error).toMatch(/title column/)
    expect(parseIndexCsv('title;artist\nX;Y').error).toMatch(/pages column/)
    expect(parseIndexCsv('   \n').error).toMatch(/empty/)
  })
  it('validates pages against the PDF and applies an offset', () => {
    const r = parseIndexCsv('title;pages\nA;1-2\nB;9\nC;x', { pageCount: 5, offset: 2 })
    expect(r.entries).toEqual([{ title: 'A', pages: [2, 3], fields: {} }])
    expect(r.warnings).toEqual(['Line 3 (B): The maximum allowed page is 5', 'Line 4 (C): "x" is not a valid page ordering'])
  })
  it('splits lines', () => {
    expect(splitCsvLine(' a ; "b;c" ;', ';')).toEqual(['a', 'b;c', ''])
  })
})

describe('decodeText', () => {
  it('strips BOMs and decodes UTF-16', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi')
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0, 0x69, 0]))).toBe('hi')
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x68, 0, 0x69]))).toBe('hi')
    expect(decodeText(new Uint8Array([0x68, 0, 0x69, 0]))).toBe('hi')
  })
})

describe('outlineToEntries', () => {
  it('turns bookmarks into page ranges sorted by page', () => {
    const e = outlineToEntries(
      [
        { title: 'Second\r\n', pageIndex: 4, depth: 0 },
        { title: 'First', pageIndex: 0, depth: 0 },
        { title: 'Nested', pageIndex: 2, depth: 1 },
        { title: 'Third', pageIndex: 7, depth: 0 },
        { title: 'Broken', pageIndex: -1, depth: 0 },
      ],
      10,
      0,
    )
    expect(e.map((x) => [x.title, x.pages[0], x.pages.at(-1)])).toEqual([
      ['First', 0, 3],
      ['Second', 4, 6],
      ['Third', 7, 9],
    ])
  })
  it('keeps same-page bookmarks to one page', () => {
    const e = outlineToEntries(
      [
        { title: 'A', pageIndex: 3, depth: 0 },
        { title: 'B', pageIndex: 3, depth: 0 },
        { title: 'C', pageIndex: 5, depth: 0 },
      ],
      6,
    )
    expect(e.map((x) => x.pages)).toEqual([[3], [3, 4], [5]])
  })
})
