/**
 * Renders and edits the annotations of one page. Coordinates are normalised 0..1 to the uncropped page
 * box, which is exactly this component's parent box.
 *
 * `input` says who draws: `all` in the annotation mode (pen, mouse, and fingers unless "stylus only"),
 * `pen` while reading (a pen writes, everything else passes through to the stage), `none` shows only.
 *
 * Rendering is SVG (crisp at any zoom). Committed items live in a memoised static layer; the stroke
 * being drawn goes to a separate live layer updated imperatively once per animation frame.
 */
import { createElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { uid } from '../db/db'
import type { Annotation, Point, SongLayers, TextAnnotation } from '../db/schema'
import { settings, useSettings } from '../state/settings'
import { toast } from '../ui/primitives'
import { ZOOM_PREVIEW_ATTR } from '../viewer/api'
import { ignorePointer } from '../viewer/input'
import {
  bboxNorm,
  dist,
  eraseStroke,
  fromLocal,
  hitTest,
  hitTopmost,
  itemIntersectsRect,
  lassoSelect,
  measureEm,
  normRect,
  round,
  roundPoint,
  scaleItem,
  simplify,
  streamline,
  TEXT_FONTS,
  TEXT_LINE_HEIGHT,
  toLocal,
  translateItem,
  unionRect,
  type Rect,
} from './geometry'
import { gridPath, itemAnchor, snapDelta, snapPoint, snapScale } from './grid'
import { isVisible, setCurrentLayer, useSongLayers } from './layers'
import { hasClipboard, paste, setClipboard, setTool, snapCell } from './ops'
import { holdAwake, isPenPresent, penContactCount, touchBlockedByPen, usePen } from './pen'
import { isHighlight, itemNodes, nodeToMarkup, visibleItems, type SvgNode } from './render'
import { snipRegion, writeSystemClipboard } from './snip'
import { clampMeasures, DEFAULT_STAFF_SPACE, STAFF_SPACES } from './staff'
import { commit, getItems, pageKey, registerEditable, saveSoon, setItems, setSelection, useAnnotUI, usePageItems, type TextEdit } from './store'
import { isShapeTool, TOOL_LABEL, toolConfig, type ShapeTool, type ToolConfig, type ToolId } from './tools'

/* ---------------------------------------------------------------- Helpers */

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize((s) => (Math.abs(s.w - w) < 0.5 && Math.abs(s.h - h) < 0.5 ? s : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

const camel = (k: string) => (k === 'xml:space' ? 'xmlSpace' : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()))

function toReact(n: SvgNode, key: number | string): ReactElement {
  const props: Record<string, unknown> = { key }
  for (const [k, v] of Object.entries(n.attrs)) if (v !== undefined) props[camel(k)] = v
  if (n.tf) props.transform = `translate(${n.tf.tx} ${n.tf.ty}) scale(${n.tf.s})`
  return createElement(n.tag, props, n.text ?? n.children?.map((c, i) => toReact(c, i)))
}

const nodeCache = new WeakMap<Annotation, { H: number; el: ReactElement[] }>()
const ItemView = memo(function ItemView({ item, W, H }: { item: Annotation; W: number; H: number }) {
  let c = nodeCache.get(item)
  if (!c || c.H !== H) {
    c = { H, el: itemNodes(item, W, H).map((n, i) => toReact(n, i)) }
    nodeCache.set(item, c)
  }
  return <>{c.el}</>
})

const W = 1000

const StaticLayer = memo(function StaticLayer({ items, H, hiddenId }: { items: Annotation[]; H: number; hiddenId?: string }) {
  const hl: Annotation[] = []
  const rest: Annotation[] = []
  for (const it of items) if (it.id !== hiddenId) (isHighlight(it) ? hl : rest).push(it)
  const svg = 'pointer-events-none absolute inset-0 h-full w-full overflow-visible'
  return (
    <>
      {hl.length > 0 && (
        <svg className={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ mixBlendMode: 'multiply' }} aria-hidden>
          {hl.map((it) => (
            <ItemView key={it.id} item={it} W={W} H={H} />
          ))}
        </svg>
      )}
      {rest.length > 0 && (
        <svg className={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {rest.map((it) => (
            <ItemView key={it.id} item={it} W={W} H={H} />
          ))}
        </svg>
      )}
    </>
  )
})

/* ------------------------------------------------------------------ Layer */

export type LayerInput = 'none' | 'pen' | 'all'

export function AnnotationLayer({ songId, fileId, page, input, show = true }: { songId: string; fileId: string; page: number; input: LayerInput; /** Draw the stored annotations (the editor works either way). */ show?: boolean }) {
  const key = pageKey(songId, fileId, page)
  const items = usePageItems(key)
  const layers = useSongLayers(songId)
  const ref = useRef<HTMLDivElement>(null)
  const size = useElementSize(ref)
  const editing = useAnnotUI((s) => (s.editing?.key === key ? s.editing : null))
  // Drawing (and hit-testing) order follows the layer list.
  const visible = useMemo(() => visibleItems(items, layers.layers), [items, layers])
  const H = size.w > 0 ? Math.round((W * size.h) / size.w * 100) / 100 : W
  // Reading: native finger scrolling (and its momentum) stays as it is until a pen is around. Touch-action
  // is read when a pointer lands, so a pen that hovers first is covered before it touches.
  const penNear = usePen((p) => p.awake || p.present)
  const holdsTouch = input === 'all' || (input === 'pen' && penNear)

  return (
    <div
      ref={ref}
      data-annot-key={key}
      className="absolute inset-0"
      style={{ pointerEvents: input === 'none' ? 'none' : 'auto', touchAction: holdsTouch ? 'none' : undefined }}
    >
      {show && size.w > 0 && <StaticLayer items={visible} H={H} hiddenId={editing?.id} />}
      {input !== 'none' && size.w > 0 && <Editor pageKey={key} songId={songId} layers={layers} visible={visible} H={H} box={size} rootRef={ref} penOnly={input === 'pen'} />}
    </div>
  )
}

/* ----------------------------------------------------------------- Editor */

type Gesture =
  | {
      kind: 'ink'
      tool: 'pen' | 'highlighter'
      cfg: ToolConfig
      pts: Point[]
      tip: Point
      pred: Point[]
      pressure: boolean
      straight: boolean
      hold: { x: number; y: number }
      holdTimer: number
      touch: boolean
    }
  | { kind: 'shape'; tool: ShapeTool; cfg: ToolConfig; a: Point; b: Point; touch: boolean }
  | { kind: 'erase'; cfg: ToolConfig; before: Annotation[]; work: Annotation[]; last: Point; temp: boolean; touch: boolean; dirty?: boolean }
  | { kind: 'boxerase'; a: Point; b: Point; touch: boolean }
  | { kind: 'stamp'; cfg: ToolConfig; at: Point; touch: boolean }
  | { kind: 'text'; at: Point; sx: number; sy: number; touch: boolean }
  | { kind: 'move'; before: Annotation[]; ids: Set<string>; start: Point; moved: boolean; hitId?: string; touch: boolean; preview?: Annotation[] }
  | { kind: 'resize'; before: Annotation[]; ids: Set<string>; anchor: Point; corner: Point; start: Point; touch: boolean; preview?: Annotation[] }
  | { kind: 'lasso'; pts: Point[]; additive: boolean; touch: boolean; holdTimer: number; sx: number; sy: number }
  | { kind: 'snip'; a: Point; b: Point; touch: boolean }

let lastTap = { t: 0, id: '' }
/** Commit function of the open text editor (pointer input elsewhere closes it first). */
let activeTextCommit: (() => void) | null = null

const SMOOTH_STREAM = [0, 0.2, 0.38, 0.55]
const SMOOTH_TOL_PX = [0, 0.3, 0.6, 1.1]
/** Pressure change (0..1) that keeps a point when simplifying a pressure stroke. */
const PRESSURE_TOL = 0.06

/** The scroller a finger drags by hand while the layer holds touch-action. */
function findScroller(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    if (/(auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) {
      // A snapping strip (horizontal scroll mode) re-snaps after every scripted step, so a drag would skip
      // pages. Leave it alone: the swipe reaches the stage and turns the page through its binding.
      return cs.scrollSnapType && !cs.scrollSnapType.startsWith('none') ? null : n
    }
  }
  return null
}

function Editor({
  pageKey: key,
  songId,
  layers,
  visible,
  H,
  box,
  rootRef,
  penOnly,
}: {
  pageKey: string
  songId: string
  layers: SongLayers
  visible: Annotation[]
  H: number
  box: { w: number; h: number }
  rootRef: React.RefObject<HTMLDivElement | null>
  /** Reading: only a pen is handled here; touch and mouse go on to the stage untouched. */
  penOnly: boolean
}) {
  const liveRef = useRef<SVGGElement>(null)
  const liveSvgRef = useRef<SVGSVGElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const tool = useSettings((s) => s.s.annotations.tool)
  const tempEraser = useAnnotUI((s) => s.tempEraser)
  const selection = useAnnotUI((s) => (s.selection?.key === key ? s.selection : null))
  const editing = useAnnotUI((s) => (s.editing?.key === key ? s.editing : null))
  const items = usePageItems(key)
  const pendingClear = useRef(false)

  // Latest values for native listeners.
  const live = useRef({ layers, visible, H })
  live.current = { layers, visible, H }

  useEffect(() => (rootRef.current ? registerEditable(key, rootRef.current) : undefined), [key, rootRef])

  useLayoutEffect(() => {
    if (pendingClear.current && liveRef.current) {
      liveRef.current.innerHTML = ''
      pendingClear.current = false
    }
  }, [items])

  useEffect(() => {
    const root = rootRef.current
    const liveG = liveRef.current
    const liveSvg = liveSvgRef.current
    if (!root || !liveG || !liveSvg) return

    let g: Gesture | null = null
    let gPointer = -1
    let rect = root.getBoundingClientRect()
    let raf = 0
    const fingers = new Map<number, { x: number; y: number }>()
    let multi: { cx: number; cy: number } | null = null
    let fingerScroll: { scroller: HTMLElement | null; scrolled: number; pens: number } | null = null
    /** Keeps the quick palette up while a pen gesture runs. */
    let releaseHold: (() => void) | null = null
    let penDownAt = -Infinity
    let penUpAt = -Infinity

    const aspect = () => rect.height / Math.max(1, rect.width)
    const norm = (e: { clientX: number; clientY: number }): Point => ({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height })
    const px = (n: number) => n / Math.max(1, rect.width) // screen px → local units
    const Hc = () => live.current.H

    const setLive = (nodes: SvgNode[] | string, multiply = false) => {
      liveG.innerHTML = typeof nodes === 'string' ? nodes : nodes.map(nodeToMarkup).join('')
      liveSvg.style.mixBlendMode = multiply ? 'multiply' : ''
    }
    const clearLive = () => {
      liveG.innerHTML = ''
      pendingClear.current = false
    }
    /** Clear the live layer once React has painted the committed item (avoids a flicker). */
    const clearLiveAfterCommit = () => {
      pendingClear.current = true
      requestAnimationFrame(() => requestAnimationFrame(() => pendingClear.current && clearLive()))
    }

    const baseItem = (cfg: ToolConfig) => ({ id: uid(), layer: live.current.layers.current, color: cfg.color, opacity: cfg.opacity, createdAt: Date.now() })

    const ensureLayerVisible = () => {
      const L = live.current.layers
      const cur = L.layers.find((l) => l.id === L.current)
      if (cur && !cur.visible) {
        void setCurrentLayer(songId, cur.id)
        toast(`Layer "${cur.name}" was hidden — showing it`)
      }
    }

    /* -------------------------------------------------------- live render */

    const inkItem = (gi: Extract<Gesture, { kind: 'ink' }>, final = false): Annotation => {
      let pts: Point[]
      if (gi.straight) pts = [gi.pts[0], gi.tip]
      else pts = final ? [...gi.pts, gi.tip] : [...gi.pts, gi.tip, ...gi.pred]
      return { ...baseItem(gi.cfg), type: gi.tool, width: gi.cfg.size / 1000, points: pts, dashed: gi.cfg.dashed || undefined }
    }

    const shapeItem = (gs: Extract<Gesture, { kind: 'shape' }>): Annotation => ({
      ...baseItem(gs.cfg),
      type: gs.tool,
      width: gs.cfg.size / 1000,
      a: gs.a,
      b: gs.tool === 'staff' ? staffCorner(gs.a, gs.b) : gs.b,
      fill: (gs.tool === 'rect' || gs.tool === 'ellipse') && gs.cfg.fill ? true : undefined,
      dashed: (gs.tool !== 'staff' && gs.cfg.dashed) || undefined,
      height: gs.tool === 'crescendo' || gs.tool === 'decrescendo' ? (gs.cfg.height ?? 18) / 1000 : undefined,
      measures: gs.tool === 'staff' ? clampMeasures(gs.cfg.measures) : undefined,
    })

    /** A staff dragged nearly flat (or tapped) gets a standard system height; a tap also a default length. */
    const staffCorner = (a: Point, b: Point): Point => {
      const as = aspect()
      const h = (DEFAULT_STAFF_SPACE * STAFF_SPACES) / as
      const tap = Math.hypot((b.x - a.x) * rect.width, (b.y - a.y) * rect.height) < 6
      const x = tap ? Math.min(0.98, a.x + 0.6) : b.x
      const y = Math.abs(b.y - a.y) * rect.height < 14 ? a.y + (b.y < a.y && !tap ? -h : h) : b.y
      return { x: round(x), y: round(Math.max(0, Math.min(1, y))) }
    }

    const snap = <T extends Point>(p: T): T => {
      const cell = snapCell()
      return cell ? snapPoint(p, cell, aspect()) : p
    }

    const stampItem = (gs: Extract<Gesture, { kind: 'stamp' }>): Annotation => ({
      ...baseItem(gs.cfg),
      type: 'stamp',
      at: { x: round(gs.at.x), y: round(gs.at.y) },
      stamp: gs.cfg.stamp ?? 'fermata',
      size: gs.cfg.size / 1000,
    })

    const dashedRect = (r: Rect) =>
      `<rect x="${r.x0 * W}" y="${r.y0 * Hc()}" width="${(r.x1 - r.x0) * W}" height="${(r.y1 - r.y0) * Hc()}" fill="rgba(37,99,235,0.06)" stroke="#2563eb" stroke-width="${px(1.5) * W}" stroke-dasharray="${px(6) * W} ${px(4) * W}"/>`

    const render = () => {
      raf = 0
      if (!g) return
      switch (g.kind) {
        case 'ink':
          setLive(itemNodes(inkItem(g), W, Hc()), g.tool === 'highlighter')
          break
        case 'shape':
          setLive(itemNodes(shapeItem(g), W, Hc()))
          break
        case 'stamp':
          setLive(itemNodes(stampItem(g), W, Hc()))
          break
        case 'erase':
          if (g.dirty) {
            g.dirty = false
            setItems(key, g.work, false)
          }
          break
        case 'move':
        case 'resize':
          if (g.preview) {
            setItems(key, g.preview, false)
            g.preview = undefined
          }
          break
        case 'snip':
          setLive(dashedRect(normRect(g.a, g.b)))
          break
        case 'boxerase':
          setLive(dashedRect(normRect(g.a, g.b)).replace(/#2563eb/g, '#dc2626').replace('rgba(37,99,235,0.06)', 'rgba(220,38,38,0.08)'))
          break
        case 'lasso': {
          const d = g.pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x * W).toFixed(1)} ${(p.y * Hc()).toFixed(1)}`).join('')
          setLive(`<path d="${d}Z" fill="rgba(37,99,235,0.08)" stroke="#2563eb" stroke-width="${px(1.5) * W}" stroke-dasharray="${px(5) * W} ${px(4) * W}"/>`)
          break
        }
        default:
          break
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(render)
    }

    /* ----------------------------------------------------------- cursor */

    const showCursor = (e: PointerEvent | null, cfg?: ToolConfig) => {
      const c = cursorRef.current
      if (!c) return
      if (!e || !cfg) {
        c.style.display = 'none'
        return
      }
      const r = root.getBoundingClientRect()
      const d = (cfg.size / 1000) * r.width
      c.style.display = 'block'
      c.style.width = c.style.height = `${d}px`
      c.style.transform = `translate(${e.clientX - r.left - d / 2}px, ${e.clientY - r.top - d / 2}px)`
    }

    /* ----------------------------------------------------------- erasing */

    const eraseAt = (ge: Extract<Gesture, { kind: 'erase' }>, p: Point) => {
      const a = aspect()
      const radius = ge.cfg.size / 2000
      const mode = ge.cfg.eraser ?? 'stroke'
      const L = live.current.layers
      // Walk from the last position so fast sweeps don't skip strokes.
      const lp = toLocal(ge.last, a)
      const cp = toLocal(p, a)
      const steps = Math.max(1, Math.ceil(dist(lp, cp) / Math.max(radius / 2, 1e-4)))
      let work = ge.work
      let changed = false
      for (let s = 1; s <= steps; s++) {
        const c = fromLocal({ x: lp.x + ((cp.x - lp.x) * s) / steps, y: lp.y + ((cp.y - lp.y) * s) / steps }, a)
        const next: Annotation[] = []
        for (const it of work) {
          if (!isVisible(it, L)) {
            next.push(it)
            continue
          }
          if (mode === 'stroke' && (it.type === 'pen' || it.type === 'highlighter')) {
            const pieces = eraseStroke(it, c, radius, a, uid)
            if (pieces === null) next.push(it)
            else {
              next.push(...pieces)
              changed = true
            }
          } else if (hitTest(it, c, radius, a)) changed = true
          else next.push(it)
        }
        work = next
      }
      ge.last = p
      if (changed) {
        ge.work = work
        ge.dirty = true
      }
    }

    /* ----------------------------------------------------------- select */

    const selectionRect = (): Rect | null => {
      const sel = useAnnotUI.getState().selection
      if (!sel || sel.key !== key) return null
      const ids = new Set(sel.ids)
      return unionRect(getItems(key).filter((i) => ids.has(i.id)).map((i) => bboxNorm(i, aspect())))
    }

    const handleAt = (p: Point, touch: boolean): { anchor: Point; corner: Point } | null => {
      const r = selectionRect()
      if (!r) return null
      const tol = (touch ? 26 : 14) / rect.width
      const corners: [Point, Point][] = [
        [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y1 }],
        [{ x: r.x1, y: r.y0 }, { x: r.x0, y: r.y1 }],
        [{ x: r.x1, y: r.y1 }, { x: r.x0, y: r.y0 }],
        [{ x: r.x0, y: r.y1 }, { x: r.x1, y: r.y0 }],
      ]
      const a = aspect()
      for (const [c, anchor] of corners) if (dist(toLocal(c, a), toLocal(p, a)) <= tol) return { anchor, corner: c }
      return null
    }

    const startTextEdit = (p: Point) => {
      const a = aspect()
      const hit = hitTopmost(live.current.visible.filter((i) => i.type === 'text'), p, px(6), a) as TextAnnotation | undefined
      if (hit) {
        const style = { color: hit.color, opacity: hit.opacity, size: hit.size * 1000, bold: !!hit.bold, italic: !!hit.italic, font: hit.font ?? 'sans', background: !!hit.background }
        useAnnotUI.setState({ editing: { key, id: hit.id, at: hit.at, style }, selection: null, activeKey: key })
      } else {
        ensureLayerVisible()
        const at = snap(p)
        useAnnotUI.setState({ editing: { key, at: { x: round(at.x), y: round(at.y) } }, selection: null, activeKey: key })
      }
    }

    /* ---------------------------------------------------------- fingers */

    // Fingers that don't draw scroll the page by hand: with touch-action none nothing scrolls natively.
    // Taps, swipes and every other finger gesture are the stage's (the user's bindings).

    const centroid = () => {
      const pts = [...fingers.values()]
      return { cx: pts.reduce((s, p) => s + p.x, 0) / pts.length, cy: pts.reduce((s, p) => s + p.y, 0) / pts.length }
    }

    const fingerDown = (e: PointerEvent) => {
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (fingers.size >= 2) {
        if (g?.touch) cancelGesture()
        multi = centroid()
      }
      fingerScroll = { scroller: findScroller(root), scrolled: 0, pens: penContactCount() }
    }

    const fingerMove = (e: PointerEvent) => {
      const f = fingers.get(e.pointerId)
      if (!f) return
      const dx = e.clientX - f.x
      const dy = e.clientY - f.y
      f.x = e.clientX
      f.y = e.clientY
      // A pen touched down (on any page) since these fingers landed: they are a resting hand and scroll nothing more.
      if (fingerScroll && fingerScroll.pens !== penContactCount() && settings().annotations.palmRejection) return
      if (multi) {
        const { cx, cy } = centroid()
        // The viewer's pinch zoom pans too while it previews; scrolling here would fight it.
        const sc = fingerScroll?.scroller
        if (sc && !sc.hasAttribute(ZOOM_PREVIEW_ATTR)) sc.scrollBy(-(cx - multi.cx), -(cy - multi.cy))
        multi = { cx, cy }
      } else if (fingerScroll?.scroller) {
        const s = fingerScroll.scroller
        const before = s.scrollLeft + s.scrollTop
        s.scrollBy(-dx, -dy)
        const was = fingerScroll.scrolled
        fingerScroll.scrolled += Math.abs(s.scrollLeft + s.scrollTop - before)
        // A drag that scrolled the page is not also a swipe or a tap.
        if (was <= 20 && fingerScroll.scrolled > 20) ignorePointer(e.pointerId)
      }
    }

    const fingerUp = (e: PointerEvent) => {
      fingers.delete(e.pointerId)
      // The fingers still down carry on from where they are (no jump to the new midpoint).
      if (multi) multi = fingers.size ? centroid() : null
    }

    /* ---------------------------------------------------------- gestures */

    const cancelGesture = () => {
      if (!g) return
      if (g.kind === 'ink' || g.kind === 'lasso') clearTimeout(g.holdTimer)
      if (g.kind === 'erase' || g.kind === 'move' || g.kind === 'resize') setItems(key, g.kind === 'erase' ? g.before : g.before, false)
      g = null
      gPointer = -1
      endHold()
      clearLive()
      if (useAnnotUI.getState().tempEraser) useAnnotUI.setState({ tempEraser: false })
    }

    const endHold = () => {
      releaseHold?.()
      releaseHold = null
    }

    const onDown = (e: PointerEvent) => {
      const s = settings().annotations
      if (e.pointerType === 'mouse' && e.button !== 0) return

      if (penOnly && e.pointerType !== 'pen') {
        // Reading: fingers and the mouse belong to the stage. Only while this layer holds touch-action
        // (a pen is around) does a finger need scrolling by hand; a hand resting under the pen is ignored.
        if (e.pointerType === 'touch' && root.style.touchAction === 'none' && !touchBlockedByPen(e)) fingerDown(e)
        return
      }
      if (e.pointerType === 'pen') penDownAt = performance.now()

      if (activeTextCommit) {
        e.preventDefault()
        activeTextCommit()
        return
      }

      if (e.pointerType === 'touch') {
        const palm = s.palmRejection && (isPenPresent() || e.width > 42 || e.height > 42)
        if (palm) {
          e.preventDefault()
          // Not a gesture for the stage either (a palm-sized contact brushing the page).
          ignorePointer(e.pointerId)
          return
        }
        if (s.stylusOnly || fingers.size > 0 || (g && g.touch)) {
          // Second finger cancels a finger stroke; fingers never draw in stylus-only mode.
          e.preventDefault()
          fingerDown(e)
          return
        }
        fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      } else if (g && g.touch) cancelGesture() // pen/mouse wins over a resting palm
      if (g) return

      e.preventDefault()
      // Touches reach the viewer so a second finger can pinch-zoom (it cancels this stroke, see fingerDown).
      // A pen or mouse stroke is nobody else's: not the stage's, not a link marker's under it.
      if (e.pointerType !== 'touch') e.stopPropagation()
      rect = root.getBoundingClientRect()
      try {
        root.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic events */
      }
      gPointer = e.pointerId
      if (penOnly) releaseHold = holdAwake()
      useAnnotUI.setState({ activeKey: key })

      const penEraser = e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || (e.buttons & 2) !== 0 || e.button === 5)
      const t: ToolId = penEraser || useAnnotUI.getState().tempEraser ? 'eraser' : s.tool
      const cfg = toolConfig(t, s.tools)
      if (penEraser) useAnnotUI.setState({ tempEraser: true })
      const p = norm(e)
      const touch = e.pointerType === 'touch'

      if (t !== 'select' && useAnnotUI.getState().selection) useAnnotUI.setState({ selection: null })

      if (t === 'pen' || t === 'highlighter') {
        ensureLayerVisible()
        const pressure = t === 'pen' && e.pointerType === 'pen' && s.pressure && !cfg.dashed
        const pt: Point = pressure ? { ...p, p: Math.max(0.05, e.pressure || 0.5) } : p
        g = { kind: 'ink', tool: t, cfg, pts: [pt], tip: pt, pred: [], pressure, straight: !!e.shiftKey, hold: { x: e.clientX, y: e.clientY }, holdTimer: 0, touch }
        if (t === 'highlighter') armHold(g)
      } else if (isShapeTool(t)) {
        ensureLayerVisible()
        const sp = snap(p)
        g = { kind: 'shape', tool: t, cfg, a: sp, b: sp, touch }
      } else if (t === 'eraser') {
        if (cfg.eraser === 'box' && !penEraser) g = { kind: 'boxerase', a: p, b: p, touch }
        else {
          const before = getItems(key)
          g = { kind: 'erase', cfg: penEraser ? { ...cfg, eraser: cfg.eraser === 'box' ? 'stroke' : cfg.eraser } : cfg, before, work: before, last: p, temp: penEraser, touch }
          eraseAt(g, p)
          showCursor(e, cfg)
        }
      } else if (t === 'stamp') {
        ensureLayerVisible()
        g = { kind: 'stamp', cfg, at: snap(p), touch }
      } else if (t === 'text') {
        g = { kind: 'text', at: p, sx: e.clientX, sy: e.clientY, touch }
      } else if (t === 'snip') {
        g = { kind: 'snip', a: p, b: p, touch }
      } else if (t === 'select') {
        const h = handleAt(p, touch)
        const sel = useAnnotUI.getState().selection
        const selIds = sel?.key === key ? new Set(sel.ids) : new Set<string>()
        const before = getItems(key)
        const sr = selectionRect()
        const pad = 8 / rect.width
        if (h && selIds.size) g = { kind: 'resize', before, ids: selIds, anchor: h.anchor, corner: h.corner, start: p, touch }
        else if (sr && !e.shiftKey && p.x >= sr.x0 - pad && p.x <= sr.x1 + pad && p.y >= sr.y0 - pad && p.y <= sr.y1 + pad) {
          const hit = hitTopmost(live.current.visible, p, px(touch ? 10 : 6), aspect())
          g = { kind: 'move', before, ids: selIds, start: p, moved: false, hitId: hit?.id, touch }
        } else {
          const hit = hitTopmost(live.current.visible, p, px(touch ? 10 : 6), aspect())
          if (hit) {
            let ids: string[]
            if (e.shiftKey) ids = selIds.has(hit.id) ? [...selIds].filter((i) => i !== hit.id) : [...selIds, hit.id]
            else ids = selIds.has(hit.id) ? [...selIds] : [hit.id]
            setSelection(key, ids)
            g = { kind: 'move', before, ids: new Set(ids), start: p, moved: false, hitId: hit.id, touch }
          } else {
            if (!e.shiftKey) useAnnotUI.setState({ selection: null })
            const gl: Gesture = { kind: 'lasso', pts: [p], additive: e.shiftKey, touch, holdTimer: 0, sx: e.clientX, sy: e.clientY }
            // Long press on empty space pastes the clipboard there.
            if (hasClipboard())
              gl.holdTimer = window.setTimeout(() => {
                if (g !== gl) return
                cancelGesture()
                navigator.vibrate?.(12)
                void paste({ key, p: snap(p) })
              }, 550)
            g = gl
          }
        }
      }
      schedule()
    }

    const armHold = (gi: Extract<Gesture, { kind: 'ink' }>) => {
      clearTimeout(gi.holdTimer)
      gi.holdTimer = window.setTimeout(() => {
        if (g !== gi || gi.straight || gi.pts.length < 3) return
        const a = aspect()
        let len = 0
        for (let i = 1; i < gi.pts.length; i++) len += dist(toLocal(gi.pts[i - 1], a), toLocal(gi.pts[i], a))
        if (len < px(16)) return
        gi.straight = true
        snapStraight(gi)
        schedule()
      }, 480)
    }

    /** Highlighter lines snap to horizontal when nearly level. */
    const snapStraight = (gi: Extract<Gesture, { kind: 'ink' }>) => {
      if (gi.tool !== 'highlighter') return
      const a = aspect()
      const s0 = toLocal(gi.pts[0], a)
      const t = toLocal(gi.tip, a)
      if (Math.abs(t.y - s0.y) < Math.abs(t.x - s0.x) * Math.tan((5 * Math.PI) / 180)) gi.tip = { ...gi.tip, y: gi.pts[0].y }
    }

    const constrain = (a: Point, b: Point, t: ShapeTool, shift: boolean): Point => {
      const as = aspect()
      const la = toLocal(a, as)
      const lb = toLocal(b, as)
      const dx = lb.x - la.x
      const dy = lb.y - la.y
      if (t === 'staff') return b
      if (t === 'rect' || t === 'ellipse') {
        if (!shift) return b
        const m = Math.max(Math.abs(dx), Math.abs(dy))
        return fromLocal({ x: la.x + Math.sign(dx || 1) * m, y: la.y + Math.sign(dy || 1) * m }, as)
      }
      const ang = Math.atan2(dy, dx)
      const len = Math.hypot(dx, dy)
      let snapped = ang
      if (shift) snapped = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12)
      else if ((t === 'crescendo' || t === 'decrescendo') && Math.abs(Math.sin(ang)) < Math.sin((10 * Math.PI) / 180)) snapped = Math.abs(ang) > Math.PI / 2 ? Math.PI : 0
      if (snapped === ang) return b
      return fromLocal({ x: la.x + Math.cos(snapped) * len, y: la.y + Math.sin(snapped) * len }, as)
    }

    const onMove = (e: PointerEvent) => {
      if (fingers.has(e.pointerId) && e.pointerId !== gPointer) {
        fingerMove(e)
        return
      }
      if (penOnly && e.pointerType !== 'pen') return
      if (!g || e.pointerId !== gPointer) {
        // Hover: eraser cursor.
        const s = settings().annotations
        const eraser = s.tool === 'eraser' && (toolConfig('eraser', s.tools).eraser ?? 'stroke') !== 'box'
        if (eraser && e.pointerType !== 'touch') {
          rect = root.getBoundingClientRect()
          showCursor(e, toolConfig('eraser', s.tools))
        } else showCursor(null)
        return
      }
      e.preventDefault()
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      const list = evs.length ? evs : [e]
      switch (g.kind) {
        case 'ink': {
          const s = settings().annotations
          const amount = SMOOTH_STREAM[s.smoothing] ?? 0.38
          for (const ev of list) {
            const q = norm(ev)
            const pt: Point = g.pressure ? { ...q, p: Math.max(0.05, ev.pressure || 0.5) } : q
            g.tip = pt
            const last = g.pts[g.pts.length - 1]
            if (Math.hypot((pt.x - last.x) * rect.width, (pt.y - last.y) * rect.height) < 0.75) continue
            const sp = streamline(last, pt, amount) as Point
            g.pts.push(g.pressure ? { x: sp.x, y: sp.y, p: pt.p } : { x: sp.x, y: sp.y })
          }
          if (e.shiftKey && !g.straight) g.straight = true
          if (g.straight) snapStraight(g)
          const pred = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : []
          const gi = g
          gi.pred = gi.straight ? [] : pred.slice(0, 2).map((ev) => (gi.pressure ? { ...norm(ev), p: gi.tip.p } : norm(ev)))
          if (g.tool === 'highlighter' && !g.straight && Math.hypot(e.clientX - g.hold.x, e.clientY - g.hold.y) > 5) {
            g.hold = { x: e.clientX, y: e.clientY }
            armHold(g)
          }
          break
        }
        case 'shape':
          g.b = e.shiftKey && g.tool !== 'staff' ? constrain(g.a, norm(e), g.tool, true) : constrain(g.a, snap(norm(e)), g.tool, false)
          break
        case 'snip':
          g.b = norm(e)
          break
        case 'erase':
          for (const ev of list) eraseAt(g, norm(ev))
          showCursor(e, g.cfg)
          break
        case 'boxerase':
          g.b = norm(e)
          break
        case 'stamp':
          g.at = snap(norm(e))
          break
        case 'text':
          break
        case 'lasso':
          for (const ev of list) g.pts.push(norm(ev))
          if (g.holdTimer && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > (g.touch ? 10 : 6)) {
            clearTimeout(g.holdTimer)
            g.holdTimer = 0
          }
          break
        case 'move': {
          const p = norm(e)
          const dx = p.x - g.start.x
          const dy = p.y - g.start.y
          if (!g.moved && Math.hypot(dx * rect.width, dy * rect.height) < (g.touch ? 6 : 3)) break
          g.moved = true
          const ids = g.ids
          let d = { dx, dy }
          const cell = snapCell()
          const hitId = g.hitId
          const lead = cell ? (g.before.find((i) => i.id === hitId && ids.has(i.id)) ?? g.before.find((i) => ids.has(i.id))) : undefined
          if (lead) d = snapDelta(itemAnchor(lead, aspect()), dx, dy, cell, aspect())
          g.preview = g.before.map((i) => (ids.has(i.id) ? translateItem(i, d.dx, d.dy) : i))
          break
        }
        case 'resize': {
          const a = aspect()
          const p = norm(e)
          const d0 = dist(toLocal(g.start, a), toLocal(g.anchor, a))
          const d1 = dist(toLocal(p, a), toLocal(g.anchor, a))
          const sc = Math.max(0.05, snapScale(g.anchor, g.corner, d1 / Math.max(1e-6, d0), snapCell(), a))
          const ids = g.ids
          const anchor = g.anchor
          g.preview = g.before.map((i) => (ids.has(i.id) ? scaleItem(i, anchor, sc) : i))
          break
        }
      }
      schedule()
    }

    const onUp = (e: PointerEvent) => {
      if (fingers.has(e.pointerId) && e.pointerId !== gPointer) {
        fingerUp(e)
        return
      }
      fingers.delete(e.pointerId)
      if (!g || e.pointerId !== gPointer) return
      if (e.pointerType === 'pen') penUpAt = performance.now()
      if (e.type === 'pointercancel') {
        // The browser took the pointer (a native scroll won the race): nothing half-drawn stays behind.
        cancelGesture()
        return
      }
      e.preventDefault()
      const cur = g
      if ((cur.kind === 'move' || cur.kind === 'resize') && cur.preview) setItems(key, cur.preview, false)
      g = null
      gPointer = -1
      endHold()
      cancelAnimationFrame(raf)
      raf = 0
      const s = settings().annotations
      switch (cur.kind) {
        case 'ink': {
          clearTimeout(cur.holdTimer)
          const a = aspect()
          let pts: Point[] = cur.straight ? [cur.pts[0], cur.tip] : [...cur.pts, cur.tip]
          let len = 0
          for (let i = 1; i < pts.length; i++) len += dist(toLocal(pts[i - 1], a), toLocal(pts[i], a))
          if (len < px(2)) pts = [pts[0]]
          else if (!cur.straight) {
            const tol = px(SMOOTH_TOL_PX[s.smoothing] ?? 0.6)
            // Pressure strokes keep the points where the width changes.
            pts = simplify(pts.map((q) => toLocal(q, a)), tol, cur.pressure ? PRESSURE_TOL : 0).map((q) => fromLocal(q, a))
          }
          const item = { ...inkItem(cur, true), points: pts.map(roundPoint) } as Annotation
          commit(cur.tool === 'pen' ? 'Pen stroke' : 'Highlight', [{ key, before: getItems(key), after: [...getItems(key), item] }])
          clearLiveAfterCommit()
          break
        }
        case 'shape': {
          const a = aspect()
          if (cur.tool !== 'staff' && dist(toLocal(cur.a, a), toLocal(cur.b, a)) < px(6)) {
            clearLive()
            break
          }
          const item = shapeItem({ ...cur, a: roundPoint(cur.a), b: roundPoint(cur.b) })
          commit(TOOL_LABEL[cur.tool], [{ key, before: getItems(key), after: [...getItems(key), item] }])
          clearLiveAfterCommit()
          break
        }
        case 'erase':
          commit('Erase', [{ key, before: cur.before, after: cur.work }])
          showCursor(e.pointerType === 'touch' ? null : e, cur.cfg)
          clearLive()
          break
        case 'boxerase': {
          const r = normRect(cur.a, cur.b)
          const L = live.current.layers
          const before = getItems(key)
          const after = before.filter((it) => !(isVisible(it, L) && itemIntersectsRect(it, r, aspect())))
          if (after.length !== before.length) commit('Erase', [{ key, before, after }])
          clearLive()
          break
        }
        case 'stamp': {
          const item = stampItem(cur)
          commit('Stamp', [{ key, before: getItems(key), after: [...getItems(key), item] }])
          clearLiveAfterCommit()
          break
        }
        case 'text':
          if (Math.hypot(e.clientX - cur.sx, e.clientY - cur.sy) < 10) startTextEdit(cur.at)
          break
        case 'snip': {
          const r = normRect(cur.a, cur.b)
          if ((r.x1 - r.x0) * rect.width < 8 || (r.y1 - r.y0) * rect.height < 8) {
            clearLive()
            toast('Drag a rectangle over the part of the page to copy')
            break
          }
          const job = snipRegion(key, { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(1, r.x1), y1: Math.min(1, r.y1) }, root)
          writeSystemClipboard(job.then((s) => s.blob))
          job.then(
            (s) => {
              clearLive()
              setClipboard([s.item], aspect(), key)
              setTool('select')
              toast('Snippet copied — long-press (or use Paste) to place it')
            },
            (err) => {
              clearLive()
              console.warn('snip failed', err)
              toast('Could not copy this region', 'error')
            },
          )
          break
        }
        case 'lasso': {
          clearTimeout(cur.holdTimer)
          clearLive()
          const a = aspect()
          let len = 0
          for (let i = 1; i < cur.pts.length; i++) len += dist(toLocal(cur.pts[i - 1], a), toLocal(cur.pts[i], a))
          if (len < px(12)) break
          const picked = lassoSelect(live.current.visible, cur.pts, a).map((i) => i.id)
          const prev = cur.additive ? (useAnnotUI.getState().selection?.ids ?? []) : []
          setSelection(key, [...new Set([...prev, ...picked])])
          break
        }
        case 'move':
          if (cur.moved) commit(cur.ids.size > 1 ? `Move ${cur.ids.size} annotations` : 'Move', [{ key, before: cur.before, after: getItems(key) }])
          else if (cur.hitId) {
            const now = performance.now()
            const it = getItems(key).find((i) => i.id === cur.hitId)
            if (it?.type === 'text' && lastTap.id === it.id && now - lastTap.t < 400) startTextEdit({ x: it.at.x + 1e-4, y: it.at.y + 1e-4 })
            lastTap = { t: now, id: cur.hitId }
          }
          break
        case 'resize':
          commit('Resize', [{ key, before: cur.before, after: getItems(key) }])
          break
      }
      if (useAnnotUI.getState().tempEraser) useAnnotUI.setState({ tempEraser: false })
      saveSoon()
    }

    const onLeave = () => {
      if (!g) showCursor(null)
    }
    const isPen = (e: Event) => (e as PointerEvent).pointerType === 'pen'
    const noMenu = (e: Event) => {
      if (!penOnly || isPen(e)) e.preventDefault()
    }
    // A pen stroke that started on a link marker or smart button draws; it never follows the link. Where a
    // click carries no pointer type, one right after a pen lift is the pen's.
    const noPenClick = (e: Event) => {
      const type = (e as PointerEvent).pointerType
      if (type === 'pen' || (!type && performance.now() - penUpAt < 400)) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    // A pen that reports no hover lands while the page may still pan natively (touch-action is unset
    // until a pen is around). Cancelling its touchstart keeps the browser from turning the stroke into a
    // scroll; if it does anyway, pointercancel drops the stroke.
    const noPenScroll = (e: TouchEvent) => {
      if (!e.cancelable) return
      const stylus = [...e.changedTouches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus')
      if (stylus || performance.now() - penDownAt < 80) e.preventDefault()
    }

    // Reading: the layer is one of several things on the page (link markers sit above it), so it listens
    // on the page box, capturing, and takes only the pen. Annotating: it covers the page and takes it all.
    const host: HTMLElement = (penOnly && root.parentElement) || root
    const capture = penOnly
    host.addEventListener('pointerdown', onDown, capture)
    host.addEventListener('pointermove', onMove, capture)
    host.addEventListener('pointerup', onUp, capture)
    host.addEventListener('pointercancel', onUp, capture)
    root.addEventListener('pointerleave', onLeave)
    host.addEventListener('contextmenu', noMenu, capture)
    if (penOnly) {
      host.addEventListener('click', noPenClick, true)
      host.addEventListener('touchstart', noPenScroll, { capture: true, passive: false })
    }
    return () => {
      host.removeEventListener('pointerdown', onDown, capture)
      host.removeEventListener('pointermove', onMove, capture)
      host.removeEventListener('pointerup', onUp, capture)
      host.removeEventListener('pointercancel', onUp, capture)
      root.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('contextmenu', noMenu, capture)
      host.removeEventListener('click', noPenClick, true)
      host.removeEventListener('touchstart', noPenScroll, true)
      cancelAnimationFrame(raf)
      endHold()
      clearLive()
      showCursor(null)
      if (g?.kind === 'ink' || g?.kind === 'lasso') clearTimeout(g.holdTimer)
      if (g && (g.kind === 'erase' || g.kind === 'move' || g.kind === 'resize')) setItems(key, g.before, false)
    }
  }, [key, songId, rootRef, penOnly])

  const grid = useSettings((s) => s.s.annotations.grid)
  const activeTool = tempEraser ? 'eraser' : tool
  // Reading: the mouse is not a drawing tool here, so it keeps its normal cursor.
  const cursor = penOnly
    ? undefined
    : activeTool === 'select' ? 'default' : activeTool === 'text' ? 'text' : activeTool === 'eraser' ? 'none' : activeTool === 'stamp' ? 'copy' : 'crosshair'

  // Selection box.
  const selRect = useMemo(() => {
    if (!selection) return null
    const ids = new Set(selection.ids)
    return unionRect(items.filter((i) => ids.has(i.id)).map((i) => bboxNorm(i, box.h / Math.max(1, box.w))))
  }, [selection, items, box])

  return (
    <div className="absolute inset-0" style={{ cursor }}>
      {grid.show && !penOnly && <GridOverlay cell={grid.size / 1000} H={H} />}
      <svg ref={liveSvgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <g ref={liveRef} />
      </svg>
      <div
        ref={cursorRef}
        className="pointer-events-none absolute left-0 top-0 hidden rounded-full border-2 border-red-500/70 bg-red-500/10 shadow-[0_0_0_1px_rgba(255,255,255,0.8)]"
      />
      {selRect && activeTool === 'select' && <SelectionBox r={selRect} />}
      {editing && <TextEditor key={`${editing.id ?? ''}:${editing.at.x}:${editing.at.y}`} edit={editing} box={box} songLayer={layers.current} />}
    </div>
  )
}

const GridOverlay = memo(function GridOverlay({ cell, H }: { cell: number; H: number }) {
  const d = useMemo(() => gridPath(cell, W, H), [cell, H])
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="rgba(37,99,235,0.2)" strokeWidth={1} vectorEffect="non-scaling-stroke" shapeRendering="crispEdges" />
    </svg>
  )
})

function SelectionBox({ r }: { r: Rect }) {
  const style = { left: `${r.x0 * 100}%`, top: `${r.y0 * 100}%`, width: `${(r.x1 - r.x0) * 100}%`, height: `${(r.y1 - r.y0) * 100}%` }
  const handle = 'absolute size-3 rounded-sm border-2 border-[#2563eb] bg-white shadow'
  return (
    <div className="pointer-events-none absolute" style={style}>
      <div className="absolute -inset-1 rounded border-[1.5px] border-dashed border-[#2563eb]" />
      <div className={`${handle} -left-2 -top-2`} />
      <div className={`${handle} -right-2 -top-2`} />
      <div className={`${handle} -bottom-2 -right-2`} />
      <div className={`${handle} -bottom-2 -left-2`} />
    </div>
  )
}

/* ------------------------------------------------------------ Text editor */

function TextEditor({ edit, box, songLayer }: { edit: TextEdit; box: { w: number; h: number }; songLayer: string }) {
  const tools = useSettings((s) => s.s.annotations.tools)
  // An existing text keeps its own style; a new one uses the Text tool's.
  const cfg = useMemo(() => ({ ...toolConfig('text', tools), ...edit.style }), [tools, edit.style])
  const existing = useMemo(() => (edit.id ? (getItems(edit.key).find((i) => i.id === edit.id) as TextAnnotation | undefined) : undefined), [edit])
  const [text, setText] = useState(existing?.text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  const state = useRef({ text, cfg, edit, existing, songLayer })
  state.current = { text, cfg, edit, existing, songLayer }
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus()
      const n = ref.current?.value.length ?? 0
      ref.current?.setSelectionRange(n, n)
    }, 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    // StrictMode re-mounts immediately: cancel the commit scheduled by the simulated unmount.
    clearTimeout(unmountTimer.current)
    const commitEdit = () => {
      if (done.current) return
      done.current = true
      activeTextCommit = null
      const { text: value, cfg: c, edit, existing, songLayer } = state.current
      const clean = value.replace(/\s+$/, '')
      const before = getItems(edit.key)
      const style = {
        color: c.color,
        opacity: c.opacity,
        size: c.size / 1000,
        bold: c.bold || undefined,
        italic: c.italic || undefined,
        font: c.font ?? 'sans',
        background: c.background ? '#ffffff' : undefined,
      }
      if (existing) {
        if (!clean) commit('Delete text', [{ key: edit.key, before, after: before.filter((i) => i.id !== existing.id) }])
        else commit('Edit text', [{ key: edit.key, before, after: before.map((i) => (i.id === existing.id ? { ...existing, ...style, text: clean } : i)) }])
      } else if (clean) {
        const item: TextAnnotation = { id: uid(), type: 'text', layer: songLayer, createdAt: Date.now(), at: edit.at, text: clean, ...style }
        commit('Text', [{ key: edit.key, before, after: [...before, item] }])
      }
      saveSoon()
      useAnnotUI.setState({ editing: null })
    }
    activeTextCommit = commitEdit
    return () => {
      // Unmounting (page turn, leaving annotation mode) still saves the text.
      unmountTimer.current = setTimeout(commitEdit, 0)
    }
  }, [])

  const fontPx = (cfg.size / 1000) * box.h
  const lines = (text || ' ').split('\n')
  const family = TEXT_FONTS[cfg.font ?? 'sans']
  const em = Math.max(1, ...lines.map((l) => measureEm(l + 'M', family, cfg.bold, cfg.italic)))
  return (
    <textarea
      ref={ref}
      value={text}
      spellCheck={false}
      aria-label="Annotation text"
      placeholder="Type…"
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        // The toolbar's colour and size controls restyle this text: using them keeps it open.
        if (e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-keeps-text-edit]')) return
        activeTextCommit?.()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          activeTextCommit?.()
        }
      }}
      className="absolute m-0 resize-none overflow-hidden border-0 p-0 outline-none ring-2 ring-[#2563eb]/60 placeholder:text-black/30"
      style={{
        left: `${edit.at.x * 100}%`,
        top: `${edit.at.y * 100}%`,
        width: em * fontPx + 4,
        height: lines.length * fontPx * TEXT_LINE_HEIGHT + 2,
        fontSize: fontPx,
        lineHeight: TEXT_LINE_HEIGHT,
        fontFamily: family,
        fontWeight: cfg.bold ? 700 : 400,
        fontStyle: cfg.italic ? 'italic' : 'normal',
        color: cfg.color,
        opacity: cfg.opacity,
        background: cfg.background ? '#ffffff' : 'rgba(255,255,255,0.35)',
        whiteSpace: 'pre',
        touchAction: 'auto',
      }}
    />
  )
}
