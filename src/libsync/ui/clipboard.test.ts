// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ui/primitives', () => ({ toast: vi.fn() }))
const { clearClipboardLater } = await import('./clipboard')

let clip: string
let perm: PermissionState
let focused: boolean
const writeText = vi.fn(async (t: string) => void (clip = t))
const readText = vi.fn(async () => clip)

beforeEach(() => {
  vi.useFakeTimers()
  clip = 'OSJ1.secret'
  perm = 'granted'
  focused = true
  writeText.mockClear()
  readText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } })
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: perm }) } })
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('clearClipboardLater', () => {
  it('clears the clipboard after the delay when it still holds the code', async () => {
    clearClipboardLater('OSJ1.secret', 60_000)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(writeText).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(clip).toBe('')
  })

  it('leaves something else alone', async () => {
    clearClipboardLater('OSJ1.secret', 1000)
    clip = 'my own text'
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(clip).toBe('my own text')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('never prompts: skips when clipboard-read is not already granted', async () => {
    perm = 'prompt'
    clearClipboardLater('OSJ1.secret', 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(readText).not.toHaveBeenCalled()
    expect(clip).toBe('OSJ1.secret')
  })

  it('skips silently without the clipboard read API', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    clearClipboardLater('OSJ1.secret', 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('waits for the page to get focus back', async () => {
    focused = false
    clearClipboardLater('OSJ1.secret', 1000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(readText).not.toHaveBeenCalled()
    focused = true
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(clip).toBe('')
  })

  it('can be cancelled', async () => {
    const cancel = clearClipboardLater('OSJ1.secret', 1000)
    cancel()
    await vi.advanceTimersByTimeAsync(2000)
    expect(readText).not.toHaveBeenCalled()
  })
})
