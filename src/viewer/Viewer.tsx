import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnnotationLayer } from '../annotations/AnnotationLayer'
import { AbcView } from '../abc/AbcView'
import { textContainerStyle } from '../chordpro/render'
import { db, updateSong } from '../db/db'
import type { DisplayMode, Song } from '../db/schema'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions, runAction } from './actions'
import { setViewerApi } from './api'
import { askGoToPage } from './askPage'
import { emit } from './events'
import { useKeyBindings, useStageGestures } from './input'
import { computeStops, firstPageOf, fitPage, fitSpread, prefetchPages, stopForPage, type Box, type Stop } from './layout'
import { LinkMarkers } from './LinkMarkers'
import { PAPER, PageView } from './PageView'
import { TEXT_BLOCK_STYLE, TEXT_PAGE_PADDING } from './textPagination'
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

/** Last song whose play was counted (see the songOpened effect). */
let lastPlay = { id: '', at: 0 }

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
  const liveSong = useLiveQuery(() => (songId ? db.songs.get(songId) : undefined), [songId])
  // useLiveQuery keeps returning the previous song until the new query resolves; never lay out
  // (or clamp positions against) the wrong song.
  const song = liveSong?.id === songId ? liveSong : undefined

  const stageRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stageBox = useSize(stageRef)
  // While annotating, the tool bar sits over the stage; lay pages out below it so the top is drawable.
  const [topInset, setTopInset] = useState(0)
  const annotatingNow = useViewer((v) => v.annotating)
  useLayoutEffect(() => {
    if (!annotatingNow) return setTopInset(0)
    const el = document.querySelector<HTMLElement>('[data-viewer-top]')
    if (!el) return
    const ro = new ResizeObserver(() => setTopInset(Math.round(el.getBoundingClientRect().height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [annotatingNow])
  const box = useMemo(() => ({ width: stageBox.width, height: Math.max(1, stageBox.height - topInset) }), [stageBox, topInset])
  const landscape = stageBox.width > stageBox.height
  const textOnly = !!song && song.files.length > 0 && song.files.every((f) => f.kind === 'chordpro' || f.kind === 'text' || f.kind === 'abc')
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
    const w = mode === 'double' ? (stageBox.width - gap) / 2 : stageBox.width
    return { width: Math.max(1, w), height: Math.max(1, stageBox.height) }
  }, [stageBox, mode, gap])

  const { pages, loading } = useDisplayPages(song, textBox, textStyle, {
    transpose,
    columns: song?.text?.columns ?? (landscape && mode !== 'double' && stageBox.width > 900 ? 2 : 1),
    zoom: textZoom * (song?.text?.fontScale ?? 1),
  })
  const stops = useMemo(
    () => computeStops(pages.length, mode, s.display.halfPageSplit, s.display.twoPageTurn),
    [pages.length, mode, s.display.halfPageSplit, s.display.twoPageTurn],
  )
  const paged = mode !== 'verticalScroll' && mode !== 'horizontalScroll'

  // Clamp/resolve the position (-1 = "last page", used when going back to the previous song).
  useEffect(() => {
    if (!pages.length || loading) return
    const max = paged ? stops.length - 1 : pages.length - 1
    if (position < 0) setV({ position: max })
    else if (position > max) setV({ position: max })
  }, [position, stops.length, pages.length, paged, loading, setV])

  const hasPages = pages.length > 0
  const pos = Math.max(0, Math.min(position, (paged ? stops.length : pages.length) - 1))
  const currentPage = paged ? firstPageOf(stops[pos]) : pos

  // Record song open.
  useEffect(() => {
    if (!song) return
    emit('songOpened', { song, setlistId: useViewer.getState().setlistId })
    // StrictMode (and quick remounts) run this twice for one opening: count a play once.
    const now = Date.now()
    if (lastPlay.id !== song.id || now - lastPlay.at > 2000) {
      updateSong(song.id, { lastPlayedAt: now, playCount: (song.playCount ?? 0) + 1 })
    }
    lastPlay = { id: song.id, at: now }
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
  /** `toEnd`: turning back past page one lands on the previous song's last page. */
  const goSong = useCallback((delta: number, toEnd = false) => {
    const v = useViewer.getState()
    const next = v.index + delta
    if (next < 0 || next >= v.queue.length) {
      toast(delta > 0 ? 'End of list' : 'Start of list')
      return false
    }
    setDirection(delta > 0 ? 1 : -1)
    v.goSong(next, toEnd ? -1 : 0)
    return true
  }, [])

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

  // Turning a page means the performer is playing: get the auto-hiding toolbar out of the way.
  const autoHide = s.display.toolbarAutoHide > 0
  const hideChrome = useCallback(() => {
    const v = useViewer.getState()
    if (autoHide && v.toolbar && !v.panel && !v.annotating) setV({ toolbar: false })
  }, [autoHide, setV])

  const next = useCallback((source?: string) => {
    hideChrome()
    if (!paged || (fit === 'width' && zoom === 1 && mode === 'single') || zoom > 1) {
      if (scrollStep(1)) return
    }
    const v = useViewer.getState()
    const max = paged ? stops.length - 1 : pages.length - 1
    if (paged && v.position < max) {
      setDirection(1)
      v.setPosition(v.position + 1)
    } else if (s.pageTurn.pedalStopsAtSongEnd && (source === 'key' || source === 'midi' || source === 'face')) {
      toast('End of song — tap to continue')
    } else if (s.pageTurn.continueToNextSong) goSong(1)
    else toast('End of song')
  }, [paged, fit, zoom, mode, scrollStep, stops.length, pages.length, s.pageTurn.continueToNextSong, s.pageTurn.pedalStopsAtSongEnd, goSong, hideChrome])

  const prev = useCallback((source?: string) => {
    hideChrome()
    if (!paged || (fit === 'width' && zoom === 1 && mode === 'single') || zoom > 1) {
      if (scrollStep(-1)) return
    }
    const v = useViewer.getState()
    if (paged && v.position > 0) {
      setDirection(-1)
      v.setPosition(v.position - 1)
    } else if (s.pageTurn.pedalStopsAtSongEnd && (source === 'key' || source === 'midi' || source === 'face')) {
      toast('Start of song')
    } else if (s.pageTurn.backToPrevSong) goSong(-1, true)
    else toast('Start of song')
  }, [paged, fit, zoom, mode, scrollStep, s.pageTurn.backToPrevSong, s.pageTurn.pedalStopsAtSongEnd, goSong, hideChrome])

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

  // Keep the same page in view when the layout changes (display mode, two-page turn, text reflow):
  // positions are stop indexes in paged modes and page indexes in scroll modes.
  const shown = useRef<{ songId?: string; page: number; paged: boolean; stops: Stop[] }>({ page: 0, paged, stops })
  useEffect(() => {
    const prevShown = shown.current
    shown.current = { songId, page: currentPage, paged, stops }
    if (prevShown.songId !== songId || loading || !pages.length || position < 0) return
    if (prevShown.stops === stops && prevShown.paged === paged) return
    const page = Math.min(prevShown.page, pages.length - 1)
    if (paged) {
      const p = stopForPage(stops, page)
      if (p !== position) setV({ position: p })
    } else {
      if (page !== position) setV({ position: page })
      if (prevShown.paged) goToPage(page)
    }
  })

  // When a page turns in fit-width/zoomed mode, start at the top of the new page.
  useEffect(() => {
    if (paged) scrollRef.current?.scrollTo({ top: direction > 0 ? 0 : 0, left: 0 })
  }, [pos, paged, direction])

  // Scroll modes: the strip reports the page in view.
  const onStripPage = useCallback((page: number) => {
    if (page !== useViewer.getState().position) setV({ position: page })
  }, [setV])

  // Scroll modes: a song opened at a given page (e.g. its last page when going back) scrolls there.
  const openedAt = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (loading || !hasPages || box.width <= 0 || openedAt.current === songId) return
    openedAt.current = songId
    if (!paged && position !== 0) goToPage(position < 0 ? pages.length - 1 : position)
  })

  useEffect(
    () =>
      registerActions({
        nextPage: next,
        prevPage: prev,
        nextHalfPage: next,
        prevHalfPage: prev,
        nextOnePage: next,
        prevOnePage: prev,
        nextTwoPages: (src) => {
          next(src)
          if (mode !== 'double' || s.display.twoPageTurn !== 'two') next(src)
        },
        prevTwoPages: (src) => {
          prev(src)
          if (mode !== 'double' || s.display.twoPageTurn !== 'two') prev(src)
        },
        nextPageLoop: () => {
          const v = useViewer.getState()
          if (paged && v.position >= stops.length - 1) {
            setDirection(1)
            setV({ position: 0 })
          } else next()
        },
        prevPageLoop: () => {
          const v = useViewer.getState()
          if (paged && v.position <= 0) {
            setDirection(-1)
            setV({ position: stops.length - 1 })
          } else prev()
        },
        firstPage: () => (paged ? setV({ position: 0 }) : goToPage(0)),
        lastPage: () => (paged ? setV({ position: stops.length - 1 }) : goToPage(pages.length - 1)),
        scrollDown: (src) => scrollStep(1) || next(src),
        scrollUp: (src) => scrollStep(-1) || prev(src),
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
          if (r === undefined) return
          setV({ position: r, linkReturn: v.linkReturn.slice(0, -1) })
          if (!paged) goToPage(r)
        },
        textBigger: () => setV({ textZoom: Math.min(3, useViewer.getState().textZoom * 1.1) }),
        textSmaller: () => setV({ textZoom: Math.max(0.4, useViewer.getState().textZoom / 1.1) }),
        transposeUp: () => setV({ transpose: { ...useViewer.getState().transpose, [songId]: (useViewer.getState().transpose[songId] ?? 0) + 1 } }),
        transposeDown: () => setV({ transpose: { ...useViewer.getState().transpose, [songId]: (useViewer.getState().transpose[songId] ?? 0) - 1 } }),
        cycleDisplayMode: () => {
          const order: DisplayMode[] = ['single', 'double', 'halfPage', 'verticalScroll']
          const nextMode = order[(order.indexOf(mode) + 1) % order.length]
          if (song) updateSong(song.id, { display: { ...song.display, mode: nextMode } })
          toast(`Display: ${nextMode}`)
        },
        goToPage: () => askGoToPage(pages.length, currentPage, goToPage),
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
    [next, prev, goSong, paged, stops.length, pages.length, goToPage, scrollStep, setV, s.display.performanceLock, s.display.twoPageTurn, songId, mode, song, currentPage],
  )

  useEffect(() => {
    setViewerApi({
      songId,
      mode,
      pageCount: pages.length,
      currentPage,
      scroller: scrollRef.current,
      canScroll: () => {
        const el = scrollRef.current
        return !!el && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
      },
      goToPage,
      next,
      prev,
    })
  })
  useEffect(() => () => setViewerApi(null), [])

  // Zoom keeps the point under the fingers (or mouse) in place; applied once the new size is laid out.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const zoomFocus = useRef<{ x: number; y: number; from: number } | null>(null)
  const zoomAt = useCallback((next: number, clientX: number, clientY: number) => {
    const r = scrollRef.current?.getBoundingClientRect()
    const z = Math.max(1, Math.min(4, next))
    if (r && z !== zoomRef.current) zoomFocus.current = { x: clientX - r.left, y: clientY - r.top, from: zoomRef.current }
    setZoom(z)
  }, [])
  useLayoutEffect(() => {
    const f = zoomFocus.current
    const el = scrollRef.current
    zoomFocus.current = null
    if (!f || !el || f.from === zoom) return
    const k = zoom / f.from
    el.scrollLeft = (el.scrollLeft + f.x) * k - f.x
    el.scrollTop = (el.scrollTop + f.y) * k - f.y
  }, [zoom])

  // The pinch scale is relative to the start of the gesture, so the base only moves between pinches.
  const pinching = useRef(false)
  useStageGestures(stageRef, {
    enabled: !annotating,
    pinchOnly: annotating,
    zoomed: zoom > 1.01,
    onPinch: (scale, cx, cy) => {
      pinching.current = true
      zoomAt(pinchBase.current * scale, cx, cy)
    },
    onPinchEnd: () => {
      pinching.current = false
      pinchBase.current = zoomRef.current
    },
  })
  useEffect(() => {
    if (!pinching.current) pinchBase.current = zoom
  }, [zoom])

  // Ctrl/Cmd + wheel zoom on desktop.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomAt(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Hide the mouse cursor while performing once the mouse is idle.
  const [cursorHidden, setCursorHidden] = useState(false)
  useEffect(() => {
    if (!s.display.hideCursor) return
    let t = window.setTimeout(() => setCursorHidden(true), 2500)
    const onMove = () => {
      setCursorHidden(false)
      clearTimeout(t)
      t = window.setTimeout(() => setCursorHidden(true), 2500)
    }
    window.addEventListener('mousemove', onMove)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousemove', onMove)
    }
  }, [s.display.hideCursor])

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
    textLayoutWidth: textBox.width,
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
    <div className="fixed inset-0 z-40 flex flex-col bg-black text-white no-select" style={{ cursor: cursorHidden && !toolbar && !annotating ? 'none' : undefined, filter: s.display.brightness < 1 ? `brightness(${s.display.brightness})` : undefined }}>
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden" style={{ background: stageBg, touchAction: zoom > 1 || !paged || fit !== 'page' ? 'pan-x pan-y' : 'none' }}>
        {song && pages.length > 0 && box.width > 0 && (
          paged ? (
            <div ref={scrollRef} className="absolute inset-x-0 bottom-0 overflow-auto" style={{ scrollbarWidth: 'none', top: topInset }}>
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
            <ScrollStrip key={songId} onPage={onStripPage} scrollRef={scrollRef} pages={pages} box={box} zoom={zoom} gap={gap} ctx={ctx} horizontal={mode === 'horizontalScroll'} />
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
  /** Width text pages were paginated at. */
  textLayoutWidth: number
  night: boolean
  paper: string
  annotating: boolean
  showAnnotations: boolean
  onFollowLink: (page: number) => void
}

/** Render one display page in a box. */
export function DisplayPageView({ dp, index, size, ctx, priority = true, clip }: { dp: DisplayPage; index: number; size: Box; ctx: PageCtx; priority?: boolean; clip?: { from: number; to: number } }) {
  // Annotations can be hidden while link points and smart buttons stay usable.
  const overlay = ctx.song ? (
    <>
      {(ctx.showAnnotations || ctx.annotating) && (
        <AnnotationLayer songId={ctx.song.id} fileId={dp.file.id} page={dp.type === 'file' ? dp.page : dp.type === 'text' ? 1000 + dp.page : 2000 + (dp.page ?? 0)} editable={ctx.annotating} />
      )}
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
    return <TextPageView dp={dp} size={size} night={ctx.night} paper={ctx.paper} overlay={overlay} layoutWidth={ctx.textLayoutWidth} />
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

/**
 * A paginated text page. Text is laid out at the size it was paginated for (`layoutWidth`) and scaled
 * to the box it is shown in, so zooming or shrinking the stage never re-flows or clips it.
 */
function TextPageView({ dp, size, night, paper, overlay, layoutWidth }: { dp: Extract<DisplayPage, { type: 'text' }>; size: Box; night: boolean; paper: string; overlay: React.ReactNode; layoutWidth: number }) {
  const pageBadge = useSettings((st) => st.s.display.showPageNumber)
  const w = layoutWidth > 0 ? layoutWidth : size.width
  const h = w / dp.aspect
  const scale = size.width / w
  const gap = w * 0.04
  const style: CSSProperties = {
    ...textContainerStyle(dp.opts.style, dp.zoom),
    width: w,
    height: h,
    padding: w * TEXT_PAGE_PADDING,
    transform: scale !== 1 ? `scale(${scale})` : undefined,
    transformOrigin: '0 0',
  }
  return (
    <div className="relative overflow-hidden" style={{ width: size.width, height: size.height, background: PAPER[paper], filter: night ? 'invert(1) hue-rotate(180deg)' : undefined }}>
      <div style={style}>
        <div data-text-columns className="flex h-full" style={{ gap }}>
          {dp.text.columns.map((col, i) => (
            <div key={i} className="min-w-0 flex-1">
              {col.map((b) => (
                <div key={b.key} style={TEXT_BLOCK_STYLE}>
                  {b.node}
                </div>
              ))}
            </div>
          ))}
          {Array.from({ length: Math.max(0, dp.columns - dp.text.columns.length) }, (_, i) => (
            <div key={'e' + i} className="flex-1" />
          ))}
        </div>
      </div>
      {/* The stage's page-number badge sits in the same corner; only number text pages without it. */}
      {dp.count > 1 && !pageBadge && (
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
  const items = prefetchPages(stops, pos)
    .filter(({ page }) => pages[page]?.type === 'file')
    .map(({ stop, slot, page }) => ({ dp: pages[page], i: page, size: stopBoxes(stops[stop], pages, box, fit, gap, 1)[slot] }))
  const ctx: PageCtx = { song: undefined, textLayoutWidth: 0, night: false, paper: 'white', annotating: false, showAnnotations: false, onFollowLink: () => {} }
  return (
    <div aria-hidden className="pointer-events-none fixed -left-[20000px] top-0 opacity-0">
      {items.map(({ dp, i, size }) => (
        <DisplayPageView key={dp.key} dp={dp} index={i} size={size} ctx={ctx} priority={false} />
      ))}
    </div>
  )
}

function ScrollStrip({ scrollRef, pages, box, zoom, gap, ctx, horizontal, onPage }: { scrollRef: React.RefObject<HTMLDivElement | null>; pages: DisplayPage[]; box: Box; zoom: number; gap: number; ctx: PageCtx; horizontal: boolean; onPage: (page: number) => void }) {
  const [visible, setVisible] = useState<Set<number>>(() => new Set([0, 1, 2]))
  // Report the page in view (the strip owns the element, so this is attached whenever it exists).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const ref = horizontal ? el.scrollLeft + el.clientWidth * 0.3 : el.scrollTop + el.clientHeight * 0.3
      let cur = 0
      el.querySelectorAll<HTMLElement>('[data-page]').forEach((it) => {
        if ((horizontal ? it.offsetLeft : it.offsetTop) <= ref) cur = Number(it.dataset.page)
      })
      onPage(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef, horizontal, onPage])
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
