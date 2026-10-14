import { Hand, Minus, Play, Plus, Square, X } from 'lucide-react'
import { useState } from 'react'
import { updateSong } from '../db/db'
import type { MetronomeSettings } from '../db/schema'
import { useSettings } from '../state/settings'
import { cx, Segmented, Select, Slider, Toggle } from '../ui/primitives'
import type { PanelProps } from '../viewer/panels'
import { AutoScrollPanel } from './AutoScrollPanel'
import { clampBpm } from './metronome/clock'
import { metronome, songMetronome, useMetronome } from './metronome/engine'
import { SOUNDS } from './metronome/sounds'
import { tempoMarking } from './metronome/tempo'
import { PanelBody, PanelButton, Row, ScopeLine, Section, Stepper } from './ui'
import { startMetronomeFor, tap } from './useToolActions'

const SUBDIVISIONS = [
  { value: 1, label: '♩', title: 'Beats only' },
  { value: 2, label: '♫', title: 'Eighths' },
  { value: 3, label: '3', title: 'Triplets' },
  { value: 4, label: '♬', title: 'Sixteenths' },
]

/** Metronome + auto-scroll controls. Changes are saved for the current song; "Make default" promotes them. */
export function MetronomePanel(props: PanelProps) {
  const [tab, setTab] = useState<'metronome' | 'scroll'>('metronome')
  return (
    <div>
      <div className="px-4 pt-4">
        <Segmented
          className="w-full !border-white/10 !bg-white/5"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'metronome', label: 'Metronome' },
            { value: 'scroll', label: 'Auto-scroll' },
          ]}
        />
      </div>
      {tab === 'metronome' ? <MetronomeControls {...props} /> : <AutoScrollPanel {...props} />}
    </div>
  )
}

