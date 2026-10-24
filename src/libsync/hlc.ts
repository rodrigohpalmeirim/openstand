/**
 * Hybrid logical clock (docs/SYNC.md §6.1).
 *
 * `${wall 12 hex}${counter 4 hex}${deviceId 16 hex}` = 32 lowercase hex chars. Fixed width, so plain
 * string comparison is the tuple order (wall, counter, device): causal where causality exists, and an
 * arbitrary but total order otherwise.
 */
import { CLOCK_AHEAD_WARN, type Hlc, type HlcClock } from './model'

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
   * raises the `clockAhead` warning naming that device). The clock still advances, so causality holds.
   */
  onAhead?: (device: string, aheadMs: number) => void
}

export function createClock(deviceId: string, last?: Hlc, wall: () => number = Date.now, opts: ClockOptions = {}): HlcClock {
  if (!isDeviceId(deviceId)) throw new TypeError(`deviceId must be 16 lowercase hex chars: ${deviceId}`)
  let l = last && isHlc(last) ? parseHlc(last) : { wall: 0, counter: 0 }
  let lastHlc: Hlc = last && isHlc(last) ? formatHlc(l.wall, l.counter, deviceId) : HLC_ZERO

  const set = (w: number, c: number) => {
    if (c > COUNTER_MAX) {
      w += 1
      c = 0
    }
    l = { wall: w, counter: c }
    lastHlc = formatHlc(w, c, deviceId)
    return lastHlc
  }
  const physical = (w: number | undefined) => Math.max(0, Math.floor(w ?? wall()))

  return {
    now(w?: number) {
      const pt = physical(w)
      return pt > l.wall ? set(pt, 0) : set(l.wall, l.counter + 1)
    },
    receive(remote: Hlc, w?: number) {
      const r = parseHlc(remote)
      const pt = physical(w)
      if (r.wall - pt > CLOCK_AHEAD_WARN) opts.onAhead?.(r.device, r.wall - pt)
      const m = Math.max(l.wall, r.wall, pt)
      if (m === l.wall && m === r.wall) set(m, Math.max(l.counter, r.counter) + 1)
      else if (m === l.wall) set(m, l.counter + 1)
      else if (m === r.wall) set(m, r.counter + 1)
      else set(m, 0)
    },
    get last() {
      return lastHlc
    },
  }
}
