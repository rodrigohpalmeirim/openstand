import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { AbcBlock } from '../abc/AbcView'
import { formatKey, makeTransposer, nashville, parseKey } from '../music/chords'
import { ChordDiagram } from '../music/ChordDiagram'
import { lookupDiagram, type ChordDefinition, type Diagram, type Instrument } from '../music/diagrams'
import type { TextStyle } from './style'
import { ChordTapArea } from './ChordTap'
import { MarkupText, Runs, safeColor, safeSize } from './markup'
import { firstChord, metaFirst, songChords, type ChordProSong, type GridCell, type Line, type Section } from './parse'

export { DEFAULT_TEXT_STYLE, type TextStyle } from './style'

export interface RenderOpts {
  style: TextStyle
  transpose: number
  /** Capo: chords are shown as shapes (transposed down by the capo). */
  capo?: number
  /** Key to use for nashville numbers / spelling; taken from the song ({key} or first chord) when omitted. */
  key?: string
}

const FONT: Record<TextStyle['fontFamily'], string> = {
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
}

/* ---------------------------------------------------------- chord context */

/** Everything needed to display the chords of one song with the current options. */
export interface ChordCtx {
  /** Display text for a chord as written in the file. */
  display: (chord: string) => string
  /** English name after transposition/capo (dictionary lookups). */
  lookupName: (chord: string) => string
  /** Original key as written (or the first chord). */
  originalKey?: string
  /** Sounding key after transposition. */
  soundKey?: string
  /** Key of the shapes when a capo is used. */
  shapeKey?: string
  capo: number
  /** Total semitones applied to the sounding key. */
  semitones: number
  defines: ChordDefinition[]
  instrument: Instrument
}

export function chordContext(song: ChordProSong, opts: RenderOpts): ChordCtx {
  const { style } = opts
  const src = song.notation?.source ?? style.sourceNaming ?? 'english'
  const out = song.notation?.display ?? style.naming
  const keyText = opts.key ?? metaFirst(song, 'key') ?? firstChord(song)
  const capo = Math.max(0, opts.capo ?? 0)
  const semis = opts.transpose + song.transpose
  const base = {
    key: keyText,
    naming: src,
    prefer: style.accidental === 'auto' ? undefined : style.accidental,
    allowDouble: style.allowDouble,
    allowUncommon: style.allowUncommon,
  }
  const shown = makeTransposer({ ...base, semitones: semis - capo, outNaming: out === 'nashville' ? 'english' : out })
  const eng = makeTransposer({ ...base, semitones: semis - capo, outNaming: 'english' })
  const sound = makeTransposer({ ...base, semitones: semis })
  const nash = (style.nashville || out === 'nashville') && !!keyText
  const keyName = (k?: ReturnType<typeof parseKey>) => (k ? formatKey(k, out === 'nashville' ? 'english' : out) : undefined)
  return {
    display: (c) => (c.startsWith('*') ? c.slice(1) : nash ? nashville(c, keyText!, src) : shown.chord(c)),
    lookupName: (c) => eng.chord(c),
    originalKey: keyText ? keyName(parseKey(keyText, src)) : undefined,
    soundKey: keyName(sound.key),
    shapeKey: capo ? keyName(shown.key) : undefined,
    capo,
    semitones: semis,
    defines: song.defines,
    instrument: style.instrument,
  }
}

/** Diagrams for every chord used in the song (after transposition/capo). */
export function songDiagrams(song: ChordProSong, ctx: ChordCtx): { label: string; diagram: Diagram | null }[] {
  const seen = new Set<string>()
  const out: { label: string; diagram: Diagram | null }[] = []
  for (const c of songChords(song)) {
    const name = ctx.lookupName(c)
    if (seen.has(name)) continue
    seen.add(name)
    // {define}s refer to chords as written, so only use them while untransposed.
    const defs = name === c ? ctx.defines : []
    const d = lookupDiagram(name, ctx.instrument, defs)
    if (d || /^[A-G]/.test(name)) out.push({ label: ctx.display(c), diagram: d })
  }
  return out
}

/** Legacy helper. */
export function displayChord(chord: string, song: ChordProSong, opts: RenderOpts): string {
  return chordContext(song, opts).display(chord)
}

/* -------------------------------------------------------- format directives */

