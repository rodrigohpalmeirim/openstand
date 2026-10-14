/**
 * Index import (spec 01-library §7.5): split one PDF into many songs that all share the same file,
 * each song showing a page range via Song.pageOrder. Sources: the PDF outline (bookmarks) or a CSV.
 *
 * CSV format: `;`-delimited (`,` or tab also detected), optional first line naming the PDF
 * ("Real Book.pdf"), then a header row such as `title;pages;artist;key`. Without a recognisable header
 * the columns are positional: title;pages;artist;composer;album;genre;key;year. The pages cell uses the
 * page-order grammar ("12", "12-14", "12-13, 15"), 1-based, optionally shifted by a page offset.
 */
import { parsePageOrder } from '../library/editor/pageOrder'

export interface IndexEntry {
  title: string
  /** 0-based PDF page indexes, in display order. */
  pages: number[]
  /** Extra field values keyed by canonical column name (see COLUMNS). */
  fields: Record<string, string>
}

export interface IndexParse {
  pdfName?: string
  entries: IndexEntry[]
  /** Fatal error (no rows can be imported). */
  error?: string
  /** Per-row problems, e.g. 'Line 5: The maximum allowed page is 300'. */
  warnings: string[]
}

/** Canonical column → accepted header spellings (lower-case, spaces/underscores removed). */
export const COLUMNS: Record<string, string[]> = {
  title: ['title', 'name', 'song', 'songtitle'],
  pages: ['pages', 'page', 'pagerange', 'range'],
  sortTitle: ['sorttitle', 'customsorttitle'],
  songNumber: ['songid', 'songnumber', 'number', 'no', 'nr', '#'],
  artists: ['artist', 'artists', 'performer'],
  composers: ['composer', 'composers', 'writer', 'author'],
  albums: ['album', 'albums', 'book', 'books'],
  genres: ['genre', 'genres', 'style'],
  collections: ['collection', 'collections'],
  keys: ['key', 'keys'],
  signatures: ['signature', 'signatures', 'timesignature', 'time', 'meter'],
  sources: ['source', 'sources', 'sourcetype', 'type'],
  years: ['year', 'years'],
  tags: ['tag', 'tags'],
  custom: ['custom', 'custom1', 'customgroup'],
  custom2: ['custom2'],
  keywords: ['keywords', 'keyword'],
  difficulty: ['difficulty'],
  rating: ['rating', 'stars'],
  duration: ['duration', 'length'],
  tempos: ['tempo', 'tempos', 'bpm'],
  notes: ['notes', 'note', 'comment', 'comments'],
}
const POSITIONAL = ['title', 'pages', 'artists', 'composers', 'albums', 'genres', 'keys', 'years']

function columnOf(header: string): string | null {
  const h = header.toLowerCase().replace(/[\s_-]+/g, '')
  for (const [col, names] of Object.entries(COLUMNS)) if (names.includes(h)) return col
  return null
}

/** Decode a text file, honouring UTF-8 / UTF-16 LE / UTF-16 BE byte-order marks (BOM stripped). */
export function decodeText(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2))
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
  // Heuristic for BOM-less UTF-16: many NUL bytes in odd/even positions.
  if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return new TextDecoder('utf-16le').decode(b)
  if (b.length >= 4 && b[0] === 0 && b[2] === 0 && b[1] !== 0) return new TextDecoder('utf-16be').decode(b)
  return new TextDecoder('utf-8').decode(b).replace(/^﻿/, '')
}

/** Split one CSV line, honouring double-quoted cells ("a;b" and "" escapes). */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"' && cur.trim() === '') {
      q = true
      cur = ''
    } else if (ch === delim) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

function detectDelimiter(line: string): string {
  if (line.includes(';')) return ';'
  if (line.includes('\t')) return '\t'
  if (line.includes(',')) return ','
  return ';'
}

export function parseIndexCsv(text: string, opts: { pageCount?: number; offset?: number; delimiter?: string } = {}): IndexParse {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  const res: IndexParse = { entries: [], warnings: [] }
  let i = 0
  const skipBlank = () => {
    while (i < lines.length && !lines[i].trim()) i++
  }
  skipBlank()
  if (i >= lines.length) return { ...res, error: 'The CSV file is empty' }
  // A first line without a delimiter that names a PDF (or any single path) is the PDF reference.
  const first = lines[i].trim()
  if (/\.pdf"?$/i.test(first) && !/[;\t]/.test(first.replace(/^".*"$/, ''))) {
    res.pdfName = first.replace(/^"|"$/g, '').split(/[\\/]/).pop()
    i++
    skipBlank()
  }
  if (i >= lines.length) return { ...res, error: 'No songs found in the CSV file' }
  const delim = opts.delimiter ?? detectDelimiter(lines[i])
  const head = splitCsvLine(lines[i], delim)
  const mapped = head.map(columnOf)
  let cols: (string | null)[]
  if (mapped.some(Boolean)) {
    if (!mapped.includes('title')) return { ...res, error: 'A title column was not found. Add a header row such as "title;pages".' }
    if (!mapped.includes('pages')) return { ...res, error: 'A pages column was not found. Add a header row such as "title;pages".' }
    cols = mapped
    i++
  } else cols = POSITIONAL
  const offset = opts.offset ?? 0
  const pc = opts.pageCount ?? Number.MAX_SAFE_INTEGER
  for (; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const cells = splitCsvLine(lines[i], delim)
    const fields: Record<string, string> = {}
    cols.forEach((c, k) => {
      if (c && cells[k]) fields[c] = cells[k]
    })
    const title = (fields.title ?? '').replace(/[\r\n]+/g, ' ').trim()
    const pagesText = fields.pages ?? ''
    delete fields.title
    delete fields.pages
    if (!title) {
      res.warnings.push(`Line ${i + 1}: missing title`)
      continue
    }
    const shifted = offset
      ? pagesText.replace(/\d+/g, (n) => String(Number(n) + offset))
      : pagesText
    const r = parsePageOrder(shifted, [{ id: 'pdf', pageCount: pc }])
    if (!r.ok) {
      res.warnings.push(`Line ${i + 1} (${title}): ${pagesText ? r.error : 'missing pages'}`)
      continue
    }
    res.entries.push({ title, pages: r.refs.map((x) => x.page), fields })
  }
  if (!res.entries.length && !res.error) res.error = res.warnings.length ? 'No valid rows in the CSV file' : 'No songs found in the CSV file'
  return res
}

export interface OutlineItem {
  title: string
  /** 0-based page, or -1 when the destination could not be resolved. */
  pageIndex: number
  depth: number
}

/**
 * One entry per bookmark: pages from the bookmark's page to the page before the next bookmark (after
 * sorting by page); the last bookmark runs to the end. `maxDepth` limits nesting (0 = top level only).
 */
export function outlineToEntries(items: OutlineItem[], numPages: number, maxDepth = Infinity): IndexEntry[] {
  const list = items
    .filter((it) => it.depth <= maxDepth && it.pageIndex >= 0 && it.pageIndex < numPages)
    .map((it, k) => ({ ...it, k, title: it.title.replace(/[\r\n]+/g, ' ').trim() }))
    .filter((it) => it.title)
    .sort((a, b) => a.pageIndex - b.pageIndex || a.k - b.k)
  return list.map((it, k) => {
    const next = list[k + 1]
    const end = next ? next.pageIndex - 1 : numPages - 1
    const pages: number[] = []
    for (let p = it.pageIndex; p <= Math.max(it.pageIndex, end); p++) pages.push(p)
    return { title: it.title, pages, fields: {} }
  })
}
