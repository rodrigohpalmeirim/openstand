// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createClock, formatHlc, HLC_ZERO, hlcAhead, hlcWall, isHlc, parseHlc } from './hlc'
import { CLOCK_AHEAD_MAX, CLOCK_AHEAD_WARN } from './model'
import { rng } from './merge.test-helper'

const A = '0123456789abcdef'
const B = 'fedcba9876543210'
const T = 1_760_000_000_000

describe('hlc format', () => {
  it('is 32 lowercase hex chars and round-trips', () => {
    const h = formatHlc(T, 7, A)
    expect(h).toHaveLength(32)
    expect(isHlc(h)).toBe(true)
    expect(parseHlc(h)).toEqual({ wall: T, counter: 7, device: A })
    expect(hlcWall(h)).toBe(T)
    expect(HLC_ZERO < h).toBe(true)
  })

  it('rejects bad device ids, out-of-range parts and malformed strings', () => {
    expect(() => createClock('devA')).toThrow(/16 lowercase hex/)
    expect(() => formatHlc(T, 0x10000, A)).toThrow(RangeError)
    expect(() => formatHlc(2 ** 48, 0, A)).toThrow(RangeError)
    expect(() => formatHlc(-1, 0, A)).toThrow(RangeError)
    expect(() => parseHlc('xyz')).toThrow(TypeError)
    expect(isHlc(formatHlc(T, 0, A).toUpperCase())).toBe(false)
  })

  it('string order equals (wall, counter, device) tuple order', () => {
    const r = rng(42)
    const devs = [A, B, '0000000000000001', 'ffffffffffffffff']
    const tuples = Array.from({ length: 2000 }, () => ({
      wall: r.chance(0.3) ? T : T + r.int(1e9),
      counter: r.chance(0.3) ? 0 : r.int(0x10000),
      device: r.pick(devs),
    }))
    const byTuple = [...tuples].sort((x, y) => x.wall - y.wall || x.counter - y.counter || (x.device < y.device ? -1 : x.device > y.device ? 1 : 0))
    const byString = tuples.map((t) => formatHlc(t.wall, t.counter, t.device)).sort()
    expect(byString).toEqual(byTuple.map((t) => formatHlc(t.wall, t.counter, t.device)))
  })
})

