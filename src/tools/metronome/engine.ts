import { create } from 'zustand'
import type { MetronomeSettings, Song } from '../../db/schema'
import { settings } from '../../state/settings'
import { useViewer } from '../../state/viewer'
import { toast } from '../../ui/primitives'
import { viewerApi } from '../../viewer/api'
import { startAutoScroll } from '../store'
import { TickClock, type Tick, type TickLevel } from './clock'
import { renderClick, type SoundId } from './sounds'
import { parseSignature, songBpm } from './tempo'

/** Live metronome status for visuals. */
interface MetronomeStatus {
  running: boolean
  /** True while the count-in bars play. */
  countingIn: boolean
  /** Beat within the bar (0-based) of the last tick heard. */
  beat: number
  /** Bar number (0-based, count-in bars excluded; negative during the count-in). */
  bar: number
  level: TickLevel
  /** Increments on every beat (not subdivisions), to retrigger animations. */
  seq: number
  bpm: number
  beatsPerBar: number
  /** Visual beat display enabled for the current settings. */
  visual: boolean
}

export const useMetronome = create<MetronomeStatus>(() => ({
  running: false,
  countingIn: false,
  beat: 0,
  bar: 0,
  level: 'beat',
  seq: 0,
  bpm: 100,
  beatsPerBar: 4,
  visual: true,
}))

/**
 * Effective settings for a song: per-song values over the defaults. The song's time signature seeds the
 * meter; the BPM is `songBpm` (an older per-song metronome BPM, else the first tempo).
 */
export function songMetronome(song: Song | undefined): MetronomeSettings {
  const d = settings().metronome
  const base: MetronomeSettings = {
    bpm: d.bpm,
    beatsPerBar: d.beatsPerBar,
    beatUnit: d.beatUnit,
    subdivision: d.subdivision,
    accentFirst: d.accentFirst,
    countIn: d.countIn,
    visual: d.visual,
    audible: d.audible,
    sound: d.sound,
    volume: d.volume,
    autoStart: d.autoStart ?? false,
    beatsPerPage: d.beatsPerPage ?? 0,
  }
  const meter = parseSignature(song?.signatures?.[0])
  const bpm = songBpm(song)
  return { ...base, ...meter, ...(song?.metronome ?? {}), ...(bpm ? { bpm } : {}) }
}

const LOOKAHEAD = 0.12
const HIDDEN_LOOKAHEAD = 1.6
const TIMER_MS = 25

/**
 * Web Audio look-ahead scheduler: a coarse timer queues clicks slightly ahead on the audio clock,
 * which plays them sample-accurately. Visuals and page auto-turns follow the audio output clock.
 */
class MetronomeEngine {
  cfg: MetronomeSettings = songMetronome(undefined)
  /** Song the settings came from. */
  songId: string | null = null
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private buffers = new Map<string, AudioBuffer>()
  private clock: TickClock | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private raf = 0
  private pending: Tick[] = []
  private countIn = 0
  /** Audio time at which a "stop after count-in" run ends. */
  private endAt: number | null = null
  private beatsOnPage = 0

  get running() {
    return this.clock !== null
  }

  private audio(): AudioContext | null {
    if (this.ctx) return this.ctx
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    this.ctx = new AC({ latencyHint: 'interactive' })
    this.gain = this.ctx.createGain()
    this.gain.connect(this.ctx.destination)
    return this.ctx
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : performance.now() / 1000
  }

