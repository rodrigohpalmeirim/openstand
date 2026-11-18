import { useEffect, useRef } from 'react'
import { touchBlockedByPen } from '../annotations/pen'
import { useAnnotUI } from '../annotations/store'
import { settings, type KeyBinding, type TouchZone } from '../state/settings'
import { runAction, type ActionId } from './actions'

export function zoneAt(x: number, y: number, w: number, h: number): TouchZone {
  const col = x < w / 3 ? 'l' : x > (2 * w) / 3 ? 'r' : 'c'
  const row = y < h / 3 ? 't' : y > (2 * h) / 3 ? 'b' : 'm'
  return (row + col) as TouchZone
}

const GRID = [
  ['tl', 'tc', 'tr'],
  ['ml', 'mc', 'mr'],
  ['bl', 'bc', 'br'],
] as const satisfies readonly (readonly TouchZone[])[]

export interface ZoneArea {
  zone: TouchZone
  action: ActionId
  row: number
  col: number
  rows: number
  cols: number
}

/**
 * The zones as rectangles for drawing: runs along a row doing the same thing, then such runs stacked
 * in the rows below (so the default columns stay columns).
 */
export function zoneAreas(zones: Record<TouchZone, ActionId>): ZoneArea[] {
  const out: ZoneArea[] = []
  GRID.forEach((cells, row) => {
    for (let col = 0; col < 3; ) {
      const zone = cells[col]
      const action = zones[zone]
      let cols = 1
      while (col + cols < 3 && zones[cells[col + cols]] === action) cols++
      const above = out.find((a) => a.row + a.rows === row && a.col === col && a.cols === cols && a.action === action)
      if (above) above.rows++
      else out.push({ zone, action, row, col, rows: 1, cols })
      col += cols
    }
  })
  return out
}

/** Normalise a KeyboardEvent to the identifier stored in bindings. */
export function keyId(e: KeyboardEvent): string {
  const mods = (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.metaKey ? 'Meta+' : '') + (e.shiftKey ? 'Shift+' : '')
  // Prefer the physical code (layout-independent); media keys only have a key.
  const base = e.code && e.code !== 'Unidentified' ? e.code : e.key
  return mods + base
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Escape: 'Esc',
  Space: 'Space',
  Enter: 'Enter',
}

/** Human-readable label for a stored key id such as "Shift+KeyN" or "PageDown". */
export function keyLabel(id: string): string {
  return id
    .split('+')
    .map((part) => KEY_NAMES[part] ?? part.replace(/^(Key|Digit|Numpad)/, ''))
    .join(' + ')
}

/** Shared across touch and pedals so a bouncing pedal or a double tap can't turn two pages. */
let lastTurn = 0
function debounced(a: ActionId): boolean {
  if (a !== 'nextPage' && a !== 'prevPage') return false
  const now = performance.now()
  if (now - lastTurn < settings().pageTurn.debounceMs) return true
  lastTurn = now
  return false
}

/** Inputs that take no text (checkboxes, buttons…) leave pedal and key bindings working. */
const NON_TEXT_INPUTS = /^(checkbox|radio|button|submit|reset|color|file|image)$/

/**
 * Sliders focused by a pointer press leave arrow keys to the bindings (a pedal must not nudge a slider
 * that merely kept focus from a tap); focused from the keyboard (Tab) they keep their arrows/Home/End.
 */
const pointerSliders = new WeakSet<Element>()
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') pointerSliders.add(e.target)
    },
    true,
  )
  document.addEventListener('focusout', (e) => e.target instanceof Element && pointerSliders.delete(e.target), true)
}

export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    /^(TEXTAREA|SELECT)$/.test(t.tagName) ||
    (t instanceof HTMLInputElement && (t.type === 'range' ? !pointerSliders.has(t) : !NON_TEXT_INPUTS.test(t.type))))

/** Physical key of an event, without modifiers: keyup of a modifier has no modifier flag set. */
const physicalKey = (e: KeyboardEvent) => (e.code && e.code !== 'Unidentified' ? e.code : e.key)

/**
 * Keydowns another handler took for itself (the annotation toolbar's tool hotkeys, undo, nudging a
 * selection): the binding for that key must not run as well. Claim from a listener that runs before the
 * bindings' one, which is on the window in the bubble phase (so: on the document, or capturing).
 */
const claimedKeys = new WeakSet<KeyboardEvent>()
export function claimKey(e: KeyboardEvent) {
  claimedKeys.add(e)
}

/**
 * Keydown/keyup handlers for the bindings in settings. A key with both a press and a hold binding
 * waits: released before 500ms it runs the press action, held longer the hold action.
 */
