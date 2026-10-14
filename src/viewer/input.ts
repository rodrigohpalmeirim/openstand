import { useEffect, useRef } from 'react'
import { settings, type TouchZone } from '../state/settings'
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

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/**
 * Keyboard / Bluetooth page-turner pedals. Most pedals (AirTurn, PageFlip, Donner, …) emulate a
 * keyboard sending arrow keys, PageUp/PageDown or Space. Long-press bindings fire after 500ms hold.
 */
export function useKeyBindings(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const held = new Map<string, { timer: number; fired: boolean }>()
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
        if (short) runAction(short.action, 'key')
        return
      }
      const st = { fired: false, timer: 0 }
      st.timer = window.setTimeout(() => {
        st.fired = true
        runAction(long.action, 'key')
      }, 500)
      held.set(id, st)
    }
    const up = (e: KeyboardEvent) => {
      const id = keyId(e)
      const st = held.get(id)
      if (!st) return
      clearTimeout(st.timer)
      held.delete(id)
      if (!st.fired) {
        const short = settings().pageTurn.keys.find((k) => (k.key === id || k.key === e.key) && !k.long)
        if (short) runAction(short.action, 'key')
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      held.forEach((s) => clearTimeout(s.timer))
    }
  }, [enabled])
}

interface GestureOpts {
  /** Disabled while annotating so strokes don't turn pages. */
  enabled: boolean
  /** Current zoom; swipes are disabled when zoomed in so panning works. */
  zoomed: boolean
  onPinch?: (scale: number, cx: number, cy: number) => void
  onPinchEnd?: () => void
}

/** Pointer gestures on the performance stage: zone taps, swipes, double tap, long press, pinch. */
export function useStageGestures(ref: React.RefObject<HTMLElement | null>, opts: GestureOpts) {
  const o = useRef(opts)
  o.current = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const pts = new Map<number, { x: number; y: number; t: number; sx: number; sy: number }>()
    let pinchStart = 0
    let longTimer = 0
    let longFired = false
    let lastTap = { t: 0, x: 0, y: 0 }
    let tapTimer = 0
    let lastTurn = 0
    let multi = false

    const fire = (a: ActionId) => {
      if (a === 'nextPage' || a === 'prevPage') {
        const now = performance.now()
        if (now - lastTurn < settings().pageTurn.debounceMs) return
        lastTurn = now
      }
      runAction(a, 'touch')
    }

    const down = (e: PointerEvent) => {
      if (!o.current.enabled) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), sx: e.clientX, sy: e.clientY })
      if (pts.size === 2) {
        multi = true
        clearTimeout(longTimer)
        const [a, b] = [...pts.values()]
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y)
      } else if (pts.size === 1) {
        multi = false
        longFired = false
        clearTimeout(longTimer)
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
      if (Math.hypot(p.x - p.sx, p.y - p.sy) > 12) clearTimeout(longTimer)
      if (pts.size === 2 && pinchStart > 0) {
        const [a, b] = [...pts.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        o.current.onPinch?.(d / pinchStart, (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
    }
    const up = (e: PointerEvent) => {
      const p = pts.get(e.pointerId)
      pts.delete(e.pointerId)
      clearTimeout(longTimer)
      if (!p || !o.current.enabled) return
      if (multi) {
        if (pts.size === 0) {
          multi = false
          pinchStart = 0
          o.current.onPinchEnd?.()
        }
        return
      }
      if (longFired) return
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
      pts.delete(e.pointerId)
      clearTimeout(longTimer)
      if (pts.size === 0 && multi) {
        multi = false
        o.current.onPinchEnd?.()
      }
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
