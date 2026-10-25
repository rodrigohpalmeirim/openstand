/**
 * ChordPro parser (ChordPro 6 directive set incl. aliases, selectors, attributes, %{meta}
 * substitution, ABC/SVG/textblock environments) and plain-text chord sheet converter.
 */
import { formatKey, isChordLine, isChordToken, lineTokens, makeTransposer, type NoteNaming } from '../music/chords'
import { parseDefine, type ChordDefinition } from '../music/diagrams'
import { hasMarkup, parseMarkup, stripMarkup, type Run, type TagStack } from './markup'

export type { ChordDefinition } from '../music/diagrams'

export interface ChordSegment {
  chord?: string
  text: string
  /** Styled runs when the text contains inline markup (text holds the plain version). */
  runs?: Run[]
}

export type GridCell =
  | { kind: 'bar'; text: string }
  | { kind: 'chord'; chords: string[] }
  | { kind: 'mark'; text: string }

export type Line =
  | { type: 'lyrics'; segments: ChordSegment[] }
  | { type: 'comment'; text: string; style: 'normal' | 'italic' | 'box' }
  | { type: 'tab'; text: string }
  | { type: 'grid'; text: string; cells?: GridCell[]; left?: string; right?: string }
  | { type: 'empty' }
  /** {chorus}: `target` is the index (in song.sections) of the chorus to repeat. */
  | { type: 'chorusRef'; label?: string; target?: number }
  | { type: 'image'; src: string; width?: number; height?: number; scale?: number; align?: string }
  | { type: 'abc'; source: string }
  | { type: 'svg'; source: string }
  /** {chord: X} shows a chord diagram inline. */
  | { type: 'diagram'; chord: string }
  /** Textblock line (markup allowed, no chords). */
  | { type: 'text'; text: string }

export type SectionKind = 'verse' | 'chorus' | 'bridge' | 'tab' | 'grid' | 'abc' | 'svg' | 'textblock' | 'none' | 'other'

export interface Section {
  kind: SectionKind
  label?: string
  lines: Line[]
  /** A column/page break placed before this section. */
  breakBefore?: 'column' | 'page'
  attrs?: Record<string, string>
}

export type FormatTarget = 'title' | 'subtitle' | 'text' | 'chord' | 'chorus' | 'comment' | 'tab' | 'grid' | 'footer' | 'label'

export interface ChordProSong {
  meta: Record<string, string[]>
  sections: Section[]
  defines: ChordDefinition[]
  /** {transpose: n} directive in the file. */
  transpose: number
  columns?: number
  /** {meta: notation <source> [<display>]} */
  notation?: { source?: NoteNaming; display?: NoteNaming }
  /** Font/size/colour directives ({textsize}, {chordcolour}…). Values are raw; the renderer validates. */
  format: Partial<Record<FormatTarget, { font?: string; size?: string; color?: string }>>
  /** {diagrams: off} in the file. */
  diagrams?: boolean
}

export interface ParseOptions {
  /** Instrument for conditional selectors ({title-guitar: …}). */
  instrument?: string
  /** Optional user name, also accepted as a selector. */
  user?: string
  /** Semitones the song is shown transposed by, so %{key} gives the key actually played. */
  transpose?: number
  /** Note names the file's chords are written in (overridden by {meta: notation …}). */
  naming?: NoteNaming
}

const ALIASES: Record<string, string> = {
  t: 'title',
  st: 'subtitle',
  su: 'subtitle',
  a: 'album',
  c: 'comment',
  gc: 'comment',
  guitar_comment: 'comment',
  highlight: 'comment',
  x_comment: 'comment',
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
  soa: 'start_of_abc',
  eoa: 'end_of_abc',
  sos: 'start_of_svg',
  eos: 'end_of_svg',
  sop: 'start_of_part',
  eop: 'end_of_part',
  sotb: 'start_of_textblock',
  eotb: 'end_of_textblock',
  np: 'new_page',
  npp: 'new_physical_page',
  colb: 'column_break',
  col: 'columns',
  ns: 'new_song',
  flow: 'structure',
  book: 'album',
}

/** Directives that become song metadata. */
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
  'sorttitle',
  'genre',
  'keywords',
  'source',
  'structure',
  'footer',
])

