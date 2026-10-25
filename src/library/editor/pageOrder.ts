/**
 * Text page-order grammar (spec 01-library §5), extended for multi-file songs.
 *
 *   order  := token ("," token)*
 *   token  := [file ":"] page ["-" page]
 *
 * - Pages and files are 1-based. `A-B` is an inclusive range; descending ranges (`5-3`) and repeats
 *   are allowed (D.S. / coda jumps). `--` and en/em dashes are read as `-`; whitespace is ignored.
 * - `file:` selects the song's N-th file (in file-list order). A token without a prefix refers to the
 *   same file as the previous token (file 1 at the start), so "1-3, 2:1-4, 6" = file 1 pages 1-3,
 *   then file 2 pages 1-4 and 6. Single-file songs never need a prefix.
 */
import type { PageRef } from '../../db/schema'

export interface OrderFile {
  id: string
  pageCount: number
}

export type PageOrderParse = { ok: true; refs: PageRef[] } | { ok: false; error: string }

const TOKEN = /^(?:(\d+):)?(\d+)(?:-(\d+))?$/

export function normalizeOrderText(text: string): string {
  return text
    .replace(/[‒-―−]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, '')
}

export function parsePageOrder(text: string, files: OrderFile[]): PageOrderParse {
  if (!files.length) return { ok: false, error: 'There are no files yet' }
  const tokens = normalizeOrderText(text)
    .split(',')
    .filter((t) => t !== '')
  if (!tokens.length) return { ok: false, error: 'Enter at least one page, e.g. 1-3' }
  const refs: PageRef[] = []
  let fileNo = 1
  for (const tok of tokens) {
    const m = TOKEN.exec(tok)
    if (!m) return { ok: false, error: `"${tok}" is not a valid page ordering` }
    if (m[1] !== undefined) {
      fileNo = Number(m[1])
      if (fileNo < 1 || fileNo > files.length)
        return {
          ok: false,
          error: files.length === 1 ? `There is only one file ("${tok}")` : `File ${fileNo} does not exist (there are ${files.length} files)`,
        }
    }
    const file = files[fileNo - 1]
    const a = Number(m[2])
    const b = m[3] === undefined ? a : Number(m[3])
    for (const p of [a, b]) {
      if (p < 1) return { ok: false, error: `Pages are numbered from 1 ("${tok}")` }
      if (p > file.pageCount)
        return {
          ok: false,
          error:
            files.length === 1
              ? `The maximum allowed page is ${file.pageCount}`
              : `The maximum allowed page in file ${fileNo} is ${file.pageCount}`,
        }
    }
    const step = b >= a ? 1 : -1
    for (let p = a; ; p += step) {
      refs.push({ fileId: file.id, page: p - 1 })
      if (p === b) break
    }
  }
  return { ok: true, refs }
}

/** Compact text for a page list: consecutive runs become ranges, file prefixes only where the file changes. */
export function formatPageOrder(refs: PageRef[], files: OrderFile[]): string {
  const index = new Map(files.map((f, i) => [f.id, i + 1]))
  const items = refs.filter((r) => index.has(r.fileId)).map((r) => ({ f: index.get(r.fileId)!, p: r.page + 1 }))
  const out: string[] = []
  let curFile = 1
  let i = 0
  while (i < items.length) {
    const start = items[i]
    let j = i
    let dir = 0
    while (j + 1 < items.length && items[j + 1].f === start.f) {
      const d = items[j + 1].p - items[j].p
      if ((d === 1 || d === -1) && (dir === 0 || d === dir)) {
        dir = d
        j++
      } else break
    }
    const end = items[j]
    const prefix = files.length > 1 && start.f !== curFile ? `${start.f}:` : ''
    curFile = start.f
    out.push(prefix + (j === i ? `${start.p}` : `${start.p}-${end.p}`))
    i = j + 1
  }
  return out.join(', ')
}

/** All pages of all files, in file order. */
export function defaultPageOrder(files: OrderFile[]): PageRef[] {
  const refs: PageRef[] = []
  for (const f of files) for (let p = 0; p < f.pageCount; p++) refs.push({ fileId: f.id, page: p })
  return refs
}

export function sameOrder(a: PageRef[], b: PageRef[]): boolean {
  return a.length === b.length && a.every((r, i) => r.fileId === b[i].fileId && r.page === b[i].page)
}

/** `undefined` when the order is the default (keeps Song.pageOrder absent so added files just append). */
export function normalizePageOrder(refs: PageRef[], files: OrderFile[]): PageRef[] | undefined {
  return sameOrder(refs, defaultPageOrder(files)) ? undefined : refs
}
