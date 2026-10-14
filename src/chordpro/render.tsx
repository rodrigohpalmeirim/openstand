import type { CSSProperties, ReactNode } from 'react'
import { formatChord, nashville, parseChord, transposeChord, transposeKey, type Accidental, type NoteNaming } from '../music/chords'
import { metaFirst, type ChordProSong, type Line, type Section } from './parse'

export interface TextStyle {
  fontFamily: 'sans' | 'serif' | 'mono'
  /** Lyrics font size in px at zoom 1. */
  fontSize: number
  /** Chord size relative to lyrics. */
  chordScale: number
  chordColor: string
  chordBold: boolean
  lyricsColor: string
  titleColor: string
  commentColor: string
  /** How a chorus is highlighted. */
  chorusStyle: 'bar' | 'background' | 'indent' | 'none'
  chorusColor: string
  lineSpacing: number
  showChords: boolean
  showMeta: boolean
  /** Render choruses again where {chorus} references appear. */
  expandChorusRefs: boolean
  /** Lyrics-only view (hide chord lines entirely). */
  lyricsOnly: boolean
  naming: NoteNaming
  /** Display chords as Nashville numbers relative to the song key. */
  nashville: boolean
  /** Spelling of transposed chords. */
  accidental: Accidental | 'auto'
  /** Show chords inline "[G]word" instead of above. */
  inlineChords: boolean
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'sans',
  fontSize: 20,
  chordScale: 0.9,
  chordColor: '#c2410c',
  chordBold: true,
  lyricsColor: '#1b1a18',
  titleColor: '#1b1a18',
  commentColor: '#6a6760',
  chorusStyle: 'bar',
  chorusColor: '#c2410c',
  lineSpacing: 1.15,
  showChords: true,
  showMeta: true,
  expandChorusRefs: true,
  lyricsOnly: false,
  naming: 'english',
  nashville: false,
  accidental: 'auto',
  inlineChords: false,
}

export interface RenderOpts {
  style: TextStyle
  transpose: number
  capo?: number
  /** Key to use for nashville numbers / accidentals; taken from the song when omitted. */
  key?: string
}

const FONT: Record<TextStyle['fontFamily'], string> = {
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
}

export function displayChord(chord: string, song: ChordProSong, opts: RenderOpts): string {
  const { style } = opts
  const songKey = opts.key ?? metaFirst(song, 'key')
  const semis = opts.transpose + song.transpose - (opts.capo ?? 0)
  const targetKey = songKey ? transposeKey(songKey, semis) : undefined
  if (style.nashville && songKey) return nashville(chord, songKey)
  const prefer = style.accidental === 'auto' ? undefined : style.accidental
  if (!semis && style.naming === 'english' && !prefer) return chord
  if (!semis && prefer) {
    const c = parseChord(chord)
    return c ? formatChord(c, prefer, style.naming) : chord
  }
  return transposeChord(chord, semis, { prefer, targetKey, outNaming: style.naming })
}

/** One measurable block (keeps lines of a section together where possible). */
export interface Block {
  key: string
  node: ReactNode
  breakBefore?: 'column' | 'page'
  /** Section header blocks should stay with the next block. */
  keepWithNext?: boolean
}

function LyricsLine({ line, song, opts }: { line: Extract<Line, { type: 'lyrics' }>; song: ChordProSong; opts: RenderOpts }) {
  const { style } = opts
  const hasChords = style.showChords && !style.lyricsOnly && line.segments.some((s) => s.chord)
  const chordStyle: CSSProperties = {
    color: style.chordColor,
    fontWeight: style.chordBold ? 700 : 500,
    fontSize: `${style.chordScale}em`,
  }
  if (style.inlineChords && hasChords) {
    return (
      <div className="whitespace-pre-wrap">
        {line.segments.map((s, i) => (
          <span key={i}>
            {s.chord && <span style={chordStyle}>[{displayChord(s.chord, song, opts)}]</span>}
            {s.text}
          </span>
        ))}
      </div>
    )
  }
  if (!hasChords) {
    const text = line.segments.map((s) => s.text).join('')
    if (!text.trim()) return null
    return <div className="whitespace-pre-wrap">{text}</div>
  }
  return (
    <div className="flex flex-wrap items-end">
      {line.segments.map((s, i) => {
        const chord = s.chord ? displayChord(s.chord, song, opts) : ''
        // Words split across chord positions stay visually joined; a trailing space keeps chords apart.
        const text = s.text || (chord ? ' ' : '')
        return (
          <span key={i} className="inline-flex flex-col">
            <span style={chordStyle} className="min-h-[1.2em] whitespace-pre pr-[0.35em] leading-tight">
              {chord}
            </span>
            <span className="whitespace-pre">{text}</span>
          </span>
        )
      })}
    </div>
  )
}

function renderLine(line: Line, i: number, song: ChordProSong, opts: RenderOpts): ReactNode {
  const { style } = opts
  switch (line.type) {
    case 'lyrics':
      return <LyricsLine key={i} line={line} song={song} opts={opts} />
    case 'comment':
      return (
        <div
          key={i}
          className={
            line.style === 'box'
              ? 'my-1 inline-block rounded border px-2 py-0.5'
              : line.style === 'italic'
                ? 'italic'
                : 'my-0.5 inline-block rounded px-1.5 font-semibold'
          }
          style={{
            color: style.commentColor,
            borderColor: style.commentColor,
            background: line.style === 'normal' ? 'color-mix(in srgb, currentColor 10%, transparent)' : undefined,
          }}
        >
          {line.text}
        </div>
      )
    case 'tab':
    case 'grid':
      return (
        <div key={i} className="whitespace-pre font-mono text-[0.85em]">
          {line.text || ' '}
        </div>
      )
    case 'empty':
      return <div key={i} className="h-[0.7em]" />
    case 'chorusRef':
      return (
        <div key={i} className="font-semibold italic" style={{ color: style.commentColor }}>
          {line.label || 'Chorus'}
        </div>
      )
    case 'image':
      return null
  }
}

