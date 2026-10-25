import { Play, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Song } from '../../db/schema'
import { terms } from '../../library/browse/terms'
import { settings, useSettings } from '../../state/settings'
import { useViewer } from '../../state/viewer'
import { cx, toast } from '../../ui/primitives'
import { viewerApi, ZOOM_PREVIEW_ATTR } from '../../viewer/api'
import type { Stop } from '../../viewer/layout'
import { stopAutoScroll, useTools } from '../store'
import { songAutoScroll } from './config'
import { pageSpeed, scrollSeconds, stripSpeed, turnInterval } from './math'

/** Set while a run is paused by touch: resumes it at once (the "Paused" pill). */
let resumeNow: (() => void) | null = null

/**
 * Auto-scroll engine (runs while `useViewer.autoScrollOn`).
 * - Vertical strip: scrolls the whole song continuously; speed = total distance / (duration − delay),
 *   or the fixed px/s.
 * - Paged view taller than the screen (fit width, zoomed): scrolls each page, pauses `pageDelay` at
 *   the bottom, then turns the page; every page gets an equal share of the planned time.
 * - Views that can't scroll (whole pages, two-up, horizontal strip): timed page turns, one every
 *   (duration − delay) / number of views (or one screen height at the fixed speed).
 * Stops by itself at the end of the song.
 */
