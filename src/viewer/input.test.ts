import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettings, type KeyBinding } from '../state/settings'
import type { ActionId } from './actions'
import { isTyping, keyBindingHandlers, keyId } from './input'

const key = (type: 'keydown' | 'keyup', code: string, opts: KeyboardEventInit = {}) => new KeyboardEvent(type, { code, key: code, ...opts })

describe('keyBindingHandlers', () => {
  const keys = useSettings.getState().s.pageTurn.keys
  let ran: ActionId[]
  let h: ReturnType<typeof keyBindingHandlers>
  const bind = (k: KeyBinding[]) => useSettings.getState().setIn('pageTurn', { keys: k, debounceMs: 0 })

  beforeEach(() => {
    vi.useFakeTimers()
    ran = []
    h = keyBindingHandlers((a) => ran.push(a))
  })
  afterEach(() => {
    h.dispose()
    vi.useRealTimers()
    useSettings.getState().setIn('pageTurn', { keys })
  })

  it('runs press bindings on keydown', () => {
    bind([{ key: 'PageDown', action: 'nextPage' }])
    h.down(key('keydown', 'PageDown'))
    expect(ran).toEqual(['nextPage'])
  })

  it('tapping a modifier with press and hold bindings runs the press action', () => {
    const shift = keyId(key('keydown', 'ShiftLeft', { shiftKey: true }))
    expect(shift).toBe('Shift+ShiftLeft')
    bind([
      { key: shift, action: 'nextPage' },
      { key: shift, action: 'nextSong', long: true },
    ])
    h.down(key('keydown', 'ShiftLeft', { shiftKey: true, key: 'Shift' }))
    vi.advanceTimersByTime(100)
    // A modifier's keyup no longer carries its own modifier flag.
    h.up(key('keyup', 'ShiftLeft', { key: 'Shift' }))
    vi.advanceTimersByTime(1000)
    expect(ran).toEqual(['nextPage'])
  })

  it('holding a key runs the hold action only', () => {
    bind([
      { key: 'Space', action: 'nextPage' },
      { key: 'Space', action: 'prevPage', long: true },
    ])
    h.down(key('keydown', 'Space'))
    vi.advanceTimersByTime(600)
    h.up(key('keyup', 'Space'))
    expect(ran).toEqual(['prevPage'])
  })
})

describe('isTyping', () => {
  const input = (type: string) => Object.assign(document.createElement('input'), { type })
  it('treats text fields as typing', () => {
    expect(isTyping(input('text'))).toBe(true)
    expect(isTyping(input('search'))).toBe(true)
    expect(isTyping(input('number'))).toBe(true)
    expect(isTyping(document.createElement('textarea'))).toBe(true)
  })
  it('leaves bindings working on checkboxes and buttons', () => {
    expect(isTyping(input('checkbox'))).toBe(false)
    expect(isTyping(input('radio'))).toBe(false)
    expect(isTyping(input('button'))).toBe(false)
    expect(isTyping(document.createElement('button'))).toBe(false)
  })
  it('a slider keeps its keys when focused from the keyboard, not after a pointer press', () => {
    const slider = input('range')
    document.body.append(slider)
    slider.focus()
    expect(isTyping(slider)).toBe(true)
    slider.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(isTyping(slider)).toBe(false)
    slider.blur()
    slider.focus()
    expect(isTyping(slider)).toBe(true)
    slider.remove()
  })
})
