import type { DisplayMode, FitMode } from '../db/schema'

export interface Box {
  width: number
  height: number
}

/** What is visible at one navigation stop. */
export type Stop =
  | { kind: 'spread'; pages: number[] }
  /** Half-page turn: top part shows `top` page's upper region, bottom shows `bottom` page's lower region. */
  | { kind: 'half'; top: number; bottom: number; split: number }

/**
 * Navigation stops for paged modes.
 * - single: one page per stop
 * - double: two pages side by side ("book" pairs 1-2, 3-4…)
 * - halfPage: full page, then a stop where the next page's top replaces the current page's top, …
 */
export function computeStops(pageCount: number, mode: DisplayMode, split = 0.5, twoPageTurn: 'two' | 'single' | 'alternate' = 'two'): Stop[] {
  const stops: Stop[] = []
  if (pageCount <= 0) return stops
  switch (mode) {
    case 'double':
      if (pageCount === 1) stops.push({ kind: 'spread', pages: [0] })
      else if (twoPageTurn === 'single') {
        // [1|2] → [2|3] → [3|4]: every turn advances one page.
        for (let i = 0; i + 1 < pageCount; i++) stops.push({ kind: 'spread', pages: [i, i + 1] })
      } else if (twoPageTurn === 'alternate') {
        // [1|2] → [3|2] → [3|4] → [5|4]: only the page already read is replaced.
        let shown = [0, 1]
        stops.push({ kind: 'spread', pages: shown })
        for (let n = 2; n < pageCount; n++) {
          shown = n % 2 === 0 ? [n, shown[1]] : [shown[0], n]
          stops.push({ kind: 'spread', pages: shown })
        }
      } else for (let i = 0; i < pageCount; i += 2) stops.push({ kind: 'spread', pages: i + 1 < pageCount ? [i, i + 1] : [i] })
      break
    case 'halfPage':
      for (let i = 0; i < pageCount; i++) {
        stops.push({ kind: 'spread', pages: [i] })
        if (i + 1 < pageCount) stops.push({ kind: 'half', top: i + 1, bottom: i, split })
      }
      break
    default:
      for (let i = 0; i < pageCount; i++) stops.push({ kind: 'spread', pages: [i] })
  }
  return stops
}

/** Index of the stop that shows `page` (used when jumping to a bookmark or switching modes). */
export function stopForPage(stops: Stop[], page: number): number {
  // Prefer the stop that starts with the page (matters when spreads overlap, e.g. one-page steps).
  let i = stops.findIndex((s) => s.kind === 'spread' && s.pages[0] === page)
  if (i < 0) i = stops.findIndex((s) => (s.kind === 'spread' ? s.pages.includes(page) : false))
  return i < 0 ? 0 : i
}

/**
 * Pages of the neighbouring stops worth pre-rendering (next, previous, the one after next), each page
 * once and none already visible; overlapping spreads (one-page or alternate turns) share pages.
 */
export function prefetchPages(stops: Stop[], pos: number): { stop: number; slot: number; page: number }[] {
  const cur = stops[pos]
  const seen = new Set(cur?.kind === 'spread' ? cur.pages : [])
  const out: { stop: number; slot: number; page: number }[] = []
  for (const n of [pos + 1, pos - 1, pos + 2]) {
    const st = stops[n]
    if (!st || st.kind !== 'spread') continue
    st.pages.forEach((page, slot) => {
      if (seen.has(page)) return
      seen.add(page)
      out.push({ stop: n, slot, page })
    })
  }
  return out
}

/** First page shown by a stop (for page indicators, bookmarks, sync). */
export function firstPageOf(stop: Stop | undefined): number {
  if (!stop) return 0
  return stop.kind === 'spread' ? Math.min(...stop.pages) : stop.bottom
}

/** Fit a page of aspect (w/h) into a box. */
export function fitPage(aspect: number, box: Box, fit: FitMode): Box {
  if (fit === 'width') return { width: box.width, height: box.width / aspect }
  if (fit === 'height') return { width: box.height * aspect, height: box.height }
  const byWidth = { width: box.width, height: box.width / aspect }
  return byWidth.height <= box.height ? byWidth : { width: box.height * aspect, height: box.height }
}

/** Widest a page gets in vertical scroll with fit "width" (unless zoomed): wider is unreadable. */
export const SCROLL_MAX_WIDTH = 1100

/**
 * Page size in vertical scroll mode. "Width" fills the strip up to SCROLL_MAX_WIDTH; "page" and
 * "height" keep each page within the viewport height so landscape screens don't blow pages up.
 */
export function scrollPageSize(aspect: number, box: Box, fit: FitMode, zoom = 1): Box {
  const b = fit === 'width' ? fitPage(aspect, { width: Math.min(box.width, SCROLL_MAX_WIDTH), height: Infinity }, 'width') : fitPage(aspect, box, 'page')
  return { width: b.width * zoom, height: b.height * zoom }
}

/**
 * Sizes for the pages of a side-by-side spread: both pages share one height so they line up like a
 * book, scaled to fit the available box.
 */
export function fitSpread(aspects: number[], box: Box, fit: FitMode, gap: number): Box[] {
  if (aspects.length === 1) return [fitPage(aspects[0], box, fit)]
  const totalAspect = aspects.reduce((a, b) => a + b, 0)
  const availW = box.width - gap * (aspects.length - 1)
  let h = fit === 'width' ? availW / totalAspect : Math.min(box.height, availW / totalAspect)
  if (fit === 'height') h = box.height
  return aspects.map((a) => ({ width: h * a, height: h }))
}

/** A page of a scroll strip along its scroll axis (offsets relative to the scroller's content). */
export interface StripItem {
  page: number
  start: number
  size: number
}

/** Reading position in a scroll strip: the page at the leading edge of the view and how far into it (0..1). */
export interface StripAnchor {
  page: number
  frac: number
}

/** Page whose start is the last one at or before `offset` (the first page before any). */
export function pageAtOffset(items: StripItem[], offset: number): number {
  let cur = items[0]?.page ?? 0
  for (const it of items) if (it.start <= offset) cur = it.page
  return cur
}

/** Anchor for a scroll offset; null at the very start, which should stay the start whatever the sizes. */
export function stripAnchor(items: StripItem[], offset: number): StripAnchor | null {
  if (offset <= 1 || !items.length) return null
  const page = pageAtOffset(items, offset)
  const it = items.find((i) => i.page === page)!
  return { page, frac: Math.max(0, Math.min(1, (offset - it.start) / Math.max(1, it.size))) }
}

/** Scroll offset that shows an anchor again once the pages have new sizes. */
export function anchorOffset(items: StripItem[], a: StripAnchor): number | undefined {
  const it = items.find((i) => i.page === a.page)
  return it && it.start + a.frac * it.size
}
