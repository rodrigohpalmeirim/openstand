/**
 * ChordPro parser (ChordPro 6 subset plus common legacy aliases) and plain-text chord sheet converter.
 */
import { isChordLine, type NoteNaming } from '../music/chords'

export interface ChordSegment {
  chord?: string
  text: string
}

export type Line =
  | { type: 'lyrics'; segments: ChordSegment[] }
  | { type: 'comment'; text: string; style: 'normal' | 'italic' | 'box' }
  | { type: 'tab'; text: string }
  | { type: 'grid'; text: string }
  | { type: 'empty' }
  | { type: 'chorusRef'; label?: string }
  | { type: 'image'; src: string }

export type SectionKind = 'verse' | 'chorus' | 'bridge' | 'tab' | 'grid' | 'none' | 'other'

export interface Section {
  kind: SectionKind
  label?: string
  lines: Line[]
  /** A column/page break placed before this section. */
  breakBefore?: 'column' | 'page'
}

export interface ChordDefinition {
  name: string
  /** e.g. "base-fret 1 frets x 3 2 0 1 0" */
  raw: string
  baseFret?: number
  frets?: (number | null)[]
  fingers?: number[]
}

export interface ChordProSong {
  meta: Record<string, string[]>
  sections: Section[]
  defines: ChordDefinition[]
  /** {transpose: n} directive in the file. */
  transpose: number
  columns?: number
}

const ALIASES: Record<string, string> = {
  t: 'title',
  st: 'subtitle',
  su: 'subtitle',
  c: 'comment',
  ci: 'comment_italic',
  cb: 'comment_box',
  soc: 'start_of_chorus',
  eoc: 'end_of_chorus',
  sov: 'start_of_verse',
  eov: 'end_of_verse',
  sob: 'start_of_bridge',
  eob: 'end_of_bridge',
  sot: 'start_of_tab',
  eot: 'end_of_tab',
  sog: 'start_of_grid',
  eog: 'end_of_grid',
  np: 'new_page',
  npp: 'new_physical_page',
  colb: 'column_break',
  col: 'columns',
  ns: 'new_song',
  g: 'guitar_comment',
  highlight: 'comment',
  x_comment: 'comment',
}

const META_KEYS = new Set([
  'title',
  'subtitle',
  'artist',
  'composer',
  'lyricist',
  'arranger',
  'copyright',
  'album',
  'year',
  'key',
  'time',
  'tempo',
  'duration',
  'capo',
  'meta',
  'sorttitle',
  'genre',
  'keywords',
  'book',
  'source',
])

/** Split "[G]Amazing [D/F#]grace" into chord/text segments. */
export function parseLyricLine(line: string): ChordSegment[] {
  const segs: ChordSegment[] = []
  const re = /\[([^\]]*)\]/g
  let last = 0
  let pendingChord: string | undefined
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    const text = line.slice(last, m.index)
    if (text || pendingChord !== undefined) segs.push({ chord: pendingChord, text })
    pendingChord = m[1]
    last = m.index + m[0].length
  }
  const tail = line.slice(last)
  if (tail || pendingChord !== undefined) segs.push({ chord: pendingChord, text: tail })
  return segs
}

function parseDefine(value: string): ChordDefinition {
  const parts = value.trim().split(/\s+/)
  const name = parts.shift() ?? ''
  const def: ChordDefinition = { name, raw: parts.join(' ') }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].toLowerCase().replace(/:$/, '')
    if (p === 'base-fret') def.baseFret = Number(parts[++i])
    else if (p === 'frets') {
      const frets: (number | null)[] = []
      while (i + 1 < parts.length && /^(x|X|N|-?\d+)$/.test(parts[i + 1])) {
        const v = parts[++i]
        frets.push(/^[xXN]$/.test(v) || v === '-1' ? null : Number(v))
      }
      def.frets = frets
    } else if (p === 'fingers') {
      const f: number[] = []
      while (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) f.push(Number(parts[++i]))
      def.fingers = f
    }
  }
  return def
}

