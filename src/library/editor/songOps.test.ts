import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import { emptySong } from '../../db/schema'
import { createIndexSongs, createSnippet, duplicateSong } from './songOps'

const file = (id: string, pageCount: number) => ({ id, name: `${id}.pdf`, kind: 'pdf' as const, blobId: `blob-${id}`, pageCount, size: 1 })

describe('songOps', () => {
  beforeEach(async () => {
    await db.songs.clear()
    await db.annotations.clear()
    const s = emptySong({ id: 's1', title: 'Song', artists: ['A'] })
    s.files = [file('f1', 3), file('f2', 2)]
    s.pageSettings = { 'f1:2': { rotation: 90 }, 'f1:0': { rotation: 180 } }
    s.bookmarks = [{ id: 'b', name: 'Coda', pageIndex: 3 }]
    await db.songs.put(s)
    await db.annotations.put({ id: 's1:f1:2', songId: 's1', fileId: 'f1', page: 2, items: [] })
  })

  it('duplicates with a unique title and annotations', async () => {
    const c = await duplicateSong('s1')
    expect(c!.title).toBe('Song (1)')
    expect(await db.annotations.where('songId').equals(c!.id).count()).toBe(1)
    expect((await duplicateSong('s1'))!.title).toBe('Song (2)')
  })

  it('creates a snippet from a page range of the resolved order', async () => {
    const s = await createSnippet('s1', 2, 3)
    expect(s!.pageOrder).toEqual([
      { fileId: 'f1', page: 2 },
      { fileId: 'f2', page: 0 },
    ])
    expect(Object.keys(s!.pageSettings)).toEqual(['f1:2'])
    expect(s!.bookmarks.map((b) => b.pageIndex)).toEqual([1])
    expect(s!.artists).toEqual(['A'])
    expect(s!.title).toBe('Song (pages 3-4)')
    expect(await db.annotations.where('songId').equals(s!.id).count()).toBe(1)
  })

  it('creates index songs sharing one blob', async () => {
    const songs = await createIndexSongs({ name: 'Book.pdf', kind: 'pdf', blobId: 'bk', pageCount: 50, size: 9 }, [
      { title: 'One', pages: [0, 1], fields: { artists: 'X, Y', difficulty: '7' } },
      { title: 'Two', pages: [2], fields: {} },
    ])
    expect(songs.map((s) => s.files[0].blobId)).toEqual(['bk', 'bk'])
    expect(songs[0].pageOrder!.map((r) => r.page)).toEqual([0, 1])
    expect(songs[0].pageOrder![0].fileId).toBe(songs[0].files[0].id)
    expect(songs[0].artists).toEqual(['X', 'Y'])
    expect(songs[0].difficulty).toBe(7)
    expect(songs[1].sourcePage).toBe(3)
  })
})
