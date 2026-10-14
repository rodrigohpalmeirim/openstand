import type { AutoScrollSettings } from '../../db/schema'

/** Song length used when the song has no duration set. */
export const DEFAULT_SONG_SECONDS = 180
/** Never plan a song faster than this, whatever the settings say. */
const MIN_SECONDS = 10

/** Seconds of actual scrolling: the song duration minus the initial delay. */
export function scrollSeconds(songDuration: number, delay: number): number {
  const total = songDuration > 0 ? songDuration : DEFAULT_SONG_SECONDS
  return Math.max(MIN_SECONDS, total - Math.max(0, delay))
}

/**
 * Speed for a continuous strip (vertical scroll mode): the whole remaining distance in the planned
 * time, or the fixed px/s. `factor` is the session faster/slower multiplier.
 */
export function stripSpeed(s: Pick<AutoScrollSettings, 'mode' | 'speed'>, distance: number, seconds: number, factor = 1): number {
  const base = s.mode === 'speed' ? s.speed : distance / Math.max(1, seconds)
  return Math.max(1, base * factor)
}

/**
 * Speed while scrolling within one page of a paged view (fit-width / zoomed). Every page gets the same
 * share of the planned time after the pauses at the page ends, so pages of different heights still
 * finish on schedule.
 */
export function pageSpeed(
  s: Pick<AutoScrollSettings, 'mode' | 'speed' | 'pageDelay'>,
  overflow: number,
  pages: number,
  seconds: number,
  factor = 1,
): number {
  if (s.mode === 'speed') return Math.max(1, s.speed * factor)
  const n = Math.max(1, pages)
  const perPage = Math.max(2, (seconds - Math.max(0, s.pageDelay) * (n - 1)) / n)
  return Math.max(1, (overflow / perPage) * factor)
}

/**
 * Seconds each view stays up when the view can't scroll (whole pages / two-up): timed page turns.
 * In fixed-speed mode the "reading speed" is how long it would take to scroll one screen height.
 */
export function turnInterval(
  s: Pick<AutoScrollSettings, 'mode' | 'speed'>,
  stops: number,
  seconds: number,
  viewport: number,
  factor = 1,
): number {
  const base = s.mode === 'speed' ? viewport / Math.max(1, s.speed) : seconds / Math.max(1, stops)
  return Math.max(1, base / factor)
}

/** Next session speed factor for the faster/slower actions (±15 %, kept within 0.25x..4x). */
export function stepFactor(factor: number, dir: 1 | -1): number {
  const next = dir > 0 ? factor * 1.15 : factor / 1.15
  return Math.round(Math.min(4, Math.max(0.25, next)) * 100) / 100
}
