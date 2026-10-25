import { describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import { emptySong, type Song } from '../../db/schema'
import { rebaseOnLatest as rebaseOn } from '../../libsync/state'

const rebaseOnLatest = (base: Song, edited: Song) => rebaseOn(db, base, edited)

describe('SongEditor save rebases onto the stored song', () => {
  it('keeps edits that arrived from another device while the editor was open', async () => {
    const base = emptySong({ id: 'ed1', title: 'Old', tags: ['a'], notes: '', rating: 0 })
    base.bookmarks = [{ id: 'b1', name: 'Intro', pageIndex: 0 }]
    await db.songs.put(base)
    // Opened in the editor: the draft is a copy of `base`. Meanwhile sync writes a remote edit.
    await db.songs.put({ ...base, rating: 4, tags: ['a', 'remote'], bookmarks: [...base.bookmarks, { id: 'b2', name: 'Coda', pageIndex: 2 }] })
    const draft: Song = { ...structuredClone(base), title: 'New title', notes: 'mine', tags: ['a', 'mine'], modifiedAt: 99 }
    const saved = await rebaseOnLatest(base, draft)
    expect(saved).not.toBe('deleted')
    const s = saved as Song
    expect([s.title, s.notes, s.rating, s.modifiedAt]).toEqual(['New title', 'mine', 4, 99])
    expect([...s.tags].sort()).toEqual(['a', 'mine', 'remote'])
    expect(s.bookmarks.map((b) => b.id)).toEqual(['b1', 'b2'])
  })

  it('reports a song deleted meanwhile', async () => {
    const base = emptySong({ id: 'ed2', title: 'Gone' })
    expect(await rebaseOnLatest(base, { ...base, title: 'x' })).toBe('deleted')
  })
})
