// @vitest-environment node
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { OpenStandDB } from './db'

it('upgrades a version-1 database to version 2 without touching library data', async () => {
  const name = 'upgrade-test'
  const v1 = new Dexie(name)
  v1.version(1).stores({ songs: 'id, title', setlists: 'id', blobs: 'id, hash', annotations: 'id, songId, fileId', thumbs: 'id', kv: 'key' })
  await v1.table('songs').put({ id: 's1', title: 'A' })
  await v1.table('kv').put({ key: 'k', value: 1 })
  v1.close()

  const db = new OpenStandDB(name)
  await db.open()
  expect(db.verno).toBe(2)
  expect(await db.songs.get('s1')).toMatchObject({ title: 'A' })
  expect(await db.kv.get('k')).toEqual({ key: 'k', value: 1 })

  await db.syncState.put({ key: 'seq', value: { next: 1 } })
  await db.syncDirty.put({ id: 'song/s1', at: 1 })
  await db.syncTransfers.put({ dir: 'down', hash: 'h', size: 1, mime: 'x', state: 'queued', priority: 0, attempts: 0, nextAt: 0 })
  await db.syncChunks.put({ hash: 'h', index: 0, data: new Blob(['x']) })
  expect(await db.syncTransfers.get(['down', 'h'])).toMatchObject({ state: 'queued' })
  expect(await db.syncChunks.where('[hash+index]').between(['h', 0], ['h', Infinity]).count()).toBe(1)
  expect(await db.syncState.get('seq')).toEqual({ key: 'seq', value: { next: 1 } })
  db.close()
  await Dexie.delete(name)
})
