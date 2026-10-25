import { describe, expect, it } from 'vitest'
import { chordInsertion, detectKey, transposeChordProText, transposePlainText } from './transform'

describe('text transforms', () => {
  it('detects the key', () => {
    expect(detectKey('{key: D}\n[G]x')).toBe('D')
    expect(detectKey('[Em]x [G]y')).toBe('Em')
    expect(detectKey('Key: Bb\nla')).toBe('Bb')
    expect(detectKey('  A   E\nla la')).toBe('A')
  })
  it('transposes a ChordPro file', () => {
    const src = `{title: X}
{key: G}
[G]Hello [D/F#]world [*Riff]
{sot}
e|--3--|
{eot}
{sog}
| G . | C~D . |
{eog}
{soa}
X:1
K:G
GABc|
{eoa}`
    expect(transposeChordProText(src, 2)).toBe(`{title: X}
{key: A}
[A]Hello [E/G#]world [*Riff]
{sot}
e|--3--|
{eot}
{sog}
| A . | D~E . |
{eog}
{soa}
%%mstranspose 2
X:1
K:G
GABc|
{eoa}`)
    expect(transposeChordProText('{soa}\n%%mstranspose 5\nX:1\n{eoa}', 3)).toBe('{soa}\n%%mstranspose -4\nX:1\n{eoa}')
    expect(transposeChordProText('{key: C}\n[C][F][G7]', 1)).toBe('{key: Db}\n[Db][Gb][Ab7]')
  })
  it('transposes plain text chord lines', () => {
    expect(transposePlainText('Key: D\n\nD    A    Bm\nPlain text sheets\n', -2)).toBe('Key: C\n\nC    G    Am\nPlain text sheets\n')
    // Windows line endings: the key line is still rewritten and the result has one line ending style.
    expect(transposePlainText('Key: E\r\n\r\nE   B/D#\r\nWalking\r\n', 2)).toBe('Key: F#\n\nF#  C#/F\nWalking\n')
    expect(transposeChordProText('{key: G}\r\n[G]x\r\n', 2)).toBe('{key: A}\n[A]x\n')
  })
  it('computes chord tap insertions', () => {
    expect(chordInsertion('Amazing grace', 3, 'G')).toEqual({ start: 0, end: 0, insert: '[G]' })
    expect(chordInsertion('Amazing grace', 10, 'D')).toEqual({ start: 8, end: 8, insert: '[D]' })
    expect(chordInsertion('[C]Amazing', 2, 'G')).toEqual({ start: 0, end: 3, insert: '[G]' })
    expect(chordInsertion('[C]Amazing', 5, 'G')).toEqual({ start: 3, end: 3, insert: '[G]' })
  })
})
