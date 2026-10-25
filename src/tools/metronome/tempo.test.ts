import { describe, expect, it } from 'vitest'
import { emptySong } from '../../db/schema'
import { songMetronome } from './engine'
import { applyTempoEdit, parseSignature, retempo, songBpm } from './tempo'

describe('parseSignature', () => {
  it('reads n/d, additive meters and the C symbols', () => {
    expect(parseSignature('3/4')).toEqual({ beatsPerBar: 3, beatUnit: 4 })
    expect(parseSignature(' 6 / 8 ')).toEqual({ beatsPerBar: 6, beatUnit: 8 })
    expect(parseSignature('2+3/8')).toEqual({ beatsPerBar: 5, beatUnit: 8 })
    expect(parseSignature('C')).toEqual({ beatsPerBar: 4, beatUnit: 4 })
    expect(parseSignature('C|')).toEqual({ beatsPerBar: 2, beatUnit: 2 })
  })
  it('rejects what the metronome cannot play', () => {
    for (const s of [undefined, '', 'waltz', '3/5', '0/4', '17/8', '4/4/4']) expect(parseSignature(s)).toBeNull()
  })
})

describe('song tempo', () => {
  it('lets an older per-song metronome bpm win over the tempo list', () => {
    expect(songBpm({ tempos: [120], metronome: { bpm: 100 } })).toBe(100)
    expect(songBpm({ tempos: [0, 120], metronome: {} })).toBe(120)
    expect(songBpm({ tempos: [], metronome: { bpm: 100 } })).toBe(100)
    expect(songBpm({})).toBeUndefined()
  })
  it('drops the old metronome bpm when the Tempo field was edited, and only then', () => {
    const before: { tempos: number[]; metronome?: { bpm?: number; countIn?: number } } = { tempos: [120], metronome: { bpm: 100, countIn: 1 } }
    expect(applyTempoEdit(before, { ...before, tempos: [130] })).toEqual({ tempos: [130], metronome: { countIn: 1 } })
    expect(applyTempoEdit(before, { ...before, metronome: { bpm: 100 } })).toEqual({ ...before, metronome: { bpm: 100 } })
    const plain = { tempos: [90], metronome: { bpm: 100 } }
    expect(applyTempoEdit(plain, { tempos: [] as number[], metronome: { bpm: 100 } })).toEqual({ tempos: [], metronome: undefined })
    expect(applyTempoEdit(undefined, plain)).toBe(plain)
  })
  it('edits the tempo being played, else the first, and drops the old metronome bpm', () => {
    expect(retempo({ tempos: [100, 140] }, 140, 141)).toEqual({ tempos: [100, 141], metronome: undefined })
    expect(retempo({ tempos: [100, 140] }, 90, 95)).toEqual({ tempos: [95, 140], metronome: undefined })
    expect(retempo({}, 100, 101)).toEqual({ tempos: [101], metronome: undefined })
    expect(retempo({ tempos: [100], metronome: { bpm: 100, countIn: 1 } }, 100, 110)).toEqual({ tempos: [110], metronome: { countIn: 1 } })
  })
})

describe('songMetronome', () => {
  it('takes the meter from the song’s time signature and the bpm from its tempo', () => {
    const s = emptySong({ id: 's', title: 'Waltz', signatures: ['3/4'], tempos: [90] })
    expect(songMetronome(s)).toMatchObject({ beatsPerBar: 3, beatUnit: 4, bpm: 90 })
  })
  it('lets per-song metronome settings override the signature, and an older metronome bpm the tempo list', () => {
    // Songs saved by older versions keep their tempo; editing Tempo in the editor drops the old copy.
    const s = emptySong({ id: 's', title: 'x', signatures: ['6/8'], tempos: [120], metronome: { bpm: 100, beatsPerBar: 2 } })
    expect(songMetronome(s)).toMatchObject({ beatsPerBar: 2, beatUnit: 8, bpm: 100 })
    expect(songMetronome(applyTempoEdit(s, { ...s, tempos: [130] }))).toMatchObject({ beatsPerBar: 2, bpm: 130 })
  })
})
