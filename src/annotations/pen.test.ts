import { describe, expect, it } from 'vitest'
import { PEN_IDLE, PEN_TIMING, penDeadline, penPresent, penReduce, type PenEnv, type PenEvent, type PenModel } from './pen'

const READING: PenEnv = { explicit: false, held: false }
const { dwell, idle, recent, palm } = PEN_TIMING

/** Run events (type, time) through the reducer. */
function run(events: [PenEvent['type'], number][], env: PenEnv = READING, from: PenModel = PEN_IDLE): PenModel {
  return events.reduce((m, [type, t]) => penReduce(m, { type, t }, env), from)
}

/** A hand-held pen hovering from `from` to `to`: it jitters, so events keep coming. */
const hovering = (from: number, to: number, step = 50): [PenEvent['type'], number][] => {
  const out: [PenEvent['type'], number][] = []
  for (let t = from; t <= to; t += step) out.push(['hover', t])
  return out
}

describe('waking', () => {
  it('wakes at once on contact', () => {
    expect(run([['down', 1000]]).awake).toBe(true)
  })

  it('wakes on hover only after the dwell', () => {
    expect(run([['hover', 1000]]).awake).toBe(false)
    expect(run([['hover', 1000], ['hover', 1000 + dwell - 1]]).awake).toBe(false)
    expect(run([['hover', 1000], ['hover', 1000 + dwell]]).awake).toBe(true)
  })

  it('wakes after the dwell when the pen holds still (a tick, no further event)', () => {
    const m = run([['hover', 1000]])
    expect(penDeadline(m, 1000, READING)).toBe(1000 + dwell)
    expect(run([['tick', 1000 + dwell]], READING, m).awake).toBe(true)
  })

  it('does not flash for a pen passing by', () => {
    const m = run([['hover', 1000], ['hover', 1060], ['leave', 1100], ['tick', 1000 + dwell], ['tick', 2000]])
    expect(m.awake).toBe(false)
    // Coming back starts the dwell again.
    expect(run([['hover', 3000], ['hover', 3000 + dwell - 10]], READING, m).awake).toBe(false)
  })

  it('a pen left lying on the glass does not wake anything later', () => {
    // In range, silent for a long time (it fell asleep meanwhile), then time passes for other reasons.
    const asleep = run([...hovering(0, 300), ['tick', 300 + idle]])
    expect(asleep.awake).toBe(false)
    expect(run([['tick', 60_000], ['poke', 61_000], ['tick', 62_000]], READING, asleep).awake).toBe(false)
    // Picking it up again wakes straight away: it has been in range all along.
    expect(run([['hover', 90_000]], READING, asleep).awake).toBe(true)
  })
})

describe('sleeping', () => {
  it('sleeps when nothing was seen for the idle time', () => {
    const m = run([['down', 0], ['up', 500], ['leave', 520]])
    expect(m.awake).toBe(true)
    // The palm window of a pen without hover runs out first, then the idle time.
    expect(penDeadline(m, 600, READING)).toBe(500 + palm)
    expect(penDeadline(m, 500 + palm + 5, READING)).toBe(520 + idle)
    expect(run([['tick', 520 + idle - 1]], READING, m).awake).toBe(true)
    expect(run([['tick', 520 + idle]], READING, m).awake).toBe(false)
  })

  it('stays awake while a hand-held pen hovers, sleeps once it lies still', () => {
    const m = run([...hovering(0, 10_000), ['tick', 10_000 + idle - 1]])
    expect(m.awake).toBe(true)
    expect(run([['tick', 10_000 + idle]], READING, m).awake).toBe(false)
  })

  it('never sleeps while the pen is down', () => {
    const m = run([['down', 0], ['tick', idle * 3]])
    expect(m.awake).toBe(true)
    expect(penDeadline(m, idle * 3, READING)).toBe(null)
  })

  it('is kept awake by a hold, a text edit or a gesture, then counts down again', () => {
    const held: PenEnv = { explicit: false, held: true }
    let m = run([['down', 0], ['up', 100], ['leave', 120], ['tick', idle * 2]], held)
    expect(m.awake).toBe(true)
    // Releasing the hold pokes: a full idle time from there.
    m = run([['poke', idle * 2]], READING, m)
    expect(run([['tick', idle * 3 - 1]], READING, m).awake).toBe(true)
    expect(run([['tick', idle * 3]], READING, m).awake).toBe(false)
  })

  it('a poke restarts the countdown', () => {
    const m = run([['down', 0], ['up', 100], ['leave', 100], ['poke', 3000], ['tick', 100 + idle]])
    expect(m.awake).toBe(true)
    expect(run([['tick', 3000 + idle]], READING, m).awake).toBe(false)
  })

  it('sleep() dismisses now, and hover does not bring it back until the pen leaves or touches', () => {
    let m = run([...hovering(0, 400), ['sleep', 450]])
    expect(m.awake).toBe(false)
    m = run(hovering(500, 2000), READING, m)
    expect(m.awake).toBe(false)
    expect(run([['down', 2100]], READING, m).awake).toBe(true)
    expect(run([['leave', 2100], ...hovering(3000, 3000 + dwell)], READING, m).awake).toBe(true)
  })

  it('sleep() with the pen out of range does not snooze the next approach', () => {
    const m = run([['down', 0], ['up', 100], ['leave', 100], ['sleep', 200], ...hovering(5000, 5000 + dwell)])
    expect(m.awake).toBe(true)
  })
})