export function keyBindingHandlers(run: (a: ActionId) => void = (a) => runAction(a, 'key')) {
  // Keyed by physical key: the binding id of a modifier differs between its keydown ("Shift+ShiftLeft") and keyup ("ShiftLeft").
  const held = new Map<string, { timer: number; fired: boolean; short?: KeyBinding }>()
  const down = (e: KeyboardEvent) => {
    if (isTyping(e.target) || claimedKeys.has(e)) return
    const id = keyId(e)
    const binds = settings().pageTurn.keys.filter((k) => k.key === id || k.key === e.key)
    if (!binds.length) return
    e.preventDefault()
    if (e.repeat) return
    const long = binds.find((b) => b.long)
    const short = binds.find((b) => !b.long)
    if (!long) {
      if (short && !debounced(short.action)) run(short.action)
      return
    }
    const st = { fired: false, timer: 0, short }
    st.timer = window.setTimeout(() => {
      st.fired = true
      run(long.action)
    }, 500)
    held.set(physicalKey(e), st)
  }
  const up = (e: KeyboardEvent) => {
    const k = physicalKey(e)
    const st = held.get(k)
    if (!st) return
    clearTimeout(st.timer)
    held.delete(k)
    if (!st.fired && st.short && !debounced(st.short.action)) run(st.short.action)
  }
  const dispose = () => held.forEach((s) => clearTimeout(s.timer))
  return { down, up, dispose }
}

/**
 * Keyboard / Bluetooth page-turner pedals. Most pedals (AirTurn, PageFlip, Donner, …) emulate a
 * keyboard sending arrow keys, PageUp/PageDown or Space. Long-press bindings fire after 500ms hold.
 */
export function useKeyBindings(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const { down, up, dispose } = keyBindingHandlers()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      dispose()
    }
  }, [enabled])
}

/** The viewer state that decides what a pointer on the stage may do. */
export interface StageMode {
  /** The full annotation mode (docked toolbar) is on. */
  annotating: boolean
  /** In the full mode only a pen draws; fingers keep navigating. */
  stylusOnly: boolean
  /** A pen writes on the pages (always, except under performance lock), so it never navigates. */
  penInk: boolean
}

/**
 * `full`: every binding (zone taps, swipes, double tap, long press, pinch, multi-finger taps) ·
 * `multi`: only pinch and multi-finger taps, a single pointer belongs to the drawing · `none`: not a gesture.
 */
export type StageRole = 'full' | 'multi' | 'none'

export function stageRole(pointerType: string, m: StageMode): StageRole {
  if (pointerType === 'pen') return m.penInk || m.annotating ? 'none' : 'full'
  if (!m.annotating) return 'full'
  // Annotating: the mouse draws; fingers draw too unless only the pen does.
  if (pointerType === 'touch') return m.stylusOnly ? 'full' : 'multi'
  return 'none'
}

/**
 * Pointers the stage must not read a gesture from: a palm, or a finger that scrolled the page by hand
 * (the annotation layer does that while it holds touch-action, see `fingerMove` there).
 */
const deadPointers = new Set<number>()
export function ignorePointer(pointerId: number) {
  deadPointers.add(pointerId)
}
/** Forget a pointer that lifted, once everything handling this event has seen that it was dead. */
const buryPointer = (pointerId: number) => deadPointers.has(pointerId) && queueMicrotask(() => deadPointers.delete(pointerId))

interface GestureOpts extends StageMode {
  /** Current zoom; swipes are disabled when zoomed in so panning works. */
  zoomed: boolean
  /** `scale` is relative to the finger distance at the start; (sx, sy) is the start midpoint. */
  onPinch?: (scale: number, cx: number, cy: number, sx: number, sy: number) => void
  /** Fires once when a pinch ends: a finger lifts (fewer than two remain), a third lands, or it is cancelled. */
  onPinchEnd?: () => void
}

