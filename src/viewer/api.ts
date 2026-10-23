import type { DisplayMode } from '../db/schema'

/**
 * Imperative handle to the live viewer, for tools that need to drive it (auto-scroll, smart buttons,
 * link points, sync). Populated by Viewer while a song is open; every member is safe to call when absent.
 */
export interface ViewerApi {
  songId: string
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

/** Set on the scroller while a zoom preview (pinch, Ctrl+wheel) transforms its content: its scroll offset is not real. */
export const ZOOM_PREVIEW_ATTR = 'data-zoom-preview'

let current: ViewerApi | null = null

export function setViewerApi(api: ViewerApi | null) {
  current = api
}

export function viewerApi(): ViewerApi | null {
  return current
}

/**
 * Show a display page of a song once the viewer has laid that song out. Positions are layout units
 * (spreads, half pages), so callers that know a page index (bookmarks, links to other songs, sync from
 * a device with another layout) must go through the viewer instead of setting a position.
 */
export function goToPageWhenReady(songId: string, page: number, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs
  const tick = () => {
    const api = current
    if (api?.songId === songId && api.pageCount > page) {
      if (api.currentPage !== page) api.goToPage(page)
    } else if (Date.now() < until) setTimeout(tick, 50)
  }
  tick()
}