describe('the full annotation mode', () => {
  const explicit: PenEnv = { explicit: true, held: false }

  it('never wakes there, by hover or by contact', () => {
    expect(run([...hovering(0, 1000), ['down', 1100], ['move', 1150]], explicit).awake).toBe(false)
  })

  it('goes dark on entering and wakes again on leaving if the pen is still around', () => {
    let m = run(hovering(0, 1000))
    expect(m.awake).toBe(true)
    m = run([['tick', 1010]], explicit, m)
    expect(m.awake).toBe(false)
    m = run(hovering(1050, 3000), explicit, m)
    expect(run([['tick', 3010]], READING, m).awake).toBe(true)
  })

  it('still reports presence', () => {
    const m = run([['hover', 0], ['down', 100]], explicit)
    expect(penPresent(m, 150)).toBe(true)
  })
})

describe('present (fingers are ignored)', () => {
  it('is true while the pen is down, however long', () => {
    expect(penPresent(run([['down', 0]]), 60_000)).toBe(true)
  })

  it('is true while a hovering pen keeps sending events, and runs out when it lies still', () => {
    const m = run(hovering(0, 1000))
    expect(penPresent(m, 1000 + recent - 1)).toBe(true)
    expect(penPresent(m, 1000 + recent)).toBe(false)
    expect(penDeadline({ ...m, awake: false, snoozed: true }, 1500, READING)).toBe(1000 + recent)
  })

  it('needs no dwell: the first hover event already blocks fingers', () => {
    expect(penPresent(run([['hover', 0]]), 10)).toBe(true)
  })

  it('ends at once when a hovering pen leaves range', () => {
    const m = run([...hovering(0, 300), ['down', 350], ['move', 400], ['up', 450], ['hover', 470], ['leave', 500]])
    expect(penPresent(m, 500)).toBe(false)
  })

  it('lasts the palm window after the last contact of a pen that reports no hover', () => {
    // Such a pen "leaves" right after every lift.
    const m = run([['down', 0], ['move', 200], ['up', 300], ['leave', 300]])
    expect(penPresent(m, 300 + palm - 1)).toBe(true)
    expect(penPresent(m, 300 + palm)).toBe(false)
    expect(penDeadline({ ...m, awake: false }, 400, READING)).toBe(300 + palm)
  })

  it('is false before any pen was seen', () => {
    expect(penPresent(PEN_IDLE, 0)).toBe(false)
    expect(penPresent(PEN_IDLE, 123_456)).toBe(false)
    expect(penDeadline(PEN_IDLE, 0, READING)).toBe(null)
  })

  it('a hover event while "down" means the lift was missed', () => {
    const m = run([['down', 0], ['hover', 100]])
    expect(m.down).toBe(false)
    expect(penPresent(m, 100 + recent)).toBe(false)
  })
})

describe('penDeadline', () => {
  it('gives the nearest pending change and nothing once all are handled', () => {
    // Awake, hovering: presence runs out first, then the idle sleep.
    const m = run(hovering(0, 1000))
    expect(penDeadline(m, 1000, READING)).toBe(1000 + recent)
    expect(penDeadline(m, 1000 + recent + 5, READING)).toBe(1000 + idle)
    const asleep = run([['tick', 1000 + idle]], READING, m)
    expect(penDeadline(asleep, 1000 + idle + 5, READING)).toBe(null)
  })

  it('does not wait for sleep while held', () => {
    const m = run([['down', 0], ['up', 10], ['leave', 10]])
    expect(penDeadline(m, palm + 100, { explicit: false, held: true })).toBe(null)
  })
})
