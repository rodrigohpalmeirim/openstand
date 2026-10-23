import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getBlob } from '../db/db'
import type { Crop, SongFile } from '../db/schema'
import { loadPdf, renderPdfRegion } from '../files/pdf'
import { MAX_PAGE_PIXELS, cachedBitmap, clearRenderCache, maxRenderWidth, renderPage } from './pageSource'

export const PAPER: Record<string, string> = { white: '#ffffff', cream: '#fbf6e9', sepia: '#f3e7cf', gray: '#ececec', cool: '#eef3f9' }

/** Extra area (CSS px) rendered around the visible part of a detail layer, so small scrolls need no re-render. */
const DETAIL_MARGIN = 384

interface Detail {
  canvas: HTMLCanvasElement
  /** Width in device px of the whole-page render the region was cut from. */
  target: number
  /** Covered area in CSS px of a page `fullW` wide. */
  x0: number
  y0: number
  x1: number
  y1: number
}

const release = (c: HTMLCanvasElement) => {
  c.remove()
  c.width = c.height = 0
}

/**
 * Draws one PDF/image page into a box of `width` x `height` CSS px. The page is rendered at device
 * resolution, cropped by moving an oversized canvas inside a clipping box, and `overlay` (annotations,
 * link markers) is laid over the *uncropped* page area so its 0..1 coordinates stay stable.
 * Whole-page bitmaps are capped (MAX_PAGE_PIXELS); past that a sharp "detail" canvas covering only the
 * visible part of the page is drawn on top.
 */
