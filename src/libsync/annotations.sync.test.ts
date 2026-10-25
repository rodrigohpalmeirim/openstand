// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { flush, getItems, load, remoteChanged, resetHistory, undo, update } from '../annotations/store'
import { openLibrary } from '../db/db'
import type { EngineHooks } from './engine'
import { addSong, bytes, converge, enableDevice, joinDevice, page, stroke, world } from './sync.test-helper'

// The hooks service.ts installs for the active library.
const hooks: EngineHooks = {
  beforeApply: async (ops) => {
    if (ops.some((o) => o.c === 'ann')) await flush()
  },
  afterApply: async (a) => {
    if (a.anns.size) await remoteChanged(a.anns)
  },
}

describe('annotation store with sync', () => {
  it('never erases strokes that arrive from another device, also through undo', async () => {
    const w = world()
    const A = openLibrary(`ann-sync-${Date.now()}`) // the store works on the global db
    await addSong(A, 's1', 'Song', { files: [{ id: 'f1', data: bytes(1, 32) }] })
    await A.annotations.put(page('s1', 'f1', [stroke('base')]))
    const eA = await enableDevice(w, A, { hooks })
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)

    const k = 's1:f1:0'
    resetHistory()
    await load(k)
    update(k, 'Pen stroke', (items) => [...items, stroke('localA')]) // in memory, not flushed yet

    await B.annotations.put(page('s1', 'f1', [stroke('base'), stroke('fromB')]))
    await eB.sync()
    await eA.sync() // flushes the store first, applies B's stroke, reloads the page
    expect(getItems(k).map((i) => i.id).sort()).toEqual(['base', 'fromB', 'localA'])
    await converge(eA, eB)
    // Same z-order everywhere (concurrent additions sort by birth).
    expect((await B.annotations.get(k))!.items.map((i) => i.id)).toEqual(getItems(k).map((i) => i.id))

    // Undo the local stroke: B's stroke stays, on both devices.
    expect(undo()).toBe('Pen stroke')
    await flush()
    await converge(eA, eB)
    expect(getItems(k).map((i) => i.id)).toEqual(['base', 'fromB'])
    expect((await B.annotations.get(k))!.items.map((i) => i.id)).toEqual(['base', 'fromB'])

    // B erases everything while A draws: A's new stroke survives the "erase all".
    update(k, 'Pen stroke', (items) => [...items, stroke('late')])
    await B.annotations.delete(k)
    await eB.sync()
    await flush()
    await converge(eA, eB)
    expect(getItems(k).map((i) => i.id)).toEqual(['late'])
    expect((await B.annotations.get(k))!.items.map((i) => i.id)).toEqual(['late'])
  })
})
