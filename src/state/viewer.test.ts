import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, useSettings } from './settings'
import { useViewer } from './viewer'

/** jsdom has no Fullscreen API: fake one that tracks document.fullscreenElement. */
let fsElement: Element | null = null
const request = vi.fn(async () => {
  fsElement = document.documentElement
  document.dispatchEvent(new Event('fullscreenchange'))
})
const exit = vi.fn(async () => {
  fsElement = null
  document.dispatchEvent(new Event('fullscreenchange'))
})

beforeEach(() => {
  fsElement = null
  request.mockClear()
  exit.mockClear()
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: request })
  useSettings.getState().setIn('display', { fullscreen: true })
})

afterEach(() => {
  useViewer.getState().close()
  useSettings.getState().reset()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('fullscreen while performing', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.display.fullscreen).toBe(true)
  })

  it('requests fullscreen synchronously on open and exits on close', async () => {
    useViewer.getState().open(['a'])
    expect(request).toHaveBeenCalledTimes(1)
    await flush()
    useViewer.getState().close()
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the setting is off', async () => {
    useSettings.getState().setIn('display', { fullscreen: false })
    useViewer.getState().open(['a'])
    await flush()
    useViewer.getState().close()
    expect(request).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('leaves fullscreen alone if it was already on before opening', async () => {
    fsElement = document.documentElement
    useViewer.getState().open(['a'])
    await flush()
    useViewer.getState().close()
    expect(request).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it("doesn't exit or re-enter after the user left fullscreen themselves", async () => {
    useViewer.getState().open(['a', 'b'])
    await flush()
    await document.exitFullscreen() // Esc
    exit.mockClear()
    useViewer.getState().goSong(1)
    expect(request).toHaveBeenCalledTimes(1)
    // The user turns it back on with the toolbar toggle: still theirs, not ours.
    await document.documentElement.requestFullscreen()
    useViewer.getState().close()
    expect(exit).not.toHaveBeenCalled()
  })

  it('swallows rejections when there is no user activation', async () => {
    request.mockImplementationOnce(() => Promise.reject(new TypeError('Permissions check failed')))
    useViewer.getState().open(['a'])
    await flush()
    useViewer.getState().close()
    expect(exit).not.toHaveBeenCalled()
  })

  it('undoes a request that resolves after the viewer already closed', async () => {
    useViewer.getState().open(['a'])
    useViewer.getState().close()
    await flush()
    expect(exit).toHaveBeenCalledTimes(1)
    expect(document.fullscreenElement).toBeNull()
  })
})
