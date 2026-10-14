import { describe, expect, it } from 'vitest'
import { parseChordPro, parseLyricLine, textToChordPro } from './parse'

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
    expect(s.sections.map((x) => x.kind)).toEqual(['none', 'chorus', 'none', 'tab'])
    expect(s.sections[3].breakBefore).toBe('page')
    expect(s.sections[3].lines[0]).toEqual({ type: 'tab', text: 'e|---0---|' })
    expect(s.defines[0]).toMatchObject({ name: 'Asus2', baseFret: 1, frets: [null, 0, 2, 2, 0, 0] })
  })
  it('reads header metadata from plain text', () => {
    const cp = textToChordPro('Title: Hi\nKey: D\n\nD  A\nla la')
    expect(cp.split('\n').slice(0, 2)).toEqual(['{title: Hi}', '{key: D}'])
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
  })
})
