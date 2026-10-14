import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) return p
  }
  return null
}

/**
 * Pointer-based reordering for lists and grids (mouse, pen and touch). Items carry
 * `data-sort-index`; the list is reordered live via `onMove(from, to)` while dragging. With
 * `longPress`, touch drags start after a 300 ms hold so normal swipes still scroll.
 */
export function useDragSort(onMove: (from: number, to: number) => void, opts: { longPress?: boolean } = {}) {
  const containerRef = useRef<HTMLElement | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const moveRef = useRef(onMove)
  useLayoutEffect(() => {
    moveRef.current = onMove
  })
  /** Callback ref for the element that contains the `data-sort-index` items. */
  const ref = useCallback((el: HTMLElement | null) => {
    containerRef.current = el
  }, [])
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  const onPointerDown = useCallback(
    (index: number) => (e: RPointerEvent) => {
      if (e.button !== 0) return
      const container = containerRef.current
      if (!container) return
      const touch = e.pointerType === 'touch'
      const sx = e.clientX
      const sy = e.clientY
      let cur = index
      let active = false
      let px = sx
      let py = sy
      let raf = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const scroller = scrollParent(container)

      const start = () => {
        active = true
        setDragging(cur)
        navigator.vibrate?.(10)
        raf = requestAnimationFrame(tick)
      }
      const target = (x: number, y: number) => {
        const items = [...container.querySelectorAll<HTMLElement>('[data-sort-index]')]
        let best = -1
        let bestD = Infinity
        for (const it of items) {
          const r = it.getBoundingClientRect()
          const i = Number(it.dataset.sortIndex)
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i
          const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2))
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
        return best
      }
      const tick = () => {
        if (!active) return
        if (scroller) {
          const r = scroller.getBoundingClientRect()
          const edge = 48
          if (py < r.top + edge) scroller.scrollBy(0, -Math.ceil((r.top + edge - py) / 4))
          else if (py > r.bottom - edge) scroller.scrollBy(0, Math.ceil((py - (r.bottom - edge)) / 4))
        }
        const t = target(px, py)
        if (t >= 0 && t !== cur) {
          moveRef.current(cur, t)
          cur = t
          setDragging(t)
        }
        raf = requestAnimationFrame(tick)
      }
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return
        px = ev.clientX
        py = ev.clientY
        const dist = Math.hypot(px - sx, py - sy)
        if (!active) {
          if (touch && opts.longPress) {
            if (dist > 8) end()
          } else if (dist > 5) start()
        }
      }
      const blockTouch = (ev: TouchEvent) => {
        if (active) ev.preventDefault()
      }
      const end = () => {
        clearTimeout(timer)
        cancelAnimationFrame(raf)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        window.removeEventListener('touchmove', blockTouch)
        cleanup.current = null
        if (active) {
          // Swallow the click that follows a drag.
          const stop = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.preventDefault()
          }
          window.addEventListener('click', stop, { capture: true, once: true })
          setTimeout(() => window.removeEventListener('click', stop, true), 50)
        }
        active = false
        setDragging(null)
      }
      if (touch && opts.longPress) timer = setTimeout(start, 300)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
      window.addEventListener('touchmove', blockTouch, { passive: false })
      cleanup.current = end
    },
    [opts.longPress],
  )

  return { ref, dragging, onPointerDown }
}

/** Move an array item (immutable). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice()
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}
