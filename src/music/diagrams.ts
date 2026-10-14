/**
 * Chord diagram lookup: song-level {define}s first, then the built-in dictionary for the instrument.
 * Guitar and ukulele fingerings come from @tombatossals/chords-db (MIT, loaded lazily); piano
 * voicings are generated from the chord quality.
 */
import { parseChord, type Chord } from './chords'

export type Instrument = 'guitar' | 'ukulele' | 'piano'

export interface FretShape {
  kind: 'frets'
  /** Fret per string, low string first; null = muted, 0 = open. Relative to baseFret (1 = base fret). */
  frets: (number | null)[]
  fingers?: number[]
  /** Fret numbers (relative) that are barred. */
  barres?: number[]
  baseFret: number
}

export interface KeysShape {
  kind: 'keys'
  /** Semitones above the C that starts the drawn keyboard. */
  keys: number[]
}

export type Shape = FretShape | KeysShape

export interface Diagram {
  name: string
  shape: Shape
  /** Alternative voicings (dictionary only). */
  variants?: Shape[]
  source: 'define' | 'builtin' | 'generated'
  /** The dictionary had no exact match; a simpler chord was used. */
  approx?: boolean
}

/** A {define}/{chord} definition in a ChordPro file. */
export interface ChordDefinition {
  name: string
  raw: string
  baseFret?: number
  frets?: (number | null)[]
  fingers?: number[]
  /** Piano keys (semitones from the root's C). */
  keys?: number[]
  /** Copy the fingering of a built-in chord. */
  copy?: string
  /** "diagram off" hides the diagram. */
  hidden?: boolean
  /** Display name override. */
  display?: string
}

export const STRINGS: Record<Exclude<Instrument, 'piano'>, number> = { guitar: 6, ukulele: 4 }
export const TUNINGS: Record<Exclude<Instrument, 'piano'>, string[]> = {
  guitar: ['E', 'A', 'D', 'G', 'B', 'E'],
  ukulele: ['G', 'C', 'E', 'A'],
}

/* ------------------------------------------------------------------ data */

interface DbPosition {
  frets: number[]
  fingers?: number[]
  barres?: number[]
  baseFret: number
}
interface DbFile {
  chords: Record<string, { key: string; suffix: string; positions: DbPosition[] }[]>
}

type Dict = Map<string, FretShape[]>
const dicts = new Map<Instrument, Dict>()
const loading = new Map<Instrument, Promise<void>>()

const DB_KEY_PC: Record<string, number> = {
  C: 0, Csharp: 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Fsharp: 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
}

function buildDict(file: DbFile): Dict {
  const d: Dict = new Map()
  for (const [key, list] of Object.entries(file.chords)) {
    const pc = DB_KEY_PC[key]
    if (pc === undefined) continue
    for (const c of list) {
      d.set(
        `${pc}:${c.suffix}`,
        c.positions.map((p) => ({
          kind: 'frets',
          frets: p.frets.map((f) => (f < 0 ? null : f)),
          fingers: p.fingers,
          barres: p.barres,
          baseFret: p.baseFret,
        })),
      )
    }
  }
  return d
}

/** Load the dictionary for an instrument (no-op for piano). Resolves when lookups are synchronous. */
export function loadInstrument(inst: Instrument): Promise<void> {
  if (inst === 'piano' || dicts.has(inst)) return Promise.resolve()
  let p = loading.get(inst)
  if (!p) {
    p = (inst === 'guitar' ? import('@tombatossals/chords-db/lib/guitar.json') : import('@tombatossals/chords-db/lib/ukulele.json'))
      .then((m) => {
        dicts.set(inst, buildDict(((m as { default?: DbFile }).default ?? m) as DbFile))
      })
      .catch(() => {
        loading.delete(inst)
      })
    loading.set(inst, p)
  }
  return p
}

export function instrumentLoaded(inst: Instrument): boolean {
  return inst === 'piano' || dicts.has(inst)
}

/* --------------------------------------------------------------- qualities */

