import { ChevronLeft, ChevronRight, CornerUpLeft, Menu as MenuIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { settings, useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { useMetronome } from '../tools/metronome/engine'
import { ACTIONS, onAction, runAction, type ActionId } from './actions'
import { zoneAreas } from './input'
import { firstPageOf, type Stop } from './layout'

const FADE_MS = 500

/** 'on' for `ms` once `start` is true, then 'fading' for FADE_MS, then 'off'. `dismiss` starts the fade early. */
function useBriefly(start: boolean, ms: number) {
  const [phase, setPhase] = useState<'on' | 'fading' | 'off'>('on')
  useEffect(() => {
    if (!start || phase !== 'on') return
    const t = window.setTimeout(() => setPhase('fading'), ms)
    return () => clearTimeout(t)
  }, [start, phase, ms])
  useEffect(() => {
    if (phase !== 'fading') return
    const t = window.setTimeout(() => setPhase('off'), FADE_MS)
    return () => clearTimeout(t)
  }, [phase])
  const dismiss = useCallback(() => setPhase((p) => (p === 'on' ? 'fading' : p)), [])
  return [phase, dismiss] as const
}

function ZoneIcon({ a }: { a: ActionId }) {
  if (a === 'nextPage' || a === 'nextHalfPage') return <ChevronRight className="size-4 shrink-0" />
  if (a === 'prevPage' || a === 'prevHalfPage') return <ChevronLeft className="size-4 shrink-0" />
  if (a === 'toggleToolbar') return <MenuIcon className="size-4 shrink-0" />
  return null
}

/**
 * Outlines the tap zones and what they do the first time a song is opened on this device (touch screens
 * only, where zones are the main way to turn pages), once its pages are there, until the first tap or for
 * a few seconds. Never takes input.
 */
export function ZonesHint({ ready }: { ready: boolean }) {
  const zones = useSettings((st) => st.s.pageTurn.zones)
  const annotating = useViewer((v) => v.annotating)
  // Read once: marking it seen below must not hide the hint that is showing.
  const [due] = useState(() => !settings().zonesHintSeen)
  const active = due && ready && !!window.matchMedia?.('(any-pointer: coarse)').matches && Object.values(zones).some((a) => a !== 'none')
  const [phase, dismiss] = useBriefly(active, 4000)
  useEffect(() => {
    if (!active) return
    useSettings.getState().set({ zonesHintSeen: true })
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', dismiss, true)
    }
  }, [active, dismiss])
  if (!active || phase === 'off' || annotating) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[12] grid grid-cols-3 grid-rows-3 bg-black/30 transition-opacity duration-500 animate-fade-in"
      style={{ opacity: phase === 'on' ? 1 : 0 }}
    >
      {zoneAreas(zones).map((z) => (
        <div
          key={z.zone}
          className="flex items-center justify-center border border-dashed border-white/60 p-3"
          style={{ gridRow: `${z.row + 1} / span ${z.rows}`, gridColumn: `${z.col + 1} / span ${z.cols}` }}
        >
          {z.action !== 'none' && (
            <span className="flex max-w-full items-center gap-1.5 rounded-full bg-black/75 px-3.5 py-1.5 text-center text-sm font-medium text-white shadow-lg">
              <ZoneIcon a={z.action} />
              {ACTIONS[z.action].label}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The song title, small at the top, for a moment after the toolbar (which shows it) hides. Keyed by
 * song, so it shows again when the next song opens.
 */
export function SongTitleBadge({ title }: { title: string }) {
  const show = useSettings((st) => st.s.display.showSongTitle)
  // The metronome's beat dots sit in the same spot.
  const metronome = useMetronome((m) => m.running && m.visual)
  const [phase] = useBriefly(true, 2500)
  if (!show || metronome || !title || phase === 'off') return null
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-[max(0.375rem,env(safe-area-inset-top))] z-10 max-w-[min(60vw,28rem)] -translate-x-1/2 truncate rounded-full bg-black/40 px-2.5 py-0.5 text-xs font-medium text-white/75 backdrop-blur transition-opacity duration-500 animate-fade-in"
      style={{ opacity: phase === 'on' ? 1 : 0 }}
    >
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
