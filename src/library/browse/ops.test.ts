import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import { emptySong } from '../../db/schema'
import { useViewer } from '../../state/viewer'
import {
  addToSetlist,
  applyBatch,
  createSetlist,
  deleteGroup,
  deleteSongs,
  duplicateSong,
  performSetlist,
  renameGroup,
} from './ops'

beforeEach(async () => {
  await Promise.all([db.songs.clear(), db.setlists.clear(), db.annotations.clear(), db.kv.clear()])
  await db.songs.bulkPut([
    emptySong({ id: 'a', title: 'Alpha', artists: ['Miles', 'Bill'] }),
    emptySong({ id: 'b', title: 'Beta', artists: ['miles davis'] }),
    emptySong({ id: 'c', title: 'Gamma', artists: ['Miles Davis'] }),
  ])
})

describe('group operations', () => {
  it('renames and merges into an existing value without duplicates', async () => {
    await renameGroup('artists', 'Miles', 'Miles Davis')
    expect((await db.songs.get('a'))!.artists).toEqual(['Miles Davis', 'Bill'])
    // b had a case variant: untouched by this rename
    expect((await db.songs.get('b'))!.artists).toEqual(['miles davis'])
    await renameGroup('artists', 'Bill', 'Miles Davis')
    expect((await db.songs.get('a'))!.artists).toEqual(['Miles Davis'])
  })
  it('deletes a value from every song, case-insensitively', async () => {
    await deleteGroup('artists', 'MILES DAVIS')
    expect((await db.songs.get('b'))!.artists).toEqual([])
    expect((await db.songs.get('c'))!.artists).toEqual([])
    expect((await db.songs.get('a'))!.artists).toEqual(['Miles', 'Bill'])
  })
})

describe('songs', () => {
  it('deleting songs prunes setlist entries', async () => {
    const id = await createSetlist('Gig', ['a', 'b', 'a'])
    await deleteSongs(['a'])
    expect(await db.songs.get('a')).toBeUndefined()
    expect((await db.setlists.get(id))!.entries.map((e) => e.songId)).toEqual(['b'])
  })
  it('duplicates with a unique title and copied annotations', async () => {
    await db.annotations.put({ id: 'a:f:0', songId: 'a', fileId: 'f', page: 0, items: [] })
    const copy = (await duplicateSong('a'))!
    expect(copy.title).toBe('Alpha (1)')
    expect(await db.annotations.get(`${copy.id}:f:0`)).toBeTruthy()
  })
  it('batch edit adds, removes and replaces', () => {
    const s = emptySong({ id: 'x', title: 'X', genres: ['Jazz'] })
    expect(applyBatch(s, { groups: [{ kind: 'group', field: 'genres', mode: 'add', value: 'Swing' }] }).genres).toEqual(['Jazz', 'Swing'])
    expect(applyBatch(s, { groups: [{ kind: 'group', field: 'genres', mode: 'remove', value: 'jazz' }] }).genres).toEqual([])
    expect(applyBatch(s, { groups: [{ kind: 'group', field: 'genres', mode: 'set', value: 'A; B' }], rating: 4, key: 'G' })).toMatchObject({
      genres: ['A', 'B'],
      rating: 4,
      keys: ['G'],
    })
  })
})

describe('setlists', () => {
  it('inserts at a position and performs skipping breaks', async () => {
    const id = await createSetlist('Gig', ['a', 'b'])
    await addToSetlist(id, ['c'], 1)
    const sl = (await db.setlists.get(id))!
    expect(sl.entries.map((e) => e.songId)).toEqual(['a', 'c', 'b'])
    sl.entries.splice(1, 0, { key: 'brk', songId: '', isBreak: true })
    performSetlist(sl, 1)
    const v = useViewer.getState()
    expect(v.queue).toEqual(['a', 'c', 'b'])
    expect(v.index).toBe(1)
    expect(v.setlistId).toBe(id)
  })
})
