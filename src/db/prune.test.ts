// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, pruneAnnotations } from './db'
import { emptySong, type SongFile } from './schema'

const file = (id: string): SongFile => ({ id, name: `${id}.pdf`, kind: 'pdf', blobId: `b-${id}` }) as SongFile
const page = (songId: string, fileId: string) => ({ id: `${songId}:${fileId}:0`, songId, fileId, page: 0, items: [] })

describe('pruneAnnotations', () => {
  beforeEach(async () => {
    await db.songs.clear()
    await db.annotations.clear()
    await db.songs.bulkPut([emptySong({ id: 's1', title: 'A', files: [file('a')] }), emptySong({ id: 's2', title: 'B', files: [file('b')] })])
    await db.annotations.bulkPut([page('s1', 'a'), page('s1', 'gone'), page('s2', 'b'), page('s2', 'gone'), page('deleted', 'x')])
  })

  it('only tidies the given song', async () => {
    expect(await pruneAnnotations('s1')).toBe(1)
    expect((await db.annotations.toCollection().primaryKeys()).sort()).toEqual(['deleted:x:0', 's1:a:0', 's2:b:0', 's2:gone:0'])
  })

  it('drops pages of removed files and deleted songs', async () => {
    expect(await pruneAnnotations()).toBe(3)
    expect((await db.annotations.toCollection().primaryKeys()).sort()).toEqual(['s1:a:0', 's2:b:0'])
  })
})
