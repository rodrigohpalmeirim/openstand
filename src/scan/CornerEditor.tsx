import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '../ui/primitives'
import { isConvexQuad, type Pt, type Quad } from './geometry'

const PAD = 28
const LOUPE = 132
const ZOOM = 3
const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
const EDGE_NAMES = ['top', 'right', 'bottom', 'left']

/**
 * Photo with the paper outline: four draggable corners (and four edge handles that move a whole
 * side), a magnifier while dragging, arrow-key nudging for keyboard users.
 */
export function CornerEditor({
  url,
  width,
  height,
  quad,
  onChange,
}: {
  url: string
  width: number
  height: number
  quad: Quad
  onChange: (q: Quad) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const loupe = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<{ handle: number; at: Pt } | null>(null)
  const quadRef = useRef(quad)
  useLayoutEffect(() => {
    quadRef.current = quad
  })

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const scale = Math.max(0.0001, Math.min((size.w - PAD * 2) / width, (size.h - PAD * 2) / height))
  const dw = width * scale
  const dh = height * scale
  const ox = (size.w - dw) / 2
  const oy = (size.h - dh) / 2
  const toScreen = (p: Pt) => ({ x: ox + p.x * dw, y: oy + p.y * dh })
  const pts = quad.map(toScreen)

  /** Handles 0–3 are corners; 4–7 are the sides starting at corner (h − 4). */
  const moveHandle = (q: Quad, handle: number, dx: number, dy: number): Quad | null => {
    const next = q.map((p) => ({ ...p })) as Quad
    const idx = handle < 4 ? [handle] : [handle - 4, (handle - 3) % 4]
    for (const i of idx) {
      next[i].x = Math.max(0, Math.min(1, q[i].x + dx))
      next[i].y = Math.max(0, Math.min(1, q[i].y + dy))
    }
    return isConvexQuad(next) ? next : null
  }

  const startDrag = (handle: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    const q0 = quadRef.current
    const at = (q: Quad) => (handle < 4 ? q[handle] : { x: (q[handle - 4].x + q[(handle - 3) % 4].x) / 2, y: (q[handle - 4].y + q[(handle - 3) % 4].y) / 2 })
    setDrag({ handle, at: at(q0) })
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const next = moveHandle(q0, handle, (ev.clientX - start.x) / dw, (ev.clientY - start.y) / dh)
      if (!next) return
      onChange(next)
      setDrag({ handle, at: at(next) })
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKey = (handle: number) => (e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 10 : 1) / Math.max(dw, dh)
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d) return
    e.preventDefault()
    const next = moveHandle(quad, handle, d[0], d[1])
    if (next) onChange(next)
  }

  // Draw the magnifier: the photo around the dragged point at ZOOM× the on-screen size, plus the outline.
  useEffect(() => {
    const c = loupe.current
    const im = img.current
    if (!drag || !c || !im || !im.complete) return
    const dpr = window.devicePixelRatio || 1
    c.width = LOUPE * dpr
    c.height = LOUPE * dpr
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const k = scale * ZOOM // screen px per photo px inside the loupe
    const cx0 = drag.at.x * width
    const cy0 = drag.at.y * height
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, LOUPE, LOUPE)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(im, cx0 - LOUPE / 2 / k, cy0 - LOUPE / 2 / k, LOUPE / k, LOUPE / k, 0, 0, LOUPE, LOUPE)
    const map = (p: Pt) => [(p.x * width - cx0) * k + LOUPE / 2, (p.y * height - cy0) * k + LOUPE / 2] as const
    const q = quadRef.current
    ctx.strokeStyle = 'rgba(251,146,60,0.95)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    q.forEach((p, i) => (i ? ctx.lineTo(...map(p)) : ctx.moveTo(...map(p))))
    ctx.closePath()
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(LOUPE / 2 - 9, LOUPE / 2)
    ctx.lineTo(LOUPE / 2 + 9, LOUPE / 2)
    ctx.moveTo(LOUPE / 2, LOUPE / 2 - 9)
    ctx.lineTo(LOUPE / 2, LOUPE / 2 + 9)
    ctx.stroke()
  }, [drag, scale, width, height])

  // Keep the loupe clear of the finger and hand: in the top corner on the other side of the stage.
  let loupePos: Pt | null = null
  if (drag) {
    const p = toScreen(drag.at)
    const left = p.x > size.w / 2
    loupePos = { x: left ? 8 : size.w - LOUPE - 8, y: 8 }
    // Very wide, short stages: if the point sits right under that corner, use the bottom instead.
    if (Math.abs(p.x - (loupePos.x + LOUPE / 2)) < LOUPE && p.y < LOUPE + 24) loupePos.y = size.h - LOUPE - 8
  }

  const poly = pts.map((p) => `${p.x},${p.y}`).join(' ')
  const handles = [
    ...pts.map((p, i) => ({ p, i, side: false })),
    ...pts.map((p, i) => {
      const b = pts[(i + 1) % 4]
      return { p: { x: (p.x + b.x) / 2, y: (p.y + b.y) / 2 }, i: i + 4, side: true }
    }),
  ]

  return (
    <div ref={box} className="relative h-full w-full touch-none select-none overflow-hidden">
      {size.w > 0 && (
        <>
          <img
            ref={img}
            src={url}
            alt="Photo of the page"
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={{ left: ox, top: oy, width: dw, height: dh }}
          />
          <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h}>
            <path d={`M0,0H${size.w}V${size.h}H0Z M${poly.replaceAll(' ', ' L')}Z`} fillRule="evenodd" fill="rgba(0,0,0,0.5)" />
            <polygon points={poly} fill="none" stroke="var(--os-accent)" strokeWidth={2} strokeLinejoin="round" />
          </svg>
          {handles.map(({ p, i, side }) => (
            <button
              key={i}
              type="button"
              aria-label={side ? `Move ${EDGE_NAMES[i - 4]} edge` : `Move ${CORNER_NAMES[i]} corner`}
              title={side ? 'Drag to move this edge' : 'Drag to the paper corner'}
              onPointerDown={startDrag(i)}
              onKeyDown={onKey(i)}
              className="group absolute flex size-12 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing"
              style={{ left: p.x, top: p.y }}
            >
              <span
                className={cx(
                  'block rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.4)] transition group-focus-visible:ring-4 group-focus-visible:ring-accent/60',
                  side ? 'h-2.5 w-6 bg-white/80' : 'size-6 bg-accent/30',
                  drag?.handle === i && 'scale-110 bg-accent/60',
                )}
                style={side ? { transform: `rotate(${(Math.atan2(pts[(i - 3) % 4].y - pts[i - 4].y, pts[(i - 3) % 4].x - pts[i - 4].x) * 180) / Math.PI}deg)` } : undefined}
              />
            </button>
          ))}
          {loupePos && (
            <canvas
              ref={loupe}
              aria-hidden
              className="pointer-events-none absolute rounded-full border-2 border-white shadow-xl"
              style={{ left: loupePos.x, top: loupePos.y, width: LOUPE, height: LOUPE }}
            />
          )}
        </>
      )}
    </div>
  )
}
