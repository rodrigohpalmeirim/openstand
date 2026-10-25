/**
 * Annotation rendering shared by the live layer, SVG export and canvas flattening. Each item turns
 * into a small tree of neutral SVG-ish nodes in pixel space (page = W x H), so every output path
 * draws exactly the same thing.
 */
import type { Annotation, Layer, StrokeAnnotation } from '../db/schema'
import {
  arrowHead,
  arrowHeadLen,
  HAIRPIN_HEIGHT,
  hairpinEnds,
  hasPressure,
  pressureWidth,
  smoothPath,
  stampBoxLocal,
  strokeOutline,
  TEXT_FONTS,
  TEXT_LINE_HEIGHT,
  textBoxLocal,
} from './geometry'
import { staffPaths } from './staff'
import { getStamp, STAMP_FONTS } from './stamps'

export interface SvgNode {
  tag: 'g' | 'path' | 'rect' | 'ellipse' | 'text' | 'image'
  attrs: Record<string, string | number | undefined>
  /** Translate + uniform scale for groups (kept structured so canvas can apply it). */
  tf?: { tx: number; ty: number; s: number }
  children?: SvgNode[]
  text?: string
}

const n2 = (v: number) => Math.round(v * 100) / 100

/** Which items draw with multiply blending (behind ink). */
export const isHighlight = (it: Annotation) => it.type === 'highlighter'

function strokeNodes(it: StrokeAnnotation, W: number, H: number): SvgNode[] {
  const pts = it.points.map((p) => ({ x: p.x * W, y: p.y * H, p: p.p }))
  const w = it.width * W
  if (it.type === 'pen' && !it.dashed && hasPressure(it.points)) {
    // Smooth pressure a little so the outline doesn't wobble.
    let prev = pts[0].p ?? 0.5
    const withW = pts.map((p) => {
      prev = prev * 0.6 + (p.p ?? 0.5) * 0.4
      return { x: p.x, y: p.y, w: pressureWidth(w, prev) }
    })
    return [{ tag: 'path', attrs: { d: strokeOutline(withW), fill: it.color, opacity: it.opacity < 1 ? it.opacity : undefined } }]
  }
  const single = pts.length === 1 || (pts.length === 2 && pts[0].x === pts[1].x && pts[0].y === pts[1].y)
  return [
    {
      tag: 'path',
      attrs: {
        d: smoothPath(single ? [pts[0]] : pts),
        fill: 'none',
        stroke: it.color,
        'stroke-width': n2(w),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': it.dashed && !single ? `${n2(w * 2.6)} ${n2(w * 2.2)}` : undefined,
        opacity: it.opacity < 1 ? it.opacity : undefined,
      },
    },
  ]
}

