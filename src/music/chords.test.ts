import { describe, expect, it } from 'vitest'
import {
  formatKey,
  isChordLine,
  keyDistance,
  makeTransposer,
  nashville,
  parseChord,
  parseKey,
  transposeChord,
  transposeChordLine,
  transposeKey,
} from './chords'

describe('chords', () => {
  it('parses common chords', () => {
    expect(parseChord('C')).toMatchObject({ root: 0, suffix: '' })
    expect(parseChord('F#m7b5/C#')).toMatchObject({ root: 6, suffix: 'm7b5', bass: 1 })
    expect(parseChord('Bbmaj7')).toMatchObject({ root: 10, suffix: 'maj7', flat: true })
    expect(parseChord('Asus4')).toMatchObject({ root: 9, suffix: 'sus4' })
    expect(parseChord('Esus2')).toMatchObject({ root: 4, suffix: 'sus2' })
    expect(parseChord('G7(b9)')).toMatchObject({ root: 7 })
    expect(parseChord('(Am)')).toMatchObject({ root: 9, suffix: 'm', parens: true })
    expect(parseChord('C♯m')).toMatchObject({ root: 1, suffix: 'm' })
    expect(parseChord('Hello')).toBeNull()
    expect(parseChord('Am I')).toBeNull()
    expect(parseChord('*Riff')).toBeNull()
    // German-only spellings are not chords in the default locale.
    expect(parseChord('As')).toBeNull()
    expect(parseChord('H')).toBeNull()
  })
  it('transposes with sensible spelling (no key)', () => {
    expect(transposeChord('C', 2)).toBe('D')
    expect(transposeChord('Bb', 2)).toBe('C')
    expect(transposeChord('Bb', 1)).toBe('B')
    expect(transposeChord('F#m', -1)).toBe('Fm')
    expect(transposeChord('C/E', 3, { targetKey: 'Eb' })).toBe('Eb/G')
    expect(transposeChord('D', 1, { prefer: 'flat' })).toBe('Eb')
    expect(transposeChord('A', 1)).toBe('A#')
    expect(transposeChord('A', -1)).toBe('Ab')
    expect(transposeChord('H7', 1, { naming: 'german' })).toBe('C7')
    expect(transposeChord('C', -2, { naming: 'german', prefer: 'flat' })).toBe('B')
    expect(transposeChord('(Am7)', 2)).toBe('(Bm7)')
    expect(transposeChord('N.C.', 2)).toBe('N.C.')
  })
  it('transposes keys (17-key cycle, convention then direction)', () => {
    expect(transposeKey('C', 1)).toBe('Db')
    expect(transposeKey('C', 6)).toBe('F#')
    expect(transposeKey('C', -6)).toBe('Gb')
    expect(transposeKey('Am', 1)).toBe('Bbm')
    expect(transposeKey('E', 2)).toBe('F#')
    expect(transposeKey('G', 1)).toBe('Ab')
    expect(transposeKey('G', -1)).toBe('Gb')
    expect(transposeKey('C', -1)).toBe('B')
    expect(transposeKey('D', -1)).toBe('Db')
    expect(transposeKey('Em', 1)).toBe('Fm')
    expect(transposeKey('Am', 6)).toBe('D#m')
    expect(transposeKey('Am', -6)).toBe('Ebm')
    expect(transposeKey('Bm', -1)).toBe('Bbm')
    expect(transposeKey('C', 4)).toBe('E')
    expect(transposeKey('F#', 0)).toBe('F#')
    expect(keyDistance('C', 'A')).toBe(-3)
    expect(keyDistance('C', 'F')).toBe(5)
  })
  it('transposes letter-aware from the key', () => {
    const t = (key: string, semis: number, chord: string, o = {}) => makeTransposer({ key, semitones: semis, ...o }).chord(chord)
    // G → A: every letter moves one step.
    expect(t('G', 2, 'F#')).toBe('G#')
    expect(t('G', 2, 'D/F#')).toBe('E/G#')
    expect(t('G', 2, 'Bb')).toBe('C')
    expect(t('G', 2, 'C')).toBe('D')
    // C → Eb: letters move two steps, sharps become naturals.
    expect(t('C', 3, 'C/E')).toBe('Eb/G')
    expect(t('C', 3, 'F#m7b5')).toBe('Am7b5')
    expect(t('C', 3, 'B7')).toBe('D7')
    expect(t('C', 3, 'G#dim')).toBe('Bdim')
    // G → Ab (up one): D → Eb, not D#.
    expect(t('G', 1, 'D7')).toBe('Eb7')
    expect(t('G', 1, 'Em')).toBe('Fm')
    // Down → flats.
    expect(t('A', -1, 'C#m')).toBe('Cm')
    expect(t('A', -1, 'E')).toBe('Eb')
    // Minor keys
    expect(t('Am', 2, 'E7')).toBe('F#7')
    expect(t('Em', 1, 'B7')).toBe('C7')
  })
  it('handles uncommon names and double accidentals by option', () => {
    // C → F#: B becomes E# (theoretically correct) or F (simplified, default).
    expect(makeTransposer({ key: 'C', semitones: 6 }).chord('B7')).toBe('F7')
    expect(makeTransposer({ key: 'C', semitones: 6, allowUncommon: true }).chord('B7')).toBe('E#7')
    // F → Gb: Ab becomes Bbb (double flat) or A.
    expect(makeTransposer({ key: 'F', semitones: 1, targetKey: 'Gb' }).chord('Ab')).toBe('A')
    expect(makeTransposer({ key: 'F', semitones: 1, targetKey: 'Gb', allowDouble: true }).chord('Ab')).toBe('Bbb')
    // Gb → Cb would need Cb.
    expect(makeTransposer({ key: 'Gb', semitones: 5, targetKey: 'Cb', allowUncommon: true }).chord('Gb')).toBe('Cb')
    expect(makeTransposer({ key: 'Gb', semitones: 5, targetKey: 'Cb' }).chord('Gb')).toBe('B')
    // Forced accidentals
    expect(makeTransposer({ key: 'G', semitones: 1, prefer: 'sharp' }).chord('D7')).toBe('D#7')
  })
  it('shows capo shapes (transposed down by the capo)', () => {
    const tr = makeTransposer({ key: 'A', semitones: -2 })
    expect(tr.key && formatKey(tr.key)).toBe('G')
    expect(tr.chord('C#m')).toBe('Bm')
    expect(tr.chord('E7')).toBe('D7')
    const bb = makeTransposer({ key: 'Bb', semitones: -3 })
    expect(bb.key && formatKey(bb.key)).toBe('G')
    expect(bb.chord('Eb')).toBe('C')
  })
  it('localises chord names', () => {
    const out = (c: string, n: 'german' | 'czech' | 'scandinavian' | 'latin', semis = 0) =>
      makeTransposer({ key: 'C', semitones: semis, outNaming: n }).chord(c)
    expect(out('B7', 'german')).toBe('H7')
    expect(out('Bb', 'german')).toBe('B')
    expect(out('Bbm', 'czech')).toBe('Bmi')
    expect(out('Am7', 'czech')).toBe('Ami7')
    expect(out('Cmaj7', 'czech')).toBe('Cmaj7')
    expect(out('Bb', 'scandinavian')).toBe('Bb')
    expect(out('B', 'scandinavian')).toBe('H')
    expect(out('G/B', 'german')).toBe('G/H')
    expect(out('Am', 'latin')).toBe('Lam')
    expect(out('F#', 'latin')).toBe('Fa#')
    // Parsing localised sources
    expect(parseChord('Ami7', 'czech')).toMatchObject({ root: 9, suffix: 'm7' })
    expect(parseChord('B', 'german')).toMatchObject({ root: 10 })
    expect(parseChord('H7', 'german')).toMatchObject({ root: 11 })
    expect(parseChord('Fis', 'german')).toMatchObject({ root: 6 })
    expect(parseChord('Es', 'german')).toMatchObject({ root: 3 })
    expect(parseChord('As7', 'german')).toMatchObject({ root: 8, suffix: '7' })
    expect(parseChord('Esus4', 'german')).toMatchObject({ root: 4, suffix: 'sus4' })
    expect(parseChord('Sol7', 'latin')).toMatchObject({ root: 7, suffix: '7' })
    expect(makeTransposer({ key: 'C', semitones: 0, naming: 'german', outNaming: 'english' }).chord('B')).toBe('Bb')
    expect(makeTransposer({ key: 'C', semitones: 0, naming: 'czech', outNaming: 'english' }).chord('Hmi')).toBe('Bm')
  })
  it('parses keys', () => {
    expect(parseKey('F# minor')).toMatchObject({ note: { letter: 3, acc: 1 }, minor: true })
    expect(parseKey('Bb major')).toMatchObject({ note: { letter: 6, acc: -1 }, minor: false })
    expect(parseKey('Em')).toMatchObject({ minor: true })
  })
  it('detects chord lines (65% rule)', () => {
    expect(isChordLine('  G     D/F#   Em   C  ')).toBe(true)
    expect(isChordLine('| Am | F | C | G |')).toBe(true)
    expect(isChordLine('Amazing grace how sweet')).toBe(false)
    expect(isChordLine('A')).toBe(true)
    expect(isChordLine('Am I')).toBe(false)
    expect(isChordLine('A day in the life')).toBe(false)
    expect(isChordLine('C  G  Am  riff')).toBe(true)
    expect(isChordLine('Chorus: G - C - D x2')).toBe(true)
    expect(isChordLine('[G][C]')).toBe(true)
    expect(isChordLine('N.C.')).toBe(false)
    expect(isChordLine('')).toBe(false)
  })
  it('transposes chord lines in place', () => {
    const tr = makeTransposer({ key: 'G', semitones: 2 })
    expect(transposeChordLine('G     D/F#   Em', tr.chord)).toBe('A     E/G#   F#m')
    expect(transposeChordLine('C D', makeTransposer({ key: 'C', semitones: 1 }).chord)).toBe('Db Eb')
    expect(transposeChordLine('Bb  riff  F', makeTransposer({ key: 'F', semitones: 2 }).chord)).toBe('C   riff  G')
  })
  it('nashville numbers', () => {
    expect(nashville('D7', 'G')).toBe('57')
    expect(nashville('Em', 'G')).toBe('6m')
    expect(nashville('C/E', 'C')).toBe('1/3')
  })
})
