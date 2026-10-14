import type { DisplayMode } from '../db/schema'

/**
 * Imperative handle to the live viewer, for tools that need to drive it (auto-scroll, smart buttons,
 * link points, sync). Populated by Viewer while a song is open; every member is safe to call when absent.
 */
export interface ViewerApi {
  mode: DisplayMode
  /** Number of display pages in the current song. */
  pageCount: number
  /** Index of the first visible display page. */
  currentPage: number
  /** Scrollable container of the stage (scroll modes, fit-width or zoomed pages). */
  scroller: HTMLElement | null
  /** True when the current view can scroll (vertical strip, fit-width page taller than screen, zoomed). */
  canScroll: () => boolean
  goToPage: (page: number) => void
  next: () => void
  prev: () => void
}

let current: ViewerApi | null = null

export function setViewerApi(api: ViewerApi | null) {
  current = api
}

export function viewerApi(): ViewerApi | null {
  return current
}
