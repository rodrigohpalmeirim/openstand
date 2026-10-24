import { useEffect, useRef } from 'react'
import { renderPage } from './pageSource'
import type { DisplayPage } from './useDisplayPages'

/** Small floating preview of a page, shown while scrubbing the page slider. */
export function PagePreview({ dp, index, total, left }: { dp: DisplayPage; index: number; total: number; left: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let alive = true
    const c = ref.current
    if (!c || dp.type !== 'file') return
    void renderPage(dp.file, dp.page, 180, dp.rotation).then((bmp) => {
      if (!alive) return
      c.width = bmp.width
      c.height = bmp.height
      try {
        c.getContext('2d')!.drawImage(bmp, 0, 0)
      } catch {
        /* evicted bitmap */
      }
    }, () => {}) // e.g. the file is still downloading (library sync)
    return () => {
      alive = false
    }
  }, [dp])
  return (
    <div
      className="pointer-events-none absolute bottom-16 z-30 -translate-x-1/2 rounded-xl border border-white/15 bg-neutral-900/95 p-1.5 shadow-2xl"
      style={{ left: Math.max(80, Math.min(left, window.innerWidth - 80)) }}
    >
      {dp.type === 'file' ? (
        <canvas ref={ref} className="block w-[120px] rounded bg-white" />
      ) : (
        <div className="flex h-[150px] w-[120px] items-center justify-center rounded bg-white text-xs text-neutral-500">Text page</div>
      )}
      <div className="pt-1 text-center text-xs tabular-nums text-white/80">
        {index + 1} / {total}
      </div>
    </div>
  )
}