const FAMILY = (v?: string): TextStyle['fontFamily'] | undefined => {
  const t = v?.toLowerCase() ?? ''
  if (/mono|courier/.test(t)) return 'mono'
  if (/serif|times|georgia/.test(t) && !/sans/.test(t)) return 'serif'
  if (/sans|helvetica|arial|roboto/.test(t)) return 'sans'
  return undefined
}

/** Apply a file's {textsize}/{chordcolour}/… directives to the display style. */
export function effectiveStyle(style: TextStyle, song: ChordProSong): TextStyle {
  if (!style.formatDirectives) return style
  const f = song.format
  const s = { ...style }
  const textPt = parseFloat(f.text?.size ?? '') || 0
  if (textPt > 4 && textPt < 72) s.fontSize = (style.fontSize * textPt) / 12
  const chordPt = parseFloat(f.chord?.size ?? '') || 0
  if (chordPt > 4 && chordPt < 72) s.chordScale = Math.max(0.5, Math.min(2, chordPt / (textPt || 12)))
  s.lyricsColor = safeColor(f.text?.color) ?? s.lyricsColor
  s.chordColor = safeColor(f.chord?.color) ?? s.chordColor
  s.titleColor = safeColor(f.title?.color) ?? s.titleColor
  s.commentColor = safeColor(f.comment?.color) ?? s.commentColor
  s.chorusColor = safeColor(f.chorus?.color) ?? s.chorusColor
  s.fontFamily = FAMILY(f.text?.font) ?? s.fontFamily
  return s
}

/** Extra CSS for elements whose directives are not part of TextStyle. */
function targetCss(song: ChordProSong, style: TextStyle, target: 'tab' | 'grid' | 'label' | 'footer' | 'title' | 'subtitle' | 'chorus'): CSSProperties {
  if (!style.formatDirectives) return {}
  const f = song.format[target]
  if (!f) return {}
  const textPt = parseFloat(song.format.text?.size ?? '') || 12
  const fam = FAMILY(f.font)
  return {
    color: safeColor(f.color),
    fontSize: f.size ? safeSize(f.size, textPt) : undefined,
    fontFamily: fam ? FONT[fam] : undefined,
  }
}

/* ------------------------------------------------------------- components */

/** One measurable block (keeps lines of a section together where possible). */
export interface Block {
  key: string
  node: ReactNode
  breakBefore?: 'column' | 'page'
  /** Section header blocks should stay with the next block. */
  keepWithNext?: boolean
}

interface Ctx {
  song: ChordProSong
  opts: RenderOpts
  chords: ChordCtx
}

function chordCss(style: TextStyle): CSSProperties {
  return { color: style.chordColor, fontWeight: style.chordBold ? 700 : 500, fontSize: `${style.chordScale}em` }
}

function ChordName({ chord, ctx }: { chord: string; ctx: Ctx }) {
  const label = ctx.chords.display(chord)
  if (chord.startsWith('*')) return <span style={{ fontStyle: 'italic' }}>{label}</span>
  return <span data-chord={ctx.chords.lookupName(chord)} data-label={label}>{label}</span>
}

function SegText({ seg }: { seg: { text: string; runs?: import('./markup').Run[] } }) {
  return seg.runs ? <Runs runs={seg.runs} /> : <>{seg.text}</>
}