/** Nodes for one annotation in a W x H pixel page. */
export function itemNodes(it: Annotation, W: number, H: number): SvgNode[] {
  const aspect = H / W
  const op = it.opacity < 1 ? it.opacity : undefined
  switch (it.type) {
    case 'pen':
    case 'highlighter':
      return strokeNodes(it, W, H)
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
    case 'crescendo':
    case 'decrescendo': {
      const a = { x: it.a.x * W, y: it.a.y * H }
      const b = { x: it.b.x * W, y: it.b.y * H }
      const w = it.width * W
      const strokeAttrs = {
        fill: 'none',
        stroke: it.color,
        'stroke-width': n2(w),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': it.dashed ? `${n2(w * 3)} ${n2(w * 2.4)}` : undefined,
      }
      let d = ''
      if (it.type === 'line') d = `M${n2(a.x)} ${n2(a.y)}L${n2(b.x)} ${n2(b.y)}`
      else if (it.type === 'arrow') {
        const [h1, h2] = arrowHead(a, b, arrowHeadLen(it.width) * W)
        d = `M${n2(a.x)} ${n2(a.y)}L${n2(b.x)} ${n2(b.y)}M${n2(h1.x)} ${n2(h1.y)}L${n2(b.x)} ${n2(b.y)}L${n2(h2.x)} ${n2(h2.y)}`
      } else if (it.type === 'crescendo' || it.type === 'decrescendo') {
        const [apex, open] = it.type === 'crescendo' ? [a, b] : [b, a]
        const [u1, u2] = hairpinEnds(apex, open, (it.height ?? HAIRPIN_HEIGHT) * W)
        d = `M${n2(u1.x)} ${n2(u1.y)}L${n2(apex.x)} ${n2(apex.y)}L${n2(u2.x)} ${n2(u2.y)}`
      } else if (it.type === 'rect') {
        const x0 = Math.min(a.x, b.x)
        const y0 = Math.min(a.y, b.y)
        const x1 = Math.max(a.x, b.x)
        const y1 = Math.max(a.y, b.y)
        d = `M${n2(x0)} ${n2(y0)}H${n2(x1)}V${n2(y1)}H${n2(x0)}Z`
      } else {
        const cx = (a.x + b.x) / 2
        const cy = (a.y + b.y) / 2
        const rx = Math.abs(b.x - a.x) / 2
        const ry = Math.abs(b.y - a.y) / 2
        d = `M${n2(cx - rx)} ${n2(cy)}A${n2(rx)} ${n2(ry)} 0 1 0 ${n2(cx + rx)} ${n2(cy)}A${n2(rx)} ${n2(ry)} 0 1 0 ${n2(cx - rx)} ${n2(cy)}Z`
      }
      const nodes: SvgNode[] = []
      if (it.fill && (it.type === 'rect' || it.type === 'ellipse')) nodes.push({ tag: 'path', attrs: { d, fill: it.color, 'fill-opacity': 0.22, stroke: 'none' } })
      nodes.push({ tag: 'path', attrs: { d, ...strokeAttrs } })
      return [{ tag: 'g', attrs: { opacity: op }, children: nodes }]
    }
    case 'staff': {
      const p = staffPaths({ x0: it.a.x * W, y0: it.a.y * H, x1: it.b.x * W, y1: it.b.y * H }, it.measures, it.width * W)
      const stroke = (d: string, w: number, cap: string): SvgNode => ({
        tag: 'path',
        attrs: { d, fill: 'none', stroke: it.color, 'stroke-width': n2(w), 'stroke-linecap': cap, 'stroke-linejoin': 'round' },
      })
      const children: SvgNode[] = [stroke(p.lines, it.width * W, 'butt'), stroke(p.bars, p.barW, 'butt'), { tag: 'path', attrs: { d: p.fill, fill: it.color } }]
      if (p.clef) children.push(stroke(p.clef, p.clefW, 'round'))
      return [{ tag: 'g', attrs: { opacity: op }, children }]
    }
    case 'text': {
      const box = textBoxLocal(it, aspect)
      const fs = box.fs * W
      const x = it.at.x * W
      const y = it.at.y * H
      const family = TEXT_FONTS[it.font ?? 'sans']
      const children: SvgNode[] = []
      if (it.background) {
        const pad = fs * 0.2
        children.push({
          tag: 'rect',
          attrs: { x: n2(x - pad), y: n2(y - pad), width: n2(box.w * W + 2 * pad), height: n2(box.h * W + 2 * pad), rx: n2(pad), fill: it.background },
        })
      }
      box.lines.forEach((line, i) => {
        children.push({
          tag: 'text',
          attrs: {
            x: n2(x),
            y: n2(y + (i + 0.5) * fs * TEXT_LINE_HEIGHT + fs * 0.35),
            'font-size': n2(fs),
            'font-family': family,
            'font-weight': it.bold ? 'bold' : undefined,
            'font-style': it.italic ? 'italic' : undefined,
            fill: it.color,
            'xml:space': 'preserve',
          },
          text: line,
        })
      })
      return [{ tag: 'g', attrs: { opacity: op }, children }]
    }
    case 'stamp': {
      const s = getStamp(it.stamp)
      const box = stampBoxLocal(it.stamp, it.size, aspect)
      const w = box.w * W
      const h = box.h * W
      const cx = it.at.x * W
      const cy = it.at.y * H
      if (s.kind === 'text') {
        const font = STAMP_FONTS[s.font]
        return [
          {
            tag: 'text',
            attrs: {
              x: n2(cx),
              y: n2(cy + h * 0.33),
              'font-size': n2(h),
              'font-family': font.family,
              'font-weight': font.bold ? 'bold' : undefined,
              'font-style': font.italic ? 'italic' : undefined,
              'text-anchor': 'middle',
              fill: it.color,
              opacity: op,
            },
            text: s.text,
          },
        ]
      }
      const k = h / s.h
      const children: SvgNode[] = [
        ...(s.fill ?? []).map((d): SvgNode => ({ tag: 'path', attrs: { d, fill: it.color } })),
        ...(s.stroke ?? []).map(
          (st): SvgNode => ({ tag: 'path', attrs: { d: st.d, fill: 'none', stroke: it.color, 'stroke-width': st.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }),
        ),
      ]
      return [{ tag: 'g', attrs: { opacity: op }, tf: { tx: n2(cx - w / 2), ty: n2(cy - h / 2), s: k }, children }]
    }
    case 'image': {
      const x = Math.min(it.a.x, it.b.x) * W
      const y = Math.min(it.a.y, it.b.y) * H
      return [
        {
          tag: 'image',
          attrs: { href: it.src, x: n2(x), y: n2(y), width: n2(Math.abs(it.b.x - it.a.x) * W), height: n2(Math.abs(it.b.y - it.a.y) * H), preserveAspectRatio: 'none', opacity: op },
        },
      ]
    }
  }
}

/* --------------------------------------------------------------- SVG text */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function nodeToMarkup(n: SvgNode): string {
  let a = ''
  for (const [k, v] of Object.entries(n.attrs)) if (v !== undefined) a += ` ${k}="${esc(String(v))}"`
  if (n.tf) a += ` transform="translate(${n.tf.tx} ${n.tf.ty}) scale(${n.tf.s})"`
  const inner = n.text !== undefined ? esc(n.text) : (n.children ?? []).map(nodeToMarkup).join('')
  return `<${n.tag}${a}>${inner}</${n.tag}>`
}

/**
 * Drawing order: layers later in the stored list draw on top; within a layer, creation order. Items whose layer
 * no longer exists draw first. Returns `items` itself when already in order.
 */
export function sortByLayer<T extends Annotation>(items: T[], layers: Layer[]): T[] {
  if (layers.length < 2 || items.length < 2) return items
  const rank = new Map(layers.map((l, i) => [l.id, i + 1]))
  const r = (it: T) => rank.get(it.layer) ?? 0
  for (let i = 1; i < items.length; i++) if (r(items[i]) < r(items[i - 1])) return items.slice().sort((a, b) => r(a) - r(b))
  return items
}

/** Items on visible layers, in drawing order (see `sortByLayer`). */
export function visibleItems(items: Annotation[], layers?: Layer[]): Annotation[] {
  if (!layers?.length) return items
  const hidden = new Set(layers.filter((l) => !l.visible).map((l) => l.id))
  return sortByLayer(hidden.size ? items.filter((it) => !hidden.has(it.layer)) : items, layers)
}

/**
 * Convert a page's annotations into a standalone SVG document of `width` x `height` pixels
 * (the full uncropped page). Highlights are drawn first with multiply blending. Pass `layers` to
 * drop items on hidden layers and draw in layer order.
 */
export function annotationsToSVG(items: Annotation[], width: number, height: number, opts: { layers?: Layer[] } = {}): string {
  const vis = visibleItems(items, opts.layers)
  const hl = vis.filter(isHighlight)
  const rest = vis.filter((i) => !isHighlight(i))
  const body =
    (hl.length ? `<g style="mix-blend-mode:multiply">${hl.flatMap((i) => itemNodes(i, width, height)).map(nodeToMarkup).join('')}</g>` : '') +
    rest.flatMap((i) => itemNodes(i, width, height)).map(nodeToMarkup).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

/* ----------------------------------------------------------------- Canvas */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const imageCache = new Map<string, Promise<CanvasImageSource | null>>()
function loadImage(src: string): Promise<CanvasImageSource | null> {
  let p = imageCache.get(src)
  if (!p) {
    p = fetch(src)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .catch(() => null)
    imageCache.set(src, p)
  }
  return p
}

function drawNode(ctx: Ctx, n: SvgNode, images: Map<string, CanvasImageSource | null>) {
  const num = (k: string) => (n.attrs[k] === undefined ? undefined : Number(n.attrs[k]))
  ctx.save()
  const op = num('opacity')
  if (op !== undefined) ctx.globalAlpha *= op
  if (n.tf) {
    ctx.translate(n.tf.tx, n.tf.ty)
    ctx.scale(n.tf.s, n.tf.s)
  }
  switch (n.tag) {
    case 'g':
      for (const c of n.children ?? []) drawNode(ctx, c, images)
      break
    case 'path': {
      const p = new Path2D(String(n.attrs.d))
      const fill = n.attrs.fill
      if (fill && fill !== 'none') {
        ctx.save()
        const fo = num('fill-opacity')
        if (fo !== undefined) ctx.globalAlpha *= fo
        ctx.fillStyle = String(fill)
        ctx.fill(p)
        ctx.restore()
      }
      const stroke = n.attrs.stroke
      if (stroke && stroke !== 'none') {
        ctx.strokeStyle = String(stroke)
        ctx.lineWidth = num('stroke-width') ?? 1
        ctx.lineCap = (n.attrs['stroke-linecap'] as CanvasLineCap) ?? 'butt'
        ctx.lineJoin = (n.attrs['stroke-linejoin'] as CanvasLineJoin) ?? 'miter'
        const dash = n.attrs['stroke-dasharray']
        if (dash) ctx.setLineDash(String(dash).split(/[ ,]+/).map(Number))
        ctx.stroke(p)
      }
      break
    }
    case 'rect': {
      ctx.fillStyle = String(n.attrs.fill)
      const [x, y, w, h, r] = ['x', 'y', 'width', 'height', 'rx'].map((k) => num(k) ?? 0)
      ctx.beginPath()
      if ('roundRect' in ctx) ctx.roundRect(x, y, w, h, r)
      else (ctx as CanvasRenderingContext2D).rect(x, y, w, h)
      ctx.fill()
      break
    }
    case 'text': {
      ctx.fillStyle = String(n.attrs.fill)
      ctx.font = `${n.attrs['font-style'] === 'italic' ? 'italic ' : ''}${n.attrs['font-weight'] === 'bold' ? 'bold ' : ''}${num('font-size')}px ${n.attrs['font-family']}`
      ctx.textAlign = n.attrs['text-anchor'] === 'middle' ? 'center' : 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(n.text ?? '', num('x') ?? 0, num('y') ?? 0)
      break
    }
    case 'image': {
      const img = images.get(String(n.attrs.href))
      if (img) ctx.drawImage(img, num('x') ?? 0, num('y') ?? 0, num('width') ?? 0, num('height') ?? 0)
      break
    }
  }
  ctx.restore()
}

/**
 * Flatten annotations onto a canvas of `w` x `h` pixels (the full uncropped page). Async only
 * because image annotations must be decoded first; drawing order is preserved.
 */
export async function drawAnnotationsToCanvas(ctx: Ctx, items: Annotation[], w: number, h: number, opts: { layers?: Layer[] } = {}): Promise<void> {
  const vis = visibleItems(items, opts.layers)
  const srcs = [...new Set(vis.flatMap((i) => (i.type === 'image' ? [i.src] : [])))]
  const images = new Map<string, CanvasImageSource | null>()
  await Promise.all(srcs.map(async (s) => images.set(s, await loadImage(s))))
  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  for (const it of vis) if (isHighlight(it)) for (const nd of itemNodes(it, w, h)) drawNode(ctx, nd, images)
  ctx.globalCompositeOperation = 'source-over'
  for (const it of vis) if (!isHighlight(it)) for (const nd of itemNodes(it, w, h)) drawNode(ctx, nd, images)
  ctx.restore()
}
