import { CornerUpLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSettings, type TouchZone } from '../state/settings'
import { useViewer } from '../state/viewer'
import { useMetronome } from '../tools/metronome/engine'
import { ACTIONS, onAction, runAction, type ActionId } from './actions'
import { firstPageOf, type Stop } from './layout'

const COLS = [
  ['tl', 'ml', 'bl'],
  ['tc', 'mc', 'bc'],
  ['tr', 'mr', 'br'],
] as const satisfies readonly (readonly TouchZone[])[]

/**
 * Outlines the tap zones for a moment when a song opens (touch screens only, where zones are the main
 * way to turn pages). A column doing one thing everywhere is drawn as one zone. Never takes input.
 */
export function ZonesHint({ songId }: { songId: string }) {
  const enabled = useSettings((st) => st.s.pageTurn.showZonesHint)
  const zones = useSettings((st) => st.s.pageTurn.zones)
  const annotating = useViewer((v) => v.annotating)
  const [seen, setSeen] = useState<{ songId: string; phase: 'fading' | 'off' } | null>(null)
  const eligible = enabled && !!window.matchMedia?.('(any-pointer: coarse)').matches && Object.values(zones).some((a) => a !== 'none')
  useEffect(() => {
    if (!eligible) return
    const fade = window.setTimeout(() => setSeen({ songId, phase: 'fading' }), 1500)
    const off = window.setTimeout(() => setSeen({ songId, phase: 'off' }), 2100)
    return () => {
      clearTimeout(fade)
      clearTimeout(off)
    }
  }, [songId, eligible])
  const phase = seen?.songId === songId ? seen.phase : 'on'
  if (!eligible || phase === 'off' || annotating) return null
  const label = (a: ActionId) => (a === 'none' ? '' : ACTIONS[a].label)
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[12] grid grid-cols-3 grid-rows-3 transition-opacity duration-500"
      style={{ opacity: phase === 'on' ? 1 : 0 }}
    >
      {COLS.flatMap((col, c) => {
        const merged = col.every((z) => zones[z] === zones[col[0]])
        return (merged ? [col[0]] : col).map((z, r) => (
          <div
            key={z}
            className="flex items-center justify-center border border-dashed border-white/35 bg-black/15 p-2"
            style={{ gridColumn: c + 1, gridRow: merged ? '1 / span 3' : r + 1 }}
          >
            {label(zones[z]) && <span className="rounded-full bg-black/65 px-3 py-1 text-center text-xs font-medium text-white/90">{label(zones[z])}</span>}
          </div>
        ))
      })}
    </div>
  )
}

/** The song title, small at the top, while the toolbar (which shows it) is hidden. */
export function SongTitleBadge({ title }: { title: string }) {
  const show = useSettings((st) => st.s.display.showSongTitle)
  // The metronome's beat dots sit in the same spot.
  const metronome = useMetronome((m) => m.running && m.visual)
  if (!show || metronome || !title) return null
  return (
    <div className="pointer-events-none absolute left-1/2 top-[max(0.375rem,env(safe-area-inset-top))] z-10 max-w-[min(60vw,28rem)] -translate-x-1/2 truncate rounded-full bg-black/40 px-2.5 py-0.5 text-xs font-medium text-white/75 backdrop-blur">
      {title}
    </div>
  )
}

/** Page turns and jumps that mean the performer has moved on from a followed link. */
const MOVES_ON = new Set<ActionId>([
  // Listeners run before the handler, so following another link hides the chip and then shows it again.
  'activateLinkOrTurn', 'followLink', 'nextPage', 'prevPage', 'nextOnePage', 'prevOnePage', 'nextTwoPages', 'prevTwoPages', 'nextPageLoop', 'prevPageLoop',
  'nextHalfPage', 'prevHalfPage', 'firstPage', 'lastPage', 'scrollDown', 'scrollUp', 'nextBookmark', 'prevBookmark',
])

/**
 * After following a link point, a chip to jump back to where the link was. It goes away on its own,
 * on the next page turn, or once used.
 */
export function LinkBackChip({ stops, paged }: { stops: Stop[]; paged: boolean }) {
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const [back, setBack] = useState<number | null>(null)
  useEffect(() => {
    const unsub = useViewer.subscribe((st, prev) => {
      if (st.linkReturn === prev.linkReturn) return
      setBack(st.linkReturn.length > prev.linkReturn.length ? st.linkReturn[st.linkReturn.length - 1] : null)
    })
    const unAction = onAction((a) => MOVES_ON.has(a) && setBack(null))
    return () => {
      unsub()
      unAction()
    }
  }, [])
  useEffect(() => {
    if (back === null) return
    const t = window.setTimeout(() => setBack(null), 8000)
    return () => clearTimeout(t)
  }, [back])
  if (back === null) return null
  const page = paged ? firstPageOf(stops[back]) : back
  return (
    <button
      type="button"
      onClick={() => runAction('goBack')}
      className="absolute left-3 z-20 flex h-11 items-center gap-2 rounded-full border border-white/10 bg-neutral-900/90 pl-3 pr-4 text-sm font-medium text-white shadow-2xl backdrop-blur-xl animate-pop-in hover:bg-neutral-800"
      style={{ bottom: `calc(${toolbar ? 64 : 12}px + env(safe-area-inset-bottom))` }}
    >
      <CornerUpLeft className="size-4 text-[var(--os-accent)]" />
      Back to p. {page + 1}
    </button>
  )
}
