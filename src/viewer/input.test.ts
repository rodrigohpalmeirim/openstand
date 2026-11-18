import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PEN_TIMING, usePenPresence } from '../annotations/pen'
import { DEFAULT_SETTINGS, useSettings, type KeyBinding, type TouchZone } from '../state/settings'
import { onAction, type ActionId } from './actions'
import { claimKey, ignorePointer, isTyping, keyBindingHandlers, keyId, stageRole, useStageGestures, zoneAreas, type StageMode } from './input'

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

  it('leaves a key alone that another handler claimed', () => {
    bind([{ key: 'KeyP', action: 'prevSong' }])
    const claimed = key('keydown', 'KeyP')
    claimKey(claimed)
    h.down(claimed)
    expect(ran).toEqual([])
    h.down(key('keydown', 'KeyP'))
    expect(ran).toEqual(['prevSong'])
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

const zoneGrid = (rows: ActionId[][]) =>
  Object.fromEntries((['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'] as TouchZone[]).map((z, i) => [z, rows.flat()[i]])) as Record<TouchZone, ActionId>

describe('zoneAreas', () => {
  it('draws the default zones as three columns', () => {
    expect(zoneAreas(DEFAULT_SETTINGS.pageTurn.zones).map(({ action, col, rows, cols }) => [action, col, rows, cols])).toEqual([
      ['prevPage', 0, 3, 1],
      ['toggleToolbar', 1, 3, 1],
      ['nextPage', 2, 3, 1],
    ])
  })

  it('merges rows and leftover rectangles', () => {
    const areas = zoneAreas(
      zoneGrid([
        ['prevPage', 'prevPage', 'prevPage'],
        ['prevPage', 'toggleToolbar', 'nextPage'],
        ['nextPage', 'nextPage', 'nextPage'],
      ]),
    )
    expect(areas.map(({ zone, rows, cols }) => [zone, rows, cols])).toEqual([
      ['tl', 1, 3],
      ['ml', 1, 1],
      ['mc', 1, 1],
      ['mr', 1, 1],
      ['bl', 1, 3],
    ])
  })
})

describe('stageRole', () => {
  const reading: StageMode = { annotating: false, stylusOnly: false, penInk: true }
  const drawing: StageMode = { annotating: true, stylusOnly: false, penInk: true }
  const stylus: StageMode = { annotating: true, stylusOnly: true, penInk: true }

  it('a pen that writes never navigates', () => {
    expect(stageRole('pen', reading)).toBe('none')
    expect(stageRole('pen', drawing)).toBe('none')
    expect(stageRole('pen', stylus)).toBe('none')
    expect(stageRole('pen', { ...reading, stylusOnly: true })).toBe('none')
  })

  it('under performance lock a pen is a pointer like any other', () => {
    expect(stageRole('pen', { ...reading, penInk: false })).toBe('full')
  })

  it('reading: fingers and the mouse use every binding', () => {
    expect(stageRole('touch', reading)).toBe('full')
    expect(stageRole('mouse', reading)).toBe('full')
    expect(stageRole('touch', { ...reading, stylusOnly: true })).toBe('full')
  })

  it('annotating: fingers that draw keep pinch and multi-finger taps; with stylus only they navigate', () => {
    expect(stageRole('touch', drawing)).toBe('multi')
    expect(stageRole('touch', stylus)).toBe('full')
  })

  it('annotating: the mouse draws', () => {
    expect(stageRole('mouse', drawing)).toBe('none')
    expect(stageRole('mouse', stylus)).toBe('none')
  })
})

describe('useStageGestures', () => {
  const initial = useSettings.getState().s
  let stage: HTMLDivElement
  let fired: ActionId[]
  let off: () => void
  let mode: StageMode
  let nextId = 10
  let unmount: (() => void)[] = []
  // Module state (the page-turn debounce, the pen's last events) outlives a test: keep the clock moving forward.
  let clock = 0

  const ev = (type: string, pointerType: string, pointerId: number, x: number, y: number, target: EventTarget = stage) =>
    target.dispatchEvent(new PointerEvent(type, { pointerType, pointerId, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }))
  const down = (pointerType: string, x: number, y: number) => {
    const id = nextId++
    ev('pointerdown', pointerType, id, x, y)
    return { id, pointerType, x, y }
  }
  const moveTo = (p: { id: number; pointerType: string; x: number; y: number }, x: number, y: number) => {
    p.x = x
    p.y = y
    ev('pointermove', p.pointerType, p.id, x, y, window)
  }
  const lift = (p: { id: number; pointerType: string; x: number; y: number }) => ev('pointerup', p.pointerType, p.id, p.x, p.y, window)
  const tap = (pointerType: string, x: number, y: number) => {
    const p = down(pointerType, x, y)
    vi.advanceTimersByTime(40)
    lift(p)
  }
  /** Pen events as the browser sends them to the window. */
  const pen = (type: string, opts: PointerEventInit = {}) => window.dispatchEvent(new PointerEvent(type, { pointerType: 'pen', pointerId: 2, bubbles: true, ...opts }))

  const mount = (onPinch?: () => void) => {
    unmount.push(renderHook(() => usePenPresence(true)).unmount)
    unmount.push(renderHook(() => useStageGestures({ current: stage }, { ...mode, zoomed: false, onPinch })).unmount)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    useSettings.getState().setIn('pageTurn', { debounceMs: 0, twoFingerTap: 'undoAnnotation', threeFingerTap: 'redoAnnotation', longPress: 'toggleNightMode', swipeUp: 'scrollDown' })
    stage = document.createElement('div')
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900, x: 0, y: 0, toJSON: () => ({}) })
    document.body.append(stage)
    fired = []
    off = onAction((a) => fired.push(a))
    mode = { annotating: false, stylusOnly: false, penInk: true }
    vi.advanceTimersByTime((clock += 100_000))
  })
  afterEach(() => {
    unmount.forEach((u) => u())
    unmount = []
    off()
    stage.remove()
    vi.useRealTimers()
    useSettings.getState().replace(initial)
  })

  it('reading: a finger tap fires its zone, a swipe its binding, a hold the long press', () => {
    mount()
    tap('touch', 800, 450)
    tap('touch', 100, 450)
    expect(fired).toEqual(['nextPage', 'prevPage'])
    const p = down('touch', 600, 450)
    vi.advanceTimersByTime(100)
    moveTo(p, 400, 455)
    lift(p)
    expect(fired).toEqual(['nextPage', 'prevPage', 'nextPage'])
    const h = down('touch', 450, 450)
    vi.advanceTimersByTime(700)
    lift(h)
    expect(fired.at(-1)).toBe('toggleNightMode')
    expect(fired).toHaveLength(4)
  })

  it('a pen tap or stroke on the stage never fires anything', () => {
    mount()
    tap('pen', 800, 450)
    const p = down('pen', 600, 450)
    moveTo(p, 300, 450)
    lift(p)
    vi.advanceTimersByTime(1000)
    expect(fired).toEqual([])
  })

  it('under performance lock a pen taps like a finger', () => {
    mode = { ...mode, penInk: false }
    mount()
    tap('pen', 800, 450)
    expect(fired).toEqual(['nextPage'])
  })

  it('a touch that lands while a pen hovers is ignored for its whole life', () => {
    mount()
    pen('pointermove', { buttons: 0 })
    tap('touch', 800, 450)
    const p = down('touch', 600, 450)
    // The pen goes away while the finger is still down: it stays ignored.
    pen('pointerout', { relatedTarget: null })
    vi.advanceTimersByTime(100)
    moveTo(p, 300, 450)
    lift(p)
    const held = down('touch', 450, 450)
    vi.advanceTimersByTime(700)
    lift(held)
    expect(fired).toEqual(['toggleNightMode'])
    // (the last one landed after the pen left: fingers work again at once)
  })

  it('two fingers landing while a pen hovers are no pinch and no multi-finger tap', () => {
    const onPinch = vi.fn()
    mount(onPinch)
    pen('pointermove', { buttons: 0 })
    const a = down('touch', 300, 450)
    const b = down('touch', 600, 450)
    moveTo(b, 700, 450)
    lift(a)
    lift(b)
    tap('touch', 800, 450)
    expect(onPinch).not.toHaveBeenCalled()
    expect(fired).toEqual([])
  })

  it('fingers work again once a hovering pen lies still', () => {
    mount()
    pen('pointermove', { buttons: 0 })
    vi.advanceTimersByTime(PEN_TIMING.recent - 200)
    tap('touch', 800, 450)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(300)
    tap('touch', 800, 450)
    expect(fired).toEqual(['nextPage'])
  })

  it('a pen without hover blocks fingers for the palm window after its last contact', () => {
    mount()
    // Down, up, and it "leaves" at the lift.
    pen('pointerdown', { buttons: 1 })
    pen('pointerup')
    pen('pointerout', { relatedTarget: null })
    vi.advanceTimersByTime(PEN_TIMING.palm - 100)
    tap('touch', 800, 450)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(200)
    tap('touch', 800, 450)
    expect(fired).toEqual(['nextPage'])
  })

  it('with palm rejection off a present pen blocks nothing', () => {
    useSettings.getState().setIn('annotations', { palmRejection: false })
    mount()
    pen('pointermove', { buttons: 0 })
    tap('touch', 800, 450)
    expect(fired).toEqual(['nextPage'])
  })

  it('a touch already down when the pen makes contact fires nothing when it lifts', () => {
    mount()
    const p = down('touch', 800, 450)
    vi.advanceTimersByTime(50)
    pen('pointerdown', { buttons: 1 })
    vi.advanceTimersByTime(50)
    lift(p)
    // Nor does it fire the long press it was on its way to.
    const q = down('touch', 100, 450)
    pen('pointerup')
    pen('pointerout', { relatedTarget: null })
    vi.advanceTimersByTime(1000)
    lift(q)
    expect(fired).toEqual([])
  })

  it('a finger that scrolled the page by hand is neither a swipe nor a tap', () => {
    mount()
    const p = down('touch', 450, 700)
    vi.advanceTimersByTime(100)
    moveTo(p, 450, 500)
    ignorePointer(p.id)
    lift(p)
    expect(fired).toEqual([])
    // The same drag that scrolled nothing is a swipe.
    const q = down('touch', 450, 700)
    vi.advanceTimersByTime(100)
    moveTo(q, 450, 500)
    lift(q)
    expect(fired).toEqual(['scrollDown'])
  })

  it('a pointer marked before it reaches the stage (a palm) is not tracked at all', () => {
    mount()
    const id = nextId++
    ignorePointer(id)
    ev('pointerdown', 'touch', id, 800, 450)
    ev('pointerup', 'touch', id, 800, 450, window)
    expect(fired).toEqual([])
    tap('touch', 800, 450)
    expect(fired).toEqual(['nextPage'])
  })

  it('two- and three-finger taps fire their bindings', () => {
    mount()
    const a = down('touch', 300, 450)
    const b = down('touch', 500, 450)
    vi.advanceTimersByTime(80)
    lift(a)
    lift(b)
    expect(fired).toEqual(['undoAnnotation'])
    const c = [down('touch', 300, 450), down('touch', 450, 450), down('touch', 600, 450)]
    vi.advanceTimersByTime(80)
    c.forEach(lift)
    expect(fired).toEqual(['undoAnnotation', 'redoAnnotation'])
    // Fingers that moved (a pinch or a pan) are not a tap.
    const d = down('touch', 300, 450)
    const e = down('touch', 500, 450)
    moveTo(e, 600, 450)
    lift(d)
    lift(e)
    expect(fired).toHaveLength(2)
  })

  it('annotating with fingers drawing: no single-finger gesture, multi-finger taps and pinch still work', () => {
    mode = { annotating: true, stylusOnly: false, penInk: true }
    const onPinch = vi.fn()
    mount(onPinch)
    tap('touch', 800, 450)
    const s = down('touch', 600, 450)
    moveTo(s, 300, 450)
    lift(s)
    const h = down('touch', 450, 450)
    vi.advanceTimersByTime(900)
    lift(h)
    tap('mouse', 800, 450)
    expect(fired).toEqual([])
    const a = down('touch', 300, 450)
    const b = down('touch', 500, 450)
    vi.advanceTimersByTime(80)
    lift(a)
    lift(b)
    expect(fired).toEqual(['undoAnnotation'])
    const c = down('touch', 300, 450)
    const d = down('touch', 500, 450)
    moveTo(d, 650, 450)
    expect(onPinch).toHaveBeenCalled()
    lift(c)
    lift(d)
    expect(fired).toEqual(['undoAnnotation'])
  })

  it('annotating with stylus only: fingers use the normal bindings, the mouse still draws', () => {
    mode = { annotating: true, stylusOnly: true, penInk: true }
    mount()
    tap('touch', 800, 450)
    const s = down('touch', 600, 450)
    vi.advanceTimersByTime(50)
    moveTo(s, 300, 450)
    lift(s)
    tap('mouse', 100, 450)
    tap('pen', 100, 450)
    expect(fired).toEqual(['nextPage', 'nextPage'])
  })

  it('a pointer on a text being typed is left alone', () => {
    mount()
    const area = document.createElement('textarea')
    stage.append(area)
    const id = nextId++
    ev('pointerdown', 'touch', id, 800, 450, area)
    ev('pointerup', 'touch', id, 800, 450, window)
    expect(fired).toEqual([])
  })
})