export function parseChordPro(src: string): ChordProSong {
  const song: ChordProSong = { meta: {}, sections: [], defines: [], transpose: 0 }
  let current: Section = { kind: 'none', lines: [] }
  let pendingBreak: Section['breakBefore']
  const push = () => {
    if (current.lines.length || current.kind !== 'none') song.sections.push(current)
  }
  const open = (kind: SectionKind, label?: string) => {
    // An empty implicit section only carries a pending break; hand it to the new section.
    const carried = current.kind === 'none' && !current.lines.length ? current.breakBefore : undefined
    push()
    current = { kind, label, lines: [], breakBefore: pendingBreak ?? carried }
    pendingBreak = undefined
  }
  const close = () => {
    push()
    current = { kind: 'none', lines: [], breakBefore: pendingBreak }
    pendingBreak = undefined
  }
  const addMeta = (k: string, v: string) => {
    ;(song.meta[k] ??= []).push(v)
  }

  for (const rawLine of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const inVerbatim = current.kind === 'tab' || current.kind === 'grid'
    const dm = /^\s*\{\s*([A-Za-z_][\w-]*)\s*(?:[:\s]\s*(.*?))?\s*\}\s*$/.exec(line)
    if (dm) {
      // Strip ChordPro 6 conditional selectors such as {title-guitar: …}.
      let name = dm[1].toLowerCase().replace(/-.*$/, '')
      name = ALIASES[name] ?? name
      const value = (dm[2] ?? '').trim()
      if (name.startsWith('start_of_')) {
        const k = name.slice(9)
        const kind: SectionKind =
          k === 'chorus' || k === 'verse' || k === 'bridge' || k === 'tab' || k === 'grid' ? k : 'other'
        open(kind, value.replace(/^label\s*=\s*"?([^"]*)"?$/, '$1') || (kind === 'other' ? k : undefined))
        continue
      }
      if (name.startsWith('end_of_')) {
        close()
        continue
      }
      if (inVerbatim) {
        current.lines.push({ type: current.kind === 'tab' ? 'tab' : 'grid', text: line })
        continue
      }
      switch (name) {
        case 'comment':
        case 'guitar_comment':
          current.lines.push({ type: 'comment', text: value, style: 'normal' })
          break
        case 'comment_italic':
          current.lines.push({ type: 'comment', text: value, style: 'italic' })
          break
        case 'comment_box':
          current.lines.push({ type: 'comment', text: value, style: 'box' })
          break
        case 'chorus':
          current.lines.push({ type: 'chorusRef', label: value || undefined })
          break
        case 'new_page':
        case 'new_physical_page':
          pendingBreak = 'page'
          close()
          break
        case 'column_break':
          pendingBreak = 'column'
          close()
          break
        case 'columns':
          song.columns = Math.max(1, Math.min(4, Number(value) || 1))
          break
        case 'define':
        case 'chord':
          song.defines.push(parseDefine(value))
          break
        case 'transpose':
          song.transpose = Number(value) || 0
          break
        case 'image':
          current.lines.push({ type: 'image', src: /src\s*=\s*"?([^"\s]+)"?/.exec(value)?.[1] ?? value })
          break
        case 'meta': {
          const mm = /^(\S+)\s+(.*)$/.exec(value)
          if (mm) addMeta(mm[1].toLowerCase(), mm[2])
          break
        }
        default:
          if (META_KEYS.has(name)) addMeta(name, value)
          // Unknown directives (fonts, sizes, x_*) are ignored on purpose.
          break
      }
      continue
    }
    if (inVerbatim) {
      current.lines.push({ type: current.kind === 'tab' ? 'tab' : 'grid', text: line })
      continue
    }
    if (/^\s*#/.test(line)) continue // ChordPro comment line
    if (!line.trim()) {
      current.lines.push({ type: 'empty' })
      continue
    }
    current.lines.push({ type: 'lyrics', segments: parseLyricLine(line) })
  }
  push()
  // Trim leading/trailing empty lines in each section.
  for (const s of song.sections) {
    while (s.lines[0]?.type === 'empty') s.lines.shift()
    while (s.lines.at(-1)?.type === 'empty') s.lines.pop()
  }
  song.sections = song.sections.filter((s) => s.lines.length || s.kind !== 'none' || s.breakBefore)
  return song
}

/** Does this text look like ChordPro (directives or inline [chords])? */
export function looksLikeChordPro(src: string): boolean {
  return /^\s*\{\s*(t|title|soc|start_of_chorus|c|comment|artist|key)\b/im.test(src) || /\[[A-H][^\]\s]{0,8}\][a-z ]/.test(src)
}

/**
 * Convert a plain-text "chords over lyrics" sheet into ChordPro, merging each chord line into the
 * lyric line beneath it. Lines like "Chorus:" or "[Verse 2]" become section labels via comments.
 */
export function textToChordPro(src: string, naming: NoteNaming = 'english'): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, '    ').replace(/\s+$/, '')
    if (isChordLine(line, naming)) {
      const next = lines[i + 1]?.replace(/\t/g, '    ').replace(/\s+$/, '')
      if (next !== undefined && next.trim() && !isChordLine(next, naming) && !isHeading(next)) {
        out.push(mergeChordLine(line, next))
        i++
      } else {
        out.push(chordOnlyLine(line))
      }
      continue
    }
    const meta = /^\s*(title|subtitle|artist|composer|key|capo|tempo|time|album|year)\s*:\s*(.+)$/i.exec(line)
    if (meta && !out.some((l) => l.trim() && !l.startsWith('{'))) {
      out.push(`{${meta[1].toLowerCase()}: ${meta[2].trim()}}`)
      continue
    }
    const h = isHeading(line)
    if (h) {
      out.push(`{comment: ${h}}`)
      continue
    }
    out.push(line.replace(/[[\]{}]/g, (c) => (c === '[' ? '(' : c === ']' ? ')' : c)))
  }
  return out.join('\n')
}

function isHeading(line: string): string | null {
  const m = /^\s*[[(]?\s*((?:pre-?)?chorus|verse|bridge|intro|outro|refrain|coda|instrumental|interlude|solo|tag|ending|hook)(\s*\d+)?\s*[\])]?\s*:?\s*$/i.exec(
    line,
  )
  return m ? line.trim().replace(/^[[(]|[\])]:?$|:$/g, '') : null
}

function chordOnlyLine(chords: string): string {
  return chords.replace(/(\S+)/g, (tok) => (/^[|%:]+$/.test(tok) ? tok : `[${tok}]`))
}

function mergeChordLine(chords: string, lyrics: string): string {
  const positions: { at: number; chord: string }[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(chords))) {
    if (/^[|%:]+$/.test(m[0])) continue
    positions.push({ at: m.index, chord: m[0] })
  }
  let text = lyrics.padEnd(positions.length ? positions[positions.length - 1].at : 0, ' ')
  for (let k = positions.length - 1; k >= 0; k--) {
    const { at, chord } = positions[k]
    text = text.slice(0, at) + `[${chord}]` + text.slice(at)
  }
  return text.replace(/\s+$/, '')
}

export function metaFirst(song: ChordProSong, key: string): string | undefined {
  return song.meta[key]?.[0]
}
