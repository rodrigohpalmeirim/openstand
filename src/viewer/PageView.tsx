import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Crop, SongFile } from '../db/schema'
import { cachedBitmap, renderPage } from './pageSource'

export const PAPER: Record<string, string> = { white: '#ffffff', cream: '#fbf6e9', sepia: '#f3e7cf' }

/**
 * Draws one PDF/image page into a box of `width` x `height` CSS px. The page is rendered at device
 * resolution, cropped by moving an oversized canvas inside a clipping box, and `overlay` (annotations,
 * link markers) is laid over the *uncropped* page area so its 0..1 coordinates stay stable.
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const c = crop ?? { top: 0, bottom: 0, left: 0, right: 0 }
  const fullW = width / Math.max(0.05, 1 - c.left - c.right)
  const fullH = height / Math.max(0.05, 1 - c.top - c.bottom)

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas || width < 2) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const draw = (bmp: ImageBitmap) => {
      if (cancelled) return
      try {
        canvas.width = bmp.width
        canvas.height = bmp.height
        canvas.getContext('2d')!.drawImage(bmp, 0, 0)
        setReady(true)
      } catch {
        /* bitmap was evicted; the high-res render below will redraw */
      }
    }
    const quick = cachedBitmap(file, page, rotation)
    if (quick) draw(quick)
    const t = setTimeout(
      () => {
        renderPage(file, page, fullW * dpr, rotation).then(draw, (e) => console.warn('render failed', e))
      },
      priority ? 0 : 120,
    )
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [file, page, rotation, fullW, priority, width])

  return (
    <div
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
        className="absolute"
        style={{ width: fullW, height: fullH, left: -c.left * fullW, top: -c.top * fullH }}
      >
        <canvas
          ref={canvasRef}
          className="block size-full transition-opacity duration-150"
          style={{ opacity: ready ? 1 : 0, mixBlendMode: paper === 'white' ? undefined : 'multiply' }}
        />
        {/* The overlay is inverted along with the page in night mode, so dark ink stays readable. */}
        {overlay && <div className="absolute inset-0">{overlay}</div>}
      </div>
      {!ready && <div className="absolute inset-0 animate-pulse bg-black/[0.03]" />}
    </div>
  )
}
