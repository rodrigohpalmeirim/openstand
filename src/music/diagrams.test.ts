import { beforeAll, describe, expect, it } from 'vitest'
import { canonicalSuffix, chordTones, loadInstrument, lookupDiagram, parseDefine } from './diagrams'

describe('chord diagrams', () => {
  beforeAll(async () => {
    await loadInstrument('guitar')
    await loadInstrument('ukulele')
  })
  it('normalises suffixes', () => {
    expect(canonicalSuffix('')).toBe('major')
    expect(canonicalSuffix('m')).toBe('minor')
    expect(canonicalSuffix('min7')).toBe('m7')
    expect(canonicalSuffix('Δ7')).toBe('maj7')
    expect(canonicalSuffix('ø')).toBe('m7b5')
    expect(canonicalSuffix('sus')).toBe('sus4')
    expect(canonicalSuffix('m(maj7)')).toBe('mmaj7')
  })
  it('computes chord tones', () => {
    expect(chordTones('')).toEqual([0, 4, 7])
    expect(chordTones('m7')).toEqual([0, 3, 7, 10])
    expect(chordTones('maj7')).toEqual([0, 4, 7, 11])
    expect(chordTones('dim7')).toEqual([0, 3, 6, 9])
    expect(chordTones('m7b5')).toEqual([0, 3, 6, 10])
    expect(chordTones('sus4')).toEqual([0, 5, 7])
    expect(chordTones('7b9')).toEqual([0, 4, 7, 10, 13])
    expect(chordTones('add9')).toEqual([0, 4, 7, 14])
    expect(chordTones('aug')).toEqual([0, 4, 8])
  })
  it('looks up built-in guitar and ukulele shapes', () => {
    const c = lookupDiagram('C', 'guitar')
    expect(c?.shape).toMatchObject({ kind: 'frets', frets: [null, 3, 2, 0, 1, 0], baseFret: 1 })
    expect(lookupDiagram('Am7', 'guitar')?.source).toBe('builtin')
    expect(lookupDiagram('F#m', 'guitar')?.shape.kind).toBe('frets')
    expect(lookupDiagram('Gb', 'guitar')).not.toBeNull()
    expect(lookupDiagram('C', 'ukulele')?.shape).toMatchObject({ frets: [0, 0, 0, 3] })
    expect(lookupDiagram('D/F#', 'guitar')?.shape.kind).toBe('frets')
    // Unknown extension falls back to a simpler chord.
    const odd = lookupDiagram('C7sus2', 'guitar')
    expect(odd?.approx).toBe(true)
    expect(lookupDiagram('Hello', 'guitar')).toBeNull()
  })
  it('prefers {define} shapes and honours instrument string counts', () => {
    const defs = [parseDefine('Asus2 base-fret 1 frets x 0 2 2 0 0 fingers 0 0 1 2 0 0'), parseDefine('G frets 0 2 3 2')]
    expect(lookupDiagram('Asus2', 'guitar', defs)).toMatchObject({ source: 'define', shape: { frets: [null, 0, 2, 2, 0, 0], fingers: [0, 0, 1, 2, 0, 0] } })
    // A 4-string define applies to ukulele only.
    expect(lookupDiagram('G', 'ukulele', defs)?.source).toBe('define')
    expect(lookupDiagram('G', 'guitar', defs)?.source).toBe('builtin')
    expect(lookupDiagram('X', 'guitar', [parseDefine('X copy Am')])?.shape).toMatchObject({ frets: [null, 0, 2, 2, 1, 0] })
    expect(lookupDiagram('C', 'guitar', [parseDefine('C diagram off')])).toBeNull()
  })
  it('generates piano voicings', () => {
    expect(lookupDiagram('C', 'piano')?.shape).toEqual({ kind: 'keys', keys: [0, 4, 7] })
    expect(lookupDiagram('Am7', 'piano')?.shape).toEqual({ kind: 'keys', keys: [9, 12, 16, 19] })
    expect(lookupDiagram('C/E', 'piano')?.shape).toEqual({ kind: 'keys', keys: [4, 12, 16, 19] })
  })
})
