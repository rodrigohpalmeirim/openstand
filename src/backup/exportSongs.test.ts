// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { emptySong } from '../db/schema'
import { buildListRows, listToText } from './exportSongs'

describe('title lists', () => {
  const a = emptySong({ id: 'a', title: 'Autumn Leaves', artists: ['Kosma'], keys: ['Gm'], duration: 245 })
  const b = emptySong({ id: 'b', title: 'Blue Bossa' })
  const songs = new Map([a, b].map((s) => [s.id, s]))
  it('numbers songs, keeps breaks and skips missing songs', () => {
    const rows = buildListRows([{ songId: 'a', note: 'capo 2' }, { songId: '', isBreak: true, breakLabel: 'Intermission' }, { songId: 'gone' }, { songId: 'b' }, { songId: 'a' }], songs)
    expect(rows.map((r) => (r.kind === 'break' ? `-${r.title}-` : `${r.n}.${r.title}`))).toEqual(['1.Autumn Leaves', '-Intermission-', '2.Blue Bossa', '3.Autumn Leaves'])
    const txt = listToText('Friday', rows)
    expect(txt).toContain('Friday\n======')
    expect(txt).toContain('1. Autumn Leaves — Kosma (Gm, 4:05)  [capo 2]')
    expect(txt).toContain('— Intermission —')
    expect(txt).toContain('3 songs · 8:10')
    expect(listToText('', rows, { numbered: false, details: false })).toContain('\nBlue Bossa\n')
  })
})
