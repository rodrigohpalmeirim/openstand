import {
  AudioLines,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Link2,
  ListMusic,
  Maximize,
  Minimize,
  MonitorCog,
  MoreHorizontal,
  Music2,
  Pencil,
  ScrollText,
  StickyNote,
  Timer,
  Type,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { AnnotationToolbar } from '../annotations/AnnotationToolbar'
import type { DisplayMode, Song } from '../db/schema'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useSettings } from '../state/settings'
import { useViewer, type Panel } from '../state/viewer'
import { ViewerAddons } from '../tools/ViewerAddons'
import { cx, Menu, useMenu } from '../ui/primitives'
import { askGoToPage } from './askPage'
import { PagePreview } from './PagePreview'
import { runAction } from './actions'
import type { Stop } from './layout'
import { PANELS, type PanelProps } from './panels'
import type { DisplayPage } from './useDisplayPages'

interface Props {
  song: Song
  pages: DisplayPage[]
  stops: Stop[]
  pos: number
  paged: boolean
  mode: DisplayMode
  currentPage: number
  goToPage: (p: number) => void
  zoom: number
}

function ChromeButton({ label, active, onClick, children, className }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-xl transition',
        active ? 'bg-[var(--os-accent)] text-[var(--os-accent-fg)]' : 'text-white/85 hover:bg-white/10',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function ViewerChrome(props: Props) {
  const { song, pages, pos, paged, stops, currentPage, goToPage } = props
  const v = useViewer()
  const s = useSettings((st) => st.s)
  const setlist = useLiveQuery(() => (v.setlistId ? db.setlists.get(v.setlistId) : undefined), [v.setlistId])
  const nextSong = useLiveQuery(() => (v.queue[v.index + 1] ? db.songs.get(v.queue[v.index + 1]) : undefined), [v.queue, v.index])
  const [fs, setFs] = useState(!!document.fullscreenElement)
  const more = useMenu()
  const [scrub, setScrub] = useState<{ index: number; left: number } | null>(null)
  const isText = pages.some((p) => p.type === 'text' || p.type === 'abc')

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const togglePanel = (p: Panel) => v.set({ panel: v.panel === p ? null : p })
  const panelProps: PanelProps = { ...props, close: () => v.set({ panel: null }) }
  const panel = v.panel && v.panel !== 'goto' && v.panel !== 'pages' ? PANELS[v.panel] : null
  const showChrome = v.toolbar || v.annotating
  const pageLabel = pages.length ? `${currentPage + 1} / ${pages.length}` : ''
  const atLastStop = paged ? pos >= stops.length - 1 : currentPage >= pages.length - 1

  return (
    <>
      <ViewerAddons {...panelProps} />

      {/* Persistent, unobtrusive info when the toolbar is hidden */}
      {!showChrome && s.display.showPageNumber && pages.length > 1 && (
        <div className="pointer-events-none absolute bottom-2 right-3 z-10 rounded-full bg-black/45 px-2.5 py-1 text-xs font-medium tabular-nums text-white/85 backdrop-blur">
          {pageLabel}
        </div>
      )}
      {!showChrome && s.display.showNextSongHint && atLastStop && nextSong && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs text-white/85 backdrop-blur">
          Next: <span className="font-semibold">{nextSong.title}</span>
        </div>
      )}

      {/* Top bar */}
      <div
        data-viewer-top
        className={cx(
          'absolute inset-x-0 top-0 z-20 transition-all duration-200',
          showChrome ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0',
        )}
      >
        <div className="flex items-center gap-1 bg-gradient-to-b from-black/85 to-black/60 px-2 py-1.5 backdrop-blur-md pt-[max(0.375rem,env(safe-area-inset-top))]">
          <ChromeButton label="Back to library" onClick={() => v.close()}>
            <ChevronLeft className="size-5" />
          </ChromeButton>
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-[15px] font-semibold leading-tight">{song.title}</div>
            <div className="truncate text-xs text-white/55">
              {[song.artists.join(', '), song.keys[0] && `Key ${song.keys[0]}`, setlist && `${setlist.name} · ${v.index + 1}/${v.queue.length}`].filter(Boolean).join(' · ') ||
                (v.queue.length > 1 ? `${v.index + 1} of ${v.queue.length}` : '')}
            </div>
          </div>
          {v.annotating ? null : (
            <div className="flex items-center gap-0.5">
              <ChromeButton label="Annotate" onClick={() => runAction('toggleAnnotate')}>
                <Pencil className="size-[18px]" />
              </ChromeButton>
              {isText && (
                <ChromeButton label="Text & chords" active={v.panel === 'text'} onClick={() => togglePanel('text')}>
                  <Type className="size-[18px]" />
                </ChromeButton>
              )}
              <ChromeButton label="Metronome" active={v.panel === 'metronome' || v.metronomeOn} onClick={() => togglePanel('metronome')}>
                <Timer className="size-[18px]" />
              </ChromeButton>
              <ChromeButton label="Auto-scroll" active={v.autoScrollOn} onClick={() => runAction('toggleAutoScroll')}>
                <ScrollText className="size-[18px]" />
              </ChromeButton>
              {song.audio.length > 0 && (
                <ChromeButton label="Audio" active={v.panel === 'audio'} onClick={() => togglePanel('audio')}>
                  <AudioLines className="size-[18px]" />
                </ChromeButton>
              )}
              <ChromeButton label="Bookmarks" active={v.panel === 'bookmarks'} onClick={() => togglePanel('bookmarks')}>
                <Bookmark className="size-[18px]" />
              </ChromeButton>
              {v.queue.length > 1 && (
                <ChromeButton label="Setlist" active={v.panel === 'setlist'} onClick={() => togglePanel('setlist')}>
                  <ListMusic className="size-[18px]" />
                </ChromeButton>
              )}
              <ChromeButton label="Display" active={v.panel === 'display'} onClick={() => togglePanel('display')}>
                <MonitorCog className="size-[18px]" />
              </ChromeButton>
              <button
                ref={more.ref}
                onClick={more.toggle}
                aria-label="More"
                className="inline-flex size-10 items-center justify-center rounded-xl text-white/85 hover:bg-white/10"
              >
                <MoreHorizontal className="size-5" />
              </button>
              <Menu
                anchor={more.anchor}
                open={more.open}
                onClose={more.close}
                items={[
                  { label: 'Song notes', icon: <StickyNote className="size-4" />, onSelect: () => togglePanel('notes') },
                  { label: 'Link points', icon: <Link2 className="size-4" />, onSelect: () => togglePanel('links') },
                  { label: 'MIDI', icon: <Music2 className="size-4" />, onSelect: () => togglePanel('midi') },
                  { label: 'Auto-scroll settings', icon: <ScrollText className="size-4" />, onSelect: () => togglePanel('autoscroll') },
                  { label: 'Audio player', icon: <AudioLines className="size-4" />, onSelect: () => runAction('toggleAudioPlayer') },
                  { divider: true, label: '' },
                  { label: fs ? 'Exit fullscreen' : 'Fullscreen', icon: fs ? <Minimize className="size-4" /> : <Maximize className="size-4" />, onSelect: () => runAction('toggleFullscreen') },
                  { label: v.hideAnnotations ? 'Show annotations' : 'Hide annotations', onSelect: () => runAction('toggleAnnotations') },
                ]}
              />
            </div>
          )}
        </div>
        {v.annotating && <AnnotationToolbar song={song} onDone={() => v.set({ annotating: false })} />}
      </div>

      {/* Bottom bar: page scrubber + song navigation */}
      {!v.annotating && (
        <div
          className={cx(
            'absolute inset-x-0 bottom-0 z-20 transition-all duration-200',
            showChrome ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0',
          )}
        >
          <div className="flex items-center gap-2 bg-gradient-to-t from-black/85 to-black/60 px-2 py-1.5 backdrop-blur-md pb-[max(0.375rem,env(safe-area-inset-bottom))]">
            <ChromeButton label="Previous song" onClick={() => runAction('prevSong')} className={v.index === 0 ? 'opacity-30' : ''}>
              <ChevronLeft className="size-5" />
            </ChromeButton>
            <input
              type="range"
              aria-label="Page"
              min={0}
              max={Math.max(0, pages.length - 1)}
              value={currentPage}
              onChange={(e) => {
                const i = Number(e.target.value)
                const r = e.currentTarget.getBoundingClientRect()
                setScrub({ index: i, left: r.left + (r.width * i) / Math.max(1, pages.length - 1) })
                goToPage(i)
              }}
              onPointerUp={() => setScrub(null)}
              onBlur={() => setScrub(null)}
              className="h-1 flex-1 accent-[var(--os-accent)]"
              disabled={pages.length < 2}
            />
            <button
              className="w-16 rounded-md py-1 text-center text-xs tabular-nums text-white/70 hover:bg-white/10"
              title="Go to page…"
              onClick={() => askGoToPage(pages.length, currentPage, goToPage)}
            >
              {pageLabel}
            </button>
            <ChromeButton label="Next song" onClick={() => runAction('nextSong')} className={v.index >= v.queue.length - 1 ? 'opacity-30' : ''}>
              <ChevronRight className="size-5" />
            </ChromeButton>
          </div>
        </div>
      )}

      {scrub && pages[scrub.index] && <PagePreview dp={pages[scrub.index]} index={scrub.index} total={pages.length} left={scrub.left} />}

      {/* Side panel */}
      {panel && (
        <div className="absolute bottom-0 right-0 top-0 z-30 flex w-full max-w-sm flex-col border-l border-white/10 bg-[#141416] text-white shadow-2xl animate-fade-in sm:top-14 sm:bottom-14 sm:right-2 sm:rounded-2xl sm:border">
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            <h2 className="flex-1 text-sm font-semibold">{panel.title}</h2>
            <button className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10" onClick={() => v.set({ panel: null })}>
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <panel.Component {...panelProps} />
          </div>
        </div>
      )}
    </>
  )
}
