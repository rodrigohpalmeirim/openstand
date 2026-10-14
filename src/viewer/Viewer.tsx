import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnnotationLayer } from '../annotations/AnnotationLayer'
import { AbcView } from '../abc/AbcView'
import { textContainerStyle } from '../chordpro/render'
import { db } from '../db/db'
import type { DisplayMode, Song } from '../db/schema'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions, runAction } from './actions'
import { emit } from './events'
import { useKeyBindings, useStageGestures } from './input'
import { computeStops, firstPageOf, fitPage, fitSpread, stopForPage, type Box, type Stop } from './layout'
import { LinkMarkers } from './LinkMarkers'
import { PAPER, PageView } from './PageView'
import { TEXT_PAGE_PADDING } from './textPagination'
import { useDisplayPages, type DisplayPage } from './useDisplayPages'
import { ViewerChrome } from './ViewerChrome'

function useSize(ref: React.RefObject<HTMLElement | null>): Box {
  const [size, setSize] = useState<Box>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect
      setSize((s) => (Math.abs(s.width - r.width) < 1 && Math.abs(s.height - r.height) < 1 ? s : { width: r.width, height: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let disposed = false
    const acquire = () =>
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (disposed) l.release()
          else lock = l
        })
        .catch(() => {})
    acquire()
    const onVis = () => document.visibilityState === 'visible' && acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVis)
      lock?.release().catch(() => {})
    }
  }, [active])
}

