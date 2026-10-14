/**
 * Chord symbol parsing, transposition and note-name localisation.
 *
 * A chord is modelled as root + quality/extension suffix + optional bass note ("slash chord").
 * Pitch classes are 0..11 with C = 0.
 */

export type Accidental = 'sharp' | 'flat'
/** How note names are written. */
export type NoteNaming = 'english' | 'german' | 'latin' | 'nashville'

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 }
const LATIN = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si']
const LATIN_NAMES = ['Do', 'Re', 'Ré', 'Mi', 'Fa', 'Sol', 'So', 'La', 'Si', 'Ti']
const LATIN_NAME_PC = [0, 2, 2, 4, 5, 7, 7, 9, 11, 11]

/** Keys whose signature uses flats (major and relative minor). */
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'])

export interface Chord {
  root: number
  /** Everything after the root up to an optional slash, e.g. "m7b5", "sus4", "maj7". */
  suffix: string
  bass?: number
  /** True when the original root/bass were written with flats. */
  flat: boolean
}

/** Matches a note name at the start of a string in english, german or latin notation. */
const NOTE_RE = /^(Do|Re|Ré|Mi|Fa|Sol|So|La|Si|Ti|[A-H])(#|♯|b|♭|is|es|s)?/

function parseNote(s: string): { pc: number; len: number; flat: boolean } | null {
  const m = NOTE_RE.exec(s)
  if (!m) return null
  const name = m[1]
  const latinIdx = LATIN_NAMES.indexOf(name)
  let pc = latinIdx >= 0 ? LATIN_NAME_PC[latinIdx] : LETTER_PC[name]
  let acc = m[2] ?? ''
  // German "-es"/"-s" spellings ("Es", "As") must not swallow the start of "sus" ("Asus4", "Esus").
  if ((acc === 's' || acc === 'es') && s.slice(m[0].length).startsWith('us')) acc = ''
  let flat = false
  if (acc === '#' || acc === '♯' || acc === 'is') pc += 1
  else if (acc) {
    pc -= 1
    flat = true
  }
  return { pc: (pc + 12) % 12, len: name.length + acc.length, flat }
}

const SUFFIX_RE =
  /^(maj|ma|min|mi|m|M|dim|aug|sus|add|no|omit|alt|o|ø|°|\+|-|Δ|\^|[0-9]|\(|\)|b|#|♭|♯|\/(?=[0-9])|,|\.)*$/

/**
 * Parse a chord symbol such as "F#m7b5/C#". Returns null if the text does not look like a chord,
 * which is how plain-text chord-sheet detection decides whether a line is a chord line.
 */
export function parseChord(text: string, naming: NoteNaming = 'english'): Chord | null {
  const t = text.trim()
  if (!t) return null
  const root = parseNoteFor(t, naming)
  if (!root) return null
  let rest = t.slice(root.len)
  let bass: { pc: number; len: number; flat: boolean } | null = null
  const slash = rest.lastIndexOf('/')
  if (slash >= 0) {
    const b = parseNoteFor(rest.slice(slash + 1), naming)
    if (b && b.len === rest.length - slash - 1) {
      bass = b
      rest = rest.slice(0, slash)
    }
  }
  if (!SUFFIX_RE.test(rest)) return null
  return { root: root.pc, suffix: rest, bass: bass?.pc, flat: root.flat || !!bass?.flat }
}

function parseNoteFor(s: string, naming: NoteNaming) {
  if (naming === 'german') {
    // H = B natural, B = Bb
    if (s.startsWith('H')) {
      const r = parseNote('B' + s.slice(1))
      return r
    }
    if (s.startsWith('B') && !/^B(b|♭|#|♯|is|es)/.test(s)) {
      return { pc: 10, len: 1, flat: true }
    }
  }
  return parseNote(s)
}

export function noteName(pc: number, acc: Accidental, naming: NoteNaming = 'english'): string {
  pc = ((pc % 12) + 12) % 12
  const eng = acc === 'flat' ? FLAT_NAMES[pc] : SHARP_NAMES[pc]
  switch (naming) {
    case 'german':
      if (pc === 11) return 'H'
      if (pc === 10 && acc === 'flat') return 'B'
      return eng
    case 'latin': {
      const letter = eng[0]
      const idx = 'CDEFGAB'.indexOf(letter)
      return LATIN[idx] + eng.slice(1)
    }
    default:
      return eng
  }
}

export function formatChord(c: Chord, acc: Accidental, naming: NoteNaming = 'english'): string {
  let s = noteName(c.root, acc, naming) + c.suffix
  if (c.bass !== undefined) s += '/' + noteName(c.bass, acc, naming)
  return s
}

/** Decide whether to spell with sharps or flats in a target key (e.g. "Eb" → flat, "E" → sharp). */
export function accidentalForKey(key: string | undefined, fallback: Accidental = 'sharp'): Accidental {
  const k = key ? parseChord(key) : null
  if (!k) return fallback
  const minor = /^m(?!aj)/.test(k.suffix)
  if (FLAT_KEYS.has(noteName(k.root, k.flat ? 'flat' : 'sharp') + (minor ? 'm' : ''))) return 'flat'
  // C major / A minor have no accidentals: keep the caller's preference.
  if (k.root === (minor ? 9 : 0)) return fallback
  return 'sharp'
}

export function transposeKey(key: string, semitones: number, prefer?: Accidental): string {
  const c = parseChord(key)
  if (!c) return key
  const root = (c.root + semitones + 120) % 12
  const minor = /^m(?!aj)/.test(c.suffix)
  const flatName = noteName(root, 'flat') + (minor ? 'm' : '')
  const acc = prefer ?? (FLAT_KEYS.has(flatName) ? 'flat' : 'sharp')
  return noteName(root, acc) + c.suffix
}

/**
 * Transpose a chord symbol. Spelling follows (in priority): explicit preference, target key, source spelling.
 */
export function transposeChord(
  text: string,
  semitones: number,
  opts: { prefer?: Accidental; targetKey?: string; naming?: NoteNaming; outNaming?: NoteNaming } = {},
): string {
  const naming = opts.naming ?? 'english'
  const c = parseChord(text, naming)
  if (!c) return text
  const acc: Accidental =
    opts.prefer ?? (opts.targetKey ? accidentalForKey(opts.targetKey) : c.flat ? 'flat' : 'sharp')
  const out: Chord = {
    ...c,
    root: (c.root + semitones + 120) % 12,
    bass: c.bass === undefined ? undefined : (c.bass + semitones + 120) % 12,
  }
  return formatChord(out, acc, opts.outNaming ?? naming)
}

/** Nashville number of a chord relative to a key, e.g. key G, chord D7 → "5 7". */
export function nashville(text: string, key: string): string {
  const c = parseChord(text)
  const k = parseChord(key)
  if (!c || !k) return text
  const interval = (c.root - k.root + 12) % 12
  const degrees: Record<number, string> = { 0: '1', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4', 6: 'b5', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7' }
  let s = degrees[interval] + c.suffix
  if (c.bass !== undefined) s += '/' + degrees[(c.bass - k.root + 12) % 12]
  return s
}

/** All 12 major keys, conventionally spelled. */
export const KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
export const MINOR_KEYS = KEYS.map((k) => k + 'm')
export const ALL_KEYS = [...KEYS, ...['Cm', 'C#m', 'Dm', 'D#m', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']]

/** Semitone distance from key a to key b in the range -5..6 (the "closest" transposition). */
export function keyDistance(a: string, b: string): number {
  const ka = parseChord(a)
  const kb = parseChord(b)
  if (!ka || !kb) return 0
  let d = (kb.root - ka.root + 12) % 12
  if (d > 6) d -= 12
  return d
}

/**
 * Heuristic: is this whole line made of chords (so it is a chord line above lyrics)?
 * Allows bar lines, repeat markers, "N.C." and parenthesised chords.
 */
export function isChordLine(line: string, naming: NoteNaming = 'english'): boolean {
  const tokens = line
    .replace(/[|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length) return false
  let chords = 0
  let other = 0
  for (const tok of tokens) {
    const t = tok.replace(/^\(|\)$/g, '')
    if (/^(N\.?C\.?|x\d+|\d+x|%|-|\/|:|\|\||\.\.\.)$/i.test(t)) continue
    if (parseChord(t, naming)) chords++
    else other++
  }
  return chords > 0 && other === 0
}
