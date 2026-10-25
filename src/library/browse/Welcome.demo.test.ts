import { describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import { createDemoSongs, isUntouchedDemo } from './Welcome'

describe('isUntouchedDemo', () => {
  it('recognises demo songs only while they are untouched', async () => {
    await db.songs.clear()
    await createDemoSongs()
    const [a, b] = await db.songs.toArray()
    expect(await isUntouchedDemo(a)).toBe(true)
    expect(await isUntouchedDemo(b)).toBe(true)
    expect(await isUntouchedDemo({ ...a, modifiedAt: a.modifiedAt + 1 })).toBe(false)
    expect(await isUntouchedDemo({ ...a, title: 'My song' })).toBe(false)
    expect(await isUntouchedDemo({ ...a, files: [a.files[0], a.files[0]] })).toBe(false)
    expect(await isUntouchedDemo({ ...a, files: [b.files[0]] })).toBe(false) // other demo's content
    await db.annotations.put({ id: `${a.id}:${a.files[0].id}:0`, songId: a.id, fileId: a.files[0].id, page: 0, items: [] })
    expect(await isUntouchedDemo(a)).toBe(false)
  })
})
