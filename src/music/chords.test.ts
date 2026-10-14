import { describe, expect, it } from 'vitest'
import { isChordLine, keyDistance, nashville, parseChord, transposeChord, transposeKey } from './chords'

describe('chords', () => {
  it('parses common chords', () => {
    expect(parseChord('C')).toMatchObject({ root: 0, suffix: '' })
    expect(parseChord('F#m7b5/C#')).toMatchObject({ root: 6, suffix: 'm7b5', bass: 1 })
    expect(parseChord('Bbmaj7')).toMatchObject({ root: 10, suffix: 'maj7', flat: true })
    expect(parseChord('Asus4')).toMatchObject({ root: 9, suffix: 'sus4' })
    expect(parseChord('Esus2')).toMatchObject({ root: 4, suffix: 'sus2' })
    expect(parseChord('G7(b9)')).toMatchObject({ root: 7 })
    expect(parseChord('Hello')).toBeNull()
    expect(parseChord('Am I')).toBeNull()
  })
  it('transposes with sensible spelling', () => {
    expect(transposeChord('C', 2)).toBe('D')
    expect(transposeChord('Bb', 2)).toBe('C')
    expect(transposeChord('Bb', 1)).toBe('B')
    expect(transposeChord('F#m', -1)).toBe('Fm')
    expect(transposeChord('C/E', 3, { targetKey: 'Eb' })).toBe('Eb/G')
    expect(transposeChord('D', 1, { prefer: 'flat' })).toBe('Eb')
    expect(transposeChord('A', 1)).toBe('A#')
    expect(transposeChord('H7', 1, { naming: 'german' })).toBe('C7')
    expect(transposeChord('C', -2, { naming: 'german', prefer: 'flat' })).toBe('B')
  })
  it('transposes keys', () => {
    expect(transposeKey('C', 1)).toBe('Db')
    expect(transposeKey('C', 6)).toBe('F#')
    expect(transposeKey('Am', 1)).toBe('Bbm')
    expect(transposeKey('E', 2)).toBe('F#')
    expect(keyDistance('C', 'A')).toBe(-3)
    expect(keyDistance('C', 'F')).toBe(5)
  })
  it('detects chord lines', () => {
    expect(isChordLine('  G     D/F#   Em   C  ')).toBe(true)
    expect(isChordLine('| Am | F | C | G |')).toBe(true)
    expect(isChordLine('Amazing grace how sweet')).toBe(false)
    expect(isChordLine('A')).toBe(true)
  })
  it('nashville numbers', () => {
    expect(nashville('D7', 'G')).toBe('57')
    expect(nashville('Em', 'G')).toBe('6m')
  })
})
