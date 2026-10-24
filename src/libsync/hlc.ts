/**
 * Hybrid logical clock (docs/SYNC.md §6.1).
 *
 * `${wall 12 hex}${counter 4 hex}${deviceId 16 hex}` = 32 lowercase hex chars. Fixed width, so plain
 * string comparison is the tuple order (wall, counter, device): causal where causality exists, and an
 * arbitrary but total order otherwise.
 */
import { CLOCK_AHEAD_MAX, CLOCK_AHEAD_WARN, type Hlc, type HlcClock } from './model'

export type { Hlc, HlcClock } from './model'

const WALL_MAX = 0xffff_ffff_ffff // 12 hex digits (year ~10889)
const COUNTER_MAX = 0xffff
const HLC_RE = /^[0-9a-f]{32}$/
const DEVICE_RE = /^[0-9a-f]{16}$/

/** Smaller than every real timestamp. */
export const HLC_ZERO: Hlc = '0'.repeat(32)

export const isHlc = (h: unknown): h is Hlc => typeof h === 'string' && HLC_RE.test(h)
export const isDeviceId = (d: unknown): d is string => typeof d === 'string' && DEVICE_RE.test(d)

export function formatHlc(wall: number, counter: number, device: string): Hlc {
  if (!Number.isInteger(wall) || wall < 0 || wall > WALL_MAX) throw new RangeError(`HLC wall out of range: ${wall}`)
  if (!Number.isInteger(counter) || counter < 0 || counter > COUNTER_MAX) throw new RangeError(`HLC counter out of range: ${counter}`)
  if (!isDeviceId(device)) throw new TypeError(`deviceId must be 16 lowercase hex chars: ${device}`)
  return wall.toString(16).padStart(12, '0') + counter.toString(16).padStart(4, '0') + device
}

export function parseHlc(h: Hlc): { wall: number; counter: number; device: string } {
  if (!isHlc(h)) throw new TypeError(`Not an HLC: ${h}`)
  return { wall: parseInt(h.slice(0, 12), 16), counter: parseInt(h.slice(12, 16), 16), device: h.slice(16) }
}

/** Wall-clock ms of a timestamp (cheap; no validation). */
export const hlcWall = (h: Hlc): number => parseInt(h.slice(0, 12), 16)

export const maxHlc = (a: Hlc, b: Hlc): Hlc => (a > b ? a : b)

export interface ClockOptions {
  /**
   * Called when `receive` sees a remote wall more than CLOCK_AHEAD_WARN ahead of local time (the engine
   * raises the `clockAhead` warning naming that device). Up to CLOCK_AHEAD_MAX ahead the clock still
   * advances, so causality holds; beyond that the timestamp is refused (`receive` returns false).
   */
  onAhead?: (device: string, aheadMs: number) => void
}

/**
 * `receive` refuses (returns false, clock untouched) malformed timestamps and walls more than
 * CLOCK_AHEAD_MAX ahead of local time: one bad remote value must not drag every device's clock into the
 * future for good. New values are computed before any state changes, and the counter saturates at the
 * format's maximum instead of throwing, so the clock can never be left half-updated or unusable.
 */
export function createClock(deviceId: string, last?: Hlc, wall: () => number = Date.now, opts: ClockOptions = {}): HlcClock {
  if (!isDeviceId(deviceId)) throw new TypeError(`deviceId must be 16 lowercase hex chars: ${deviceId}`)
  const physical = (w: number | undefined) => Math.min(WALL_MAX, Math.max(0, Math.floor(Number.isFinite(w) ? w! : wall())))
  // A persisted value far in the future (poisoned before this guard existed) would stamp every local edit
  // with it, and other devices refuse those: start from physical time instead.
  const restored = last && isHlc(last) ? parseHlc(last) : undefined
  const keep = !!restored && restored.wall - physical(undefined) <= CLOCK_AHEAD_MAX
  let l = keep ? { wall: restored.wall, counter: restored.counter } : { wall: 0, counter: 0 }
  let lastHlc: Hlc = keep ? formatHlc(l.wall, l.counter, deviceId) : HLC_ZERO

  const set = (w: number, c: number) => {
    if (c > COUNTER_MAX) {
      w += 1
      c = 0
    }
    if (w > WALL_MAX) {
      w = WALL_MAX
      c = COUNTER_MAX
    }
    const next = formatHlc(w, c, deviceId)
    l = { wall: w, counter: c }
    lastHlc = next
    return next
  }

  return {
    now(w?: number) {
      const pt = physical(w)
      return pt > l.wall ? set(pt, 0) : set(l.wall, l.counter + 1)
    },
    receive(remote: Hlc, w?: number) {
      if (!isHlc(remote)) return false
      const r = parseHlc(remote)
      const pt = physical(w)
      const ahead = r.wall - pt
      if (ahead > CLOCK_AHEAD_WARN) opts.onAhead?.(r.device, ahead)
      if (ahead > CLOCK_AHEAD_MAX) return false
      const m = Math.max(l.wall, r.wall, pt)
      if (m === l.wall && m === r.wall) set(m, Math.max(l.counter, r.counter) + 1)
      else if (m === l.wall) set(m, l.counter + 1)
      else if (m === r.wall) set(m, r.counter + 1)
      else set(m, 0)
      return true
    },
    get last() {
      return lastHlc
    },
  }
}

/** How far (ms) a timestamp's wall is ahead of `now`; ≤ 0 when it isn't. Malformed → Infinity. */
export const hlcAhead = (h: unknown, now: number): number => (isHlc(h) ? hlcWall(h) - now : Infinity)
