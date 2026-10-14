import type { Bookmark, LinkPoint, SetlistEntry } from '../db/schema'
import type { Stop } from '../viewer/layout'

/* ---------------------------------------------------------------- bookmarks */

export const sortBookmarks = (bms: Bookmark[]) => [...bms].sort((a, b) => a.pageIndex - b.pageIndex || a.name.localeCompare(b.name))

/** First bookmark after the current page, or undefined at the end. */
export function nextBookmark(bms: Bookmark[], currentPage: number): Bookmark | undefined {
  return sortBookmarks(bms).find((b) => b.pageIndex > currentPage)
}

/** Last bookmark before the current page, or undefined at the start. */
export function prevBookmark(bms: Bookmark[], currentPage: number): Bookmark | undefined {
  return sortBookmarks(bms)
    .reverse()
    .find((b) => b.pageIndex < currentPage)
}

/* -------------------------------------------------------------------- links */

/** Distinct marker colours; a link's colour is picked by its list position. */
export const LINK_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#ea580c', '#0d9488', '#9333ea', '#166534', '#0ea5e9', '#c026d3',
  '#4f46e5', '#0891b2', '#0f766e', '#65a30d', '#d97706', '#92400e', '#475569', '#6b7280', '#6d28d9', '#db2777',
]
export const linkColor = (i: number) => LINK_COLORS[((i % LINK_COLORS.length) + LINK_COLORS.length) % LINK_COLORS.length]

/** Display pages visible at the current position (two for spreads and half-page views). */
export function visiblePages(stops: Stop[], pos: number, paged: boolean, currentPage: number): number[] {
  if (!paged) return [currentPage]
  const st = stops[pos]
  if (!st) return [currentPage]
  return st.kind === 'spread' ? [...st.pages] : st.top === st.bottom ? [st.top] : [st.top, st.bottom]
}

/**
 * "Activate link point or turn page": the first link at or after the pointer (list order) that
 * starts on a visible page. Links on other pages are skipped, so missing one doesn't block the rest.
 * Returns -1 when the page should simply turn.
 */
export function linkToActivate(links: LinkPoint[], pointer: number, visible: number[]): number {
  for (let i = Math.max(0, pointer); i < links.length; i++) if (visible.includes(links[i].from.pageIndex)) return i
  return -1
}

/** Short description, e.g. "p.3 → p.1". */
export const describeLink = (l: LinkPoint) => `p.${l.from.pageIndex + 1} → p.${l.to.pageIndex + 1}`

/* ------------------------------------------------------------------ queue */

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const out = [...arr]
  const [it] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(out.length, to)), 0, it)
  return out
}

/** Reorder the performance queue keeping the current song current. */
export function reorderQueue(queue: string[], index: number, from: number, to: number): { queue: string[]; index: number } {
  const next = moveItem(queue, from, to)
  let i = index
  if (from === index) i = Math.max(0, Math.min(next.length - 1, to))
  else if (from < index && to >= index) i = index - 1
  else if (from > index && to <= index) i = index + 1
  return { queue: next, index: i }
}

/** Remove one queue entry, keeping the current song current (or the next one if it was removed). */
export function removeFromQueue(queue: string[], index: number, at: number): { queue: string[]; index: number } {
  const next = queue.filter((_, i) => i !== at)
  const i = at < index ? index - 1 : Math.min(index, next.length - 1)
  return { queue: next, index: Math.max(0, i) }
}

export type QueueRow = { kind: 'song'; songId: string; qi: number; note?: string } | { kind: 'break'; label: string; key: string }

/**
 * Rows for the setlist panel: the queue, with the setlist's set breaks and entry notes when the queue
 * still follows the setlist order (it may have been rearranged during the performance).
 */
export function queueRows(queue: string[], entries: SetlistEntry[] | undefined): QueueRow[] {
  const plain = (): QueueRow[] => queue.map((songId, qi) => ({ kind: 'song', songId, qi }))
  if (!entries) return plain()
  const songs = entries.filter((e) => !e.isBreak)
  if (songs.length !== queue.length || songs.some((e, i) => e.songId !== queue[i])) return plain()
  const rows: QueueRow[] = []
  let qi = 0
  for (const e of entries) {
    if (e.isBreak) rows.push({ kind: 'break', label: e.breakLabel || 'Set break', key: e.key })
    else rows.push({ kind: 'song', songId: e.songId, qi: qi++, note: e.note })
  }
  return rows
}