describe('clock', () => {
  it('is strictly monotonic even when the wall clock goes backwards', () => {
    const r = rng(1)
    let w = T
    const c = createClock(A, undefined, () => w)
    let prev = c.last
    for (let i = 0; i < 5000; i++) {
      w += r.int(5) - 2 // jitters back and forth
      const h = r.chance(0.3) ? c.now(w - r.int(100000)) : c.now()
      expect(h > prev).toBe(true)
      expect(c.last).toBe(h)
      prev = h
    }
  })

  it('takes max(last.wall, wall) and counts within the same ms', () => {
    const c = createClock(A, undefined, () => T)
    expect(parseHlc(c.now())).toEqual({ wall: T, counter: 0, device: A })
    expect(parseHlc(c.now())).toEqual({ wall: T, counter: 1, device: A })
    // An older dirty-mark time (§8.2 step 3) can't move the clock back.
    expect(parseHlc(c.now(T - 60_000))).toEqual({ wall: T, counter: 2, device: A })
    expect(parseHlc(c.now(T + 5))).toEqual({ wall: T + 5, counter: 0, device: A })
  })

  it('bumps the wall by one when the counter would overflow', () => {
    const c = createClock(A, formatHlc(T, 0xfffe, A), () => T)
    expect(parseHlc(c.now())).toEqual({ wall: T, counter: 0xffff, device: A })
    expect(parseHlc(c.now())).toEqual({ wall: T + 1, counter: 0, device: A })
    expect(parseHlc(c.now())).toEqual({ wall: T + 1, counter: 1, device: A })
  })

  it('resumes after a persisted last value (re-stamped with its own device id)', () => {
    const c = createClock(A, formatHlc(T + 1000, 3, B), () => T)
    expect(c.last).toBe(formatHlc(T + 1000, 3, A))
    expect(parseHlc(c.now())).toEqual({ wall: T + 1000, counter: 4, device: A })
    expect(createClock(A, 'garbage', () => T).last).toBe(HLC_ZERO)
  })

  it('receive follows the standard HLC rules', () => {
    // remote ahead: adopt its wall, counter + 1
    let c = createClock(A, undefined, () => T)
    c.receive(formatHlc(T + 10, 5, B))
    expect(parseHlc(c.last)).toEqual({ wall: T + 10, counter: 6, device: A })
    // remote behind: keep own, counter + 1
    c = createClock(A, formatHlc(T, 9, A), () => T - 100)
    c.receive(formatHlc(T - 50, 40, B))
    expect(parseHlc(c.last)).toEqual({ wall: T, counter: 10, device: A })
    // equal walls: max counter + 1
    c = createClock(A, formatHlc(T, 3, A), () => T - 1)
    c.receive(formatHlc(T, 8, B))
    expect(parseHlc(c.last)).toEqual({ wall: T, counter: 9, device: A })
    // physical time ahead of both: counter resets
    c = createClock(A, formatHlc(T, 3, A), () => T + 500)
    c.receive(formatHlc(T + 100, 8, B))
    expect(parseHlc(c.last)).toEqual({ wall: T + 500, counter: 0, device: A })
  })

  it('anything stamped after a receive sorts after the received timestamp (causality under skew)', () => {
    const r = rng(7)
    for (let i = 0; i < 500; i++) {
      const skew = r.int(4 * 3600_000) - 2 * 3600_000 // ±2 h between the two devices
      const a = createClock(A, undefined, () => T)
      const b = createClock(B, undefined, () => T + skew)
      const sent = a.now()
      b.receive(sent)
      expect(b.now() > sent).toBe(true)
      const reply = b.now()
      a.receive(reply)
      expect(a.now() > reply).toBe(true)
    }
  })

  it('warns about a remote clock more than 5 min ahead, but still advances (no drift cap)', () => {
    const onAhead = vi.fn()
    const c = createClock(A, undefined, () => T, { onAhead })
    c.receive(formatHlc(T + CLOCK_AHEAD_WARN, 0, B)) // exactly at the limit: fine
    expect(onAhead).not.toHaveBeenCalled()
    const far = formatHlc(T + 3 * 3600_000, 0, B)
    c.receive(far)
    expect(onAhead).toHaveBeenCalledWith(B, 3 * 3600_000)
    expect(c.last > far).toBe(true)
    expect(c.now() > far).toBe(true)
    // A remote behind us never warns.
    c.receive(formatHlc(T - 3 * 3600_000, 0, B))
    expect(onAhead).toHaveBeenCalledTimes(1)
  })

  it('receive refuses a malformed timestamp and leaves the clock untouched', () => {
    const c = createClock(A, undefined, () => T)
    const before = c.now()
    expect(c.receive('nope')).toBe(false)
    expect(c.receive(undefined as unknown as string)).toBe(false)
    expect(c.last).toBe(before)
  })

  it('refuses a remote more than CLOCK_AHEAD_MAX ahead (warns, clock untouched); accepts up to it', () => {
    const onAhead = vi.fn()
    const c = createClock(A, undefined, () => T, { onAhead })
    const before = c.now()
    const far = formatHlc(T + CLOCK_AHEAD_MAX + 1, 0, B)
    expect(c.receive(far)).toBe(false)
    expect(onAhead).toHaveBeenCalledWith(B, CLOCK_AHEAD_MAX + 1)
    expect(c.last).toBe(before)
    expect(c.receive(formatHlc(T + CLOCK_AHEAD_MAX, 0, B))).toBe(true)
    expect(hlcWall(c.last)).toBe(T + CLOCK_AHEAD_MAX)
  })

  it('never throws or half-updates on the largest timestamps (review: ffff… overflow)', () => {
    const c = createClock(A, undefined, () => T)
    const before = c.now()
    expect(c.receive('f'.repeat(16) + B)).toBe(false) // year ~10889: far ahead
    expect(c.last).toBe(before)
    expect(() => c.now()).not.toThrow()
    // A clock really at the end of the format saturates instead of throwing.
    const end = createClock(A, undefined, () => 0xffff_ffff_ffff)
    for (let i = 0; i < 0x10010; i++) end.now()
    expect(end.last).toBe('f'.repeat(16) + A)
    expect(end.receive('f'.repeat(16) + B)).toBe(true)
    expect(end.last).toBe('f'.repeat(16) + A)
  })

  it('ignores a persisted value far in the future (a clock poisoned before the guard)', () => {
    const poisoned = formatHlc(T + 365 * 86_400_000, 3, A)
    expect(createClock(A, poisoned, () => T).now()).toBe(formatHlc(T, 0, A))
    const fine = formatHlc(T + 60_000, 3, A)
    expect(createClock(A, fine, () => T).now()).toBe(formatHlc(T + 60_000, 4, A))
  })

  it('hlcAhead measures how far a timestamp is ahead (malformed: Infinity)', () => {
    expect(hlcAhead(formatHlc(T + 5, 0, B), T)).toBe(5)
    expect(hlcAhead(formatHlc(T - 5, 0, B), T)).toBe(-5)
    expect(hlcAhead('nope', T)).toBe(Infinity)
  })
})
