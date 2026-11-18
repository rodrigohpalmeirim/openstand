import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from '../ui/primitives'
import { applyH, BEND_POINTS, bendPoint, FULL_QUAD, homography, invert3, isConvexQuad, NO_BEND, type Bend, type Mat3, type Pt, type Quad } from './geometry'

const PAD = 28
const LOUPE = 132
const ZOOM = 3
const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
const EDGE_NAMES = ['top', 'right', 'bottom', 'left']
/** How far a side may bow, as a fraction of the page (in the rectified square). */
const MAX_BEND = 0.25
/** Bend handles: first handle index (after 4 corners and 4 sides) and the shortest on-screen side that shows them. */
const BEND0 = 8
const MIN_BEND_SIDE = 150
/** Outline samples per curved side. */
const SEGMENTS = 32

/** Flat page point at parameter t along side i (from corner i towards corner i+1). */
const onSide = (i: number, t: number): [number, number] => [[t, 0], [1, t], [1 - t, 1], [0, 1 - t]][i] as [number, number]
/** Signed outward distance of a rectified point from straight side i. */
const outward = (i: number, r: Pt) => [-r.y, r.x - 1, r.y - 1, -r.x][i]
const controlT = (k: number) => (k + 1) / (BEND_POINTS + 1)
const clampBend = (v: number) => Math.max(-MAX_BEND, Math.min(MAX_BEND, v))
const valuesOf = (b: Bend, side: number) => (b[side].length === BEND_POINTS ? [...b[side]] : new Array<number>(BEND_POINTS).fill(0))

function withValue(b: Bend, side: number, k: number, v: number): Bend {
  const next = b.map((s) => [...s]) as Bend
  const vals = valuesOf(b, side)
  vals[k] = clampBend(v)
  next[side] = vals.every((x) => x === 0) ? [] : vals
  return next
}

/**
 * Photo with the paper outline: four draggable corners, four edge handles that move a whole side, and
 * (when `onBendChange` is given) small handles that bow the page's top and bottom edges to follow a
 * curved book page. A magnifier shows while dragging; arrow keys nudge for keyboard users.
 */
