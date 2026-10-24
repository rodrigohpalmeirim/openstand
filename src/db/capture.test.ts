// @vitest-environment node
import 'fake-indexeddb/auto'
import Dexie, { type Table } from 'dexie'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { markRemote, setCaptureOn, setKvFilter } from './capture'
import { OpenStandDB, openLibrary, recordPlay } from './db'
import { emptySong, type Setlist } from './schema'

const db = new OpenStandDB('capture-test')
const dirty = async () => (await db.syncDirty.toCollection().primaryKeys()).sort()
const setlist = (id: string): Setlist => ({ id, name: id, entries: [], createdAt: 0, modifiedAt: 0 }) as unknown as Setlist
const page = (id: string, songId = 's1') => ({ id, songId, fileId: 'f', page: 0, items: [] })

describe('capture middleware', () => {
  beforeEach(async () => {
    setCaptureOn(db.name, false)
    await Promise.all([db.songs.clear(), db.setlists.clear(), db.annotations.clear(), db.kv.clear(), db.syncDirty.clear()])
    await db.songs.bulkPut([emptySong({ id: 's1', title: 'A' }), emptySong({ id: 's2', title: 'B' }), emptySong({ id: 's3', title: 'C' })])
    setCaptureOn(db.name, true)
    setKvFilter((k) => k.startsWith('layers:') || k.startsWith('library:'))
  })
  afterAll(() => setCaptureOn(db.name, false))

  it('captures nothing while the flag is off', async () => {
    setCaptureOn(db.name, false)
    await db.songs.put(emptySong({ id: 'x', title: 'X' }))
    await db.songs.delete('s1')
    expect(await dirty()).toEqual([])
  })

  it('put, bulkPut and add', async () => {
    await db.songs.put(emptySong({ id: 'p', title: 'P' }))
    await db.songs.bulkPut([emptySong({ id: 'q', title: 'Q' }), emptySong({ id: 'r', title: 'R' })])
    await db.setlists.add(setlist('L'))
    expect(await dirty()).toEqual(['setlist/L', 'song/p', 'song/q', 'song/r'])
    const row = await db.syncDirty.get('song/p')
    expect(row?.at).toBeGreaterThan(Date.now() - 5000)
  })

  it('update, db.table().update and Collection.modify', async () => {
    await (db.songs as unknown as Table<{ id: string; title: string }, string>).update('s1', { title: 'A2' })
    await db.table('songs').update('s2', { title: 'B2' })
    await db.songs
      .where('title')
      .equals('C')
      .modify((s) => void (s.rating = 3))
    expect(await dirty()).toEqual(['song/s1', 'song/s2', 'song/s3'])
  })

  it('recordPlay is an atomic, captured increment', async () => {
    const lib = openLibrary('capture-play')
    setCaptureOn(lib.name, true)
    await lib.songs.put(emptySong({ id: 'p', title: 'P' }))
    await lib.syncDirty.clear()
    await Promise.all([recordPlay('p', 5), recordPlay('p', 7)])
    const s = await lib.songs.get('p')
    expect([s?.playCount, s?.lastPlayedAt]).toEqual([2, 7])
    expect(await lib.syncDirty.toCollection().primaryKeys()).toEqual(['song/p'])
    setCaptureOn(lib.name, false)
  })

  it('delete, bulkDelete and where().anyOf().delete()', async () => {
    await db.songs.delete('s1')
    await db.songs.bulkDelete(['s2'])
    await db.annotations.bulkPut([page('a1'), page('a2', 's2')])
    await db.syncDirty.clear()
    await db.annotations.where('songId').anyOf(['s1', 's2']).delete()
    expect(await dirty()).toEqual(['ann/a1', 'ann/a2'])
    expect((await db.songs.count())).toBe(1)
  })

  it('clear() marks every existing key', async () => {
    await db.songs.clear()
    expect(await dirty()).toEqual(['song/s1', 'song/s2', 'song/s3'])
  })

  it('multi-table transactions and rollback', async () => {
    await db.transaction('rw', db.songs, db.setlists, async () => {
      await db.table('songs').update('s1', { title: 'T' })
      await db.setlists.put(setlist('L2'))
    })
    expect(await dirty()).toEqual(['setlist/L2', 'song/s1'])
    await db.syncDirty.clear()
    await expect(
      db.transaction('rw', db.songs, async () => {
        await db.table('songs').update('s2', { title: 'T' })
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(await dirty()).toEqual([])
  })

  it('only allow-listed kv keys', async () => {
    await db.kv.bulkPut([
      { key: 'layers:s1', value: 1 },
      { key: 'backup.lastAt', value: 2 },
      { key: 'library:savedFilters', value: [] },
    ])
    expect(await dirty()).toEqual(['kv/layers:s1', 'kv/library:savedFilters'])
  })

  it('ignores blobs, thumbs and sync tables', async () => {
    await db.blobs.put({ id: 'b', hash: 'b', mime: 'x', size: 0, data: new Blob([]) })
    await db.thumbs.put({ id: 't' } as never)
    await db.syncShadow.put({ id: 'song/s1', c: 'song', f: {}, m: {}, l: {}, n: {} })
    expect(await dirty()).toEqual([])
  })

  it('remote transactions are not captured', async () => {
    await db.transaction('rw', db.songs, db.annotations, async () => {
      markRemote(Dexie.currentTransaction)
      await db.songs.put(emptySong({ id: 'remote', title: 'R' }))
      await db.annotations.put(page('ra'))
    })
    expect(await dirty()).toEqual([])
    await db.table('songs').update('remote', { title: 'local' })
    expect(await dirty()).toEqual(['song/remote'])
  })
})