const NOTATIONS: Record<string, NoteNaming> = {
  default: 'english',
  common: 'english',
  english: 'english',
  cestina: 'czech',
  czech: 'czech',
  deutsch: 'german',
  german: 'german',
  scandinavian: 'scandinavian',
  dutch: 'scandinavian',
  latin: 'latin',
  solfege: 'latin',
  nashville: 'nashville',
}

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

/**
 * Group a lyric line into pieces that must stay on one row when it wraps: line breaks are only
 * allowed after whitespace, so a chord stays glued to the word (or word part) under it.
 */
export function lyricGroups(segments: ChordSegment[]): ChordSegment[][] {
  const groups: ChordSegment[][] = []
  let cur: ChordSegment[] = []
  let breakAfter = false
  const add = (p: ChordSegment) => {
    if (breakAfter && cur.length) {
      groups.push(cur)
      cur = []
    }
    cur.push(p)
    // A chord over no text is shown with a space after it.
    breakAfter = /\s$/.test(p.text) || (!p.text && !!p.chord)
  }
  const splitWords = (t: string) => t.split(/(?<=\s)(?=\S)/)
  for (const seg of segments) {
    let parts: ChordSegment[]
    if (seg.runs) {
      parts = []
      let runs: Run[] = []
      let endsWs = false
      for (const r of seg.runs)
        splitWords(r.text).forEach((t, i) => {
          if ((i > 0 || (endsWs && /^\S/.test(t))) && runs.length) {
            parts.push({ text: runs.map((x) => x.text).join(''), runs })
            runs = []
          }
          runs.push({ text: t, style: r.style })
          if (t) endsWs = /\s$/.test(t)
        })
      if (runs.length) parts.push({ text: runs.map((x) => x.text).join(''), runs })
    } else parts = splitWords(seg.text).map((text) => ({ text }))
    // Leading spaces belong with the first word (the chord sits over them).
    if (parts.length > 1 && !parts[0].text.trim()) {
      const [a, b] = parts.splice(0, 2)
      parts.unshift({ text: a.text + b.text, runs: a.runs && b.runs ? [...a.runs, ...b.runs] : undefined })
    }
    parts.forEach((p, i) => add({ ...p, chord: i === 0 ? seg.chord : undefined }))
  }
  if (cur.length) groups.push(cur)
  return groups
}

