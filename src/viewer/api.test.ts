import { afterEach, describe, expect, it, vi } from 'vitest'
import { goToPageWhenReady, setViewerApi, type ViewerApi } from './api'

function api(songId: string, pageCount: number, currentPage = 0) {
  const goToPage = vi.fn<(page: number) => void>()
  const a: ViewerApi = { songId, mode: 'double', pageCount, currentPage, scroller: null, canScroll: () => false, goToPage, next: () => {}, prev: () => {} }
  return Object.assign(a, { goToPage })
}

describe('goToPageWhenReady', () => {
  afterEach(() => {
    setViewerApi(null)
    vi.useRealTimers()
  })

  it('waits until the viewer shows that song with enough pages', () => {
    vi.useFakeTimers()
    const old = api('a', 3)
    setViewerApi(old)
    goToPageWhenReady('b', 10)
    expect(old.goToPage).not.toHaveBeenCalled()
    const loading = api('b', 0)
    setViewerApi(loading)
    vi.advanceTimersByTime(100)
    expect(loading.goToPage).not.toHaveBeenCalled()
    const ready = api('b', 40)
    setViewerApi(ready)
    vi.advanceTimersByTime(100)
    expect(ready.goToPage).toHaveBeenCalledWith(10)
  })

  it('gives up after the timeout and skips pages already shown', () => {
    vi.useFakeTimers()
    goToPageWhenReady('c', 2, 200)
    vi.advanceTimersByTime(300)
    const late = api('c', 5)
    setViewerApi(late)
    vi.advanceTimersByTime(300)
    expect(late.goToPage).not.toHaveBeenCalled()
    const shown = api('d', 5, 2)
    setViewerApi(shown)
    goToPageWhenReady('d', 2)
    expect(shown.goToPage).not.toHaveBeenCalled()
  })
})