/** Map a chord suffix to the dictionary's suffix vocabulary. */
export function canonicalSuffix(suffix: string): string {
  let s = suffix.replace(/[()\s]/g, '').replace(/♭/g, 'b').replace(/♯/g, '#')
  s = s.replace(/^(min|mi(?!n)|-(?=\d|$|maj|M))/, 'm')
  const table: Record<string, string> = {
    '': 'major', M: 'major', maj: 'major', ma: 'major',
    m: 'minor',
    M7: 'maj7', maj7: 'maj7', ma7: 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', '^': 'maj7', '^7': 'maj7', j7: 'maj7',
    M9: 'maj9', 'Δ9': 'maj9', M11: 'maj11', M13: 'maj13', 'Δ13': 'maj13',
    mM7: 'mmaj7', mmaj7: 'mmaj7', 'm/maj7': 'mmaj7', 'mΔ7': 'mmaj7', 'mΔ': 'mmaj7', mM9: 'mmaj9',
    '°': 'dim', o: 'dim', dim: 'dim', '°7': 'dim7', o7: 'dim7',
    'ø': 'm7b5', 'ø7': 'm7b5', 'm7-5': 'm7b5', 'mi7b5': 'm7b5',
    '+': 'aug', '#5': 'aug', '+5': 'aug', '+7': 'aug7', '7#5': 'aug7', '7+5': 'aug7', '7+': 'aug7', '+9': 'aug9', '9#5': 'aug9',
    sus: 'sus4', '4': 'sus4', '2': 'sus2', '7sus': '7sus4', sus7: '7sus4', '7sus4': '7sus4',
    '6/9': '69', '69': '69', 'm6/9': 'm69', add2: 'add9', madd2: 'madd9', 'm9add': 'madd9',
    '7-5': '7b5', '7-9': '7b9', '7+9': '7#9', '7alt': 'alt',
  }
  return table[s] ?? s
}

/** Simpler qualities to fall back on when the dictionary lacks a suffix. */
function fallbacks(canon: string): string[] {
  const out: string[] = []
  const minor = /^m(?!aj)/.test(canon) || canon === 'minor'
  if (/7/.test(canon)) out.push(canon.startsWith('maj') ? 'maj7' : minor ? 'm7' : canon.startsWith('dim') ? 'dim7' : '7')
  if (/sus2/.test(canon)) out.push('sus2')
  if (/sus/.test(canon)) out.push('sus4')
  if (/9/.test(canon)) out.push(minor ? 'm9' : '9')
  out.push(minor ? 'minor' : canon.startsWith('dim') ? 'dim' : canon.startsWith('aug') ? 'aug' : 'major')
  return out.filter((x) => x !== canon)
}