/** Split a directive value into key="value" attributes and the remaining plain text. */
export function parseAttrs(value: string): { attrs: Record<string, string>; rest: string } {
  const attrs: Record<string, string> = {}
  const rest = value.replace(/(^|\s)([a-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gi, (_, sp: string, k: string, a?: string, b?: string, c?: string) => {
    attrs[k.toLowerCase()] = a ?? b ?? c ?? ''
    return sp
  })
  return { attrs, rest: rest.trim() }
}

/**
 * %{name} metadata substitution, with the conditional forms %{name|present|absent} and
 * %{name=value|match|nomatch}; %{} inside a branch stands for the value itself.
 */
export function substituteMeta(input: string, lookup: (name: string) => string | undefined, self?: string): string {
  let out = ''
  let i = 0
  while (i < input.length) {
    const start = input.indexOf('%{', i)
    if (start < 0) {
      out += input.slice(i)
      break
    }
    out += input.slice(i, start)
    // Find the matching close brace and top-level '|' separators.
    let depth = 0
    let j = start + 2
    const bars: number[] = []
    for (; j < input.length; j++) {
      if (input.startsWith('%{', j)) {
        depth++
        j++
      } else if (input[j] === '}') {
        if (depth === 0) break
        depth--
      } else if (input[j] === '|' && depth === 0) bars.push(j)
    }
    if (j >= input.length) {
      out += input.slice(start)
      break
    }
    const body = input.slice(start + 2, j)
    const parts: string[] = []
    let p = start + 2
    for (const b of bars) {
      parts.push(input.slice(p, b))
      p = b + 1
    }
    parts.push(input.slice(p, j))
    const head = parts[0].trim()
    if (!body.trim()) out += self ?? ''
    else {
      const eq = head.indexOf('=')
      const name = (eq >= 0 ? head.slice(0, eq) : head).trim().toLowerCase()
      const value = lookup(name)
      if (parts.length === 1) out += value ?? ''
      else {
        const hit = eq >= 0 ? value === head.slice(eq + 1).trim() : !!value
        const branch = hit ? parts[1] : (parts[2] ?? '')
        out += substituteMeta(branch, lookup, value)
      }
    }
    i = j + 1
  }
  return out
}

/** Does a selector suffix ({name-selector}) apply to this instrument/user? */
export function selectorMatches(selector: string, opts: ParseOptions): boolean {
  let sel = selector.toLowerCase()
  let negate = false
  if (sel.endsWith('!')) {
    negate = true
    sel = sel.slice(0, -1)
  } else if (sel.startsWith('!')) {
    negate = true
    sel = sel.slice(1)
  }
  const inst = (opts.instrument ?? 'guitar').toLowerCase()
  const insts = inst === 'piano' || inst === 'keyboard' ? ['piano', 'keyboard', 'keys'] : [inst]
  const hit = insts.includes(sel) || (!!opts.user && sel === opts.user.toLowerCase())
  return negate ? !hit : hit
}

const BAR_RE = /^(\|\||\|\.|\|:|:\|:|:\||\||\|\d+|\[\d+)$/

/** Tokenise a {start_of_grid} line into bars, chords and marks, with margin text before/after. */
export function parseGridLine(text: string): Pick<Extract<Line, { type: 'grid' }>, 'cells' | 'left' | 'right'> {
  const toks = lineTokens(text).map((t) => t.text)
  const first = toks.findIndex((t) => BAR_RE.test(t))
  let last = -1
  toks.forEach((t, i) => BAR_RE.test(t) && (last = i))
  if (first < 0) return { cells: undefined }
  const cells: GridCell[] = toks.slice(first, last + 1).map((t) =>
    BAR_RE.test(t)
      ? { kind: 'bar', text: t }
      : /^(\.|\/|%|%%|>|-)$/.test(t)
        ? { kind: 'mark', text: t }
        : { kind: 'chord', chords: t.split('~') },
  )
  const left = toks.slice(0, first).join(' ') || undefined
  const right = toks.slice(last + 1).join(' ') || undefined
  return { cells, left, right }
}

const FORMAT_RE = /^(title|subtitle|text|chord|chorus|comment|tab|grid|footer|label)(font|size|colou?r)$/

export function parseChordPro(src: string, opts: ParseOptions = {}): ChordProSong {
  const song: ChordProSong = { meta: {}, sections: [], defines: [], transpose: 0, format: {} }
  let current: Section = { kind: 'none', lines: [] }
  let pendingBreak: Section['breakBefore']
  let verbatim: string[] = []
  let skipUntil: string | null = null
  let markupStack: TagStack = []

  const push = () => {
    if (current.kind === 'abc' || current.kind === 'svg') {
      const source = verbatim.join('\n')
      if (source.trim()) current.lines.push(current.kind === 'abc' ? { type: 'abc', source } : { type: 'svg', source })
      verbatim = []
    }
    if (current.lines.length || current.kind !== 'none') song.sections.push(current)
  }
  const open = (kind: SectionKind, label?: string, attrs?: Record<string, string>) => {
    // An empty implicit section only carries a pending break; hand it to the new section.
    const carried = current.kind === 'none' && !current.lines.length ? current.breakBefore : undefined
    push()
    current = { kind, label, lines: [], breakBefore: pendingBreak ?? carried, attrs }
    pendingBreak = undefined
    markupStack = []
  }
  const close = () => {
    push()
    current = { kind: 'none', lines: [], breakBefore: pendingBreak }
    pendingBreak = undefined
    markupStack = []
  }
  const addMeta = (k: string, v: string) => {
    ;(song.meta[k] ??= []).push(v)
  }
  const lines = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  // %{name} may refer to metadata set further down ({subtitle: by %{artist}} before {artist}), so
  // collect the plain metadata directives up front.
  const ahead: Record<string, string[]> = {}
  let aheadTranspose = 0
  for (const l of lines) {
    const m = /^\s*\{\s*([A-Za-z_]\w*)\s*(?:[:\s]\s*(.*?))?\s*\}\s*$/.exec(l)
    if (!m) continue
    let k = ALIASES[m[1].toLowerCase()] ?? m[1].toLowerCase()
    let v = m[2] ?? ''
    if (k === 'meta') {
      const mm = /^(\S+)\s*(.*)$/.exec(v)
      if (!mm) continue
      k = ALIASES[mm[1].toLowerCase()] ?? mm[1].toLowerCase()
      v = mm[2]
    }
    if (META_KEYS.has(k)) (ahead[k] ??= []).push(v)
    else if (k === 'transpose') aheadTranspose = Number(v) || 0
  }
  const lookup = (name: string) => {
    if (name === 'instrument' || name === 'instrument.type') return opts.instrument ?? 'guitar'
    if (name === 'user' || name === 'user.name') return opts.user
    const v = song.meta[name]?.length ? song.meta[name] : ahead[name]
    if (!v?.length) return undefined
    const semis = (opts.transpose ?? 0) + aheadTranspose
    if (name === 'key' && semis) {
      const naming = song.notation?.source ?? opts.naming ?? 'english'
      const k = makeTransposer({ key: v[0], semitones: semis, naming }).key
      if (k) return formatKey(k, naming)
    }
    return v.join(', ')
  }

  const directive = (name: string, value: string) => {
    switch (name) {
      case 'comment':
        current.lines.push({ type: 'comment', text: value, style: 'normal' })
        return
      case 'comment_italic':
        current.lines.push({ type: 'comment', text: value, style: 'italic' })
        return
      case 'comment_box':
        current.lines.push({ type: 'comment', text: value, style: 'box' })
        return
      case 'chorus': {
        const label = parseAttrs(value).attrs.label ?? (value || undefined)
        const choruses = song.sections.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'chorus')
        const target = (label ? choruses.filter((x) => x.s.label === label).at(-1) : undefined) ?? choruses.at(-1)
        current.lines.push({ type: 'chorusRef', label, target: target?.i })
        return
      }
      case 'new_page':
      case 'new_physical_page':
      case 'new_song':
        pendingBreak = 'page'
        close()
        return
      case 'column_break':
        pendingBreak = 'column'
        close()
        return
      case 'columns':
        song.columns = Math.max(1, Math.min(4, Number(value) || 1))
        return
      case 'define':
        song.defines.push(parseDefine(value))
        return
      case 'chord': {
        const d = parseDefine(value)
        if (d.frets || d.keys || d.copy) song.defines.push(d)
        if (d.name) current.lines.push({ type: 'diagram', chord: d.name })
        return
      }
      case 'transpose':
        song.transpose = Number(value) || 0
        return
      case 'image': {
        const { attrs, rest } = parseAttrs(value)
        const num = (v?: string) => (v && Number.isFinite(parseFloat(v)) ? parseFloat(v) : undefined)
        current.lines.push({
          type: 'image',
          src: attrs.src ?? rest,
          width: num(attrs.width),
          height: num(attrs.height),
          scale: num(attrs.scale),
          align: attrs.align,
        })
        return
      }
      case 'diagrams':
        song.diagrams = !/^(off|false|0|no)$/i.test(value)
        return
      case 'capo': {
        const n = Number(value)
        if (Number.isInteger(n) && n >= 0 && n <= 20) addMeta('capo', String(n))
        return
      }
      case 'meta': {
        const mm = /^(\S+)\s*(.*)$/.exec(value)
        if (!mm) return
        const key = mm[1].toLowerCase()
        if (key === 'notation') {
          const [s, d] = mm[2].trim().toLowerCase().split(/\s+/)
          song.notation = { source: NOTATIONS[s], display: d ? NOTATIONS[d] : undefined }
          return
        }
        const real = ALIASES[key] ?? key
        if (META_KEYS.has(real) || real === 'capo') directive(real, mm[2])
        else addMeta(key, mm[2])
        return
      }
    }
    const fm = FORMAT_RE.exec(name)
    if (fm) {
      const prop = fm[2].startsWith('colo') ? 'color' : (fm[2] as 'font' | 'size')
      ;(song.format[fm[1] as FormatTarget] ??= {})[prop] = value
      return
    }
    if (META_KEYS.has(name)) addMeta(name, value)
    // Unknown directives (x_*, pagetype, grid…) are ignored on purpose.
  }

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li].replace(/\s+$/, '')
    const raw = current.kind === 'abc' || current.kind === 'svg'
    // Line continuation (not inside ABC, where "\" has its own meaning).
    if (!raw) while (line.endsWith('\\') && li + 1 < lines.length) line = line.slice(0, -1) + lines[++li].replace(/^\s+/, '').replace(/\s+$/, '')
    const dm = /^\s*\{\s*([A-Za-z_][\w!-]*)\s*(?:[:\s]\s*(.*?))?\s*\}\s*$/.exec(line)
    let name = ''
    let selector: string | undefined
    if (dm) {
      const full = dm[1].toLowerCase()
      const dash = full.indexOf('-')
      name = dash >= 0 ? full.slice(0, dash) : full
      selector = dash >= 0 ? full.slice(dash + 1) : undefined
      name = (ALIASES[name] ?? name).replace(/colour$/, 'color')
    }
    // Skipping a section whose selector did not match.
    if (skipUntil) {
      if (dm && name === 'end_of_' + skipUntil) skipUntil = null
      continue
    }
    const isEnv = dm && (name.startsWith('start_of_') || name.startsWith('end_of_'))
    if (raw && !(isEnv && name.startsWith('end_of_'))) {
      verbatim.push(lines[li])
      continue
    }
    const inVerbatim = current.kind === 'tab' || current.kind === 'grid' || current.kind === 'textblock'
    if (dm) {
      if (selector && !selectorMatches(selector, opts)) {
        if (name.startsWith('start_of_')) skipUntil = name.slice(9)
        continue
      }
      const value = substituteMeta((dm[2] ?? '').trim(), lookup)
      if (name.startsWith('start_of_')) {
        const k = name.slice(9)
        const known: SectionKind[] = ['chorus', 'verse', 'bridge', 'tab', 'grid', 'abc', 'svg', 'textblock']
        const kind: SectionKind = (known as string[]).includes(k) ? (k as SectionKind) : 'other'
        const { attrs, rest } = parseAttrs(value)
        let label: string | undefined = attrs.label ?? (rest || undefined)
        if (kind === 'grid' && label && /^[\d+x\s]+$/.test(label)) {
          attrs.shape = label
          label = undefined
        }
        if (kind === 'other' && !label && k !== 'part') label = k.replace(/_/g, ' ')
        open(kind, label, Object.keys(attrs).length ? attrs : undefined)
        continue
      }
      if (name.startsWith('end_of_')) {
        close()
        continue
      }
      if (inVerbatim && current.kind !== 'textblock') {
        current.lines.push({ type: current.kind === 'tab' ? 'tab' : 'grid', text: line })
        continue
      }
      directive(name, value)
      continue
    }
    line = line.replace(/\t/g, '    ')
    if (current.kind === 'tab') {
      current.lines.push({ type: 'tab', text: line })
      continue
    }
    if (current.kind === 'grid') {
      current.lines.push({ type: 'grid', text: line, ...parseGridLine(line) })
      continue
    }
    if (current.kind === 'textblock') {
      current.lines.push(line.trim() ? { type: 'text', text: line } : { type: 'empty' })
      continue
    }
    if (/^\s*#/.test(line)) continue // ChordPro comment line
    if (!line.trim()) {
      current.lines.push({ type: 'empty' })
      continue
    }
    const segments = parseLyricLine(line)
    if (hasMarkup(line) || markupStack.length) {
      for (const s of segments) {
        const r = parseMarkup(s.text, markupStack)
        markupStack = r.stack
        s.runs = r.runs
        s.text = r.runs.map((x) => x.text).join('')
      }
    }
    current.lines.push({ type: 'lyrics', segments: segments.filter((s) => s.chord !== undefined || s.text) })
  }
  push()
  // Trim leading/trailing empty lines in each section.
  for (const s of song.sections) {
    while (s.lines[0]?.type === 'empty') s.lines.shift()
    while (s.lines.at(-1)?.type === 'empty') s.lines.pop()
  }
  // Re-index chorus references after dropping empty sections.
  const keep = song.sections.map((s) => !!(s.lines.length || s.kind !== 'none' || s.breakBefore))
  const newIndex: number[] = []
  let n = 0
  keep.forEach((k, i) => (newIndex[i] = k ? n++ : -1))
  song.sections = song.sections.filter((_, i) => keep[i])
  for (const s of song.sections)
    for (const l of s.lines) if (l.type === 'chorusRef' && l.target !== undefined) l.target = newIndex[l.target] >= 0 ? newIndex[l.target] : undefined
  return song
}

/** Does this text look like ChordPro (directives or inline [chords])? */
export function looksLikeChordPro(src: string): boolean {
  return (
    /^\s*\{\s*(t|title|st|subtitle|soc|start_of_\w+|c|comment|ci|artist|key|define|capo|tempo|meta)\s*[:}\s]/im.test(src) ||
    /\[[A-H][^\]\s]{0,8}\][\p{L} ]/u.test(src)
  )
}