/** Pointer gestures on the performance stage: zone taps, swipes, double tap, long press, pinch. */
export function useStageGestures(ref: React.RefObject<HTMLElement | null>, opts: GestureOpts) {
  const o = useRef(opts)
  o.current = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // `single`: this pointer may fire tap/swipe/long-press actions. `dead`: it turned out not to be a gesture.
    const pts = new Map<number, { x: number; y: number; t: number; sx: number; sy: number; single: boolean; dead: boolean }>()
    let pinchStart = 0
    let pinchMid = { x: 0, y: 0 }
    let longTimer = 0
    let longFired = false
    let lastTap = { t: 0, x: 0, y: 0 }
    let tapTimer = 0
    let multi = false
    // Multi-finger taps: max simultaneous pointers, start time and whether fingers moved.
    let maxPts = 0
    let multiStart = 0
    let multiMoved = false

    const fire = (a: ActionId) => {
      if (!debounced(a)) runAction(a, 'touch')
    }
    const endPinch = () => {
      if (pinchStart <= 0) return
      pinchStart = 0
      o.current.onPinchEnd?.()
    }
    /** Nothing that is down now is a gesture any more (a pen landed: those are palms). */
    const killAll = () => {
      clearTimeout(longTimer)
      for (const p of pts.values()) p.dead = true
      multiMoved = true
      endPinch()
    }

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const role = stageRole(e.pointerType, o.current)
      // A palm or a touch under a present pen is ignored for good. So is a pointer while a text annotation
      // is being typed: it places the caret or closes the text, and must not turn the page as well.
      if (role === 'none' || deadPointers.has(e.pointerId) || touchBlockedByPen(e) || isTyping(e.target) || useAnnotUI.getState().editing) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), sx: e.clientX, sy: e.clientY, single: role === 'full', dead: false })
      maxPts = Math.max(maxPts, pts.size)
      if (pts.size === 2) {
        multi = true
        multiStart = performance.now()
        multiMoved = false
        clearTimeout(longTimer)
        const [a, b] = [...pts.values()]
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y)
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      } else if (pts.size > 2) {
        endPinch()
      } else if (pts.size === 1) {
        multi = false
        maxPts = 1
        longFired = false
        clearTimeout(longTimer)
        if (role !== 'full') return
        const id = e.pointerId
        longTimer = window.setTimeout(() => {
          const lp = settings().pageTurn.longPress
          if (lp !== 'none' && !deadPointers.has(id) && !pts.get(id)?.dead) {
            longFired = true
            fire(lp)
          }
        }, 650)
      }
    }
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      if (!p) return
      p.x = e.clientX
      p.y = e.clientY
      if (Math.hypot(p.x - p.sx, p.y - p.sy) > 12) {
        clearTimeout(longTimer)
        if (multi) multiMoved = true
      }
      if (pts.size === 2 && pinchStart > 0) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        o.current.onPinch?.(d / pinchStart, (a.x + b.x) / 2, (a.y + b.y) / 2, pinchMid.x, pinchMid.y)
      }
    }
    const up = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      pts.delete(e.pointerId)
      const dead = deadPointers.has(e.pointerId) || !!p?.dead
      buryPointer(e.pointerId)
      if (!p) return
      clearTimeout(longTimer)
      // Lifting one finger ends the pinch even while the other stays down.
      if (pts.size < 2) endPinch()
      if (multi) {
        if (dead) multiMoved = true
        if (pts.size === 0) {
          multi = false
          // Multi-finger taps work in every state, also while fingers draw (a second finger cancels the stroke).
          if (!multiMoved && performance.now() - multiStart < 350) {
            const cfg = settings().pageTurn
            fire(maxPts >= 3 ? cfg.threeFingerTap : cfg.twoFingerTap)
          }
          maxPts = 0
        }
        return
      }
      if (!p.single || dead || longFired) return
      const dx = p.x - p.sx
      const dy = p.y - p.sy
      const dt = performance.now() - p.t
      const cfg = settings().pageTurn
      const dist = Math.hypot(dx, dy)
      if (dist > 60 && dt < 600) {
        if (o.current.zoomed) return
        const horiz = Math.abs(dx) > Math.abs(dy) * 1.3
        const vert = Math.abs(dy) > Math.abs(dx) * 1.3
        const a = horiz ? (dx < 0 ? cfg.swipeLeft : cfg.swipeRight) : vert ? (dy < 0 ? cfg.swipeUp : cfg.swipeDown) : 'none'
        if (a !== 'none') fire(a)
        return
      }
      if (dist > 12 || dt > 600) return
      const rect = el.getBoundingClientRect()
      const x = p.x - rect.left
      const y = p.y - rect.top
      const zoneAction = cfg.zones[zoneAt(x, y, rect.width, rect.height)]
      if (cfg.doubleTap === 'none') {
        fire(zoneAction)
        return
      }
      const now = performance.now()
      if (now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
        clearTimeout(tapTimer)
        lastTap = { t: 0, x: 0, y: 0 }
        fire(cfg.doubleTap)
        return
      }
      lastTap = { t: now, x, y }
      tapTimer = window.setTimeout(() => fire(zoneAction), 280)
    }
    const cancel = (e: PointerEvent) => {
      buryPointer(e.pointerId)
      if (!pts.delete(e.pointerId)) return
      clearTimeout(longTimer)
      if (pts.size < 2) endPinch()
      if (pts.size === 0) multi = false
    }
    // A pen touching down while fingers are on the stage: that is a hand resting, not a gesture.
    const penDown = (e: PointerEvent) => {
      if (e.pointerType === 'pen' && pts.size && o.current.penInk && settings().annotations.palmRejection) killAll()
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerdown', penDown, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerdown', penDown, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      clearTimeout(longTimer)
      clearTimeout(tapTimer)
    }
  }, [ref])
}
