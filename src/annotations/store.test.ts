import { describe, expect, it } from 'vitest'
import { db } from '../db/db'
import type { Annotation, StrokeAnnotation } from '../db/schema'
import { cycleLayer, deleteLayer, getLayers, addLayer, moveLayer, setCurrentLayer } from './layers'
import { annotationsToSVG, sortByLayer, visibleItems } from './render'
import { commit, flush, getItems, load, pageKey, parseKey, redo, remoteChanged, replacePage, resetHistory, setItems, undo, update, useAnnotHistory } from './store'

const mk = (id: string, layer = 'default', type: 'pen' | 'highlighter' = 'pen'): StrokeAnnotation => ({
  id,
  type,
  layer,
  color: '#123456',
  opacity: 1,
  createdAt: 0,
  width: 0.003,
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.25 },
    { x: 0.3, y: 0.2 },
  ],
})

/** Let async undo side effects (layer list writes) finish. */
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('keys', () => {
  it('round-trips page keys', () => {
    const k = pageKey('song-1', 'file-2', 1003)
    expect(parseKey(k)).toEqual({ songId: 'song-1', fileId: 'file-2', page: 1003 })
  })
})

describe('store + undo', () => {
  it('commits, undoes and redoes across pages and persists', async () => {
    resetHistory()
    const k1 = pageKey('s1', 'f', 0)
    const k2 = pageKey('s1', 'f', 1)
    await load(k1)
    await load(k2)
    update(k1, 'a', (items) => [...items, mk('a')])
    commit('two pages', [
      { key: k1, before: getItems(k1), after: [...getItems(k1), mk('b')] },
      { key: k2, before: getItems(k2), after: [mk('c')] },
    ])
    expect(getItems(k1).map((i) => i.id)).toEqual(['a', 'b'])
    expect(useAnnotHistory.getState().canUndo).toBe(true)

    expect(undo()).toBe('two pages')
    expect(getItems(k1).map((i) => i.id)).toEqual(['a'])
    expect(getItems(k2)).toEqual([])
    expect(useAnnotHistory.getState().canRedo).toBe(true)

    expect(redo()).toBe('two pages')
    expect(getItems(k2).map((i) => i.id)).toEqual(['c'])

    await flush()
    const rec = await db.annotations.get(k1)
    expect(rec?.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(rec?.songId).toBe('s1')
    expect(rec?.page).toBe(0)

    // Emptying a page removes its record.
    undo()
    undo()
    await flush()
    expect(await db.annotations.get(k1)).toBeUndefined()
  })

  it('transient previews do not create history', () => {
    resetHistory()
    const k = pageKey('s2', 'f', 0)
    setItems(k, [mk('x')], false)
    expect(useAnnotHistory.getState().canUndo).toBe(false)
    expect(getItems(k)).toHaveLength(1)
  })

  it('handles 1000 strokes without trouble', () => {
    resetHistory()
    const k = pageKey('s3', 'f', 0)
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) update(k, 'stroke', (items) => [...items, mk('m' + i)])
    expect(getItems(k)).toHaveLength(1000)
    const svg = annotationsToSVG(getItems(k), 800, 1100)
    expect(svg.match(/<path/g)).toHaveLength(1000)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

describe('layers', () => {
  it('creates, cycles and deletes layers (deleting removes their annotations)', async () => {
    resetHistory()
    const songId = 'layer-song'
    expect((await getLayers(songId)).layers.map((l) => l.name)).toEqual(['Default'])
    const id = await addLayer(songId, 'Fingering')
    let L = await getLayers(songId)
    expect(L.current).toBe(id)
    const k = pageKey(songId, 'f', 0)
    await load(k)
    update(k, 'x', () => [mk('keep'), mk('gone', id)])
    await flush()

    // New layers are appended (later = drawn on top), as older builds do.
    expect(L.layers.map((l) => l.name)).toEqual(['Default', 'Fingering'])

    // Performance cycling: solo each layer, then all.
    expect(await cycleLayer(songId, 1, false)).toBe('Layer: Default')
    L = await getLayers(songId)
    expect(L.layers.map((l) => l.visible)).toEqual([true, false])
    expect(await cycleLayer(songId, 1, false)).toBe('Layer: Fingering')
    expect(await cycleLayer(songId, 1, false)).toBe('All layers')

    await deleteLayer(songId, id)
    expect(getItems(k).map((i: Annotation) => i.id)).toEqual(['keep'])
    L = await getLayers(songId)
    expect(L.layers).toHaveLength(1)
    expect(L.current).toBe('default')
  })

  it('undoing "Delete layer" brings back the layer with its annotations', async () => {
    resetHistory()
    const songId = 'layer-undo'
    const a = await addLayer(songId, 'A')
    const b = await addLayer(songId, 'B')
    await setCurrentLayer(songId, a)
    const k = pageKey(songId, 'f', 0)
    await load(k)
    update(k, 'x', () => [mk('d'), mk('in-a', a), mk('in-b', b)])

    await deleteLayer(songId, a)
    expect(getItems(k).map((i) => i.id)).toEqual(['d', 'in-b'])
    expect((await getLayers(songId)).layers.map((l) => l.name)).toEqual(['Default', 'B'])

    expect(undo()).toBe('Delete layer')
    expect(getItems(k).map((i) => i.id)).toEqual(['d', 'in-a', 'in-b'])
    await settle()
    let L = await getLayers(songId)
    expect(L.layers.map((l) => l.name)).toEqual(['Default', 'A', 'B'])
    expect(L.current).toBe(a)

    expect(redo()).toBe('Delete layer')
    await settle()
    L = await getLayers(songId)
    expect(L.layers.map((l) => l.name)).toEqual(['Default', 'B'])
    expect(getItems(k).map((i) => i.id)).toEqual(['d', 'in-b'])
  })

  it('moves layers: +1 = later in the list = drawn higher', async () => {
    const songId = 'layer-move'
    const a = await addLayer(songId, 'A')
    await moveLayer(songId, a, 1)
    expect((await getLayers(songId)).layers.map((l) => l.name)).toEqual(['Default', 'A'])
    await moveLayer(songId, a, -1)
    expect((await getLayers(songId)).layers.map((l) => l.name)).toEqual(['A', 'Default'])
  })

  it('draws in layer order: later in the stored list on top, creation order within a layer', () => {
    const layers = [
      { id: 'off', name: 'Off', visible: false },
      { id: 'default', name: 'Default', visible: true },
      { id: 'top', name: 'Top', visible: true },
    ]
    const items = [mk('t1', 'top'), mk('d1'), mk('gone', 'deleted-layer'), mk('t2', 'top'), mk('d2'), mk('o', 'off')]
    expect(sortByLayer(items, layers).map((i) => i.id)).toEqual(['gone', 'o', 'd1', 'd2', 't1', 't2'])
    expect(visibleItems(items, layers).map((i) => i.id)).toEqual(['gone', 'd1', 'd2', 't1', 't2'])
    const sorted = [mk('d1'), mk('t1', 'top')]
    expect(sortByLayer(sorted, layers)).toBe(sorted)
    const svg = annotationsToSVG([{ ...mk('t'), layer: 'top', color: '#aa0000' }, mk('d')], 100, 100, { layers })
    expect(svg.indexOf('#123456')).toBeLessThan(svg.indexOf('#aa0000'))
  })
})

describe('page rewrites outside the history', () => {
  it('replacePage drops the page from undo steps and keeps other pages', async () => {
    resetHistory()
    const k1 = pageKey('rw', 'f', 0)
    const k2 = pageKey('rw', 'f', 1)
    await load(k1)
    await load(k2)
    update(k1, 'one', (items) => [...items, mk('a')])
    commit('both', [
      { key: k1, before: getItems(k1), after: [...getItems(k1), mk('b')] },
      { key: k2, before: getItems(k2), after: [mk('c')] },
    ])
    replacePage(k1, [mk('a2'), mk('b2')]) // e.g. the page was rotated
    expect(undo()).toBe('both')
    expect(getItems(k1).map((i) => i.id)).toEqual(['a2', 'b2'])
    expect(getItems(k2)).toEqual([])
    expect(undo()).toBeUndefined() // 'one' only touched the rewritten page
  })
})

describe('export', () => {
  it('renders SVG with highlights first and multiply blending, skipping hidden layers', () => {
    const items: Annotation[] = [
      mk('p'),
      mk('h', 'default', 'highlighter'),
      { id: 't', type: 'text', layer: 'hidden', color: '#ff0000', opacity: 1, createdAt: 0, at: { x: 0.1, y: 0.1 }, text: 'a <b>', size: 0.02 },
      { id: 's', type: 'stamp', layer: 'default', color: '#000', opacity: 0.5, createdAt: 0, at: { x: 0.5, y: 0.5 }, stamp: 'coda', size: 0.05 },
    ]
    const all = annotationsToSVG(items, 600, 800)
    expect(all.startsWith('<svg')).toBe(true)
    expect(all).toContain('width="600"')
    expect(all.indexOf('mix-blend-mode:multiply')).toBeLessThan(all.indexOf('#123456'))
    expect(all).toContain('a &lt;b&gt;')
    expect(all).toContain('transform="translate(')
    const visible = annotationsToSVG(items, 600, 800, { layers: [{ id: 'default', name: 'D', visible: true }, { id: 'hidden', name: 'H', visible: false }] })
    expect(visible).not.toContain('a &lt;b&gt;')
  })
})

describe('remote changes (library sync)', () => {
  const ids = (k: string) => getItems(k).map((i) => i.id)
  const stored = async (k: string) => (await db.annotations.get(k))?.items.map((i) => i.id) ?? []
  const remotePut = (k: string, items: Annotation[]) => db.annotations.put({ id: k, ...parseKey(k), items })

  it('flush is three-way: strokes written meanwhile by another device survive', async () => {
    resetHistory()
    const k = pageKey('r1', 'f', 0)
    await remotePut(k, [mk('a')])
    await load(k)
    update(k, 'b', (items) => [...items, mk('b')])
    await remotePut(k, [mk('a'), mk('r')]) // sync applied a remote stroke before our flush
    await flush()
    expect(await stored(k)).toEqual(['a', 'r', 'b'])
    expect(ids(k)).toEqual(['a', 'r', 'b'])
  })

  it('a local erase only removes the erased item', async () => {
    resetHistory()
    const k = pageKey('r2', 'f', 0)
    await remotePut(k, [mk('a'), mk('b')])
    await load(k)
    update(k, 'erase', (items) => items.filter((i) => i.id !== 'a'))
    await remotePut(k, [mk('a'), mk('b'), mk('r')])
    await flush()
    expect(await stored(k)).toEqual(['b', 'r'])
  })

  it('remoteChanged reloads clean pages and rebases dirty ones', async () => {
    resetHistory()
    const clean = pageKey('r3', 'f', 0)
    const dirtyKey = pageKey('r3', 'f', 1)
    await remotePut(clean, [mk('a')])
    await remotePut(dirtyKey, [mk('x')])
    await load(clean)
    await load(dirtyKey)
    update(dirtyKey, 'y', (items) => [...items, mk('y')])
    await remotePut(clean, [mk('a'), mk('r')])
    await remotePut(dirtyKey, [mk('x'), mk('s')])
    await remoteChanged([clean, dirtyKey, pageKey('not', 'loaded', 0)])
    expect(ids(clean)).toEqual(['a', 'r'])
    expect(ids(dirtyKey)).toEqual(['x', 's', 'y'])
    await flush()
    expect(await stored(dirtyKey)).toEqual(['x', 's', 'y'])
  })

  it('undo applies the inverse diff and keeps remote items', async () => {
    resetHistory()
    const k = pageKey('r4', 'f', 0)
    await load(k)
    update(k, 'b', (items) => [...items, mk('b')])
    await flush()
    await remotePut(k, [mk('b'), mk('r')])
    await remoteChanged([k])
    expect(undo()).toBe('b')
    expect(ids(k)).toEqual(['r'])
    redo()
    expect(ids(k)).toEqual(['r', 'b'])
    await flush()
    expect(await stored(k)).toEqual(['r', 'b'])
  })

  it('a drag that overlaps a remote change keeps the remote item', async () => {
    resetHistory()
    const k = pageKey('r5', 'f', 0)
    await remotePut(k, [mk('a')])
    await load(k)
    const before = getItems(k)
    const moved = { ...before[0], color: '#ff0000' }
    setItems(k, [moved], false) // drag preview
    await remotePut(k, [mk('a'), mk('r')])
    await remoteChanged([k])
    expect(ids(k)).toEqual(['a']) // the preview stays while dragging
    commit('Move', [{ key: k, before, after: [moved] }])
    expect(ids(k)).toEqual(['a', 'r'])
    await flush()
    expect(await stored(k)).toEqual(['a', 'r'])
    expect((await db.annotations.get(k))?.items[0].color).toBe('#ff0000')

    // A cancelled drag restores the current items, not the stale snapshot.
    const start = getItems(k)
    setItems(k, [], false)
    await remotePut(k, [mk('a'), mk('r'), mk('s')])
    await remoteChanged([k])
    setItems(k, start, false)
    expect(ids(k)).toEqual(['a', 'r', 's'])
  })
})
