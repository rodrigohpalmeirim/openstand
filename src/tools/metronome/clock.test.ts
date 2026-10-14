import { describe, expect, it } from 'vitest'
import { TickClock, tickTimes } from './clock'
import { nextTempoIndex, tapTempo, tempoMarking } from './tempo'

const m44 = { bpm: 120, beatsPerBar: 4, subdivision: 1, accentFirst: true }

describe('TickClock', () => {
  it('spaces beats by 60/bpm from the start time', () => {
    expect(tickTimes(m44, 1, 3)).toEqual([1, 1.5, 2, 2.5])
  })

  it('accents the first beat of each bar and counts bars', () => {
    const c = new TickClock(m44, 0)
    const ticks = c.take(2.6)
    expect(ticks.map((t) => t.level)).toEqual(['accent', 'beat', 'beat', 'beat', 'accent', 'beat'])
    expect(ticks.map((t) => t.bar)).toEqual([0, 0, 0, 0, 1, 1])
    expect(ticks[5].beat).toBe(1)
  })

  it('never returns the same tick twice across look-ahead windows', () => {
    const c = new TickClock(m44, 0)
    const a = c.take(0.6).map((t) => t.time)
    const b = c.take(1.1).map((t) => t.time)
    expect(a).toEqual([0, 0.5])
    expect(b).toEqual([1])
  })

  it('subdivides beats and marks off-beat clicks', () => {
    const c = new TickClock({ ...m44, subdivision: 3 }, 0)
    const ticks = c.take(0.5)
    expect(ticks.map((t) => +t.time.toFixed(4))).toEqual([0, 0.1667, 0.3333])
    expect(ticks.map((t) => t.level)).toEqual(['accent', 'sub', 'sub'])
  })

  it('does not accent when accentFirst is off', () => {
    const c = new TickClock({ ...m44, accentFirst: false }, 0)
    expect(c.take(0.1)[0].level).toBe('beat')
  })

  it('does not drift over long runs', () => {
    const times = tickTimes({ ...m44, bpm: 137 }, 0, 600)
    const last = times.at(-1)!
    expect(last).toBeCloseTo((times.length - 1) * (60 / 137), 9)
  })

  it('re-anchors on tempo change keeping the bar position', () => {
    const c = new TickClock(m44, 0)
    c.take(1.1) // ticks at 0, .5, 1
    c.setMeter({ ...m44, bpm: 60 }, 1.05)
    const t = c.take(3.1)
    expect(t.map((x) => x.time)).toEqual([2, 3])
    expect(t.map((x) => x.beat)).toEqual([3, 0])
    expect(t[1].level).toBe('accent')
  })

  it('restarts at a downbeat on a structural change', () => {
    const c = new TickClock(m44, 0)
    c.take(1.1)
    c.setMeter({ ...m44, beatsPerBar: 3 }, 1.05)
    const t = c.take(1.6)
    expect(t[0]).toMatchObject({ time: 1.5, beat: 0, bar: 0, level: 'accent' })
  })

  it('clamps tempo into 20..300', () => {
    expect(new TickClock({ ...m44, bpm: 1000 }, 0).meter.bpm).toBe(300)
    expect(new TickClock({ ...m44, bpm: 1 }, 0).meter.bpm).toBe(20)
  })
})

describe('tap tempo', () => {
  it('needs two taps and uses the median interval', () => {
    let st = tapTempo([], 0)
    expect(st.bpm).toBeNull()
    st = tapTempo(st.taps, 500)
    expect(st.bpm).toBe(120)
    st = tapTempo(st.taps, 1000)
    st = tapTempo(st.taps, 1700) // one sloppy tap
    st = tapTempo(st.taps, 2200)
    expect(st.bpm).toBe(120)
  })

  it('starts over after a long pause', () => {
    const st = tapTempo([0, 500], 5000)
    expect(st.taps).toEqual([5000])
    expect(st.bpm).toBeNull()
  })
})

describe('tempo helpers', () => {
  it('names tempos', () => {
    expect(tempoMarking(50)).toBe('Largo')
    expect(tempoMarking(128)).toBe('Allegro')
    expect(tempoMarking(240)).toBe('Prestissimo')
  })
  it('cycles song tempos', () => {
    expect(nextTempoIndex([90, 120, 140], 120)).toBe(2)
    expect(nextTempoIndex([90, 120, 140], 140)).toBe(0)
    expect(nextTempoIndex([90, 120], 100)).toBe(0)
    expect(nextTempoIndex([], 100)).toBe(-1)
  })
})

describe('synthesised sounds', () => {
  it('render finite, bounded samples for every sound and level', async () => {
    const { renderClick, SOUNDS } = await import('./sounds')
    for (const s of SOUNDS)
      for (const level of ['accent', 'beat', 'sub'] as const) {
        const d = renderClick(s.id, level, 48000)
        expect(d.length).toBeGreaterThan(100)
        expect(d.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.0001)).toBe(true)
        expect(d.some((v) => Math.abs(v) > 0.05)).toBe(true)
      }
  })
})