export function Viewer() {
  const queue = useViewer((v) => v.queue)
  const index = useViewer((v) => v.index)
  const position = useViewer((v) => v.position)
  const annotating = useViewer((v) => v.annotating)
  const textZoom = useViewer((v) => v.textZoom)
  const transposeMap = useViewer((v) => v.transpose)
  const hideAnnotations = useViewer((v) => v.hideAnnotations)
  const setV = useViewer((v) => v.set)
  const s = useSettings((st) => st.s)
  const songId = queue[index]
  const song = useLiveQuery(() => (songId ? db.songs.get(songId) : undefined), [songId])

  const stageRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const box = useSize(stageRef)
  const landscape = box.width > box.height
  const textOnly = !!song && song.files.length > 0 && song.files.every((f) => f.kind === 'chordpro' || f.kind === 'text')
  const preferredMode: DisplayMode =
    song?.display?.mode ?? (landscape && s.display.landscapeMode !== 'same' ? s.display.landscapeMode : s.display.mode)
  // Text songs reflow, so a two-page spread is better served by one wide page with two columns.
  const mode: DisplayMode = textOnly && preferredMode === 'double' ? 'single' : preferredMode
  const fit = song?.display?.fit ?? s.display.fit
  const [zoom, setZoom] = useState(1)
  const pinchBase = useRef(1)
  const gap = s.display.pageGap
  const transpose = (transposeMap[songId] ?? 0) + (song?.text?.transpose ?? 0)
  const textStyle = useMemo(() => {
    const t = { ...s.text, ...(song?.text?.showChords !== undefined ? { showChords: song.text.showChords } : {}) }
    if (song?.text?.accidental) t.accidental = song.text.accidental
    return t
  }, [s.text, song?.text])

  // A text page fills the space one page occupies in the current mode.
  const textBox = useMemo<Box>(() => {
    const w = mode === 'double' ? (box.width - gap) / 2 : box.width
    return { width: Math.max(1, w), height: Math.max(1, mode === 'verticalScroll' ? box.height : box.height) }
  }, [box, mode, gap])

  const { pages, loading } = useDisplayPages(song, textBox, textStyle, {
    transpose,
    columns: song?.text?.columns ?? (landscape && mode !== 'double' && box.width > 900 ? 2 : 1),
    zoom: textZoom * (song?.text?.fontScale ?? 1),
  })
  const stops = useMemo(() => computeStops(pages.length, mode, s.display.halfPageSplit), [pages.length, mode, s.display.halfPageSplit])
  const paged = mode !== 'verticalScroll' && mode !== 'horizontalScroll'

  // Clamp/resolve the position (-1 = "last page", used when going back to the previous song).
  useEffect(() => {
    if (!pages.length || loading) return
    const max = paged ? stops.length - 1 : pages.length - 1
    if (position < 0) setV({ position: max })
    else if (position > max) setV({ position: max })
  }, [position, stops.length, pages.length, paged, loading, setV])

  const pos = Math.max(0, Math.min(position, (paged ? stops.length : pages.length) - 1))
  const currentPage = paged ? firstPageOf(stops[pos]) : pos

  // Record song open.
  useEffect(() => {
    if (!song) return
    emit('songOpened', { song, setlistId: useViewer.getState().setlistId })
    db.songs.update(song.id, { lastPlayedAt: Date.now(), playCount: (song.playCount ?? 0) + 1 })
    setZoom(1)
    return () => emit('songClosed', { songId: song.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id])

  useEffect(() => {
    if (song) emit('pageChanged', { songId: song.id, page: currentPage, position: pos })
  }, [song, currentPage, pos])

  useWakeLock(s.display.keepScreenOn)
  useKeyBindings(!annotating)

  /* ------------------------------------------------------------ navigation */

  const [direction, setDirection] = useState<1 | -1>(1)
  const goSong = useCallback((delta: number) => {
    const v = useViewer.getState()
    const next = v.index + delta
    if (next < 0 || next >= v.queue.length) {
      toast(delta > 0 ? 'End of list' : 'Start of list')
      return false
    }
    setDirection(delta > 0 ? 1 : -1)
    v.goSong(next, delta < 0 && s.pageTurn.backToPrevSong ? -1 : 0)
    return true
  }, [s.pageTurn.backToPrevSong])

  const scrollStep = useCallback((dir: 1 | -1): boolean => {
    const el = scrollRef.current
    if (!el) return false
    const horizontal = mode === 'horizontalScroll'
    const max = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    const cur = horizontal ? el.scrollLeft : el.scrollTop
    if ((dir > 0 && cur >= max - 2) || (dir < 0 && cur <= 2)) return false
    const step = (horizontal ? el.clientWidth : el.clientHeight) * 0.85 * dir
    el.scrollBy({ [horizontal ? 'left' : 'top']: step, behavior: 'smooth' })
    return true
  }, [mode])

  const next = useCallback(() => {
    if (!paged || (fit === 'width' && zoom === 1 && mode === 'single') || zoom > 1) {
      if (scrollStep(1)) return
    }
    const v = useViewer.getState()
    const max = paged ? stops.length - 1 : pages.length - 1
    if (paged && v.position < max) {
      setDirection(1)
      v.setPosition(v.position + 1)
    } else if (s.pageTurn.continueToNextSong) goSong(1)
    else toast('Last page')
  }, [paged, fit, zoom, mode, scrollStep, stops.length, pages.length, s.pageTurn.continueToNextSong, goSong])

  const prev = useCallback(() => {
    if (!paged || (fit === 'width' && zoom === 1 && mode === 'single') || zoom > 1) {
      if (scrollStep(-1)) return
    }
    const v = useViewer.getState()
    if (paged && v.position > 0) {
      setDirection(-1)
      v.setPosition(v.position - 1)
    } else if (s.pageTurn.backToPrevSong) goSong(-1)
  }, [paged, fit, zoom, mode, scrollStep, s.pageTurn.backToPrevSong, goSong])

  const goToPage = useCallback(
    (page: number) => {
      if (paged) setV({ position: stopForPage(stops, page) })
      else {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`)
        el?.scrollIntoView({ block: 'start', inline: 'start' })
      }
    },
    [paged, stops, setV],
  )

  // When a page turns in fit-width/zoomed mode, start at the top of the new page.
  useEffect(() => {
    if (paged) scrollRef.current?.scrollTo({ top: direction > 0 ? 0 : 0, left: 0 })
  }, [pos, paged, direction])

  // Track the visible page in scroll modes.
  useEffect(() => {
    if (paged) return
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const items = el.querySelectorAll<HTMLElement>('[data-page]')
      const horizontal = mode === 'horizontalScroll'
      const ref = horizontal ? el.scrollLeft + el.clientWidth * 0.3 : el.scrollTop + el.clientHeight * 0.3
      let cur = 0
      items.forEach((it) => {
        if ((horizontal ? it.offsetLeft : it.offsetTop) <= ref) cur = Number(it.dataset.page)
      })
      if (cur !== useViewer.getState().position) setV({ position: cur })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [paged, mode, setV])

  useEffect(
    () =>
      registerActions({
        nextPage: next,
        prevPage: prev,
        nextHalfPage: next,
        prevHalfPage: prev,
        firstPage: () => (paged ? setV({ position: 0 }) : goToPage(0)),
        lastPage: () => (paged ? setV({ position: stops.length - 1 }) : goToPage(pages.length - 1)),
        scrollDown: () => scrollStep(1) || next(),
        scrollUp: () => scrollStep(-1) || prev(),
        nextSong: () => goSong(1),
        prevSong: () => goSong(-1),
        zoomIn: () => setZoom((z) => Math.min(4, z * 1.25)),
        zoomOut: () => setZoom((z) => Math.max(1, z / 1.25)),
        resetZoom: () => setZoom(1),
        toggleToolbar: () => setV({ toolbar: !useViewer.getState().toolbar }),
        toggleAnnotations: () => setV({ hideAnnotations: !useViewer.getState().hideAnnotations }),
        toggleAnnotate: () => {
          if (s.display.performanceLock) return toast('Performance lock is on')
          setV({ annotating: !useViewer.getState().annotating, toolbar: true })
        },
        goBack: () => {
          const v = useViewer.getState()
          const r = v.linkReturn.at(-1)
          if (r !== undefined) setV({ position: r, linkReturn: v.linkReturn.slice(0, -1) })
        },
        textBigger: () => setV({ textZoom: Math.min(3, useViewer.getState().textZoom * 1.1) }),
        textSmaller: () => setV({ textZoom: Math.max(0.4, useViewer.getState().textZoom / 1.1) }),
        transposeUp: () => setV({ transpose: { ...useViewer.getState().transpose, [songId]: (useViewer.getState().transpose[songId] ?? 0) + 1 } }),
        transposeDown: () => setV({ transpose: { ...useViewer.getState().transpose, [songId]: (useViewer.getState().transpose[songId] ?? 0) - 1 } }),
        cycleDisplayMode: () => {
          const order: DisplayMode[] = ['single', 'double', 'halfPage', 'verticalScroll']
          const nextMode = order[(order.indexOf(mode) + 1) % order.length]
          if (song) db.songs.update(song.id, { display: { ...song.display, mode: nextMode } })
          toast(`Display: ${nextMode}`)
        },
        goToPage: () => setV({ panel: 'goto', toolbar: true }),
        showBookmarks: () => setV({ panel: 'bookmarks', toolbar: true }),
        showSetlist: () => setV({ panel: 'setlist', toolbar: true }),
        toggleNotes: () => setV({ panel: useViewer.getState().panel === 'notes' ? null : 'notes', toolbar: true }),
        toggleNightMode: () => useSettings.getState().setIn('display', { nightMode: !useSettings.getState().s.display.nightMode }),
        toggleFullscreen: () => {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
          else document.documentElement.requestFullscreen?.().catch(() => {})
        },
        closeSong: () => {
          const v = useViewer.getState()
          if (v.annotating) setV({ annotating: false })
          else if (v.panel) setV({ panel: null })
          else v.close()
        },
      }),
    [next, prev, goSong, paged, stops.length, pages.length, goToPage, scrollStep, setV, s.display.performanceLock, songId, mode, song],
  )

  useStageGestures(stageRef, {
    enabled: !annotating,
    zoomed: zoom > 1.01,
    onPinch: (scale) => setZoom(Math.max(1, Math.min(4, pinchBase.current * scale))),
    onPinchEnd: () => {
      pinchBase.current = zoom
    },
  })
  useEffect(() => {
    pinchBase.current = zoom
  }, [zoom])

  // Ctrl/Cmd + wheel zoom on desktop.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => Math.max(1, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Auto-hide toolbar.
  const toolbar = useViewer((v) => v.toolbar)
  const panel = useViewer((v) => v.panel)
  useEffect(() => {
    if (!toolbar || annotating || panel || !s.display.toolbarAutoHide) return
    const t = setTimeout(() => setV({ toolbar: false }), s.display.toolbarAutoHide * 1000)
    return () => clearTimeout(t)
  }, [toolbar, annotating, panel, s.display.toolbarAutoHide, pos, setV])

  if (!songId) return null

  const night = s.display.nightMode
  const stageBg = night ? '#000' : 'var(--os-stage, #1a1a1c)'
  const ctx: PageCtx = {
    song,
    night,
    paper: s.display.paperTone,
    annotating,
    showAnnotations: !hideAnnotations && (s.annotations.showWhilePerforming || annotating),
    onFollowLink: (target) => {
      const v = useViewer.getState()
      setV({ linkReturn: [...v.linkReturn, v.position] })
      goToPage(target)
    },
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white no-select" style={{ filter: s.display.brightness < 1 ? `brightness(${s.display.brightness})` : undefined }}>
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden" style={{ background: stageBg, touchAction: zoom > 1 || !paged || fit !== 'page' ? 'pan-x pan-y' : 'none' }}>
        {song && pages.length > 0 && box.width > 0 && (
          paged ? (
            <div ref={scrollRef} className="absolute inset-0 overflow-auto" style={{ scrollbarWidth: 'none' }}>
              <PagedStop
                key={`${songId}:${pos}`}
                stop={stops[pos]}
                pages={pages}
                box={box}
                fit={fit}
                zoom={zoom}
                gap={gap}
                ctx={ctx}
                direction={direction}
                transition={s.display.transition}
              />
              {/* Pre-render neighbours off-screen so turns are instant. */}
              <Prefetch stops={stops} pos={pos} pages={pages} box={box} fit={fit} gap={gap} />
            </div>
          ) : (
            <ScrollStrip scrollRef={scrollRef} pages={pages} box={box} zoom={zoom} gap={gap} ctx={ctx} horizontal={mode === 'horizontalScroll'} />
          )
        )}
        {song && !loading && pages.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">This song has no files.</div>
        )}
        {(!song || loading) && pages.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="size-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        )}
      </div>
      {song && (
        <ViewerChrome
          song={song}
          pages={pages}
          stops={stops}
          pos={pos}
          paged={paged}
          mode={mode}
          currentPage={currentPage}
          goToPage={goToPage}
          zoom={zoom}
        />
      )}
    </div>
  )
}

export interface PageCtx {
  song: Song | undefined
  night: boolean
  paper: string
  annotating: boolean
  showAnnotations: boolean
  onFollowLink: (page: number) => void
}

/** Render one display page in a box. */
export function DisplayPageView({ dp, index, size, ctx, priority = true, clip }: { dp: DisplayPage; index: number; size: Box; ctx: PageCtx; priority?: boolean; clip?: { from: number; to: number } }) {
  const overlay =
    ctx.song && (ctx.showAnnotations || ctx.annotating) ? (
      <>
        <AnnotationLayer songId={ctx.song.id} fileId={dp.file.id} page={dp.type === 'file' ? dp.page : dp.type === 'text' ? 1000 + dp.page : 0} editable={ctx.annotating} />
        {!ctx.annotating && <LinkMarkers song={ctx.song} pageIndex={index} onFollow={ctx.onFollowLink} />}
      </>
    ) : null
  const inner = (() => {
    if (dp.type === 'file')
      return (
        <PageView
          file={dp.file}
          page={dp.page}
          width={size.width}
          height={size.height}
          rotation={dp.rotation}
          crop={dp.crop}
          night={ctx.night}
          paper={ctx.paper}
          overlay={overlay}
          priority={priority}
        />
      )
    if (dp.type === 'abc')
      return (
        <div className="relative overflow-hidden" style={{ width: size.width, height: size.height, background: PAPER[ctx.paper], filter: ctx.night ? 'invert(1) hue-rotate(180deg)' : undefined }}>
          <AbcView source={dp.source} transpose={dp.transpose} width={size.width} />
          {overlay && <div className="absolute inset-0">{overlay}</div>}
        </div>
      )
    return <TextPageView dp={dp} size={size} night={ctx.night} paper={ctx.paper} overlay={overlay} />
  })()
  if (!clip) return inner
  return (
    <div className="relative overflow-hidden" style={{ width: size.width, height: size.height * (clip.to - clip.from) }}>
      <div className="absolute left-0" style={{ top: -size.height * clip.from }}>
        {inner}
      </div>
    </div>
  )
}

function TextPageView({ dp, size, night, paper, overlay }: { dp: Extract<DisplayPage, { type: 'text' }>; size: Box; night: boolean; paper: string; overlay: React.ReactNode }) {
  const zoomScale = size.width / Math.max(1, dp.aspect * size.height) // 1 unless the box differs from the paginated box
  const pad = size.width * TEXT_PAGE_PADDING
  const style: CSSProperties = {
    ...textContainerStyle(dp.opts.style, useViewer.getState().textZoom),
    width: size.width,
    height: size.height,
    padding: pad,
    background: PAPER[paper],
    filter: night ? 'invert(1) hue-rotate(180deg)' : undefined,
    columnGap: size.width * 0.04,
  }
  void zoomScale
  return (
    <div className="relative overflow-hidden" style={style}>
      <div className="flex h-full" style={{ gap: size.width * 0.04 }}>
        {dp.text.columns.map((col, i) => (
          <div key={i} className="min-w-0 flex-1">
            {col.map((b) => (
              <div key={b.key}>{b.node}</div>
            ))}
          </div>
        ))}
        {Array.from({ length: Math.max(0, dp.columns - dp.text.columns.length) }, (_, i) => (
          <div key={'e' + i} className="flex-1" />
        ))}
      </div>
      {dp.count > 1 && (
        <div className="absolute bottom-2 right-3 text-[11px] opacity-40" style={{ color: dp.opts.style.lyricsColor }}>
          {dp.page + 1}/{dp.count}
        </div>
      )}
      {overlay && <div className="absolute inset-0">{overlay}</div>}
    </div>
  )
}

function stopBoxes(stop: Stop, pages: DisplayPage[], box: Box, fit: 'page' | 'width' | 'height', gap: number, zoom: number): Box[] {
  const z = (b: Box) => ({ width: b.width * zoom, height: b.height * zoom })
  if (stop.kind === 'half') {
    const a = pages[stop.bottom]
    return [z(fitPage(a.aspect, box, fit))]
  }
  return fitSpread(stop.pages.map((i) => pages[i].aspect), box, fit, gap).map(z)
}

function PagedStop({ stop, pages, box, fit, zoom, gap, ctx, direction, transition }: { stop: Stop | undefined; pages: DisplayPage[]; box: Box; fit: 'page' | 'width' | 'height'; zoom: number; gap: number; ctx: PageCtx; direction: 1 | -1; transition: string }) {
  if (!stop) return null
  const anim =
    transition === 'slide' ? (direction > 0 ? 'os-turn-next' : 'os-turn-prev') : transition === 'fade' ? 'os-turn-fade' : transition === 'curl' ? (direction > 0 ? 'os-turn-curl' : 'os-turn-prev') : ''
  const sizes = stopBoxes(stop, pages, box, fit, gap, zoom)
  const total = { width: sizes.reduce((a, b) => a + b.width, 0) + gap * (sizes.length - 1), height: Math.max(...sizes.map((b) => b.height)) }
  return (
    <div
      className={`flex items-center justify-center ${anim}`}
      style={{ minWidth: '100%', minHeight: '100%', width: total.width, height: total.height, gap, margin: '0 auto' }}
    >
      {stop.kind === 'spread' ? (
        stop.pages.map((pi, i) => <DisplayPageView key={pages[pi].key} dp={pages[pi]} index={pi} size={sizes[i]} ctx={ctx} />)
      ) : (
        <div className="flex flex-col">
          <DisplayPageView dp={pages[stop.top]} index={stop.top} size={sizes[0]} ctx={ctx} clip={{ from: 0, to: stop.split }} />
          <div className="relative h-0">
            <div className="absolute inset-x-0 -top-px h-0.5 bg-[var(--os-accent)] opacity-70" />
          </div>
          <DisplayPageView dp={pages[stop.bottom]} index={stop.bottom} size={sizes[0]} ctx={ctx} clip={{ from: stop.split, to: 1 }} />
        </div>
      )}
    </div>
  )
}

function Prefetch({ stops, pos, pages, box, fit, gap }: { stops: Stop[]; pos: number; pages: DisplayPage[]; box: Box; fit: 'page' | 'width' | 'height'; gap: number }) {
  const neighbours = [pos + 1, pos - 1, pos + 2].filter((i) => i >= 0 && i < stops.length)
  const items: { dp: DisplayPage; i: number; size: Box }[] = []
  for (const n of neighbours) {
    const st = stops[n]
    if (st.kind !== 'spread') continue
    const sizes = stopBoxes(st, pages, box, fit, gap, 1)
    st.pages.forEach((pi, k) => pages[pi].type === 'file' && items.push({ dp: pages[pi], i: pi, size: sizes[k] }))
  }
  const ctx: PageCtx = { song: undefined, night: false, paper: 'white', annotating: false, showAnnotations: false, onFollowLink: () => {} }
  return (
    <div aria-hidden className="pointer-events-none fixed -left-[20000px] top-0 opacity-0">
      {items.map(({ dp, i, size }) => (
        <DisplayPageView key={dp.key} dp={dp} index={i} size={size} ctx={ctx} priority={false} />
      ))}
    </div>
  )
}

function ScrollStrip({ scrollRef, pages, box, zoom, gap, ctx, horizontal }: { scrollRef: React.RefObject<HTMLDivElement | null>; pages: DisplayPage[]; box: Box; zoom: number; gap: number; ctx: PageCtx; horizontal: boolean }) {
  const [visible, setVisible] = useState<Set<number>>(() => new Set([0, 1, 2]))
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const nextSet = new Set(prev)
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.page)
            if (e.isIntersecting) nextSet.add(i)
            else nextSet.delete(i)
          }
          return nextSet
        })
      },
      { root, rootMargin: '150% 150%' },
    )
    root.querySelectorAll('[data-page]').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [scrollRef, pages])
  const maxW = Math.min(box.width, 1400)
  return (
    <div ref={scrollRef} className={`absolute inset-0 overflow-auto ${horizontal ? 'flex snap-x snap-mandatory' : ''}`} style={{ gap: Math.max(gap, 8) }}>
      {pages.map((dp, i) => {
        const size = horizontal ? fitPage(dp.aspect, box, 'page') : fitPage(dp.aspect, { width: maxW * zoom, height: Infinity }, 'width')
        return (
          <div key={dp.key} data-page={i} className={horizontal ? 'flex shrink-0 snap-start items-center justify-center' : 'mx-auto'} style={horizontal ? { width: box.width, height: box.height } : { width: size.width, height: size.height, marginBottom: Math.max(gap, 8) }}>
            {visible.has(i) ? <DisplayPageView dp={dp} index={i} size={size} ctx={ctx} /> : <div style={size} className="bg-white/5" />}
          </div>
        )
      })}
    </div>
  )
}

export { runAction }
