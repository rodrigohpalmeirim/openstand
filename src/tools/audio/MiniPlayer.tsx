import { Pause, Play, Plus, Repeat, RotateCcw, RotateCw, SkipBack, SkipForward, X } from 'lucide-react'
import type { Song } from '../../db/schema'
import { useTerms } from '../../library/browse/terms'
import { useSettings } from '../../state/settings'
import { useViewer } from '../../state/viewer'
import { cx } from '../../ui/primitives'
import { useTools } from '../store'
import { fmtTime, player, stepTrack, useAudio } from './player'

const btn = 'flex size-10 pointer-coarse:size-11 shrink-0 items-center justify-center rounded-xl text-white/85 hover:bg-white/10 disabled:opacity-30'

/** Seek bar with the A-B loop region drawn behind it. */
export function SeekBar({ className }: { className?: string }) {
  const a = useAudio()
  const dur = a.duration || 0
  const pct = (t?: number) => (dur && t !== undefined ? (t / dur) * 100 : 0)
  return (
    <div className={cx('relative flex h-6 items-center', className)}>
      {a.loopStart !== undefined && dur > 0 && (
        <div
          className="pointer-events-none absolute h-2 rounded bg-[var(--os-accent)]/35"
          style={{ left: `${pct(a.loopStart)}%`, width: `${Math.max(0.5, pct(a.loopEnd ?? a.time) - pct(a.loopStart))}%` }}
        />
      )}
      <input
        type="range"
        aria-label="Seek"
        min={0}
        max={dur || 1}
        step={0.1}
        value={Math.min(a.time, dur || 1)}
        onChange={(e) => player.seek(Number(e.target.value))}
        className="relative h-1 w-full accent-[var(--os-accent)]"
        disabled={!a.trackId}
      />
    </div>
  )
}

export function MiniPlayer({ song }: { song: Song }) {
  const visible = useTools((t) => t.playerVisible)
  const a = useAudio()
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const panel = useViewer((v) => !!v.panel)
  const skip = useSettings((st) => st.s.audio.skipSeconds)
  const terms = useTerms()
  if (!visible) return null
  const track = song.audio.find((t) => t.id === a.trackId)
  const otherSong = a.trackId && a.songId !== song.id
  const loopLabel = a.loopEnd !== undefined ? 'Clear A-B loop' : a.settingLoop ? 'Set loop end (B)' : 'Set loop start (A)'
  return (
    <div
      className={cx(
        'absolute left-1/2 z-20 w-[min(40rem,calc(100%-1rem))] -translate-x-1/2 rounded-2xl border border-white/10 bg-neutral-900/92 px-2 py-1.5 text-white shadow-2xl backdrop-blur-xl',
        // Centre beside an open side panel instead of under it (on phones the panel is a bottom sheet).
        panel && 'sm:left-[calc((100%-24.5rem)/2)] sm:w-[min(40rem,calc(100%-25.5rem))]',
      )}
      style={{ bottom: `calc(${toolbar ? 64 : 40}px + env(safe-area-inset-bottom))` }}
      role="region"
      aria-label="Audio player"
    >
      <div className="flex items-center gap-1">
        <button className={btn} aria-label="Previous track" onClick={() => void stepTrack(song, -1)} disabled={song.audio.length < 2}>
          <SkipBack className="size-4" />
        </button>
        <button className={btn} aria-label={`Back ${skip} seconds`} onClick={() => player.skip(-skip)} disabled={!a.trackId}>
          <RotateCcw className="size-4" />
        </button>
        {/* Nothing to play yet: offer to add a track instead of a dead play button. */}
        {!a.trackId && !song.audio.length ? (
          <button
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--os-accent)] text-[var(--os-accent-fg)] hover:brightness-110"
            aria-label="Add audio"
            title="Add audio"
            onClick={() => useViewer.getState().set({ panel: 'audio' })}
          >
            <Plus className="size-5" />
          </button>
        ) : (
          <button
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--os-accent)] text-[var(--os-accent-fg)] hover:brightness-110"
            aria-label={a.playing ? 'Pause' : 'Play'}
            onClick={() => void player.toggle(song)}
          >
            {a.playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 translate-x-px fill-current" />}
          </button>
        )}
        <button className={btn} aria-label={`Forward ${skip} seconds`} onClick={() => player.skip(skip)} disabled={!a.trackId}>
          <RotateCw className="size-4" />
        </button>
        <button className={btn} aria-label="Next track" onClick={() => void stepTrack(song, 1)} disabled={song.audio.length < 2}>
          <SkipForward className="size-4" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium text-white/90">
              {track?.name ?? (otherSong ? a.trackName || `Track from previous ${terms.song}` : song.audio.length ? 'Ready' : 'No audio tracks')}
            </span>
            <span className="shrink-0 tabular-nums text-white/55">
              {fmtTime(a.time)} / {fmtTime(a.duration)}
            </span>
          </div>
          <SeekBar />
        </div>
        <button
          className={cx(btn, 'w-auto px-2 text-xs font-bold pointer-coarse:w-auto', (a.settingLoop || a.loopEnd !== undefined) && 'text-[var(--os-accent)]')}
          aria-label={loopLabel}
          title={loopLabel}
          onClick={() => player.abLoop()}
          disabled={!a.trackId}
        >
          <Repeat className="mr-1 size-4" />
          {a.loopEnd !== undefined ? 'A-B' : a.settingLoop ? 'B?' : 'A'}
        </button>
        <button className={btn} aria-label="Hide player" onClick={() => useTools.setState({ playerVisible: false })}>
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
