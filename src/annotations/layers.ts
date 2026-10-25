/** Named annotation layers per song, stored in db.kv under `layers:${songId}`. */
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getKV, setKV, uid } from '../db/db'
import type { Annotation, Layer, SongLayers } from '../db/schema'
import { commit, getItems, loadSong, type PageChange } from './store'

export const DEFAULT_LAYER: Layer = { id: 'default', name: 'Default', visible: true }
export const DEFAULT_LAYERS: SongLayers = { layers: [DEFAULT_LAYER], current: 'default' }

export const layersKey = (songId: string) => `layers:${songId}`

export function normalizeLayers(v: SongLayers | undefined): SongLayers {
  if (!v?.layers?.length) return DEFAULT_LAYERS
  return { layers: v.layers, current: v.layers.some((l) => l.id === v.current) ? v.current : v.layers[0].id }
}

export async function getLayers(songId: string): Promise<SongLayers> {
  return normalizeLayers(await getKV<SongLayers | undefined>(layersKey(songId), undefined))
}

export async function saveLayers(songId: string, v: SongLayers) {
  await setKV(layersKey(songId), v)
}

/** Live layer state for a song (re-renders on any change). */
export function useSongLayers(songId: string): SongLayers {
  const v = useLiveQuery(() => db.kv.get(layersKey(songId)).then((r) => r?.value as SongLayers | undefined), [songId])
  return normalizeLayers(v)
}

/** Items on hidden layers are not drawn. Items whose layer no longer exists stay visible. */
export function isVisible(it: Annotation, layers: SongLayers): boolean {
  const l = layers.layers.find((x) => x.id === it.layer)
  return !l || l.visible
}

let mutating: Promise<void> = Promise.resolve()

/** Read-modify-write of a song's layers, one at a time (a quick undo + redo must not interleave). */
function mutate(songId: string, fn: (v: SongLayers) => SongLayers): Promise<void> {
  const run = mutating.then(async () => {
    const v = await getLayers(songId)
    await saveLayers(songId, normalizeLayers(fn(v)))
  })
  mutating = run.catch(() => {})
  return run
}

export function nextLayerName(layers: Layer[]): string {
  for (let i = 2; ; i++) {
    const name = `Layer ${i}`
    if (!layers.some((l) => l.name === name)) return name
  }
}

export async function addLayer(songId: string, name?: string): Promise<string> {
  const id = uid()
  // Appended: later in the list draws on top (the Layers popover shows the list reversed).
  await mutate(songId, (v) => ({ layers: [...v.layers, { id, name: name?.trim() || nextLayerName(v.layers), visible: true }], current: id }))
  return id
}

export const renameLayer = (songId: string, id: string, name: string) =>
  mutate(songId, (v) => ({ ...v, layers: v.layers.map((l) => (l.id === id ? { ...l, name: name.trim() || l.name } : l)) }))

export const setLayerVisible = (songId: string, id: string, visible: boolean) =>
  mutate(songId, (v) => ({ ...v, layers: v.layers.map((l) => (l.id === id ? { ...l, visible } : l)) }))

export const setCurrentLayer = (songId: string, id: string) =>
  mutate(songId, (v) => ({ layers: v.layers.map((l) => (l.id === id ? { ...l, visible: true } : l)), current: id }))

/** Move a layer in the stored list: +1 = later = drawn above the next layer ("up" in the popover). */
export const moveLayer = (songId: string, id: string, dir: -1 | 1) =>
  mutate(songId, (v) => {
    const i = v.layers.findIndex((l) => l.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= v.layers.length) return v
    const layers = v.layers.slice()
    ;[layers[i], layers[j]] = [layers[j], layers[i]]
    return { ...v, layers }
  })

/** Count annotations on a layer across the whole song. */
export async function countLayerItems(songId: string, id: string): Promise<number> {
  const keys = await loadSong(songId)
  return keys.reduce((n, k) => n + getItems(k).filter((i) => i.layer === id).length, 0)
}

const withoutLayer = (v: SongLayers, id: string): SongLayers => {
  if (v.layers.length <= 1) return v
  const layers = v.layers.filter((l) => l.id !== id)
  return { layers, current: v.current === id ? layers[0].id : v.current }
}

/** Delete a layer and its annotations, as one undo step. */
export async function deleteLayer(songId: string, id: string) {
  const v = await getLayers(songId)
  const index = v.layers.findIndex((l) => l.id === id)
  if (v.layers.length <= 1 || index < 0) return
  const layer = v.layers[index]
  const wasCurrent = v.current === id
  const keys = await loadSong(songId)
  const changes: PageChange[] = []
  for (const key of keys) {
    const before = getItems(key)
    if (before.some((i) => i.layer === id)) changes.push({ key, before, after: before.filter((i) => i.layer !== id) })
  }
  // Undo puts the layer back where it was in the list as it is then (layers may have changed since).
  const restore = (cur: SongLayers): SongLayers => {
    if (cur.layers.some((l) => l.id === id)) return cur
    const layers = cur.layers.slice()
    layers.splice(Math.min(index, layers.length), 0, layer)
    return { layers, current: wasCurrent ? id : cur.current }
  }
  commit('Delete layer', changes, { undo: () => void mutate(songId, restore), redo: () => void mutate(songId, (cur) => withoutLayer(cur, id)) })
  await mutate(songId, (cur) => withoutLayer(cur, id))
}

/**
 * Step through layers. While annotating this changes the current layer; while performing it shows
 * exactly one layer at a time, then all of them again ("hide/show annotations while performing").
 */
export async function cycleLayer(songId: string, dir: 1 | -1, annotating: boolean): Promise<string> {
  const v = await getLayers(songId)
  const n = v.layers.length
  if (annotating) {
    const i = v.layers.findIndex((l) => l.id === v.current)
    const next = v.layers[(i + dir + n) % n]
    await setCurrentLayer(songId, next.id)
    return `Layer: ${next.name}`
  }
  if (n === 1) {
    const l = v.layers[0]
    await setLayerVisible(songId, l.id, !l.visible)
    return l.visible ? 'Annotations hidden' : 'Annotations shown'
  }
  // States: 0 = all visible, 1..n = only layer i-1 visible.
  const allVisible = v.layers.every((l) => l.visible)
  const solo = v.layers.filter((l) => l.visible)
  let state = allVisible ? 0 : solo.length === 1 ? v.layers.indexOf(solo[0]) + 1 : 0
  state = (state + dir + n + 1) % (n + 1)
  const layers = v.layers.map((l, i) => ({ ...l, visible: state === 0 || i === state - 1 }))
  await saveLayers(songId, { ...v, layers })
  return state === 0 ? 'All layers' : `Layer: ${layers[state - 1].name}`
}
