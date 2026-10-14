import { clampBpm } from './clock'

/** Italian tempo marking for a BPM (same breakpoints musicians commonly use). */
export function tempoMarking(bpm: number): string {
  if (bpm < 40) return 'Lento assai'
  if (bpm < 60) return 'Largo'
  if (bpm < 66) return 'Larghetto'
  if (bpm < 76) return 'Adagio'
  if (bpm < 108) return 'Andante'
  if (bpm < 120) return 'Moderato'
  if (bpm < 140) return 'Allegro'
  if (bpm < 168) return 'Vivace'
  if (bpm < 200) return 'Presto'
  return 'Prestissimo'
}

/** A pause longer than this starts a new tap sequence. */
export const TAP_RESET_MS = 2000
const MAX_TAPS = 8

/**
 * Register a tap at `now` (ms). Returns the kept tap history and the tempo once there are at least
 * two taps. Uses the median interval so one sloppy tap doesn't skew the result.
 */
export function tapTempo(taps: number[], now: number): { taps: number[]; bpm: number | null } {
  const last = taps.at(-1)
  const kept = last !== undefined && now - last <= TAP_RESET_MS && now > last ? [...taps, now].slice(-MAX_TAPS) : [now]
  if (kept.length < 2) return { taps: kept, bpm: null }
  const gaps = kept.slice(1).map((t, i) => t - kept[i]).sort((a, b) => a - b)
  const mid = gaps.length >> 1
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
  return { taps: kept, bpm: clampBpm(60000 / median) }
}

/** Index of the tempo after `bpm` in a song's tempo list (wraps around). */
export function nextTempoIndex(tempos: number[], bpm: number): number {
  if (!tempos.length) return -1
  const at = tempos.indexOf(bpm)
  return at < 0 ? 0 : (at + 1) % tempos.length
}