function MetronomeControls({ song }: PanelProps) {
  const m = useMetronome()
  const prefs = useSettings((st) => st.s.metronome)
  const setIn = useSettings((st) => st.setIn)
  // Settings follow the song record; the engine's bpm can differ temporarily (tap, song tempo list).
  const cfg: MetronomeSettings = { ...songMetronome(song), bpm: metronome.songId === song.id ? m.bpm : songMetronome(song).bpm }
  const tempos = (song.tempos ?? []).filter((t) => t > 0)

  const save = (patch: Partial<MetronomeSettings>) => {
    const next = { ...cfg, ...patch }
    metronome.configure(next, song.id)
    void updateSong(song.id, { metronome: { ...song.metronome, ...patch } })
  }
  const setBpm = (bpm: number) => save({ bpm: clampBpm(bpm) })

  return (
    <PanelBody>
      {/* Tempo */}
      <section className="flex flex-col items-center gap-3">
        <div className="flex w-full items-center justify-between gap-2">
          <button className="flex size-12 items-center justify-center rounded-2xl border border-white/10 hover:bg-white/10" aria-label="Slower" onClick={() => setBpm(cfg.bpm - 1)}>
            <Minus className="size-5" />
          </button>
          <div className="text-center">
            <div className="text-5xl font-bold tabular-nums leading-none">{cfg.bpm}</div>
            <div className="mt-1 text-xs uppercase tracking-wider text-white/50">
              BPM · {tempoMarking(cfg.bpm)}
            </div>
          </div>
          <button className="flex size-12 items-center justify-center rounded-2xl border border-white/10 hover:bg-white/10" aria-label="Faster" onClick={() => setBpm(cfg.bpm + 1)}>
            <Plus className="size-5" />
          </button>
        </div>
        <Slider label="Tempo" min={20} max={300} value={cfg.bpm} onChange={setBpm} />
        <div className="grid w-full grid-cols-2 gap-2">
          <PanelButton onClick={() => tap(song)} className="min-h-12 text-base" title="Tap at least twice">
            <Hand className="size-4" /> Tap tempo
          </PanelButton>
          <PanelButton primary onClick={() => startMetronomeFor(song)} className="min-h-12 text-base">
            {m.running ? <Square className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
            {m.running ? 'Stop' : 'Start'}
          </PanelButton>
        </div>
        {m.running && (
          <div className="flex gap-1.5" aria-hidden>
            {Array.from({ length: cfg.beatsPerBar }, (_, i) => (
              <span key={i} className="size-3 rounded-full" style={{ background: i === m.beat ? (i === 0 ? 'var(--os-accent)' : '#fff') : 'rgb(255 255 255 / 0.15)' }} />
            ))}
          </div>
        )}
      </section>

      <Section
        title="Song tempos"
        action={
          <button className="text-xs text-[var(--os-accent)]" onClick={() => !tempos.includes(cfg.bpm) && updateSong(song.id, { tempos: [...tempos, cfg.bpm] })}>
            + Add {cfg.bpm}
          </button>
        }
      >
        {tempos.length ? (
          <div className="flex flex-wrap gap-2">
            {tempos.map((t, i) => (
              <span key={`${t}-${i}`} className={cx('inline-flex items-center rounded-full border text-sm', t === cfg.bpm ? 'border-[var(--os-accent)] bg-[var(--os-accent)]/15' : 'border-white/10')}>
                <button className="min-h-9 pl-3 pr-1 tabular-nums" onClick={() => metronome.configure({ ...cfg, bpm: t }, song.id)}>
                  {t}
                </button>
                <button className="flex size-8 items-center justify-center text-white/50 hover:text-white" aria-label={`Remove tempo ${t}`} onClick={() => updateSong(song.id, { tempos: tempos.filter((_, j) => j !== i) })}>
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-white/45">Save several tempos (intro, verse, outro…) and step through them with the "Next metronome tempo" pedal action.</p>
        )}
      </Section>

      <Section title="Rhythm">
        <div className="divide-y divide-white/10">
          <Row label="Time signature">
            <Stepper label="beats per bar" min={1} max={16} value={cfg.beatsPerBar} onChange={(v) => save({ beatsPerBar: v })} />
            <span className="text-white/40">/</span>
            <Select className="!h-10 !w-20 !pl-3 !pr-1" value={cfg.beatUnit} onChange={(e) => save({ beatUnit: Number(e.target.value) })} aria-label="Beat unit">
              {[2, 4, 8, 16].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Subdivision">
            <Segmented size="sm" className="!border-white/10 !bg-white/5" value={cfg.subdivision} onChange={(v) => save({ subdivision: v })} options={SUBDIVISIONS} />
          </Row>
          <Row label="Accent first beat">
            <Toggle checked={cfg.accentFirst} onChange={(v) => save({ accentFirst: v })} />
          </Row>
          <Row label="Count-in" hint="Bars counted before the song">
            <Stepper label="count-in bars" min={0} max={4} value={cfg.countIn} onChange={(v) => save({ countIn: v })} format={(v) => (v ? `${v} bar${v > 1 ? 's' : ''}` : 'Off')} />
          </Row>
        </div>
      </Section>

      <Section title="Sound & display">
        <div className="divide-y divide-white/10">
          <Row label="Click">
            <Toggle checked={cfg.audible} onChange={(v) => save({ audible: v })} />
          </Row>
          {cfg.audible && (
            <>
              <Row label="Sound">
                <Select className="!h-10 !w-36" value={cfg.sound} onChange={(e) => save({ sound: e.target.value as MetronomeSettings['sound'] })} aria-label="Sound">
                  {SOUNDS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label="Volume">
                <Slider className="w-36" label="Volume" min={0} max={1} step={0.05} value={cfg.volume} onChange={(v) => save({ volume: v })} />
              </Row>
            </>
          )}
          <Row label="Visual beat">
            <Toggle checked={cfg.visual} onChange={(v) => save({ visual: v })} />
          </Row>
          {cfg.visual && (
            <Row label="Style">
              <Segmented
                size="sm"
                className="!border-white/10 !bg-white/5"
                value={prefs.visualStyle}
                onChange={(v) => setIn('metronome', { visualStyle: v })}
                options={[
                  { value: 'border', label: 'Frame' },
                  { value: 'dot', label: 'Dots' },
                ]}
              />
            </Row>
          )}
          <Row label="Big beat number">
            <Toggle checked={prefs.bigBeat} onChange={(v) => setIn('metronome', { bigBeat: v })} />
          </Row>
        </div>
      </Section>

      <Section title="Automation">
        <div className="divide-y divide-white/10">
          <Row label="Start when song opens">
            <Toggle checked={!!cfg.autoStart} onChange={(v) => save({ autoStart: v })} />
          </Row>
          <Row label="Turn page every" hint="Beats per page while running">
            <Stepper label="beats per page" min={0} max={256} step={cfg.beatsPerBar} value={cfg.beatsPerPage ?? 0} onChange={(v) => save({ beatsPerPage: v })} format={(v) => (v ? `${v / cfg.beatsPerBar} bars` : 'Off')} />
          </Row>
          {cfg.countIn > 0 && (
            <>
              <Row label="After count-in">
                <Segmented
                  size="sm"
                  className="!border-white/10 !bg-white/5"
                  value={prefs.afterCountIn}
                  onChange={(v) => setIn('metronome', { afterCountIn: v })}
                  options={[
                    { value: 'continue', label: 'Keep clicking' },
                    { value: 'stop', label: 'Stop' },
                  ]}
                />
              </Row>
              <Row label="Count-in starts auto-scroll">
                <Toggle checked={prefs.countInStartsScroll} onChange={(v) => setIn('metronome', { countInStartsScroll: v })} />
              </Row>
            </>
          )}
          <Row label="Keep running between songs">
            <Toggle checked={prefs.keepRunning} onChange={(v) => setIn('metronome', { keepRunning: v })} />
          </Row>
        </div>
        <ScopeLine
          perSong={!!song.metronome && Object.keys(song.metronome).length > 0}
          onReset={() => {
            void updateSong(song.id, { metronome: undefined })
            metronome.configure(songMetronome({ ...song, metronome: undefined }), song.id)
          }}
          onMakeDefault={() => {
            const { autoStart: _a, beatsPerPage: _b, ...rest } = cfg
            setIn('metronome', rest)
          }}
        />
      </Section>
    </PanelBody>
  )
}
