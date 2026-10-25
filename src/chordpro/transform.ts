/**
 * Source-text rewrites used by the editor: transpose a whole ChordPro or plain-text file, and
 * helpers for inserting chords.
 */
import { isChordLine, isChordToken, makeTransposer, parseChord, transposeChordLine, type NoteNaming, type TransposeOptions } from '../music/chords'

type Opts = TransposeOptions & { naming?: NoteNaming }

const ENV_ALIASES: Record<string, string> = {
  soc: 'start_of_chorus', eoc: 'end_of_chorus', sot: 'start_of_tab', eot: 'end_of_tab', sog: 'start_of_grid',
  eog: 'end_of_grid', soa: 'start_of_abc', eoa: 'end_of_abc', sos: 'start_of_svg', eos: 'end_of_svg',
}
const DIRECTIVE = /^(\s*\{\s*)([A-Za-z_][\w!-]*)(\s*[:\s]\s*)?(.*?)(\s*\}\s*)$/

/** Key written in the file ({key:} / "Key:"), or the first chord. */
export function detectKey(src: string, naming: NoteNaming = 'english'): string | undefined {
  const k = /^\s*\{\s*key\s*:\s*([^}]+)\}/im.exec(src) ?? /^\s*key\s*:\s*(\S+)/im.exec(src)
  if (k && parseChord(k[1].trim().split(/\s+/)[0], naming)) return k[1].trim()
  for (const m of src.matchAll(/\[([^\]*][^\]]*)\]/g)) if (parseChord(m[1], naming)) return m[1]
  for (const line of src.split('\n'))
    if (isChordLine(line, naming)) {
      const t = line.trim().split(/\s+/).find((x) => isChordToken(x, naming))
      if (t) return t.replace(/^\[|\]$/g, '')
    }
  return undefined
}

/**
 * Transpose a ChordPro file in place: [chords], chords in grids and {key:} directives are rewritten;
 * inside {start_of_abc} blocks a %%mstranspose line is updated or inserted. Tabs are untouched.
 */
export function transposeChordProText(src: string, semitones: number, opts: Opts = {}): string {
  if (!semitones) return src
  src = src.replace(/\r\n?/g, '\n')
  const naming = opts.naming ?? 'english'
  const tr = makeTransposer({ ...opts, key: detectKey(src, naming), semitones, naming })
  const keyOf = (v: string) => {
    const t = makeTransposer({ ...opts, key: v, semitones, naming })
    return t.key ? t.chord(v.trim().split(/\s+/)[0]) : v
  }
  const out: string[] = []
  let env: string | null = null
  let abcHasMs = false
  for (const line of src.split('\n')) {
    const dm = DIRECTIVE.exec(line)
    if (dm) {
      const name = ENV_ALIASES[dm[2].toLowerCase()] ?? dm[2].toLowerCase().replace(/-.*$/, '')
      if (name.startsWith('start_of_')) {
        env = name.slice(9)
        abcHasMs = false
        out.push(line)
        continue
      }
      if (name.startsWith('end_of_')) {
        if (env === 'abc' && !abcHasMs) {
          const at = out.length - 1 - [...out].reverse().findIndex((l) => /^\s*\{\s*(start_of_abc|soa)\b/i.test(l))
          out.splice(at + 1, 0, `%%mstranspose ${normalize(semitones)}`)
        }
        env = null
        out.push(line)
        continue
      }
      if (env !== 'abc' && name === 'key' && dm[4]) {
        out.push(dm[1] + dm[2] + (dm[3] ?? ': ') + keyOf(dm[4]) + dm[5])
        continue
      }
      if (env !== 'abc') {
        out.push(line)
        continue
      }
    }
    if (env === 'abc') {
      const ms = /^%%mstranspose\s+(-?\d+)/.exec(line)
      if (ms) {
        abcHasMs = true
        out.push(`%%mstranspose ${normalize(Number(ms[1]) + semitones)}`)
      } else out.push(line)
      continue
    }
    if (env === 'tab') {
      out.push(line)
      continue
    }
    if (env === 'grid') {
      out.push(line.replace(/\S+/g, (tok) => tok.split('~').map((c) => (parseChord(c, naming) ? tr.chord(c) : c)).join('~')))
      continue
    }
    out.push(line.replace(/\[([^\]]*)\]/g, (m, c: string) => (c.startsWith('*') ? m : `[${tr.chord(c)}]`)))
  }
  return out.join('\n')
}

const normalize = (n: number) => ((((n + 6) % 12) + 12) % 12) - 6

/** Transpose a plain chords-over-lyrics text file: chord lines and a "Key:" header line. */
export function transposePlainText(src: string, semitones: number, opts: Opts = {}): string {
  if (!semitones) return src
  src = src.replace(/\r\n?/g, '\n')
  const naming = opts.naming ?? 'english'
  const tr = makeTransposer({ ...opts, key: detectKey(src, naming), semitones, naming })
  return src
    .split('\n')
    .map((line) => {
      const k = /^(\s*key\s*:\s*)(\S+)(.*)$/i.exec(line)
      if (k && parseChord(k[2], naming)) return k[1] + tr.chord(k[2]) + k[3]
      return isChordLine(line, naming) ? transposeChordLine(line, tr.chord, naming) : line
    })
    .join('\n')
}

/**
 * Chord-tap insertion: put `[chord]` at the start of the word containing `pos`, or replace the
 * bracketed chord the caret is in. Returns the edit to apply.
 */
export function chordInsertion(text: string, pos: number, chord: string): { start: number; end: number; insert: string } {
  // Inside an existing [chord]?
  let l = pos - 1
  while (l >= 0 && !'[]\n'.includes(text[l])) l--
  let r = pos
  while (r < text.length && !'[]\n'.includes(text[r])) r++
  if (text[l] === '[' && text[r] === ']') return { start: l, end: r + 1, insert: `[${chord}]` }
  let start = pos
  while (start > 0 && !/[\s\]]/.test(text[start - 1])) start--
  return { start, end: start, insert: `[${chord}]` }
}