  /** What is being heard right now (compensates output latency so flashes match clicks). */
  private heardNow(): number {
    if (!this.ctx) return this.now()
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0)
  }

  private buffer(sound: SoundId, level: TickLevel): AudioBuffer | null {
    const ctx = this.ctx
    if (!ctx) return null
    const key = `${sound}:${level}`
    let b = this.buffers.get(key)
    if (!b) {
      const data = renderClick(sound, level, ctx.sampleRate)
      b = ctx.createBuffer(1, data.length, ctx.sampleRate)
      b.getChannelData(0).set(data)
      this.buffers.set(key, b)
    }
    return b
  }

  private meter() {
    return { bpm: this.cfg.bpm, beatsPerBar: this.cfg.beatsPerBar, subdivision: this.cfg.subdivision, accentFirst: this.cfg.accentFirst }
  }

  /** Apply new settings; a running metronome changes tempo/meter at the next tick. */
  configure(cfg: MetronomeSettings, songId?: string) {
    this.cfg = cfg
    if (songId) this.songId = songId
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, cfg.volume))
    if (this.clock) this.clock.setMeter(this.meter(), this.now() + 0.02)
    useMetronome.setState({ bpm: cfg.bpm, beatsPerBar: cfg.beatsPerBar, visual: cfg.visual })
  }

  start(opts: { countIn?: number } = {}) {
    if (this.clock) return
    const ctx = this.audio()
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, this.cfg.volume))
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {})
      // Autoplay policy: without a recent user gesture the clock stays frozen.
      setTimeout(() => {
        if (this.clock && ctx.state !== 'running')
          toast('Tap to enable the metronome sound', 'info', { label: 'Enable', run: () => void ctx.resume() })
      }, 500)
    }
    this.countIn = Math.max(0, Math.round(opts.countIn ?? this.cfg.countIn ?? 0))
    this.endAt = null
    this.beatsOnPage = 0
    this.pending = []
    this.clock = new TickClock(this.meter(), this.now() + 0.06)
    useMetronome.setState({ running: true, countingIn: this.countIn > 0, beat: -1, bar: -this.countIn, seq: 0, bpm: this.cfg.bpm, beatsPerBar: this.cfg.beatsPerBar })
    useViewer.setState({ metronomeOn: true })
    this.schedule()
    this.timer = setInterval(() => this.schedule(), TIMER_MS)
    const loop = () => {
      this.dispatch()
      if (this.clock) this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    cancelAnimationFrame(this.raf)
    this.timer = null
    this.clock = null
    this.pending = []
    this.endAt = null
    useMetronome.setState({ running: false, countingIn: false, beat: -1 })
    if (useViewer.getState().metronomeOn) useViewer.setState({ metronomeOn: false })
  }

  toggle() {
    if (this.running) this.stop()
    else this.start()
  }

  private schedule() {
    const clock = this.clock
    if (!clock) return
    const ahead = typeof document !== 'undefined' && document.hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD
    if (this.endAt !== null) return
    for (const t of clock.take(this.now() + ahead)) {
      const inCountIn = t.bar < this.countIn
      if (!inCountIn && this.countIn > 0 && settings().metronome.afterCountIn === 'stop') {
        this.endAt = t.time
        this.pending.push(t)
        return
      }
      if (this.cfg.audible) this.play(t)
      this.pending.push(t)
    }
  }

  private play(t: Tick) {
    const ctx = this.ctx
    const buf = this.buffer(this.cfg.sound, t.level)
    if (!ctx || !buf || !this.gain) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.gain)
    src.start(Math.max(t.time, ctx.currentTime))
  }

  /** Publish ticks that are now audible: visuals, count-in end, beat-driven page turns. */
  private dispatch() {
    const heard = this.heardNow()
    let last: Tick | null = null
    while (this.pending.length && this.pending[0].time <= heard) {
      const t = this.pending.shift()!
      if (this.endAt !== null && t.time >= this.endAt) {
        this.stop()
        this.countInDone()
        return
      }
      // Ticks that piled up while the tab was hidden only update counters, never turn pages.
      if (t.sub === 0) this.onBeat(t, heard - t.time > 0.3)
      last = t
    }
    if (last) {
      const countingIn = last.bar < this.countIn
      useMetronome.setState((s) => ({
        countingIn,
        beat: last.beat,
        bar: last.bar - this.countIn,
        level: last.level,
        seq: last.sub === 0 ? s.seq + 1 : s.seq,
      }))
    }
  }

  private onBeat(t: Tick, stale: boolean) {
    if (this.countIn > 0 && t.bar === this.countIn && t.beat === 0) this.countInDone()
    if (t.bar < this.countIn || stale) return
    const per = this.cfg.beatsPerPage ?? 0
    if (per > 0) {
      this.beatsOnPage++
      if (this.beatsOnPage >= per) {
        this.beatsOnPage = 0
        viewerApi()?.next()
      }
    }
  }

  private countInDone() {
    if (settings().metronome.countInStartsScroll && !useViewer.getState().autoScrollOn) startAutoScroll({ skipDelay: true })
  }
}

export const metronome = new MetronomeEngine()