const NEUTRAL = /^(-+|\|+|\|[.:]|:\||:\|:|%+|\/|:|\.\.\.)$/
/** A line that only says "no chord". */
const NO_CHORD = /^\s*\(?N\.?C\.?\)?\s*$/

/**
 * Convert a plain-text "chords over lyrics" sheet into ChordPro, merging each chord line into the
 * lyric line beneath it. Lines like "Chorus:" or "[Verse 2]" become section labels via comments.
 */
export function textToChordPro(src: string, naming: NoteNaming = 'english'): string {
  const lines = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  const wrap = (tok: string) => (NEUTRAL.test(tok) ? tok : isChordToken(tok, naming) ? `[${tok.replace(/^\[|\]$/g, '')}]` : `[*${tok}]`)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, '    ').replace(/\s+$/, '')
    if (isChordLine(line, naming) || NO_CHORD.test(line)) {
      const next = lines[i + 1]?.replace(/\t/g, '    ').replace(/\s+$/, '')
      if (next !== undefined && next.trim() && !isChordLine(next, naming) && !NO_CHORD.test(next) && !isHeading(next) && !/^\s*#/.test(next)) {
        out.push(mergeChordLine(line, escapeLyrics(next), wrap))
        i++
      } else if (lineTokens(line).some((t) => BAR_RE.test(t.text))) {
        // A bar chart ("| E | B/D# | A |") becomes a grid so the bars stay between the chords.
        if (out.at(-1) === '{end_of_grid}') out.pop()
        else out.push('{start_of_grid label=""}')
        out.push(line.trim(), '{end_of_grid}')
      } else {
        out.push(line.replace(/\S+/g, wrap))
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
    out.push(/^\s*#/.test(line) ? line : escapeLyrics(line))
  }
  return out.join('\n')
}

const escapeLyrics = (line: string) => line.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')')).replace(/^(\s*)\{/, '$1(')

function isHeading(line: string): string | null {
  const m = /^\s*[[(]?\s*((?:pre-?)?chorus|verse|bridge|intro|outro|refrain|coda|instrumental|interlude|solo|tag|ending|hook)(\s*\d+)?\s*[\])]?\s*:?\s*$/i.exec(
    line,
  )
  return m ? line.trim().replace(/^[[(]|[\])]:?$|:$/g, '') : null
}

function mergeChordLine(chords: string, lyrics: string, wrap: (tok: string) => string): string {
  const positions: { at: number; chord: string }[] = []
  for (const { at, text } of lineTokens(chords)) {
    if (NEUTRAL.test(text)) continue
    positions.push({ at, chord: wrap(text) })
  }
  let text = lyrics.padEnd(positions.length ? positions[positions.length - 1].at : 0, ' ')
  for (let k = positions.length - 1; k >= 0; k--) {
    const { at, chord } = positions[k]
    text = text.slice(0, at) + chord + text.slice(at)
  }
  return text.replace(/\s+$/, '')
}

export function metaFirst(song: ChordProSong, key: string): string | undefined {
  return song.meta[key]?.[0]
}

/** Plain text of a markup string (titles/comments). */
export { stripMarkup }

/** First chord of the song (used as the key when no {key} is given). */
export function firstChord(song: ChordProSong): string | undefined {
  for (const s of song.sections)
    for (const l of s.lines) {
      if (l.type === 'lyrics') for (const seg of l.segments) if (seg.chord && !seg.chord.startsWith('*')) return seg.chord
      if (l.type === 'grid') for (const c of l.cells ?? []) if (c.kind === 'chord') return c.chords[0]
    }
  return undefined
}

/** All distinct chords used in the song, in order of appearance. */
export function songChords(song: ChordProSong): string[] {
  const seen = new Set<string>()
  const add = (c?: string) => {
    if (c && !c.startsWith('*')) seen.add(c)
  }
  for (const s of song.sections)
    for (const l of s.lines) {
      if (l.type === 'lyrics') l.segments.forEach((seg) => add(seg.chord))
      else if (l.type === 'grid') l.cells?.forEach((c) => c.kind === 'chord' && c.chords.forEach(add))
      else if (l.type === 'diagram') add(l.chord)
    }
  return [...seen]
}