function LyricsLine({ line, ctx }: { line: Extract<Line, { type: 'lyrics' }>; ctx: Ctx }) {
  const { style } = ctx.opts
  const hasChords = style.showChords && !style.lyricsOnly && line.segments.some((s) => s.chord)
  const cs = chordCss(style)
  if (style.inlineChords && hasChords) {
    return (
      <div className="whitespace-pre-wrap">
        {line.segments.map((s, i) => (
          <span key={i}>
            {s.chord && (
              <span style={cs}>
                [<ChordName chord={s.chord} ctx={ctx} />]
              </span>
            )}
            <SegText seg={s} />
          </span>
        ))}
      </div>
    )
  }
  if (!hasChords) {
    if (!line.segments.some((s) => s.text.trim())) return null
    return (
      <div className="whitespace-pre-wrap">
        {line.segments.map((s, i) => (
          <SegText key={i} seg={s} />
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-end">
      {line.segments.map((s, i) => {
        // Words split across chord positions stay visually joined; a trailing space keeps chords apart.
        const text = s.text || (s.chord ? ' ' : '')
        return (
          <span key={i} className="inline-flex flex-col">
            <span style={cs} className="min-h-[1.2em] whitespace-pre pr-[0.35em] leading-tight">
              {s.chord ? <ChordName chord={s.chord} ctx={ctx} /> : ''}
            </span>
            <span className="whitespace-pre">{s.runs ? <Runs runs={s.runs} /> : text}</span>
          </span>
        )
      })}
    </div>
  )
}

function GridLine({ line, ctx }: { line: Extract<Line, { type: 'grid' }>; ctx: Ctx }) {
  const { style } = ctx.opts
  if (!line.cells) return line.text.trim() ? <div className="italic" style={{ color: style.commentColor }}>{line.text}</div> : <div className="h-[0.7em]" />
  const cell = (c: GridCell, i: number) =>
    c.kind === 'bar' ? (
      <span key={i} className="px-[0.25em] font-bold opacity-70">
        {c.text}
      </span>
    ) : c.kind === 'mark' ? (
      <span key={i} className="inline-block min-w-[2.2em] text-center opacity-50">
        {c.text === '.' ? '' : c.text}
      </span>
    ) : (
      <span key={i} className="inline-block min-w-[2.2em] text-center" style={chordCss(style)}>
        {c.chords.map((ch, k) => (
          <Fragment key={k}>
            {k > 0 && <span className="opacity-50"> / </span>}
            <ChordName chord={ch} ctx={ctx} />
          </Fragment>
        ))}
      </span>
    )
  return (
    <div className="flex items-baseline whitespace-nowrap" style={targetCss(ctx.song, style, 'grid')}>
      {line.left && <span className="mr-[0.6em] text-[0.8em] italic" style={{ color: style.commentColor }}>{line.left}</span>}
      {line.cells.map(cell)}
      {line.right && <span className="ml-[0.6em] text-[0.8em] italic" style={{ color: style.commentColor }}>{line.right}</span>}
    </div>
  )
}

/** Intrinsic size of an SVG from its width/height attributes or viewBox. */
function svgSize(src: string): { w: number; h: number } {
  const tag = /<svg\b[^>]*>/i.exec(src)?.[0] ?? ''
  const w = parseFloat(/\swidth\s*=\s*["']?([\d.]+)/i.exec(tag)?.[1] ?? '')
  const h = parseFloat(/\sheight\s*=\s*["']?([\d.]+)/i.exec(tag)?.[1] ?? '')
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag)
  if (w && h) return { w, h }
  if (vb && Number(vb[1]) && Number(vb[2])) return { w: Number(vb[1]), h: Number(vb[2]) }
  return { w: 300, h: 150 }
}

/** Inline SVG from the file, shown through <img> so any script inside it can never run. */
function SvgBlock({ source }: { source: string }) {
  const svg = /xmlns=/.test(source) ? source : source.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  const size = svgSize(source)
  return (
    <img
      alt=""
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      style={{ width: `${size.w / 16}em`, maxWidth: '100%', aspectRatio: `${size.w} / ${size.h}`, display: 'block' }}
    />
  )
}

function ImageLine({ line }: { line: Extract<Line, { type: 'image' }> }) {
  if (!/^(https?:|data:image\/)/i.test(line.src))
    return <div className="text-[0.75em] italic opacity-50">[image: {line.src}]</div>
  const width = line.width ? `${line.width * (line.scale ?? 1)}px` : line.scale ? `${line.scale * 100}%` : undefined
  return (
    <div style={{ textAlign: (line.align as CSSProperties['textAlign']) ?? 'left' }}>
      <img alt="" src={line.src} style={{ width, maxWidth: '100%', height: line.height ? line.height * (line.scale ?? 1) : undefined }} />
    </div>
  )
}

function InlineDiagram({ chord, ctx }: { chord: string; ctx: Ctx }) {
  const name = ctx.chords.lookupName(chord)
  const d = lookupDiagram(name, ctx.chords.instrument, name === chord ? ctx.chords.defines : [])
  if (!d) return <span style={chordCss(ctx.opts.style)}>{ctx.chords.display(chord)}</span>
  return (
    <div className="my-1 inline-block pr-[0.8em]">
      <ChordDiagram diagram={d} label={ctx.chords.display(chord)} size={ctx.opts.style.diagramSize} />
    </div>
  )
}

function renderLine(line: Line, i: number, ctx: Ctx): ReactNode {
  const { style } = ctx.opts
  switch (line.type) {
    case 'lyrics':
      return <LyricsLine key={i} line={line} ctx={ctx} />
    case 'comment':
      return (
        <div key={i}>
          <div
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
            <MarkupText text={line.text} />
          </div>
        </div>
      )
    case 'tab':
      return (
        <div key={i} className="whitespace-pre font-mono text-[0.85em]" style={targetCss(ctx.song, style, 'tab')}>
          {line.text || ' '}
        </div>
      )
    case 'grid':
      return <GridLine key={i} line={line} ctx={ctx} />
    case 'empty':
      return <div key={i} className="h-[0.7em]" />
    case 'chorusRef':
      return (
        <div key={i} className="font-semibold italic" style={{ color: style.commentColor }}>
          {line.label || 'Chorus'}
        </div>
      )
    case 'image':
      return <ImageLine key={i} line={line} />
    case 'abc':
      return <AbcBlock key={i} source={line.source} transpose={ctx.chords.semitones} />
    case 'svg':
      return <SvgBlock key={i} source={line.source} />
    case 'diagram':
      return style.showChords && !style.lyricsOnly ? <InlineDiagram key={i} chord={line.chord} ctx={ctx} /> : null
    case 'text':
      return (
        <div key={i} className="whitespace-pre-wrap">
          <MarkupText text={line.text} />
        </div>
      )
  }
}

const SECTION_LABEL: Record<string, string> = { chorus: 'Chorus', bridge: 'Bridge', tab: 'Tab', grid: 'Grid' }

function SectionView({ section, ctx, showLabel = true }: { section: Section; ctx: Ctx; showLabel?: boolean }) {
  const { style } = ctx.opts
  const isChorus = section.kind === 'chorus'
  const label = showLabel ? (section.label ?? (section.kind !== 'verse' && section.kind !== 'none' ? SECTION_LABEL[section.kind] : undefined)) : undefined
  const hideTabs = style.lyricsOnly && (section.kind === 'tab' || section.kind === 'grid' || section.kind === 'abc')
  if (hideTabs) return null
  const chorusCss: CSSProperties = isChorus
    ? style.chorusStyle === 'bar'
      ? { borderLeft: `3px solid ${style.chorusColor}`, paddingLeft: '0.75em' }
      : style.chorusStyle === 'background'
        ? { background: `color-mix(in srgb, ${style.chorusColor} 10%, transparent)`, padding: '0.25em 0.6em', borderRadius: 6 }
        : style.chorusStyle === 'indent'
          ? { paddingLeft: '1.5em' }
          : {}
    : {}
  const tb = section.kind === 'textblock' ? section.attrs : undefined
  return (
    <div
      style={{
        ...chorusCss,
        ...(isChorus ? targetCss(ctx.song, style, 'chorus') : {}),
        textAlign: tb?.flush === 'center' || tb?.flush === 'right' ? tb.flush : undefined,
      }}
      className="py-[0.15em]"
    >
      {label && (
        <div className="mb-0.5 text-[0.8em] font-bold uppercase tracking-wider" style={{ color: style.commentColor, ...targetCss(ctx.song, style, 'label') }}>
          <MarkupText text={label} />
        </div>
      )}
      {section.lines.map((l, i) => renderLine(l, i, ctx))}
    </div>
  )
}

export function Header({ song, opts, chords }: { song: ChordProSong; opts: RenderOpts; chords?: ChordCtx }) {
  const { style } = opts
  const ctx = chords ?? chordContext(song, opts)
  const titles = song.meta.title ?? []
  const subtitle = song.meta.subtitle?.join(', ')
  const bits = [
    song.meta.artist?.join(', '),
    song.meta.composer?.length ? `Music: ${song.meta.composer.join(', ')}` : undefined,
    song.meta.lyricist?.length ? `Lyrics: ${song.meta.lyricist.join(', ')}` : undefined,
    song.meta.album?.length ? song.meta.album.join(', ') : undefined,
  ].filter(Boolean)
  const fileCapo = Number(metaFirst(song, 'capo')) || 0
  const facts = [
    metaFirst(song, 'key') || ctx.semitones
      ? ctx.soundKey && `Key ${ctx.soundKey}${ctx.semitones && ctx.originalKey ? ` (orig. ${ctx.originalKey})` : ''}`
      : undefined,
    ctx.capo ? `Capo ${ctx.capo}${ctx.shapeKey ? ` · ${ctx.shapeKey} shapes` : ''}` : fileCapo ? `Capo ${fileCapo}` : undefined,
    metaFirst(song, 'tempo') && `${metaFirst(song, 'tempo')} BPM`,
    metaFirst(song, 'time'),
    metaFirst(song, 'duration'),
  ].filter(Boolean)
  if (!titles.length && !subtitle && !bits.length && !facts.length) return null
  return (
    <div className="mb-[0.8em]">
      {titles.map((t, i) => (
        <div key={i} className={i === 0 ? 'text-[1.6em] font-bold leading-tight' : 'text-[1.2em] font-semibold leading-tight'} style={{ color: style.titleColor, ...targetCss(song, style, 'title') }}>
          <MarkupText text={t} />
        </div>
      ))}
      {subtitle && (
        <div className="text-[1.05em]" style={{ color: style.commentColor, ...targetCss(song, style, 'subtitle') }}>
          <MarkupText text={subtitle} />
        </div>
      )}
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
    </div>
  )
}

function DiagramRow({ items, style }: { items: { label: string; diagram: Diagram }[]; style: TextStyle }) {
  return (
    <div className="flex flex-wrap gap-x-[1em] gap-y-[0.4em] pt-[0.3em]" style={{ color: style.lyricsColor }}>
      {items.map((it) => (
        <ChordDiagram key={it.label} diagram={it.diagram} label={it.label} size={style.diagramSize} />
      ))}
    </div>
  )
}

/** Turn a parsed song into a list of blocks for pagination. */
export function songBlocks(song: ChordProSong, opts: RenderOpts): Block[] {
  const chords = chordContext(song, opts)
  const ctx: Ctx = { song, opts, chords }
  const { style } = opts
  const wrap = (node: ReactNode) => <ChordTapArea chords={chords}>{node}</ChordTapArea>
  const blocks: Block[] = [{ key: 'header', node: <Header song={song} opts={opts} chords={chords} /> }]

  const pushSection = (section: Section, key: string, breakBefore?: Block['breakBefore']) => {
    // Long sections are split into chunks of lines so pagination can break inside them;
    // short sections stay whole. Chorus references expand into the referenced chorus.
    const lines = section.lines
    const chunk = lines.length > 8 ? 4 : lines.length || 1
    let first = true
    for (let i = 0; i < Math.max(1, lines.length); i += chunk) {
      const part: Section = { ...section, lines: lines.slice(i, i + chunk) }
      blocks.push({ key: `${key}:${i}`, breakBefore: first ? breakBefore : undefined, node: wrap(<SectionView section={part} ctx={ctx} showLabel={first} />) })
      first = false
    }
  }

  song.sections.forEach((section, si) => {
    let run: Line[] = []
    let n = 0
    let pendingBreak = section.breakBefore
    const flush = () => {
      if (!run.length) return
      pushSection({ ...section, lines: run, label: n === 0 ? section.label : undefined }, `${si}.${n++}`, pendingBreak)
      pendingBreak = undefined
      run = []
    }
    for (const l of section.lines) {
      const target = l.type === 'chorusRef' && style.expandChorusRefs && l.target !== undefined ? song.sections[l.target] : undefined
      if (target) {
        flush()
        pushSection({ ...target, label: (l.type === 'chorusRef' ? l.label : undefined) ?? target.label ?? 'Chorus' }, `${si}.${n++}r`, pendingBreak)
        pendingBreak = undefined
      } else run.push(l)
    }
    if (run.length || n === 0) flush()
    if (n === 0 && !section.lines.length) pushSection(section, `${si}.e`, pendingBreak)
    blocks.push({ key: `${si}:gap`, node: <div className="h-[0.6em]" /> })
  })

  const footer = [...(song.meta.copyright ?? []).map((c) => `© ${c}`), ...(song.meta.footer ?? [])]
  if (footer.length)
    blocks.push({
      key: 'footer',
      node: (
        <div className="mt-[0.5em] text-[0.7em]" style={{ color: style.commentColor, ...targetCss(song, style, 'footer') }}>
          {footer.map((f, i) => (
            <div key={i}>
              <MarkupText text={f} />
            </div>
          ))}
        </div>
      ),
    })

  if (style.diagrams === 'bottom' && song.diagrams !== false && style.showChords && !style.lyricsOnly) {
    const items = songDiagrams(song, chords).filter((x): x is { label: string; diagram: Diagram } => !!x.diagram)
    const perRow = chords.instrument === 'piano' ? 4 : 6
    for (let i = 0; i < items.length; i += perRow)
      blocks.push({ key: `diagrams:${i}`, node: <DiagramRow items={items.slice(i, i + perRow)} style={style} /> })
  }
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
