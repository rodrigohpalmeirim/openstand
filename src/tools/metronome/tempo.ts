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

/**
 * The song's own tempo. A BPM saved with the metronome (by older versions, or before the tempo list existed)
 * still wins, so existing songs keep playing at their tempo; else the first tempo of the list.
 */
export function songBpm(song: { tempos?: number[]; metronome?: { bpm?: number } } | undefined): number | undefined {
  const b = song?.metronome?.bpm
  if (typeof b === 'number' && b > 0) return b
  return song?.tempos?.find((n) => n > 0)
}

function withoutBpm<M extends { bpm?: number }>(m: M | undefined): Omit<M, 'bpm'> | undefined {
  const { bpm: _drop, ...rest } = m ?? ({} as M)
  return Object.keys(rest).length ? rest : undefined
}

/**
 * Song patch for changing the metronome from `from` to `to` BPM. New changes go to the tempo list only:
 * the tempo being played (or the first) is replaced, and any older per-song metronome BPM is dropped.
 */
export function retempo<M extends { bpm?: number }>(song: { tempos?: number[]; metronome?: M }, from: number, to: number): { tempos: number[]; metronome: Omit<M, 'bpm'> | undefined } {
  const tempos = (song.tempos ?? []).filter((t) => t > 0)
  const at = tempos.indexOf(from)
  if (tempos.length) tempos[at < 0 ? 0 : at] = to
  else tempos.push(to)
  return { tempos, metronome: withoutBpm(song.metronome) }
}

/**
 * A song as saved from the editor: when the Tempo field was edited (`before` → `after`), an older metronome BPM
 * is dropped so the edited tempo takes effect. Otherwise `after` is returned unchanged.
 */
export function applyTempoEdit<S extends { tempos?: number[]; metronome?: { bpm?: number } }>(before: S | undefined, after: S): S {
  const same = (a: number[] = [], b: number[] = []) => a.length === b.length && a.every((t, i) => t === b[i])
  if (!before || same(before.tempos, after.tempos) || after.metronome?.bpm === undefined) return after
  return { ...after, metronome: withoutBpm(after.metronome) }
}

const BEAT_UNITS = [2, 4, 8, 16]

/** Meter from a time signature string: "3/4", "6/8", "2+3/8", "C" (4/4), "C|" or "¢" (2/2). Null when unusable. */
export function parseSignature(sig: string | undefined): { beatsPerBar: number; beatUnit: number } | null {
  const s = sig?.trim().replace(/\s+/g, '') ?? ''
  if (/^c$/i.test(s)) return { beatsPerBar: 4, beatUnit: 4 }
  if (/^(c\||¢)$/i.test(s)) return { beatsPerBar: 2, beatUnit: 2 }
  const m = s.match(/^(\d+(?:\+\d+)*)\/(\d+)$/)
  if (!m) return null
  const beats = m[1].split('+').reduce((a, n) => a + Number(n), 0)
  const unit = Number(m[2])
  if (beats < 1 || beats > 16 || !BEAT_UNITS.includes(unit)) return null
  return { beatsPerBar: beats, beatUnit: unit }
}
