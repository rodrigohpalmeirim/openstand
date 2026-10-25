import { describe, expect, it, vi } from 'vitest'
import { db } from '../db/db'
import { emptySong, type StrokeAnnotation } from '../db/schema'
import { rotateItems, rotateSongPages } from './rotate'
import { getItems, load, pageKey, setItems, flush } from './store'

vi.mock('../viewer/pageSource', () => ({ pageSize: async () => ({ width: 100, height: 200 }) }))

describe('rotateSongPages', () => {
  it('two quick rotations turn the page and its annotations the same number of times', async () => {
    const file = { id: 'f', name: 'a.png', kind: 'image' as const, blobId: 'b', pageCount: 1, size: 1 }
    const song = emptySong({ id: 'rot-song', title: 'x', files: [file] })
    await db.songs.put(song)
    const key = pageKey(song.id, 'f', 0)
    await load(key)
    const pen: StrokeAnnotation = { id: 'p', type: 'pen', layer: 'default', color: '#000', opacity: 1, createdAt: 0, width: 0.003, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.1 }] }
    setItems(key, [pen])
    await flush()

    // Both calls get the same (soon stale) song, as two quick taps in the Display panel would.
    await Promise.all([rotateSongPages(song, ['f:0'], 90), rotateSongPages(song, ['f:0'], 90)])

    expect((await db.songs.get(song.id))?.pageSettings['f:0']?.rotation).toBe(180)
    const once = rotateItems([pen], 1, 2)
    expect(getItems(key)).toEqual(rotateItems(once, 1, 0.5))
  })
})
