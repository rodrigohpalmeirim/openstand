import { Play, Square } from 'lucide-react'
import { updateSong } from '../db/db'
import type { AutoScrollSettings } from '../db/schema'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { Input, Segmented, Toggle } from '../ui/primitives'
import { viewerApi } from '../viewer/api'
import type { PanelProps } from '../viewer/panels'
import { songAutoScroll } from './autoScroll/config'
import { DEFAULT_SONG_SECONDS } from './autoScroll/math'
import { fmtTime } from './audio/player'
import { stopAutoScroll, startAutoScroll, useTools } from './store'
import { PanelBody, PanelButton, Row, ScopeLine, Section, Stepper } from './ui'
import { parseClock } from './util'

/** Auto-scroll settings for the current song (shown as a tab of the metronome panel). */
export function AutoScrollPanel({ song, paged, mode }: PanelProps) {
  useSettings((st) => st.s.autoScroll) // re-render when defaults change
  const setIn = useSettings((st) => st.setIn)
  const prefs = useSettings((st) => st.s.autoScroll)
  const on = useViewer((v) => v.autoScrollOn)
  const factor = useTools((t) => t.scrollFactor)
  const s = songAutoScroll(song)
  const save = (patch: Partial<AutoScrollSettings>) => void updateSong(song.id, { autoScroll: { ...song.autoScroll, ...patch } })
  const canScroll = viewerApi()?.canScroll() && mode !== 'horizontalScroll'
  const how = canScroll
    ? paged
      ? 'Scrolls down each page, pauses at the bottom, then turns the page.'
      : 'Scrolls the whole song continuously.'
    : 'This view fits whole pages, so pages turn on a timer instead of scrolling.'

  return (
    <PanelBody>
      <PanelButton primary className="min-h-12 w-full text-base" onClick={() => (on ? stopAutoScroll() : startAutoScroll())}>
        {on ? <Square className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
        {on ? 'Stop auto-scroll' : 'Start auto-scroll'}
      </PanelButton>
      <p className="-mt-2 text-xs text-white/50">{how}</p>

      <Section title="Speed">
        <Segmented
          className="w-full !border-white/10 !bg-white/5"
          value={s.mode}
          onChange={(v) => save({ mode: v })}
          options={[
            { value: 'duration', label: 'Song length' },
            { value: 'speed', label: 'Fixed speed' },
          ]}
        />
        <div className="mt-2 divide-y divide-white/10">
          {s.mode === 'duration' ? (
            <Row label="Song length" hint={song.duration ? 'From the song details' : `Not set — using ${fmtTime(DEFAULT_SONG_SECONDS)}`}>
              <Input
                key={song.duration}
                className="!h-10 !w-24 text-center tabular-nums"
                defaultValue={song.duration ? fmtTime(song.duration) : ''}
                placeholder={fmtTime(DEFAULT_SONG_SECONDS)}
                aria-label="Song length (m:ss)"
                onBlur={(e) => {
                  const v = parseClock(e.target.value)
                  if (v !== undefined && v !== song.duration) void updateSong(song.id, { duration: Math.round(v) })
                }}
              />
            </Row>
          ) : (
            <Row label="Pixels per second">
              <Stepper label="speed" min={2} max={400} step={2} value={s.speed} onChange={(v) => save({ speed: v })} />
            </Row>
          )}
          {factor !== 1 && (
            <Row label="Session speed" hint="From the faster/slower actions">
              <button className="text-sm text-[var(--os-accent)]" onClick={() => useTools.setState({ scrollFactor: 1 })}>
                {Math.round(factor * 100)}% · reset
              </button>
            </Row>
          )}
        </div>
      </Section>

      <Section title="Timing">
        <div className="divide-y divide-white/10">
          <Row label="Start delay" hint="Seconds before scrolling begins">
            <Stepper label="start delay" min={0} max={60} value={s.delay} onChange={(v) => save({ delay: v })} format={(v) => `${v}s`} />
          </Row>
          <Row label="Pause at page end">
            <Stepper label="page end pause" min={0} max={30} value={s.pageDelay} onChange={(v) => save({ pageDelay: v })} format={(v) => `${v}s`} />
          </Row>
          <Row label="Start when song opens">
            <Toggle checked={!!s.startOnLoad} onChange={(v) => save({ startOnLoad: v })} />
          </Row>
        </div>
        <ScopeLine
          perSong={!!song.autoScroll && Object.keys(song.autoScroll).length > 0}
          onReset={() => void updateSong(song.id, { autoScroll: undefined })}
          onMakeDefault={() => {
            const { startOnLoad: _s, pauseOnTouch: _p, ...rest } = s
            setIn('autoScroll', rest)
          }}
        />
      </Section>

      <Section title="Options">
        <div className="divide-y divide-white/10">
          <Row label="Touching the page pauses">
            <Toggle checked={prefs.pauseOnTouch} onChange={(v) => setIn('autoScroll', { pauseOnTouch: v })} />
          </Row>
          <Row label="Progress bar">
            <Toggle checked={prefs.showProgress} onChange={(v) => setIn('autoScroll', { showProgress: v })} />
          </Row>
        </div>
      </Section>
    </PanelBody>
  )
}
