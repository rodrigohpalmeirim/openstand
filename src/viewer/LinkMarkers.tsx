import { useEffect, useRef } from 'react'
import type { Song } from '../db/schema'
import { useSettings } from '../state/settings'
import { runAction } from './actions'
import { completePick, followLink, runSmartButton } from '../tools/commands'
import { linkColor } from '../tools/navigation'
import { useTools } from '../tools/store'
import { useStopStagePointer } from '../tools/util'

const BUTTON_SIZE = { sm: 'px-2 py-1 text-xs min-h-7', md: 'px-3 py-1.5 text-sm min-h-9', lg: 'px-4 py-2.5 text-base min-h-11' } as const

/**
 * Drawn inside each page box over the uncropped page (0..1 coordinates): link-point markers, their
 * destinations, smart buttons, and the tap-to-place layer used while creating them.
 */
export function LinkMarkers({ song, pageIndex, onFollow }: { song: Song; pageIndex: number; onFollow: (page: number) => void }) {
  const pick = useTools((t) => t.pick)
  const pointer = useTools((t) => t.linkPointer)
  const night = useSettings((st) => st.s.display.nightMode)
  const lp = useSettings((st) => st.s.linkPoints)
  const ref = useStopStagePointer<HTMLDivElement>()

  const froms = song.links.map((l, i) => ({ l, i })).filter(({ l }) => l.from.pageIndex === pageIndex)
  const tos = lp.showDestinations || pick ? song.links.map((l, i) => ({ l, i })).filter(({ l }) => l.to.pageIndex === pageIndex) : []
  const buttons = (song.smartButtons ?? []).filter((b) => b.pageIndex === pageIndex)
  const pendingFrom = pick?.kind === 'linkTo' && pick.from.pageIndex === pageIndex ? pick.from : null
  if (!froms.length && !tos.length && !buttons.length && !pick) return null

  const size = lp.markerSize
  return (
    // Pages are colour-inverted in night mode; invert again so markers keep their colours.
    <div ref={ref} className="pointer-events-none absolute inset-0" style={{ filter: night ? 'invert(1) hue-rotate(180deg)' : undefined }}>
      {tos.map(({ l, i }) => (
        <span
          key={'to' + l.id}
          aria-hidden
          className="absolute flex items-center justify-center rounded-full border-[3px] text-[11px] font-bold"
          style={{ left: `${l.to.x * 100}%`, top: `${l.to.y * 100}%`, width: size * 0.7, height: size * 0.7, transform: 'translate(-50%,-50%)', borderColor: linkColor(i), color: linkColor(i), background: 'rgb(255 255 255 / 0.55)' }}
        >
          {i + 1}
        </span>
      ))}
      {froms.map(({ l, i }) => (
        <button
          key={l.id}
          type="button"
          aria-label={`Link ${i + 1}: jump to page ${l.to.pageIndex + 1}${l.label ? ` (${l.label})` : ''}`}
          title={l.label || `To page ${l.to.pageIndex + 1}`}
          disabled={!!pick}
          onClick={() => followLink(song, i, onFollow)}
          className="pointer-events-auto absolute flex items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-md transition active:scale-90"
          style={{
            left: `${l.from.x * 100}%`,
            top: `${l.from.y * 100}%`,
            width: size,
            height: size,
            transform: 'translate(-50%,-50%)',
            background: linkColor(i),
            opacity: 0.88,
            outline: i === pointer ? `3px solid ${linkColor(i)}` : undefined,
            outlineOffset: 2,
          }}
        >
          {i + 1}
          {l.label && (
            <span className="absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold text-white shadow" style={{ background: linkColor(i) }}>
              {l.label}
            </span>
          )}
        </button>
      ))}
      {buttons.map((b) => (
        <button
          key={b.id}
          type="button"
          disabled={!!pick}
          onClick={() => void runSmartButton(song, b)}
          className={`pointer-events-auto absolute max-w-[40%] truncate rounded-full border border-white/70 bg-[var(--os-accent)] font-semibold text-[var(--os-accent-fg)] shadow-lg transition active:scale-95 ${BUTTON_SIZE[b.size ?? 'md']}`}
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, transform: 'translate(-50%,-50%)', opacity: 0.92 }}
        >
          {b.label || 'Button'}
        </button>
      ))}
      {pendingFrom && (
        <span
          aria-hidden
          className="absolute animate-pulse rounded-full border-2 border-white bg-[var(--os-accent)]"
          style={{ left: `${pendingFrom.x * 100}%`, top: `${pendingFrom.y * 100}%`, width: size, height: size, transform: 'translate(-50%,-50%)' }}
        />
      )}
      {pick && <PickCapture pageIndex={pageIndex} />}
    </div>
  )
}

/** Full-page tap target while placing a link or button. Swipes still turn pages. */
function PickCapture({ pageIndex }: { pageIndex: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let start: { x: number; y: number; id: number } | null = null
    const down = (e: PointerEvent) => {
      e.stopPropagation()
      start = { x: e.clientX, y: e.clientY, id: e.pointerId }
    }
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      start = null
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        runAction(dx < 0 ? 'nextPage' : 'prevPage', 'touch')
        return
      }
      if (Math.hypot(dx, dy) > 12) return
      const r = el.getBoundingClientRect()
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      void completePick({ pageIndex, x, y })
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
    }
  }, [pageIndex])
  return <div ref={ref} className="pointer-events-auto absolute inset-0 cursor-crosshair bg-[var(--os-accent)]/5 outline-2 -outline-offset-2 outline-dashed outline-[var(--os-accent)]/60" />
}