const SECTION_LABEL: Record<string, string> = { chorus: 'Chorus', bridge: 'Bridge', tab: 'Tab', grid: 'Grid' }

function SectionView({ section, song, opts }: { section: Section; song: ChordProSong; opts: RenderOpts }) {
  const { style } = opts
  const isChorus = section.kind === 'chorus'
  const label = section.label ?? (section.kind !== 'verse' && section.kind !== 'none' ? SECTION_LABEL[section.kind] : undefined)
  const chorusCss: CSSProperties = isChorus
    ? style.chorusStyle === 'bar'
      ? { borderLeft: `3px solid ${style.chorusColor}`, paddingLeft: '0.75em' }
      : style.chorusStyle === 'background'
        ? { background: `color-mix(in srgb, ${style.chorusColor} 10%, transparent)`, padding: '0.25em 0.6em', borderRadius: 6 }
        : style.chorusStyle === 'indent'
          ? { paddingLeft: '1.5em' }
          : {}
    : {}
  return (
    <div style={chorusCss} className="py-[0.15em]">
      {label && (
        <div className="mb-0.5 text-[0.8em] font-bold uppercase tracking-wider" style={{ color: style.commentColor }}>
          {label}
        </div>
      )}
      {section.lines.map((l, i) => {
        if (l.type === 'chorusRef' && style.expandChorusRefs) {
          const chorus = findChorus(song, l.label)
          if (chorus) return <SectionView key={i} section={{ ...chorus, label: chorus.label ?? l.label ?? 'Chorus' }} song={song} opts={opts} />
        }
        return renderLine(l, i, song, opts)
      })}
    </div>
  )
}

function findChorus(song: ChordProSong, label?: string): Section | undefined {
  const choruses = song.sections.filter((s) => s.kind === 'chorus')
  if (label) return choruses.find((c) => c.label === label) ?? choruses.at(-1)
  return choruses.at(-1)
}

export function Header({ song, opts }: { song: ChordProSong; opts: RenderOpts }) {
  const { style } = opts
  const title = metaFirst(song, 'title')
  const subtitle = song.meta.subtitle?.join(' · ')
  const key = metaFirst(song, 'key')
  const semis = opts.transpose + song.transpose
  const shownKey = key ? transposeKey(key, semis) : undefined
  const bits = [
    song.meta.artist?.join(', '),
    song.meta.composer?.length ? `Music: ${song.meta.composer.join(', ')}` : undefined,
    song.meta.lyricist?.length ? `Lyrics: ${song.meta.lyricist.join(', ')}` : undefined,
  ].filter(Boolean)
  const facts = [
    shownKey && `Key ${shownKey}${semis ? ` (orig. ${key})` : ''}`,
    (opts.capo ?? Number(metaFirst(song, 'capo'))) ? `Capo ${opts.capo ?? metaFirst(song, 'capo')}` : undefined,
    metaFirst(song, 'tempo') && `${metaFirst(song, 'tempo')} BPM`,
    metaFirst(song, 'time'),
  ].filter(Boolean)
  return (
    <div className="mb-[0.8em]">
      {title && (
        <div className="text-[1.6em] font-bold leading-tight" style={{ color: style.titleColor }}>
          {title}
        </div>
      )}
      {subtitle && <div className="text-[1.05em]" style={{ color: style.commentColor }}>{subtitle}</div>}
      {style.showMeta && (bits.length > 0 || facts.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-x-4 text-[0.8em]" style={{ color: style.commentColor }}>
          {bits.map((b, i) => (
            <span key={i}>{b}</span>
          ))}
          {facts.map((b, i) => (
            <span key={'f' + i} className="font-semibold">
              {b}
            </span>
          ))}
        </div>
      )}
      {song.meta.copyright && <div className="mt-1 text-[0.7em]" style={{ color: style.commentColor }}>© {song.meta.copyright[0]}</div>}
    </div>
  )
}

/** Turn a parsed song into a list of blocks for pagination. */
export function songBlocks(song: ChordProSong, opts: RenderOpts): Block[] {
  const blocks: Block[] = [{ key: 'header', node: <Header song={song} opts={opts} /> }]
  song.sections.forEach((section, si) => {
    // Long sections are split into chunks of lines so pagination can break inside them;
    // short sections stay whole.
    const lines = section.lines
    const chunk = lines.length > 8 ? 4 : lines.length || 1
    for (let i = 0; i < Math.max(1, lines.length); i += chunk) {
      const part: Section = { ...section, lines: lines.slice(i, i + chunk), label: i === 0 ? section.label : undefined }
      blocks.push({
        key: `${si}:${i}`,
        breakBefore: i === 0 ? section.breakBefore : undefined,
        node: <SectionView section={part} song={song} opts={opts} />,
      })
    }
    blocks.push({ key: `${si}:gap`, node: <div className="h-[0.6em]" /> })
  })
  return blocks
}

export function textContainerStyle(style: TextStyle, zoom = 1): CSSProperties {
  return {
    fontFamily: FONT[style.fontFamily],
    fontSize: style.fontSize * zoom,
    lineHeight: style.lineSpacing,
    color: style.lyricsColor,
  }
}
