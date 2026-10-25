// Stale-writer fixes: the text editor and "add files" may hold a song copy that is
// minutes old; they must change only what they touch on the song as stored now.
import { describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { Song } from '../db/schema'
import { addFilesToSong, createTextSong, updateTextFile } from './import'

describe('stale song copies', () => {
  it('updateTextFile keeps fields changed meanwhile (e.g. synced from another device)', async () => {
    const song = await createTextSong('Tune', '{title: Tune}\n[C]la', 'chordpro')
    const stale = structuredClone(song)
    await db.songs.put({ ...song, rating: 5, tags: ['remote'], notes: 'from the other device' })
    const next = await updateTextFile(stale, song.files[0].id, '{title: Tune}\n{key: G}\n[G]la la')
    const stored = (await db.songs.get(song.id)) as Song
    expect(stored).toEqual(next)
    expect([stored.rating, stored.tags, stored.notes, stored.keys]).toEqual([5, ['remote'], 'from the other device', ['G']])
    expect(stored.files[0].blobId).not.toBe(song.files[0].blobId)
    expect((await db.blobs.get(stored.files[0].blobId))?.size).toBeGreaterThan(0)
  })

  it('addFilesToSong appends to the stored song, not the stale copy', async () => {
    const song = await createTextSong('Two', 'x', 'text')
    const stale = structuredClone(song)
    await db.songs.put({ ...song, title: 'Renamed elsewhere' })
    const file = new File(['hello'], 'extra.txt', { type: 'text/plain' })
    const next = await addFilesToSong(stale, [file])
    expect(next.title).toBe('Renamed elsewhere')
    expect(next.files).toHaveLength(2)
    expect((await db.songs.get(song.id))?.title).toBe('Renamed elsewhere')
  })
})
