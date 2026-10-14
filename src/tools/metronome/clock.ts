/**
 * Pure tick timing for the metronome. Tick times are computed from an anchor (time + tick count)
 * rather than accumulated, so long runs don't drift; a tempo change re-anchors at the next tick.
 */

export interface Meter {
  bpm: number
  beatsPerBar: number
  /** Clicks per beat (1 = beats only). */
  subdivision: number
  accentFirst: boolean
}

export type TickLevel = 'accent' | 'beat' | 'sub'

export interface Tick {
  /** Audio-clock time in seconds. */
  time: number
  /** Running tick count since start (or since the last structural change). */
  count: number
  /** 0-based bar number. */
  bar: number
  /** 0-based beat within the bar. */
  beat: number
  /** 0-based subdivision within the beat (0 = on the beat). */
  sub: number
  level: TickLevel
}

export const clampBpm = (bpm: number) => Math.min(300, Math.max(20, Math.round(bpm)))

const sanitize = (m: Meter): Meter => ({
  bpm: clampBpm(m.bpm),
  beatsPerBar: Math.min(32, Math.max(1, Math.round(m.beatsPerBar) || 4)),
  subdivision: Math.min(8, Math.max(1, Math.round(m.subdivision) || 1)),
  accentFirst: m.accentFirst,
})

/** Describe tick number `count` of a meter. */
export function tickAt(m: Meter, count: number, time: number): Tick {
  const sub = count % m.subdivision
  const beatIndex = Math.floor(count / m.subdivision)
  const beat = beatIndex % m.beatsPerBar
  const bar = Math.floor(beatIndex / m.beatsPerBar)
  const level: TickLevel = sub > 0 ? 'sub' : beat === 0 && m.accentFirst && m.beatsPerBar > 1 ? 'accent' : 'beat'
  return { time, count, bar, beat, sub, level }
}

export class TickClock {
  meter: Meter
  private anchorTime: number
  private anchorCount: number
  /** Count of the next tick not yet handed out by `take`. */
  private next: number
  private lastTime: number | null = null

  constructor(meter: Meter, startTime: number) {
    this.meter = sanitize(meter)
    this.anchorTime = startTime
    this.anchorCount = 0
    this.next = 0
  }

  /** Seconds between two ticks. */
  get interval() {
    return 60 / this.meter.bpm / this.meter.subdivision
  }

  timeOf(count: number) {
    return this.anchorTime + (count - this.anchorCount) * this.interval
  }

  /** Time of the next tick that has not been taken yet. */
  peek() {
    return this.timeOf(this.next)
  }

  /** Every tick scheduled before `until` that has not been returned yet. */
  take(until: number): Tick[] {
    const out: Tick[] = []
    for (let t = this.timeOf(this.next); t < until; t = this.timeOf(this.next)) {
      out.push(tickAt(this.meter, this.next, t))
      this.lastTime = t
      this.next++
      if (out.length > 1000) break // guard against a stalled clock
    }
    return out
  }

  /**
   * Change the meter while running. A pure tempo change keeps the bar position; a structural change
   * (beats per bar / subdivision) restarts counting at a downbeat. Either way the next tick follows the
   * last scheduled one by one new interval (or plays at `now` if nothing was scheduled yet).
   */
  setMeter(meter: Meter, now: number) {
    const m = sanitize(meter)
    const structural = m.beatsPerBar !== this.meter.beatsPerBar || m.subdivision !== this.meter.subdivision
    this.meter = m
    const nextTime = this.lastTime === null ? Math.max(now, this.anchorTime) : Math.max(now, this.lastTime + this.interval)
    if (structural) {
      this.next = 0
      this.anchorCount = 0
    } else {
      this.anchorCount = this.next
    }
    this.anchorTime = nextTime
  }
}

/** Tick times in [from, until) for a meter starting at `start` — convenience for tests and previews. */
export function tickTimes(m: Meter, start: number, until: number): number[] {
  return new TickClock(m, start).take(until).map((t) => t.time)
}