/** Chord tones in semitones above the root for a suffix. */
export function chordTones(suffix: string): number[] {
  const canon = canonicalSuffix(suffix)
  let s = canon === 'major' ? '' : canon === 'minor' ? 'm' : canon
  let third: number | null = 4
  let fifth: number | null = 7
  const add = new Set<number>()
  const take = (re: RegExp) => {
    const m = re.exec(s)
    if (m) s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
    return !!m
  }
  if (take(/^m7b5/)) {
    third = 3
    fifth = 6
    add.add(10)
  } else if (take(/^dim7?/)) {
    third = 3
    fifth = 6
    if (/^7/.test(canon.slice(3)) || canon === 'dim7') add.add(9)
  } else if (take(/^mmaj/)) {
    third = 3
    add.add(11)
    s = s.replace(/^7/, '')
    if (take(/^9/)) add.add(14)
    if (take(/^11/)) add.add(14).add(17)
  } else if (take(/^m(?!aj)/)) third = 3
  if (take(/^aug/)) fifth = 8
  if (take(/^maj/)) {
    add.add(11)
    if (take(/^13/)) add.add(14).add(21)
    else if (take(/^11/)) add.add(14).add(17)
    else if (take(/^9/)) add.add(14)
    else take(/^7/)
  }
  if (take(/^69/)) add.add(9).add(14)
  else if (take(/^6/)) add.add(9)
  if (take(/^13/)) add.add(10).add(14).add(21)
  else if (take(/^11/)) add.add(10).add(14).add(17)
  else if (take(/^9/)) add.add(10).add(14)
  else if (take(/^7/)) add.add(10)
  if (take(/sus2/)) third = 2
  else if (take(/sus4?/)) third = 5
  if (take(/add9|add2/)) add.add(14)
  if (take(/add11|add4/)) add.add(17)
  if (take(/b5/)) fifth = 6
  if (take(/#5/)) fifth = 8
  if (take(/b9/)) {
    add.delete(14)
    add.add(13)
  }
  if (take(/#9/)) {
    add.delete(14)
    add.add(15)
  }
  if (take(/#11/)) {
    add.delete(17)
    add.add(18)
  }
  if (take(/b13/)) {
    add.delete(21)
    add.add(20)
  }
  if (canon === '5') third = null
  return [0, third, fifth, ...add].filter((x): x is number => x !== null).sort((a, b) => a - b)
}

function pianoShape(c: Chord): KeysShape {
  const tones = chordTones(c.suffix).map((t) => t + c.root)
  const keys = c.bass !== undefined ? [c.bass, ...tones.map((t) => t + 12)] : tones
  // Start low enough that the voicing sits in the drawn two octaves.
  const shift = keys[0] >= 12 ? -12 : 0
  return { kind: 'keys', keys: keys.map((k) => k + shift) }
}

/* ---------------------------------------------------------------- lookup */

const sameChord = (a: Chord, b: Chord) => a.root === b.root && a.bass === b.bass && canonicalSuffix(a.suffix) === canonicalSuffix(b.suffix)

function fromDefine(def: ChordDefinition, inst: Instrument): Shape | null {
  if (inst === 'piano') {
    if (!def.keys?.length) return null
    const c = parseChord(def.name)
    return { kind: 'keys', keys: def.keys.map((k) => k + (c?.root ?? 0)) }
  }
  if (!def.frets || def.frets.length !== STRINGS[inst]) return null
  return { kind: 'frets', frets: def.frets, fingers: def.fingers?.length ? def.fingers : undefined, baseFret: def.baseFret || 1 }
}

/**
 * Find a diagram for a chord name (English spelling). Song definitions win; otherwise the built-in
 * dictionary (loaded via loadInstrument) or a generated piano voicing is used.
 */
export function lookupDiagram(name: string, inst: Instrument, defines: ChordDefinition[] = []): Diagram | null {
  const c = parseChord(name)
  for (const d of defines) {
    const dc = parseChord(d.name)
    if (d.name !== name && !(dc && c && sameChord(dc, c))) continue
    if (d.hidden) return null
    const shape = fromDefine(d, inst)
    if (shape) return { name: d.display ?? name, shape, source: 'define' }
    if (d.copy) {
      const copied = lookupDiagram(d.copy, inst)
      if (copied) return { ...copied, name: d.display ?? name }
    }
  }
  if (!c) return null
  if (inst === 'piano') return { name, shape: pianoShape(c), source: 'generated' }
  const dict = dicts.get(inst)
  if (!dict) return null
  const canon = canonicalSuffix(c.suffix)
  const tryGet = (suffix: string) => dict.get(`${c.root}:${suffix}`)
  let shapes: FretShape[] | undefined
  let approx = false
  if (c.bass !== undefined && c.bass !== c.root) {
    const bassName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'][c.bass!]
    const prefix = canon === 'minor' ? 'm' : canon === 'major' ? '' : null
    if (prefix !== null) shapes = tryGet(`${prefix}/${bassName}`) ?? tryGet(`${prefix}/${['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'][c.bass!]}`)
  }
  shapes ??= tryGet(canon)
  if (!shapes) {
    for (const f of fallbacks(canon)) {
      shapes = tryGet(f)
      if (shapes) {
        approx = true
        break
      }
    }
  }
  if (!shapes?.length) return null
  return { name, shape: shapes[0], variants: shapes.slice(1), source: 'builtin', approx: approx || undefined }
}

/** Parse the value of {define: …} / {chord: …}. */
export function parseDefine(value: string): ChordDefinition {
  const parts = value.trim().split(/\s+/)
  const name = parts.shift() ?? ''
  const def: ChordDefinition = { name, raw: parts.join(' ') }
  const num = /^(x|X|N|-?\d+)$/
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase().replace(/:$/, '')
    if (p === 'base-fret' || p === 'base_fret') def.baseFret = Number(parts[++i])
    else if (p === 'frets') {
      const frets: (number | null)[] = []
      while (i + 1 < parts.length && num.test(parts[i + 1])) {
        const v = parts[++i]
        frets.push(/^[xXN]$/.test(v) || Number(v) < 0 ? null : Number(v))
      }
      def.frets = frets
    } else if (p === 'fingers') {
      const f: number[] = []
      while (i + 1 < parts.length && /^(\d+|[xXN-])$/.test(parts[i + 1])) {
        const v = parts[++i]
        f.push(/^\d+$/.test(v) ? Number(v) : 0)
      }
      def.fingers = f
    } else if (p === 'keys') {
      const k: number[] = []
      while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) k.push(Number(parts[++i]))
      def.keys = k
    } else if (p === 'copy' || p === 'copyall') def.copy = parts[++i]
    else if (p === 'diagram') def.hidden = /^(off|false|0)$/i.test(parts[++i] ?? '')
    else if (p === 'display') def.display = parts[++i]?.replace(/^"|"$/g, '')
  }
  return def
}