export function AutoScroller({ song, stops, pos, paged }: { song: Song; stops: Stop[]; pos: number; paged: boolean }) {
  const on = useViewer((v) => v.autoScrollOn)
  const live = useRef({ stops, pos, paged, song })
  live.current = { stops, pos, paged, song }
  const songId = song.id

  useEffect(() => {
    const setScroll = (p: Partial<ReturnType<typeof useTools.getState>['scroll']>) => {
      const cur = useTools.getState().scroll
      if (Object.entries(p).some(([k, v]) => cur[k as keyof typeof cur] !== v)) useTools.setState({ scroll: { ...cur, ...p } })
    }
    if (!on) {
      setScroll({ phase: 'idle', progress: 0, countdown: 0 })
      return
    }
    // Read the song through the ref: saving unrelated fields must not restart the run. Speed and timing
    // are re-read every frame, so changing them in the panel applies to the running scroll.
    const config = () => {
      const s = songAutoScroll(live.current.song)
      return { s, seconds: scrollSeconds(live.current.song.duration, s.delay) }
    }
    const api0 = viewerApi()
    // The start delay is for the top of the song; restarting part-way through goes at once.
    const midSong = live.current.pos > 0 || (api0?.currentPage ?? 0) > 0 || (api0?.scroller?.scrollTop ?? 0) > 2
    const skip = useTools.getState().skipScrollDelay || midSong
    useTools.setState({ skipScrollDelay: false })
    let last = performance.now()
    let startAt = last + (skip ? 0 : Math.max(0, config().s.delay) * 1000)
    let acc: number | null = null
    let waitUntil = 0
    let nextTurnAt = 0
    let lastPos = live.current.pos
    let touching = false
    let holdUntil = 0
    let raf = 0

    const finish = () => {
      setScroll({ phase: 'done', progress: 1 })
      stopAutoScroll()
      toast(`Auto-scroll reached the end of the ${terms(settings()).song}`)
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const api = viewerApi()
      if (api?.scroller?.hasAttribute(ZOOM_PREVIEW_ATTR)) {
        // Zoom preview: the scroller sits at 0,0 with a shrunken range, so its scroll is not real. Freeze
        // (shift the deadlines by the time spent here); acc resyncs to the settled scroll afterwards.
        const gap = now - last
        last = now
        startAt += gap
        if (waitUntil) waitUntil += gap
        if (nextTurnAt) nextTurnAt += gap
        return
      }
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (!api) return
      const { stops: st, pos: p, paged: isPaged } = live.current
      const views = isPaged ? Math.max(1, st.length) : Math.max(1, api.pageCount)
      const atLast = isPaged ? p >= st.length - 1 : api.currentPage >= api.pageCount - 1
      if (now < startAt) {
        setScroll({ phase: 'delay', countdown: Math.ceil((startAt - now) / 1000) })
        return
      }
      if (touching || now < holdUntil) {
        setScroll({ phase: 'paused' })
        return
      }
      const { s, seconds } = config()
      const factor = useTools.getState().scrollFactor
      const el = api.scroller
      const scrollable = !!el && api.mode !== 'horizontalScroll' && api.canScroll()
      if (p !== lastPos) {
        // Page changed (by us or by hand): restart the per-page timers.
        lastPos = p
        nextTurnAt = 0
        waitUntil = 0
        acc = null
      }

      if (scrollable && el) {
        const max = el.scrollHeight - el.clientHeight
        // Resync after manual scrolling or a page turn (scrollTop is rounded by the browser).
        if (acc === null || Math.abs(el.scrollTop - acc) > 3) acc = el.scrollTop
        if (acc >= max - 1) {
          if (!isPaged || atLast) return finish()
          if (!waitUntil) waitUntil = now + Math.max(0, s.pageDelay) * 1000
          setScroll({ phase: 'turning', progress: (p + 1) / views })
          if (now >= waitUntil) {
            waitUntil = 0
            acc = null
            api.next()
          }
          return
        }
        const speed = isPaged ? pageSpeed(s, max, views, seconds, factor) : stripSpeed(s, max, seconds, factor)
        acc = Math.min(max, acc + speed * dt)
        el.scrollTop = acc
        setScroll({ phase: 'running', timed: false, progress: isPaged ? (p + acc / Math.max(1, max)) / views : acc / Math.max(1, max) })
        return
      }

      // Timed page turns.
      const interval = turnInterval(s, views, seconds, el?.clientHeight ?? window.innerHeight, factor) * 1000
      if (!nextTurnAt) nextTurnAt = now + interval
      const index = isPaged ? p : api.currentPage
      setScroll({ phase: 'running', timed: true, progress: Math.min(1, (index + 1 - (nextTurnAt - now) / interval) / views) })
      if (now >= nextTurnAt) {
        if (atLast) return finish()
        nextTurnAt = now + interval
        api.next()
      }
    }
    raf = requestAnimationFrame(frame)

    const onDown = (e: PointerEvent) => {
      if (!settings().autoScroll.pauseOnTouch) return
      const el = viewerApi()?.scroller
      if (el && e.target instanceof Node && el.contains(e.target)) touching = true
    }
    const onUp = () => {
      if (!touching) return
      touching = false
      holdUntil = performance.now() + 1500
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    resumeNow = () => {
      touching = false
      holdUntil = 0
    }
    return () => {
      resumeNow = null
      cancelAnimationFrame(raf)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [on, songId])

  return <ScrollIndicator />
}

function ScrollIndicator() {
  const on = useViewer((v) => v.autoScrollOn)
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const panel = useViewer((v) => !!v.panel)
  const show = useSettings((st) => st.s.autoScroll.showProgress)
  const scroll = useTools((t) => t.scroll)
  const factor = useTools((t) => t.scrollFactor)
  if (!on) return null
  return (
    <>
      {show && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-white/10">
          <div className="h-full bg-[var(--os-accent)] transition-[width] duration-200" style={{ width: `${Math.round(scroll.progress * 1000) / 10}%` }} />
        </div>
      )}
      {(scroll.phase === 'delay' || scroll.phase === 'paused' || toolbar) && (
        <button
          type="button"
          onClick={scroll.phase === 'paused' && resumeNow ? resumeNow : stopAutoScroll}
          // Left of an open side panel, not under it.
          className={cx(
            'absolute right-3 z-20 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur transition hover:bg-black/85',
            panel && 'sm:right-[25.25rem]',
          )}
          style={{ top: toolbar ? 64 : 10 }}
          aria-label={scroll.phase === 'paused' ? 'Resume auto-scroll' : 'Stop auto-scroll'}
        >
          {scroll.phase === 'paused' ? <Play className="size-3.5 fill-current" /> : <Square className="size-3 fill-current" />}
          {scroll.phase === 'delay'
            ? `Scrolling in ${scroll.countdown}`
            : scroll.phase === 'paused'
              ? 'Paused · resume'
              : `Auto-scroll${scroll.timed ? ' (page turns)' : ''}${factor !== 1 ? ` · ${Math.round(factor * 100)}%` : ''}`}
        </button>
      )}
    </>
  )
}
