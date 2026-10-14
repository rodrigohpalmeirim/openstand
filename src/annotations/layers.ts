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

async function mutate(songId: string, fn: (v: SongLayers) => SongLayers) {
  const v = await getLayers(songId)
  await saveLayers(songId, normalizeLayers(fn(v)))
}

export function nextLayerName(layers: Layer[]): string {
  for (let i = 2; ; i++) {
    const name = `Layer ${i}`
    if (!layers.some((l) => l.name === name)) return name
  }
}

export async function addLayer(songId: string, name?: string): Promise<string> {
  const id = uid()
  await mutate(songId, (v) => ({ layers: [...v.layers, { id, name: name?.trim() || nextLayerName(v.layers), visible: true }], current: id }))
  return id
}

export const renameLayer = (songId: string, id: string, name: string) =>
  mutate(songId, (v) => ({ ...v, layers: v.layers.map((l) => (l.id === id ? { ...l, name: name.trim() || l.name } : l)) }))

export const setLayerVisible = (songId: string, id: string, visible: boolean) =>
  mutate(songId, (v) => ({ ...v, layers: v.layers.map((l) => (l.id === id ? { ...l, visible } : l)) }))

export const setCurrentLayer = (songId: string, id: string) =>
  mutate(songId, (v) => ({ layers: v.layers.map((l) => (l.id === id ? { ...l, visible: true } : l)), current: id }))

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

/** Delete a layer and its annotations (the annotation removal is undoable). */
export async function deleteLayer(songId: string, id: string) {
  const v = await getLayers(songId)
  if (v.layers.length <= 1) return
  const keys = await loadSong(songId)
  const changes: PageChange[] = []
  for (const key of keys) {
    const before = getItems(key)
    if (before.some((i) => i.layer === id)) changes.push({ key, before, after: before.filter((i) => i.layer !== id) })
  }
  if (changes.length) commit('Delete layer', changes)
  const layers = v.layers.filter((l) => l.id !== id)
  await saveLayers(songId, { layers, current: v.current === id ? layers[0].id : v.current })
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
