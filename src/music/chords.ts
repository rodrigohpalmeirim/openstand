/**
 * Chord symbol parsing, key-aware transposition and note-name localisation.
 *
 * A note is a letter (0..6 = C D E F G A B) plus an accidental (-2..+2). Chords keep the spelling
 * they were written with; transposition moves the letter by the key's letter distance and the pitch
 * by the semitone distance, then derives the accidental (so G→A turns F# into G#, not Ab). The
 * legacy pitch-class fields (`root`, `bass`, `flat`) are kept for callers that only need pitches.
 */

export type Accidental = 'sharp' | 'flat'
/**
 * How note names are written. `english` is the "Default" locale; German/Czech/Scandinavian use H for
 * B natural; Czech writes minor as "mi". `latin` (solfège) and `nashville` are OpenStand extras.
 */
export type NoteNaming = 'english' | 'german' | 'czech' | 'scandinavian' | 'latin' | 'nashville'

export const NAMINGS: { value: NoteNaming; label: string; hint: string }[] = [
  { value: 'english', label: 'Default', hint: 'B, Bb, Am' },
  { value: 'german', label: 'German', hint: 'H, B, Am' },
  { value: 'czech', label: 'Czech', hint: 'H, B, Ami' },
  { value: 'scandinavian', label: 'Scandinavian', hint: 'H, Bb, Am' },
  { value: 'latin', label: 'Solfège', hint: 'Do, Re, Mi' },
  { value: 'nashville', label: 'Nashville', hint: '1, 4, 5' },
]

export interface Note {
  /** 0..6 = C D E F G A B */
  letter: number
  /** -2..+2 (flats negative) */
  acc: number
}

export interface Chord {
  /** Pitch class of the root, C = 0. */
  root: number
  /** Everything after the root up to an optional slash, e.g. "m7b5", "sus4", "maj7". */
  suffix: string
  /** Pitch class of the bass note. */
  bass?: number
  /** True when the original root/bass were written with flats. */
  flat: boolean
  rootNote: Note
  bassNote?: Note
  /** Chord written in parentheses, e.g. "(Am)". */
  parens?: boolean
}

export interface TransposeOptions {
  /** Force every accidental to sharps or flats. */
  prefer?: Accidental
  /** Allow double sharps/flats (F##, Bbb); otherwise they are re-spelled. Default false. */
  allowDouble?: boolean
  /** Allow Cb, B#, E# and Fb; otherwise they become B, C, F and E. Default false. */
  allowUncommon?: boolean
}

const LETTERS = 'CDEFGAB'
const LETTER_SEMI = [0, 2, 4, 5, 7, 9, 11]
/** Position of each natural letter on the circle of fifths (C = 0). */
const LETTER_FIFTHS = [0, 2, 4, -1, 1, 3, 5]
const LATIN = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si']
const LATIN_INPUT: [string, number][] = [
  ['Sol', 4],
  ['Do', 0],
  ['Re', 1],
  ['Ré', 1],
  ['Mi', 2],
  ['Fa', 3],
  ['So', 4],
  ['La', 5],
  ['Si', 6],
  ['Ti', 6],
]

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

const mod = (n: number, m: number) => ((n % m) + m) % m

export function notePc(n: Note): number {
  return mod(LETTER_SEMI[n.letter] + n.acc, 12)
}

/** Natural spelling of a pitch class for the given accidental preference. */
export function noteFromPc(pc: number, acc: Accidental = 'sharp'): Note {
  const name = (acc === 'flat' ? FLAT_NAMES : SHARP_NAMES)[mod(pc, 12)]
  return { letter: LETTERS.indexOf(name[0]), acc: name.length > 1 ? (acc === 'flat' ? -1 : 1) : 0 }
}

const isGermanic = (n: NoteNaming) => n === 'german' || n === 'czech' || n === 'scandinavian'

