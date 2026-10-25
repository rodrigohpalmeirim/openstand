import { useEffect, useRef } from 'react'
import { settings, type KeyBinding, type TouchZone } from '../state/settings'
import { runAction, type ActionId } from './actions'

export function zoneAt(x: number, y: number, w: number, h: number): TouchZone {
  const col = x < w / 3 ? 'l' : x > (2 * w) / 3 ? 'r' : 'c'
  const row = y < h / 3 ? 't' : y > (2 * h) / 3 ? 'b' : 'm'
  return (row + col) as TouchZone
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
 * Keydown/keyup handlers for the bindings in settings. A key with both a press and a hold binding
 * waits: released before 500ms it runs the press action, held longer the hold action.
 */
export function keyBindingHandlers(run: (a: ActionId) => void = (a) => runAction(a, 'key')) {
  // Keyed by physical key: the binding id of a modifier differs between its keydown ("Shift+ShiftLeft") and keyup ("ShiftLeft").
  const held = new Map<string, { timer: number; fired: boolean; short?: KeyBinding }>()
  const down = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return
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
export function useKeyBindings(enabled: boolean) {
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

interface GestureOpts {
  /** Disabled while annotating so strokes don't turn pages. */
  enabled: boolean
  /** When disabled, still allow two-finger pinch zoom (used while annotating). */
  pinchOnly?: boolean
  /** When disabled, finger taps and swipes outside the page still turn pages (annotating with stylus only). */
  fingerTurns?: boolean
  /** Current zoom; swipes are disabled when zoomed in so panning works. */
  zoomed: boolean
  /** `scale` is relative to the finger distance at the start; (sx, sy) is the start midpoint. */
  onPinch?: (scale: number, cx: number, cy: number, sx: number, sy: number) => void
  /** Fires once when a pinch ends: a finger lifts (fewer than two remain), a third lands, or it is cancelled. */
  onPinchEnd?: () => void
}

const TURN_ACTION = /^(next|prev)(Page|OnePage|TwoPages|PageLoop|HalfPage|Song)$|^(first|last)Page$|^scroll(Up|Down)$|^activateLinkOrTurn$/

/** Pointer gestures on the performance stage: zone taps, swipes, double tap, long press, pinch. */
export function useStageGestures(ref: React.RefObject<HTMLElement | null>, opts: GestureOpts) {
  const o = useRef(opts)
  o.current = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // `turn`: this pointer may fire tap/swipe actions (always, unless the stage is disabled).
    const pts = new Map<number, { x: number; y: number; t: number; sx: number; sy: number; turn: boolean }>()
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

    const down = (e: PointerEvent) => {
      const touch = e.pointerType === 'touch'
      const fingerTurn = touch && !!o.current.fingerTurns && !(e.target instanceof Element && e.target.closest('[data-annot-key]'))
      if (!o.current.enabled && !fingerTurn && !(o.current.pinchOnly && touch)) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), sx: e.clientX, sy: e.clientY, turn: o.current.enabled || fingerTurn })
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
        if (!o.current.enabled) return
        longTimer = window.setTimeout(() => {
          const lp = settings().pageTurn.longPress
          if (lp !== 'none') {
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
      clearTimeout(longTimer)
      if (!p) return
      // Lifting one finger ends the pinch even while the other stays down.
      if (pts.size < 2) endPinch()
      if (!p.turn && !multi) return
      if (multi) {
        if (pts.size === 0) {
          multi = false
          if (o.current.enabled && !multiMoved && performance.now() - multiStart < 350) {
            const cfg = settings().pageTurn
            fire(maxPts >= 3 ? cfg.threeFingerTap : cfg.twoFingerTap)
          }
          maxPts = 0
        }
        return
      }
      if (longFired) return
      // A disabled stage (annotating) only turns pages.
      const enabled = o.current.enabled
      const go = (a: ActionId) => (enabled || TURN_ACTION.test(a)) && fire(a)
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
        if (a !== 'none') go(a)
        return
      }
      if (dist > 12 || dt > 600) return
      const rect = el.getBoundingClientRect()
      const x = p.x - rect.left
      const y = p.y - rect.top
      const zoneAction = cfg.zones[zoneAt(x, y, rect.width, rect.height)]
      if (cfg.doubleTap === 'none' || !enabled) {
        go(zoneAction)
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
      if (!pts.delete(e.pointerId)) return
      clearTimeout(longTimer)
      if (pts.size < 2) endPinch()
      if (pts.size === 0) multi = false
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      clearTimeout(longTimer)
      clearTimeout(tapTimer)
    }
  }, [ref])
}