export function CornerEditor({
  url,
  width,
  height,
  quad,
  onChange,
  bend = NO_BEND,
  onBendChange,
  rotation = 0,
}: {
  url: string
  width: number
  height: number
  quad: Quad
  onChange: (q: Quad) => void
  /** Curved sides, in the photo frame of `quad`. */
  bend?: Bend
  onBendChange?: (b: Bend) => void
  /** Quarter turns the output is rotated by: decides which photo sides are the page's top and bottom. */
  rotation?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const loupe = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<{ handle: number; at: Pt } | null>(null)
  const quadRef = useRef(quad)
  const bendRef = useRef(bend)
  useLayoutEffect(() => {
    quadRef.current = quad
    bendRef.current = bend
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
  // Drags read the live layout: the stage can resize mid-drag (toolbar reflow, rotation of the device).
  const layout = useRef({ ox, oy, dw, dh })
  useLayoutEffect(() => {
    layout.current = { ox, oy, dw, dh }
  })

  // H maps the rectified unit square onto the quad (normalized photo coordinates).
  const hOf = (q: Quad) => homography(FULL_QUAD, q)
  /** Photo point (normalized) of flat page point (u,v) under quad q and bend b. */
  const photoAt = (h: Mat3 | null, b: Bend, u: number, v: number): Pt => (h ? applyH(h, bendPoint(b, u, v)) : { x: u, y: v })
  const sidePoint = (h: Mat3 | null, b: Bend, i: number, t: number) => photoAt(h, b, ...onSide(i, t))
  /** The outline as normalized photo points, curved where bent. */
  const outline = (q: Quad, b: Bend): Pt[] => {
    const h = hOf(q)
    const out: Pt[] = []
    for (let i = 0; i < 4; i++) {
      const n = b[i].length ? SEGMENTS : 1
      for (let s = 0; s < n; s++) out.push(sidePoint(h, b, i, s / n))
    }
    return out
  }
  const H = hOf(quad)

  /** Sides that are the page's top and bottom as read (rotateQuad puts quad side (4 − k) % 4 on top). */
  const k = ((rotation % 4) + 4) % 4
  const bendSides = onBendChange ? [(4 - k) % 4, (6 - k) % 4] : []

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

  /** Where a handle sits (normalized photo coordinates). Side handles sit on the curve's midpoint. */
  const handleAt = (q: Quad, b: Bend, handle: number): Pt => {
    if (handle < 4) return q[handle]
    if (handle < BEND0) return sidePoint(hOf(q), b, handle - 4, 0.5)
    const j = handle - BEND0
    return sidePoint(hOf(q), b, Math.floor(j / BEND_POINTS), controlT(j % BEND_POINTS))
  }

  /** Rectified-square position of a screen point (relative to the box). */
  const toRect = (h: Mat3 | null, sx: number, sy: number): Pt | null => {
    const inv = h && invert3(h)
    const l = layout.current
    return inv ? applyH(inv, { x: (sx - l.ox) / l.dw, y: (sy - l.oy) / l.dh }) : null
  }
  /** Rectified-square position of a pointer event. */
  const pointerRect = (h: Mat3 | null, ev: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return toRect(h, ev.clientX - r.left, ev.clientY - r.top)
  }

  const startDrag = (handle: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    const q0 = quadRef.current
    const b0 = bendRef.current
    setDrag({ handle, at: handleAt(q0, b0, handle) })
    let move: (ev: PointerEvent) => void
    if (handle < BEND0) {
      move = (ev) => {
        if (ev.pointerId !== e.pointerId) return
        const next = moveHandle(q0, handle, (ev.clientX - start.x) / layout.current.dw, (ev.clientY - start.y) / layout.current.dh)
        if (!next) return
        onChange(next)
        setDrag({ handle, at: handleAt(next, bendRef.current, handle) })
      }
    } else {
      // Bend handles move perpendicular to their side; tracking the pointer's rectified position keeps the
      // handle under the finger however the page is foreshortened.
      const j = handle - BEND0
      const side = Math.floor(j / BEND_POINTS)
      const kk = j % BEND_POINTS
      const h0 = hOf(q0)
      // Grab offset in the rectified square, so the handle doesn't jump to the exact finger position.
      const r0 = pointerRect(h0, e)
      const grab = r0 ? outward(side, r0) - valuesOf(b0, side)[kk] : 0
      move = (ev) => {
        if (ev.pointerId !== e.pointerId) return
        const r = pointerRect(h0, ev)
        if (!r) return
        const next = withValue(b0, side, kk, outward(side, r) - grab)
        onBendChange?.(next)
        setDrag({ handle, at: handleAt(q0, next, handle) })
      }
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
    const px = e.shiftKey ? 10 : 1
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (handle >= BEND0) {
      const j = handle - BEND0
      const side = Math.floor(j / BEND_POINTS)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const next = bend.map((s) => [...s]) as Bend
        next[side] = []
        onBendChange?.(next)
        return
      }
      if (!d) return
      e.preventDefault()
      // Only the arrows across the side do anything: project onto the side's on-screen outward normal.
      const kk = j % BEND_POINTS
      const p = toScreen(handleAt(quad, bend, handle))
      const [u, v] = onSide(side, controlT(kk))
      const nu = [0, 1, 0, -1][side] * 0.01
      const nv = [-1, 0, 1, 0][side] * 0.01
      const q = toScreen(photoAt(H, bend, u + nu, v + nv))
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1
      const dot = (d[0] * (q.x - p.x) + d[1] * (q.y - p.y)) / len
      if (Math.abs(dot) < 0.5) return
      const r = toRect(H, p.x + ((q.x - p.x) / len) * px * Math.sign(dot), p.y + ((q.y - p.y) / len) * px * Math.sign(dot))
      if (r) onBendChange?.(withValue(bend, side, kk, outward(side, r)))
      return
    }
    if (!d) return
    e.preventDefault()
    const step = px / Math.max(dw, dh)
    const next = moveHandle(quad, handle, d[0] * step, d[1] * step)
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
    ctx.strokeStyle = 'rgba(251,146,60,0.95)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    outline(quadRef.current, bendRef.current).forEach((p, i) => (i ? ctx.lineTo(...map(p)) : ctx.moveTo(...map(p))))
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
  }, [drag, scale, width, height]) // oxlint-disable-line react-hooks/exhaustive-deps

  // Keep the loupe clear of the finger and hand: in the top corner on the other side of the stage.
  let loupePos: Pt | null = null
  if (drag) {
    const p = toScreen(drag.at)
    const left = p.x > size.w / 2
    loupePos = { x: left ? 8 : size.w - LOUPE - 8, y: 8 }
    // Very wide, short stages: if the point sits right under that corner, use the bottom instead.
    if (Math.abs(p.x - (loupePos.x + LOUPE / 2)) < LOUPE && p.y < LOUPE + 24) loupePos.y = size.h - LOUPE - 8
  }

  const poly = outline(quad, bend)
    .map(toScreen)
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ')
  const sideAngle = (i: number) => {
    const a = toScreen(sidePoint(H, bend, i, 0.45))
    const b = toScreen(sidePoint(H, bend, i, 0.55))
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  }

  type Handle = { p: Pt; i: number; kind: 'corner' | 'side' | 'bend'; target: number }
  const handles: Handle[] = []
  // Bend handles first so corners and side handles stack above them where hit areas overlap.
  for (const side of bendSides) {
    const a = pts[side]
    const b = pts[(side + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    // On a short side the handles would crowd the corners and the side handle: leave them out.
    if (len < MIN_BEND_SIDE) continue
    // 44px targets. Near the side handle (len/6 away) the hit areas may touch; the side handle stacks on top,
    // and neither visible dot is covered by the other's area.
    const target = 44
    for (let kk = 0; kk < BEND_POINTS; kk++) {
      const i = BEND0 + side * BEND_POINTS + kk
      handles.push({ p: toScreen(handleAt(quad, bend, i)), i, kind: 'bend', target })
    }
  }
  for (let i = 0; i < 4; i++) handles.push({ p: toScreen(handleAt(quad, bend, i + 4)), i: i + 4, kind: 'side', target: 48 })
  for (let i = 0; i < 4; i++) handles.push({ p: pts[i], i, kind: 'corner', target: 48 })

  const label = (h: Handle) => {
    if (h.kind === 'corner') return `Move ${CORNER_NAMES[h.i]} corner`
    if (h.kind === 'side') return `Move ${EDGE_NAMES[h.i - 4]} edge`
    const j = h.i - BEND0
    const side = Math.floor(j / BEND_POINTS)
    const edge = side === bendSides[0] ? 'top' : 'bottom'
    const which = BEND_POINTS === 2 ? ['left', 'right'][j % BEND_POINTS] : `point ${(j % BEND_POINTS) + 1}`
    // Along the page's top the control order runs left to right as read; along the bottom it runs back.
    const along = BEND_POINTS === 2 && edge === 'bottom' ? (which === 'left' ? 'right' : 'left') : which
    return `Curve page ${edge} edge (${along}); arrow keys bend, Delete straightens`
  }

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
          {handles.map((h) => (
            <button
              key={h.i}
              type="button"
              aria-label={label(h)}
              title={h.kind === 'side' ? 'Drag to move this edge' : h.kind === 'bend' ? 'Drag to follow a curved page edge' : 'Drag to the paper corner'}
              onPointerDown={startDrag(h.i)}
              onKeyDown={onKey(h.i)}
              onDoubleClick={
                h.kind === 'bend'
                  ? () => {
                      const next = bend.map((s) => [...s]) as Bend
                      next[Math.floor((h.i - BEND0) / BEND_POINTS)] = []
                      onBendChange?.(next)
                    }
                  : undefined
              }
              className="group absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full outline-none active:cursor-grabbing"
              style={{ left: h.p.x, top: h.p.y, width: h.target, height: h.target }}
            >
              <span
                className={cx(
                  'block rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.4)] transition group-focus-visible:ring-4 group-focus-visible:ring-accent/60',
                  h.kind === 'side' ? 'h-2.5 w-6 bg-white/80' : h.kind === 'corner' ? 'size-6 bg-accent/30' : 'size-3 bg-accent',
                  drag?.handle === h.i && 'scale-110 bg-accent/60',
                  drag?.handle === h.i && h.kind === 'bend' && 'scale-150',
                )}
                style={h.kind === 'side' ? { transform: `rotate(${sideAngle(h.i - 4)}deg)` } : undefined}
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
