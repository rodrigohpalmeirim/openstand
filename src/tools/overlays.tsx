import { Music2, Square, X } from 'lucide-react'
import { stopAbc, useAbcPlayback } from '../abc/playback'
import { useEffect, useState } from 'react'
import type { Song } from '../db/schema'
import { useTerms } from '../library/browse/terms'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { cx } from '../ui/primitives'
import { PICK_PROMPTS } from './commands'
import { cancelPick, useTools } from './store'

/** Song notes shown over the score when the song opens (setting) or via the "show notes" action. */
export function NotesPopup({ song }: { song: Song }) {
  const open = useTools((t) => t.notesPopup)
  const n = useSettings((st) => st.s.notes)
  const terms = useTerms()
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const panel = useViewer((v) => !!v.panel)
  useEffect(() => {
    if (!open || !n.autoHideSeconds) return
    const t = setTimeout(() => useTools.setState({ notesPopup: false }), n.autoHideSeconds * 1000)
    return () => clearTimeout(t)
  }, [open, n.autoHideSeconds, song.id])
  if (!open || !song.notes.trim()) return null
  return (
    <div
      role="dialog"
      aria-label={`${terms.Song} notes`}
      className={cx(
        'absolute left-1/2 w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 animate-pop-in',
        // Beside an open side panel; over the bottom sheet on phones.
        panel ? 'z-40 sm:z-20 sm:left-[calc((100%-24.5rem)/2)] sm:w-[min(36rem,calc(100%-26rem))]' : 'z-20',
      )}
      style={{ top: toolbar ? 64 : 12 }}
      onClick={() => useTools.setState({ notesPopup: false })}
    >
      <div className="relative max-h-[45vh] overflow-y-auto rounded-2xl border border-yellow-200/20 bg-neutral-900/95 px-5 py-4 pr-12 text-white shadow-2xl backdrop-blur-xl">
        <button className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-lg text-white/60 hover:bg-white/10" aria-label="Close notes">
          <X className="size-4" />
        </button>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-yellow-200/70">Notes · tap to close</div>
        <div className="whitespace-pre-wrap leading-snug" style={{ fontSize: n.fontSize }}>
          {song.notes}
        </div>
      </div>
    </div>
  )
}

/** Instruction bar while the user is tapping a location for a link or smart button. */
export function PickBanner() {
  const pick = useTools((t) => t.pick)
  if (!pick) return null
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--os-accent)]/60 bg-neutral-900/95 py-2 pl-4 pr-2 text-sm text-white shadow-2xl backdrop-blur-xl animate-pop-in">
        <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-[var(--os-accent)]" />
        <span>
          <span className="font-medium">{PICK_PROMPTS[pick.kind]}</span>
          <span className="text-white/55"> · swipe to turn pages</span>
        </span>
        <button className="min-h-10 rounded-xl px-3 font-medium text-white/80 hover:bg-white/10" onClick={cancelPick}>
          Cancel
        </button>
      </div>
    </div>
  )
}

const CORNER: Record<string, string> = { tl: 'left-3 top-3', tr: 'right-3 top-3', bl: 'left-3 bottom-3', br: 'right-3 bottom-10' }

function useClock(on: boolean) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(new Date()), 5000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** Clock and capo badges in the stage corners (hidden while the toolbar is up). */
export function CornerOverlays({ song, isText }: { song: Song; isText: boolean }) {
  const o = useSettings((st) => st.s.overlays)
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const now = useClock(o.clock !== 'off')
  const capo = song.text?.capo
  if (toolbar) return null
  const time = now.toLocaleTimeString([], { hour: o.clock24h ? '2-digit' : 'numeric', minute: '2-digit', hour12: !o.clock24h })
  const capoCorner = o.clock === 'tr' ? 'tl' : 'tr'
  return (
    <>
      {o.clock !== 'off' && (
        <div className={`pointer-events-none absolute z-10 rounded-lg bg-black/55 px-2.5 py-1 text-sm font-semibold tabular-nums text-white/90 backdrop-blur ${CORNER[o.clock]}`}>{time}</div>
      )}
      {o.capo && isText && !!capo && (
        <div className={`pointer-events-none absolute z-10 rounded-lg bg-[var(--os-accent)] px-2.5 py-1 text-sm font-bold text-[var(--os-accent-fg)] shadow ${CORNER[capoCorner]}`}>Capo {capo}</div>
      )}
    </>
  )
}

/** ABC playback keeps going with the Text panel closed; this pill shows it and stops it. */
export function AbcNowPlaying({ song }: { song: Song }) {
  const pb = useAbcPlayback()
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const panel = useViewer((v) => v.panel)
  if (pb.state === 'idle' || pb.songId !== song.id || panel === 'text') return null
  return (
    <div className="absolute left-3 z-20 animate-pop-in" style={{ bottom: `calc(${toolbar ? 64 : 12}px + env(safe-area-inset-bottom))` }}>
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-neutral-900/92 py-1 pl-3 pr-1 text-sm text-white shadow-2xl backdrop-blur-xl">
        <Music2 className={`size-4 text-[var(--os-accent)] ${pb.state === 'playing' ? 'animate-pulse' : ''}`} />
        <span className="max-w-[40vw] truncate text-white/85">{pb.state === 'loading' ? 'Loading sounds…' : (pb.title ?? 'Playing')}</span>
        <button type="button" onClick={stopAbc} aria-label="Stop playback" className="flex size-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <Square className="size-3.5 fill-current" />
        </button>
      </div>
    </div>
  )
}