/** Parse a note name at the start of `s`. */
export function parseNote(s: string, naming: NoteNaming = 'english'): { note: Note; len: number } | null {
  let letter = -1
  let len = 0
  if (naming === 'latin') {
    for (const [name, l] of LATIN_INPUT) {
      if (s.startsWith(name)) {
        letter = l
        len = name.length
        break
      }
    }
  }
  if (letter < 0) {
    const c = s[0]
    if (c && 'ABCDEFG'.includes(c)) letter = LETTERS.indexOf(c)
    else if (c === 'H' && isGermanic(naming)) letter = 6
    else return null
    len = 1
  }
  const rest = s.slice(len)
  let acc = 0
  let accLen = 0
  const m = /^(##|bb|♯♯|♭♭|#|♯|b|♭)/.exec(rest)
  if (m) {
    accLen = m[1].length
    acc = m[1] === '##' || m[1] === '♯♯' ? 2 : m[1] === 'bb' || m[1] === '♭♭' ? -2 : /#|♯/.test(m[1]) ? 1 : -1
  } else if (isGermanic(naming)) {
    // German spellings: Fis, Cis, Es, As, Des, Hes… ("s" must not swallow the start of "sus").
    const g = /^(isis|eses|is|es|s)/.exec(rest)
    if (g && !rest.slice(g[1].length).startsWith('us') && !(g[1] === 's' && letter !== 2 && letter !== 5)) {
      accLen = g[1].length
      acc = g[1] === 'isis' ? 2 : g[1] === 'is' ? 1 : g[1] === 'eses' ? -2 : -1
    }
  }
  // German family: a bare B is B flat ("Bb" is read leniently as B flat too), H is B natural.
  if (isGermanic(naming) && s[0] === 'B' && !accLen) acc = -1
  return { note: { letter, acc }, len: len + accLen }
}

/** Format a note for display in a naming locale. */
export function formatNote(n: Note, naming: NoteNaming = 'english'): string {
  const accStr = (a: number) => (a > 0 ? '#'.repeat(a) : 'b'.repeat(-a))
  if (naming === 'latin') return LATIN[n.letter] + accStr(n.acc)
  if (isGermanic(naming) && n.letter === 6) {
    if (n.acc === 0) return 'H'
    if (n.acc > 0) return 'H' + accStr(n.acc)
    if (n.acc === -1) return naming === 'scandinavian' ? 'Bb' : 'B'
    return naming === 'scandinavian' ? 'Bbb' : 'Bb'
  }
  return LETTERS[n.letter] + accStr(n.acc)
}

const SUFFIX_RE =
  /^(maj|ma|min|mi|m|M|dim|aug|sus|add|no|omit|alt|o|ø|°|\+|-|Δ|\^|[0-9]|\(|\)|b|#|♭|♯|\/(?=[0-9])|,|\.)*$/

/**
 * Parse a chord symbol such as "F#m7b5/C#". Returns null if the text does not look like a chord,
 * which is how plain-text chord-sheet detection decides whether a line is a chord line.
 */
export function parseChord(text: string, naming: NoteNaming = 'english'): Chord | null {
  let t = text.trim()
  if (!t || t.startsWith('*')) return null
  let parens = false
  if (t.length > 2 && t.startsWith('(') && t.endsWith(')') && !t.slice(1, -1).includes('(')) {
    t = t.slice(1, -1)
    parens = true
  }
  const root = parseNote(t, naming)
  if (!root) return null
  let rest = t.slice(root.len)
  let bass: { note: Note; len: number } | null = null
  const slash = rest.lastIndexOf('/')
  if (slash >= 0) {
    const b = parseNote(rest.slice(slash + 1), naming)
    if (b && b.len === rest.length - slash - 1) {
      bass = b
      rest = rest.slice(0, slash)
    }
  }
  if (!SUFFIX_RE.test(rest)) return null
  // Czech minor "mi" is stored as "m" so other locales display it normally.
  if (naming === 'czech') rest = rest.replace(/^mi(?!n)/, 'm')
  return {
    root: notePc(root.note),
    suffix: rest,
    bass: bass ? notePc(bass.note) : undefined,
    flat: root.note.acc < 0 || (bass?.note.acc ?? 0) < 0,
    rootNote: root.note,
    bassNote: bass?.note,
    parens: parens || undefined,
  }
}

function suffixFor(suffix: string, naming: NoteNaming): string {
  return naming === 'czech' ? suffix.replace(/^m(?!aj|i)/, 'mi') : suffix
}

/** Render a chord with its own (possibly transposed) spelling. */
export function chordToString(c: Chord, naming: NoteNaming = 'english'): string {
  let s = formatNote(c.rootNote, naming) + suffixFor(c.suffix, naming)
  if (c.bassNote) s += '/' + formatNote(c.bassNote, naming)
  return c.parens ? `(${s})` : s
}

/** Legacy pitch-class name. */
export function noteName(pc: number, acc: Accidental, naming: NoteNaming = 'english'): string {
  return formatNote(noteFromPc(pc, acc), naming === 'nashville' ? 'english' : naming)
}

/** Format a chord re-spelling every accidental with `acc`. */
export function formatChord(c: Chord, acc: Accidental, naming: NoteNaming = 'english'): string {
  return chordToString(
    { ...c, rootNote: noteFromPc(c.root, acc), bassNote: c.bass === undefined ? undefined : noteFromPc(c.bass, acc) },
    naming === 'nashville' ? 'english' : naming,
  )
}

/* ------------------------------------------------------------------ keys */

export interface Key {
  note: Note
  minor: boolean
}

/** Parse "G", "Em", "F# minor", "Bb major", "Ami" (Czech) … */
export function parseKey(text: string | undefined, naming: NoteNaming = 'english'): Key | null {
  if (!text) return null
  const t = text.trim().replace(/\s+(major|maj|dur|ionian)$/i, '').replace(/\s+(minor|min|moll|aeolian)$/i, 'm')
  const c = parseChord(t.split(/\s+/)[0], naming)
  if (!c) return null
  return { note: c.rootNote, minor: /^(m(?!aj)|min|mi(?!n)|-)/.test(c.suffix) }
}

export function formatKey(k: Key, naming: NoteNaming = 'english'): string {
  return formatNote(k.note, naming === 'nashville' ? 'english' : naming) + (k.minor ? (naming === 'czech' ? 'mi' : 'm') : '')
}

/** Key signature size on the circle of fifths: positive = sharps, negative = flats. */
export function keyFifths(k: Key): number {
  return LETTER_FIFTHS[k.note.letter] + 7 * k.note.acc - (k.minor ? 3 : 0)
}

/**
 * Spell the key with pitch class `pc`. The conventional spelling (fewer accidentals in the
 * signature) wins; a tie (F#/Gb, D#m/Ebm) follows `tie`, which callers set from the direction.
 */
export function spellKey(pc: number, minor: boolean, tie: Accidental, prefer?: Accidental): Key {
  const cands: Key[] = []
  for (let letter = 0; letter < 7; letter++) {
    for (const acc of [-1, 0, 1]) if (mod(LETTER_SEMI[letter] + acc, 12) === mod(pc, 12)) cands.push({ note: { letter, acc }, minor })
  }
  const natural = cands.find((k) => k.note.acc === 0)
  if (prefer) return natural ?? cands.find((k) => (prefer === 'sharp' ? k.note.acc > 0 : k.note.acc < 0)) ?? cands[0]
  cands.sort((a, b) => Math.abs(keyFifths(a)) - Math.abs(keyFifths(b)) || (tie === 'sharp' ? b.note.acc - a.note.acc : a.note.acc - b.note.acc))
  return cands[0]
}

/** Transpose a key by semitones: up prefers sharps, down prefers flats, unless convention decides. */
export function transposeKeyObj(k: Key, semitones: number, prefer?: Accidental): Key {
  if (!semitones && !prefer) return k
  return spellKey(notePc(k.note) + semitones, k.minor, semitones < 0 ? 'flat' : 'sharp', prefer)
}

export function transposeKey(key: string, semitones: number, prefer?: Accidental, naming: NoteNaming = 'english'): string {
  const c = parseChord(key, naming)
  const k = parseKey(key, naming)
  if (!c || !k) return key
  const t = transposeKeyObj(k, semitones, prefer)
  return chordToString({ ...c, rootNote: t.note, bassNote: undefined }, naming === 'nashville' ? 'english' : naming)
}

/** Decide whether to spell with sharps or flats in a target key (e.g. "Eb" → flat, "E" → sharp). */
export function accidentalForKey(key: string | undefined, fallback: Accidental = 'sharp'): Accidental {
  const k = parseKey(key)
  if (!k) return fallback
  const f = keyFifths(k)
  return f < 0 ? 'flat' : f > 0 ? 'sharp' : fallback
}

/* --------------------------------------------------------- transposition */

/**
 * Move a note by `letterSteps` letters and `semitones` semitones; the accidental follows the
 * interval. Afterwards uncommon names and double accidentals are simplified unless allowed.
 */
export function transposeNote(n: Note, letterSteps: number, semitones: number, opts: TransposeOptions = {}): Note {
  const letter = mod(n.letter + letterSteps, 7)
  const pitch = LETTER_SEMI[n.letter] + n.acc + semitones
  // Accidental needed on the new letter, folded into -6..5.
  let acc = mod(pitch - LETTER_SEMI[letter] + 6, 12) - 6
  let out: Note = { letter, acc }
  if (Math.abs(acc) > 2 || (Math.abs(acc) === 2 && !opts.allowDouble)) {
    out = noteFromPc(pitch, acc > 0 ? 'sharp' : 'flat')
    acc = out.acc
  }
  if (!opts.allowUncommon) {
    const name = LETTERS[out.letter] + acc
    if (name === 'B1' || name === 'E1' || name === 'C-1' || name === 'F-1') out = noteFromPc(pitch, 'sharp')
  }
  if (opts.prefer && out.acc !== 0 && (opts.prefer === 'sharp') !== out.acc > 0) out = noteFromPc(pitch, opts.prefer)
  return out
}

export function transposeChordObj(c: Chord, letterSteps: number, semitones: number, opts: TransposeOptions = {}): Chord {
  const rootNote = transposeNote(c.rootNote, letterSteps, semitones, opts)
  const bassNote = c.bassNote ? transposeNote(c.bassNote, letterSteps, semitones, opts) : undefined
  return {
    ...c,
    rootNote,
    bassNote,
    root: notePc(rootNote),
    bass: bassNote ? notePc(bassNote) : undefined,
    flat: rootNote.acc < 0 || (bassNote?.acc ?? 0) < 0,
  }
}

export interface Transposer {
  /** Spelled target key (when the source key is known). */
  key?: Key
  letterSteps: number
  semitones: number
  /** Transpose one chord symbol; text that is not a chord is returned unchanged. */
  chord: (text: string) => string
}

/**
 * Build a key-aware transposer. With a source key the letter distance comes from the spelled target
 * key; without one the chord's own spelling decides (flats stay flats, naturals follow direction).
 */
export function makeTransposer(opts: {
  key?: string | Key | null
  semitones: number
  naming?: NoteNaming
  outNaming?: NoteNaming
  targetKey?: string
} & TransposeOptions): Transposer {
  const naming = opts.naming ?? 'english'
  const outNaming = opts.outNaming ?? naming
  const semis = opts.semitones
  const src = typeof opts.key === 'string' ? parseKey(opts.key, naming) : (opts.key ?? null)
  let target: Key | undefined
  if (opts.targetKey) target = parseKey(opts.targetKey) ?? undefined
  else if (src) target = transposeKeyObj(src, semis)
  const letterSteps = src && target ? mod(target.note.letter - src.note.letter, 7) : 0
  const fallbackAcc: Accidental | undefined = target && !src ? accidentalForKey(formatKey(target)) : undefined
  const identity = !semis && !opts.prefer && naming === outNaming
  return {
    key: target ?? (src || undefined),
    letterSteps,
    semitones: semis,
    chord: (text) => {
      if (identity) return text
      const c = parseChord(text, naming)
      if (!c) return text
      let out: Chord
      if (src) out = transposeChordObj(c, letterSteps, semis, opts)
      else {
        // No key: spell from the chord itself.
        const acc = opts.prefer ?? fallbackAcc ?? (c.flat ? 'flat' : c.rootNote.acc > 0 ? 'sharp' : semis < 0 ? 'flat' : 'sharp')
        out = {
          ...c,
          rootNote: noteFromPc(c.root + semis, acc),
          bassNote: c.bass === undefined ? undefined : noteFromPc(c.bass + semis, acc),
        }
      }
      return chordToString(out, outNaming === 'nashville' ? 'english' : outNaming)
    },
  }
}

/**
 * Transpose a chord symbol by semitones. Spelling follows (in priority): explicit preference,
 * the source key (letter-aware), the target key, the chord's own spelling.
 */
export function transposeChord(
  text: string,
  semitones: number,
  opts: { prefer?: Accidental; targetKey?: string; fromKey?: string; naming?: NoteNaming; outNaming?: NoteNaming } & TransposeOptions = {},
): string {
  return makeTransposer({ ...opts, key: opts.fromKey, semitones }).chord(text)
}

/** Nashville number of a chord relative to a key, e.g. key G, chord D7 → "57". */
export function nashville(text: string, key: string, naming: NoteNaming = 'english'): string {
  const c = parseChord(text, naming)
  const k = parseKey(key, naming)
  if (!c || !k) return text
  const kp = notePc(k.note)
  const degrees = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7']
  let s = degrees[mod(c.root - kp, 12)] + c.suffix
  if (c.bass !== undefined) s += '/' + degrees[mod(c.bass - kp, 12)]
  return c.parens ? `(${s})` : s
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
  let d = mod(kb.root - ka.root, 12)
  if (d > 6) d -= 12
  return d
}

/* ------------------------------------------------------ chord-line detection */

/** Tokens that never count either way on a chord line. */
const NEUTRAL_TOKEN = /^(-+|\|+|\|[.:]|:\||:\|:|\|\|:?|%+|\/|:|\.\.\.|chorus:?|bridge:?|x\d+|\d+x|\(x?\d+x?\)|N\.?C\.?|\(N\.?C\.?\))$/i

/** Split a line into whitespace-separated tokens with their column. */
export function lineTokens(line: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  const s = line.replace(/\]\[/g, '] [')
  while ((m = re.exec(s))) out.push({ at: m.index, text: m[0] })
  return out
}

/** Is this token a chord (bracketed "[G]" and parenthesised "(Am)" forms accepted)? */
export function isChordToken(tok: string, naming: NoteNaming = 'english'): boolean {
  const t = tok.replace(/^\[(.*)\]$/, '$1')
  return !!parseChord(t, naming)
}

/**
 * Is this line a chord line (chords written above lyrics)? Tokens like "-", "|", "Chorus", "x2" are
 * neutral; the line qualifies when at least 65% of the remaining tokens are chords.
 */
export function isChordLine(line: string, naming: NoteNaming = 'english'): boolean {
  let total = 0
  let chords = 0
  for (const { text } of lineTokens(line)) {
    if (NEUTRAL_TOKEN.test(text)) continue
    total++
    if (isChordToken(text, naming)) chords++
  }
  return total > 0 && chords > 0 && chords >= 0.65 * total
}

/**
 * Rewrite every chord on a plain-text chord line, keeping each chord at its column where possible
 * (later chords shift right only when a longer name would collide).
 */
export function transposeChordLine(line: string, fn: (chord: string) => string, naming: NoteNaming = 'english'): string {
  let out = ''
  for (const { at, text } of lineTokens(line)) {
    const next = isChordToken(text, naming) ? (text.startsWith('[') ? `[${fn(text.slice(1, -1))}]` : fn(text)) : text
    const pad = out.length === 0 ? at : Math.max(at - out.length, 1)
    out += ' '.repeat(pad) + next
  }
  return out
}
