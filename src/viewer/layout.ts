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
export function computeStops(pageCount: number, mode: DisplayMode, split = 0.5): Stop[] {
  const stops: Stop[] = []
  if (pageCount <= 0) return stops
  switch (mode) {
    case 'double':
      for (let i = 0; i < pageCount; i += 2) stops.push({ kind: 'spread', pages: i + 1 < pageCount ? [i, i + 1] : [i] })
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
  const i = stops.findIndex((s) => (s.kind === 'spread' ? s.pages.includes(page) : false))
  return i < 0 ? 0 : i
}

/** First page shown by a stop (for page indicators, bookmarks, sync). */
export function firstPageOf(stop: Stop | undefined): number {
  if (!stop) return 0
  return stop.kind === 'spread' ? stop.pages[0] : stop.bottom
}

/** Fit a page of aspect (w/h) into a box. */
export function fitPage(aspect: number, box: Box, fit: FitMode): Box {
  if (fit === 'width') return { width: box.width, height: box.width / aspect }
  if (fit === 'height') return { width: box.height * aspect, height: box.height }
  const byWidth = { width: box.width, height: box.width / aspect }
  return byWidth.height <= box.height ? byWidth : { width: box.height * aspect, height: box.height }
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
