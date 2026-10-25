// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { db, putBlob } from '../db/db'
import { emptySong } from '../db/schema'
import { buildListRows, exportSongFiles, gigLine, listToText } from './exportSongs'

const delivered = vi.hoisted(() => [] as File[][])
vi.mock('./deliver', async (orig) => ({
  ...(await orig<typeof import('./deliver')>()),
  deliverFiles: async (files: File[]) => (delivered.push(files), true),
}))
vi.mock('../ui/primitives', () => ({ toast: vi.fn(), confirmDialog: vi.fn() }))

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

  it('puts a setlist’s gig date and venue under the heading', () => {
    expect(gigLine({ venue: 'Town Hall' })).toBe('Town Hall')
    expect(gigLine({ date: '2025-03-14', venue: ' Town Hall ' })).toMatch(/2025.* · Town Hall$/)
    expect(gigLine({})).toBe('')
    expect(listToText('Friday', [], { subtitle: 'Town Hall' })).toMatch(/^Friday\n=+\nTown Hall\n\n/)
  })
})

describe('file export', () => {
  it('a joined PDF with a repeated text song ships its text file once', async () => {
    const { id: blobId, size } = await putBlob(new TextEncoder().encode('{title: X}').buffer as ArrayBuffer, 'text/plain')
    const x = emptySong({ id: 'x', title: 'X', files: [{ id: 'f', name: 'x.cho', kind: 'chordpro', blobId, pageCount: 1, size }] })
    await db.songs.put(x)
    await exportSongFiles(['x', 'x'], { merge: true, zip: false })
    expect(delivered.at(-1)?.map((f) => f.name)).toEqual(['x.cho'])
  })
})