export function PageView({
  file,
  page,
  width,
  height,
  rotation = 0,
  crop,
  night,
  paper = 'white',
  overlay,
  priority = true,
}: {
  file: SongFile
  page: number
  width: number
  height: number
  rotation?: number
  crop?: Crop
  night?: boolean
  paper?: string
  overlay?: ReactNode
  /** Low-priority pages are rendered after a short delay (pre-rendering neighbours). */
  priority?: boolean
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const detailHostRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<Detail | null>(null)
  const [ready, setReady] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const c = crop ?? { top: 0, bottom: 0, left: 0, right: 0 }
  const fullW = width / Math.max(0.05, 1 - c.left - c.right)
  const fullH = height / Math.max(0.05, 1 - c.top - c.bottom)

  // Free canvas memory on unmount (iOS counts live canvases), and re-render after a GPU context loss.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const lost = () => {
      if (detailRef.current) release(detailRef.current.canvas)
      detailRef.current = null
    }
    const restored = () => {
      clearRenderCache()
      setEpoch((e) => e + 1)
    }
    canvas.addEventListener('contextlost', lost)
    canvas.addEventListener('contextrestored', restored)
    return () => {
      canvas.removeEventListener('contextlost', lost)
      canvas.removeEventListener('contextrestored', restored)
      canvas.width = canvas.height = 0
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const canvas = canvasRef.current
    if (!canvas || width < 2) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const draw = (bmp: ImageBitmap) => {
      if (cancelled) return true
      if (!bmp.width) return false // closed (evicted) bitmap; don't blank what's drawn
      try {
        canvas.width = bmp.width
        canvas.height = bmp.height
        canvas.getContext('2d')!.drawImage(bmp, 0, 0)
        setReady(true)
        return true
      } catch {
        return false
      }
    }
    const render = (attempt: number) =>
      renderPage(file, page, fullW * dpr, rotation)
        .then((bmp) => {
          if (!draw(bmp)) throw new Error('bitmap unavailable')
        })
        .catch((e) => {
          if (cancelled) return
          if (attempt === 0) retry = setTimeout(() => render(1), 400)
          else console.warn('render failed', e)
        })
    const quick = cachedBitmap(file, page, rotation)
    const drewQuick = !!quick && draw(quick)
    // With something already on screen, wait a little so rapid zoom steps don't queue a render each.
    const t = setTimeout(() => render(0), !priority ? 120 : drewQuick ? 80 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
      clearTimeout(retry)
    }
  }, [file, page, rotation, fullW, priority, width, epoch])

  // Drop the detail layer when the page changes or unmounts.
  useEffect(
    () => () => {
      if (detailRef.current) release(detailRef.current.canvas)
      detailRef.current = null
    },
    [file.blobId, page, rotation, epoch],
  )

  // Detail layer: a sharp render of the visible region when the whole-page bitmap is capped below device resolution.
  useEffect(() => {
    if (file.kind !== 'pdf' || width < 2) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: { ac: AbortController; d: Omit<Detail, 'canvas'> } | null = null
    const abort = () => {
      pending?.ac.abort()
      pending = null
    }
    const drop = () => {
      abort()
      if (detailRef.current) release(detailRef.current.canvas)
      detailRef.current = null
    }
    const update = () => {
      const box = boxRef.current
      const inner = pageRef.current
      const host = detailHostRef.current
      if (!box || !inner || !host) return
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      if (fullW * dpr * 0.9 <= maxRenderWidth(fullW / fullH)) return drop()
      // Visible part: the (crop-clipped) box intersected with the viewport, in CSS px of the page.
      const b = box.getBoundingClientRect()
      const r = inner.getBoundingClientRect()
      const left = Math.max(b.left, 0)
      const top = Math.max(b.top, 0)
      const right = Math.min(b.right, window.innerWidth)
      const bottom = Math.min(b.bottom, window.innerHeight)
      if (right <= left || bottom <= top || r.width < 1 || r.height < 1) return drop()
      const sx = fullW / r.width
      const sy = fullH / r.height
      const vx0 = (left - r.left) * sx
      const vy0 = (top - r.top) * sy
      const vx1 = (right - r.left) * sx
      const vy1 = (bottom - r.top) * sy
      const vw = vx1 - vx0
      const vh = vy1 - vy0
      // Stay under MAX_PAGE_PIXELS: shrink the margin first, then the resolution.
      const k = Math.min(dpr, Math.sqrt(MAX_PAGE_PIXELS / (vw * vh)))
      const area = MAX_PAGE_PIXELS / (k * k)
      const m = Math.max(0, Math.min(DETAIL_MARGIN, (Math.sqrt((vw + vh) ** 2 - 4 * (vw * vh - area)) - (vw + vh)) / 4))
      const target = fullW * k
      const covers = (d: Omit<Detail, 'canvas'> | null | undefined) =>
        !!d && Math.abs(d.target / target - 1) < 0.1 && d.x0 <= vx0 + 1 && d.y0 <= vy0 + 1 && d.x1 >= vx1 - 1 && d.y1 >= vy1 - 1
      if (covers(detailRef.current) || covers(pending?.d)) return
      abort()
      const px0 = Math.floor(Math.max(0, vx0 - m) * k)
      const py0 = Math.floor(Math.max(0, vy0 - m) * k)
      const px1 = Math.ceil(Math.min(fullW, vx1 + m) * k)
      const py1 = Math.ceil(Math.min(fullH, vy1 + m) * k)
      const d = { target, x0: px0 / k, y0: py0 / k, x1: px1 / k, y1: py1 / k }
      const ac = new AbortController()
      pending = { ac, d }
      loadPdf(file.blobId, () => getBlob(file.blobId))
        .then((doc) => {
          if (ac.signal.aborted) return
          return renderPdfRegion(doc, page, target, rotation, { x: px0, y: py0, width: px1 - px0, height: py1 - py0 }, ac.signal)
        })
        .then(
          (canvas) => {
            if (!canvas) return
            if (ac.signal.aborted) return void (canvas.width = canvas.height = 0)
            pending = null
            // Percentages keep it in place while the page is resized, until the next render replaces it.
            Object.assign(canvas.style, {
              position: 'absolute',
              left: `${(d.x0 / fullW) * 100}%`,
              top: `${(d.y0 / fullH) * 100}%`,
              width: `${((d.x1 - d.x0) / fullW) * 100}%`,
              height: `${((d.y1 - d.y0) / fullH) * 100}%`,
            })
            canvas.addEventListener('contextlost', () => {
              if (detailRef.current?.canvas !== canvas) return
              detailRef.current = null
              release(canvas)
              schedule()
            })
            const old = detailRef.current
            host.appendChild(canvas)
            detailRef.current = { canvas, ...d }
            if (old) release(old.canvas)
          },
          (e) => {
            if (ac.signal.aborted) return
            pending = null
            console.warn('detail render failed', e)
          },
        )
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(update, 150)
    }
    schedule()
    // Scroll doesn't bubble; capture catches scrolling in any container.
    const opts = { capture: true, passive: true } as const
    document.addEventListener('scroll', schedule, opts)
    window.addEventListener('resize', schedule)
    return () => {
      clearTimeout(timer)
      abort()
      document.removeEventListener('scroll', schedule, opts)
      window.removeEventListener('resize', schedule)
    }
  }, [file, page, rotation, fullW, fullH, width, epoch])

  return (
    <div
      ref={boxRef}
      className="relative overflow-hidden"
      style={{
        width,
        height,
        background: PAPER[paper] ?? paper,
        filter: night ? 'invert(1) hue-rotate(180deg)' : undefined,
        boxShadow: '0 1px 3px rgb(0 0 0 / 0.18)',
      }}
    >
      <div
        ref={pageRef}
        className="absolute"
        style={{ width: fullW, height: fullH, left: -c.left * fullW, top: -c.top * fullH }}
      >
        {/* Blended as one group so the opaque detail canvas covers the page bitmap instead of multiplying with it. */}
        <div
          className="relative size-full transition-opacity duration-150"
          style={{ opacity: ready ? 1 : 0, mixBlendMode: paper === 'white' ? undefined : 'multiply' }}
        >
          <canvas ref={canvasRef} className="block size-full" />
          <div ref={detailHostRef} className="pointer-events-none absolute inset-0" />
        </div>
        {/* The overlay is inverted along with the page in night mode, so dark ink stays readable. */}
        {overlay && <div className="absolute inset-0">{overlay}</div>}
      </div>
      {!ready && <div className="absolute inset-0 animate-pulse bg-black/[0.03]" />}
    </div>
  )
}
