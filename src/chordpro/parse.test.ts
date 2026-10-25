import { describe, expect, it } from 'vitest'
import { hasMarkup, parseMarkup, safeColor, stripMarkup } from './markup'
import { firstChord, looksLikeChordPro, lyricGroups, parseAttrs, parseChordPro, parseGridLine, parseLyricLine, songChords, substituteMeta, textToChordPro } from './parse'

describe('chordpro', () => {
  it('splits lyric lines', () => {
    expect(parseLyricLine('[G]Amazing [D/F#]grace')).toEqual([
      { chord: 'G', text: 'Amazing ' },
      { chord: 'D/F#', text: 'grace' },
    ])
    expect(parseLyricLine('no chords')).toEqual([{ chord: undefined, text: 'no chords' }])
    expect(parseLyricLine('end [C]')).toEqual([
      { chord: undefined, text: 'end ' },
      { chord: 'C', text: '' },
    ])
  })
  it('parses directives and sections', () => {
    const s = parseChordPro(`{title: Amazing Grace}
{st: Traditional}
{key: G}
{capo: 2}
{c: Slowly}
[G]Amazing grace

{soc}
[C]Chorus line
{eoc}
{chorus}
{np}
{sot}
e|---0---|
{eot}
{define: Asus2 base-fret 1 frets x 0 2 2 0 0}
{title-guitar: ignored? no, conditional}
`)
    expect(s.meta.title[0]).toBe('Amazing Grace')
    expect(s.meta.subtitle[0]).toBe('Traditional')
    expect(s.meta.key[0]).toBe('G')
    expect(s.meta.capo[0]).toBe('2')
    expect(s.sections.map((x) => x.kind)).toEqual(['none', 'chorus', 'none', 'tab'])
    expect(s.sections[3].breakBefore).toBe('page')
    expect(s.sections[3].lines[0]).toEqual({ type: 'tab', text: 'e|---0---|' })
    expect(s.sections[2].lines[0]).toEqual({ type: 'chorusRef', label: undefined, target: 1 })
    expect(s.defines[0]).toMatchObject({ name: 'Asus2', baseFret: 1, frets: [null, 0, 2, 2, 0, 0] })
  })
  it('knows the full alias table', () => {
    const s = parseChordPro(`{t: T}
{su: Sub}
{a: Album}
{book: Book}
{ci: italic}
{cb: boxed}
{gc: guitar comment}
{highlight: hl}
{flow: V C V}
{sov: Verse 1}
x
{eov}
{sob}
y
{eob}
{sop: Intro}
z
{eop}
{colb}
{col: 2}
{npp}
{ns}`)
    expect(s.meta.title).toEqual(['T'])
    expect(s.meta.subtitle).toEqual(['Sub'])
    expect(s.meta.album).toEqual(['Album', 'Book'])
    expect(s.meta.structure).toEqual(['V C V'])
    const comments = s.sections[0].lines.map((l) => l.type === 'comment' && l.style)
    expect(comments).toEqual(['italic', 'box', 'normal', 'normal'])
    expect(s.sections.slice(1, 4).map((x) => [x.kind, x.label])).toEqual([
      ['verse', 'Verse 1'],
      ['bridge', undefined],
      ['other', 'Intro'],
    ])
    expect(s.columns).toBe(2)
  })
  it('re-renders the most recent chorus with {chorus}', () => {
    const s = parseChordPro(`{soc: Chorus 1}
[C]one
{eoc}
{chorus}
{start_of_chorus label="Chorus 2"}
[G]two
{end_of_chorus}
{chorus}
{chorus: Chorus 1}`)
    const refs = s.sections.flatMap((x) => x.lines).filter((l) => l.type === 'chorusRef')
    expect(refs.map((r) => r.type === 'chorusRef' && s.sections[r.target!].label)).toEqual(['Chorus 1', 'Chorus 2', 'Chorus 1'])
  })
  it('honours conditional selectors for the instrument', () => {
    const src = `{title: Plain}
{title-ukulele: Uke title}
{comment-guitar: guitar only}
{comment-guitar!: not guitar}
{start_of_verse-piano}
[C]piano verse
{end_of_verse}
[G]shared`
    const g = parseChordPro(src, { instrument: 'guitar' })
    expect(g.meta.title).toEqual(['Plain'])
    expect(g.sections.flatMap((x) => x.lines).filter((l) => l.type === 'comment').map((l) => l.type === 'comment' && l.text)).toEqual(['guitar only'])
    expect(g.sections.map((x) => x.kind)).toEqual(['none'])
    const k = parseChordPro(src, { instrument: 'keyboard' })
    expect(k.sections.map((x) => x.kind)).toEqual(['none', 'verse', 'none'])
    const u = parseChordPro(src, { instrument: 'ukulele' })
    expect(u.meta.title).toEqual(['Plain', 'Uke title'])
  })
  it('parses key="value" attributes', () => {
    expect(parseAttrs('label="Chorus 2" x=3 rest')).toEqual({ attrs: { label: 'Chorus 2', x: '3' }, rest: 'rest' })
    const s = parseChordPro('{image: src=https://x/y.png width=200 align=center}')
    expect(s.sections[0].lines[0]).toEqual({ type: 'image', src: 'https://x/y.png', width: 200, height: undefined, scale: undefined, align: 'center' })
  })
  it('substitutes %{meta}', () => {
    const look = (n: string) => ({ title: 'Song', capo: '2', key: 'G' })[n]
    expect(substituteMeta('%{title} in %{key}', look)).toBe('Song in G')
    expect(substituteMeta('%{capo|Capo %{}|No capo}', look)).toBe('Capo 2')
    expect(substituteMeta('%{artist|by %{}|anon}', look)).toBe('anon')
    expect(substituteMeta('%{key=G|G major|other}', look)).toBe('G major')
    expect(substituteMeta('%{key=A|A|not A}', look)).toBe('not A')
    expect(substituteMeta('%{missing}', look)).toBe('')
    const s = parseChordPro('{title: Hello}\n{key: D}\n{c: %{title} — key %{key}}\n{c: %{instrument}}', { instrument: 'ukulele' })
    expect(s.sections[0].lines.map((l) => l.type === 'comment' && l.text)).toEqual(['Hello — key D', 'ukulele'])
    // Metadata defined later in the file is available too.
    expect(parseChordPro('{subtitle: A %{artist} test}\n{artist: QA Band}').meta.subtitle).toEqual(['A QA Band test'])
    // %{key} gives the key actually played.
    const t = parseChordPro('{key: G}\n{transpose: 1}\n{c: In %{key}}', { transpose: 2 })
    expect(t.sections[0].lines[0]).toMatchObject({ text: 'In Bb' })
    expect(t.meta.key).toEqual(['G'])
  })
  it('reads {meta} and notation', () => {
    const s = parseChordPro('{meta: artist Someone}\n{meta: genre Folk}\n{meta: notation German Default}')
    expect(s.meta.artist).toEqual(['Someone'])
    expect(s.meta.genre).toEqual(['Folk'])
    expect(s.notation).toEqual({ source: 'german', display: 'english' })
  })
  it('collects format directives', () => {
    const s = parseChordPro('{textsize: 14}\n{chordcolour: red}\n{titlefont: serif}')
    expect(s.format).toEqual({ text: { size: '14' }, chord: { color: 'red' }, title: { font: 'serif' } })
  })
  it('keeps abc, svg and textblock environments', () => {
    const s = parseChordPro(`{start_of_abc}
X:1
K:G
GABc|
{end_of_abc}
{start_of_svg}
<svg viewBox="0 0 10 10"></svg>
{end_of_svg}
{start_of_textblock}
Some <b>bold</b> [not a chord]
{end_of_textblock}`)
    expect(s.sections.map((x) => x.kind)).toEqual(['abc', 'svg', 'textblock'])
    expect(s.sections[0].lines[0]).toEqual({ type: 'abc', source: 'X:1\nK:G\nGABc|' })
    expect(s.sections[1].lines[0]).toEqual({ type: 'svg', source: '<svg viewBox="0 0 10 10"></svg>' })
    expect(s.sections[2].lines[0]).toEqual({ type: 'text', text: 'Some <b>bold</b> [not a chord]' })
  })
  it('parses grids', () => {
    expect(parseGridLine('Intro || G . . . | C~D . % . | Em :| x2')).toEqual({
      left: 'Intro',
      right: 'x2',
      cells: [
        { kind: 'bar', text: '||' },
        { kind: 'chord', chords: ['G'] },
        { kind: 'mark', text: '.' },
        { kind: 'mark', text: '.' },
        { kind: 'mark', text: '.' },
        { kind: 'bar', text: '|' },
        { kind: 'chord', chords: ['C', 'D'] },
        { kind: 'mark', text: '.' },
        { kind: 'mark', text: '%' },
        { kind: 'mark', text: '.' },
        { kind: 'bar', text: '|' },
        { kind: 'chord', chords: ['Em'] },
        { kind: 'bar', text: ':|' },
      ],
    })
    const s = parseChordPro('{start_of_grid 4x4}\n| A . | B . |\n{end_of_grid}')
    expect(s.sections[0]).toMatchObject({ kind: 'grid', label: undefined, attrs: { shape: '4x4' } })
    expect(firstChord(s)).toBe('A')
  })
  it('joins continuation lines and strips BOM', () => {
    const s = parseChordPro('﻿{title: A \\\n B}\n[C]one \\\ntwo')
    expect(s.meta.title).toEqual(['A B'])
    expect(s.sections[0].lines[0]).toMatchObject({ type: 'lyrics', segments: [{ chord: 'C', text: 'one two' }] })
  })
  it('parses inline markup across chords', () => {
    const s = parseChordPro('<b>[C]Hello [G]world</b> plain')
    const l = s.sections[0].lines[0]
    expect(l.type === 'lyrics' && l.segments.map((x) => x.text)).toEqual(['Hello ', 'world plain'])
    expect(l.type === 'lyrics' && l.segments[1].runs).toEqual([
      { text: 'world', style: { bold: true } },
      { text: ' plain', style: {} },
    ])
    expect(songChords(s)).toEqual(['C', 'G'])
  })
  it('converts chords-over-lyrics text', () => {
    const cp = textToChordPro(`Verse 1:
G       D/F#      Em
Amazing grace how sweet
C   G
`)
    expect(cp).toBe(`{comment: Verse 1}
[G]Amazing [D/F#]grace how [Em]sweet
[C]   [G]
`)
    expect(textToChordPro('C  G  Am riff\nla la la la la la')).toBe('[C]la [G]la [Am]la [*riff]la la la')
    expect(textToChordPro('Lyric with [brackets]')).toBe('Lyric with (brackets)')
  })
  it('keeps bar charts and N.C. lines as chords', () => {
    expect(textToChordPro('Intro:\n| E  | B/D# |\n| A | E |\n\nN.C.\nLast line')).toBe(
      '{comment: Intro}\n{start_of_grid label=""}\n| E  | B/D# |\n| A | E |\n{end_of_grid}\n\n[*N.C.]Last line',
    )
    const s = parseChordPro(textToChordPro('| E | B/D# | C#m7 |'))
    expect(s.sections[0]).toMatchObject({ kind: 'grid', label: '' })
    expect(songChords(s)).toEqual(['E', 'B/D#', 'C#m7'])
    expect(textToChordPro('N.C.')).toBe('[*N.C.]')
  })
  it('groups lyrics into unbreakable words', () => {
    const texts = (line: string) => lyricGroups(parseLyricLine(line)).map((g) => g.map((p) => (p.chord ? `[${p.chord}]` : '') + p.text).join(''))
    expect(texts('[G]Amazing grace how [D]sweet')).toEqual(['[G]Amazing ', 'grace ', 'how ', '[D]sweet'])
    // A chord inside a word keeps the word together; leading spaces stay with the chord's word.
    expect(texts('A[C]ma[G]zing [Am] grace')).toEqual(['A[C]ma[G]zing ', '[Am] grace'])
    // Chords over no text can break apart.
    expect(texts('me[F7sus4][F7]')).toEqual(['me[F7sus4]', '[F7]'])
    const line = parseChordPro('[C]Some <b>bold words</b> here').sections[0].lines[0]
    const groups = line.type === 'lyrics' ? lyricGroups(line.segments) : []
    expect(groups.map((g) => g.map((p) => p.runs?.map((r) => r.text).join('|')).join(''))).toEqual(['Some ', 'bold ', 'words| ', 'here'])
  })
  it('reads header metadata from plain text', () => {
    const cp = textToChordPro('Title: Hi\nKey: D\n\nD  A\nla la')
    expect(cp.split('\n').slice(0, 2)).toEqual(['{title: Hi}', '{key: D}'])
  })
  it('detects chordpro', () => {
    expect(looksLikeChordPro('{title: x}')).toBe(true)
    expect(looksLikeChordPro('[G]Hello')).toBe(true)
    expect(looksLikeChordPro('G  C\nHello')).toBe(false)
  })
})

describe('markup', () => {
  it('parses tags and attributes safely', () => {
    expect(hasMarkup('a <b>b</b>')).toBe(true)
    expect(hasMarkup('I <3 you')).toBe(false)
    expect(parseMarkup('<span color="red" size="18">x</span>').runs).toEqual([{ text: 'x', style: { color: 'red', size: '1.500em' } }])
    expect(parseMarkup('<span color="red;background:url(x)">x</span>').runs[0].style.color).toBeUndefined()
    expect(parseMarkup('<script>alert(1)</script>').runs).toEqual([{ text: '<script>alert(1)</script>', style: {} }])
    expect(stripMarkup('<i>a</i> &amp; <b>b</b>')).toBe('a & b')
    expect(safeColor('#ff000080')).toBe('#ff000080')
    expect(safeColor('expression(1)')).toBeUndefined()
  })
})
