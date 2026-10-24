/**
 * Joining a synced library from a device that already has songs, merge mode (docs/SYNC.md §10.3).
 * Pure: `planJoin` decides which local songs and setlists are already in the synced library, and
 * `joinSong` / `joinLayers` / `joinPages` / `remapSetlist` combine a matched pair. The join
 * transaction (WP3) applies them.
 */
import type { Annotation, AudioTrack, Layer, PageAnnotations, PageRef, Setlist, SetlistEntry, Song, SongLayers } from '../db/schema'
import { GROUP_FIELDS } from '../db/schema'
import { normTitle } from '../sync/protocol'
import { canonicalJson } from './hash'
import { annId } from './fields'

export { normTitle }

export interface JoinPlan {
  /** Local song id -> remote song id it is combined into. */
  songMap: Map<string, string>
  /** Local setlist id -> remote setlist id it duplicates (the local one is dropped). */
  setlistMap: Map<string, string>
  /** Local songs / setlists that will be added to the synced library as new records. */
  added: { songs: number; setlists: number }
}

/** Ordered file-hash signature; `null` when the song has no files or any file's data is unknown. */
function fileSig(s: Song, hashOf: (blobId: string) => string): string | null {
  if (!s.files.length) return null
  const hs = s.files.map((f) => (f.blobId ? hashOf(f.blobId) : ''))
  return hs.every((h) => h) ? hs.join(',') : null
}

const songKey = (s: Song, hashOf: (blobId: string) => string) => {
  const sig = fileSig(s, hashOf)
  return sig === null ? null : `${normTitle(s.title)}\n${sig}`
}

/**
 * §10.3 match rule. A local song L matches a remote song R when their ordered file hashes are identical
 * and non-empty and their normalised titles are equal. Matching is one-to-one, in list order: duplicates
 * within one side are not collapsed. A local setlist matches a remote one with the same normalised name
 * and the same entry `songId` sequence after mapping matched songs (breaks included); also one-to-one.
 */
export function planJoin(
  local: { songs: Song[]; setlists: Setlist[] },
  remote: { songs: Song[]; setlists: Setlist[] },
  hashOf: (blobId: string) => string,
): JoinPlan {
  const pool = new Map<string, string[]>()
  for (const r of remote.songs) {
    const k = songKey(r, hashOf)
    if (k === null) continue
    const ids = pool.get(k)
    if (ids) ids.push(r.id)
    else pool.set(k, [r.id])
  }
  const songMap = new Map<string, string>()
  for (const l of local.songs) {
    const k = songKey(l, hashOf)
    const r = k === null ? undefined : pool.get(k)?.shift()
    if (r !== undefined) songMap.set(l.id, r)
  }

  const setKey = (s: Setlist, map?: Map<string, string>) =>
    `${normTitle(s.name)}\n${JSON.stringify(s.entries.map((e) => map?.get(e.songId) ?? e.songId))}`
  const setPool = new Map<string, string[]>()
  for (const r of remote.setlists) {
    const k = setKey(r)
    const ids = setPool.get(k)
    if (ids) ids.push(r.id)
    else setPool.set(k, [r.id])
  }
  const setlistMap = new Map<string, string>()
  for (const l of local.setlists) {
    const r = setPool.get(setKey(l, songMap))?.shift()
    if (r !== undefined) setlistMap.set(l.id, r)
  }

  return {
    songMap,
    setlistMap,
    added: { songs: local.songs.length - songMap.size, setlists: local.setlists.length - setlistMap.size },
  }
}

/** L's file ids -> R's, by position (safe because matched songs have equal hash sequences). */
export function joinFileMap(local: Song, remote: Song): Map<string, string> {
  const m = new Map<string, string>()
  local.files.forEach((f, i) => {
    const r = remote.files[i]
    if (r) m.set(f.id, r.id)
  })
  return m
}

/** No meaningful value: R's "value" yields to L's. */
const blank = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)

function unionBy<T>(r: T[] | undefined, l: T[] | undefined, key: (x: T) => string): T[] {
  const out = [...(r ?? [])]
  const seen = new Set(out.map(key))
  for (const x of l ?? []) {
    const k = key(x)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(x)
    }
  }
  return out
}

/**
 * Combine local song L into its matched remote song R (§10.3 step 8). The result keeps R's id and files.
 * - lww fields (title, notes, rating, tempos, pageOrder, MIDI, …): R wins; L fills values R left blank
 *   (`undefined`, `''`, `[]`, `{}`, and 0 for rating/difficulty/duration, which mean "unset").
 * - flat fields (display, text, metronome, autoScroll): R wins per sub-field; L fills the others.
 * - set fields: union, R's order first. `favorite`: OR. `createdAt`: min. `lastPlayedAt`/`modifiedAt`: max.
 *   `playCount`: sum.
 * - `bookmarks`, `links`, `smartButtons`: union, de-duplicated by (name, pageIndex), (from, to) and
 *   (label, pageIndex, x, y). `audio` (not named by the spec): union by (name, url).
 * - `pageSettings`: R wins per key, L fills keys R lacks (L's file ids remapped to R's).
 */
export function joinSong(local: Song, remote: Song): Song {
  const fmap = joinFileMap(local, remote)
  const mapRef = (p: PageRef): PageRef => ({ ...p, fileId: fmap.get(p.fileId) ?? p.fileId })
  const mapKey = (k: string) => {
    const i = k.lastIndexOf(':')
    return i < 0 ? k : `${fmap.get(k.slice(0, i)) ?? k.slice(0, i)}${k.slice(i)}`
  }

  const out: Song = { ...local, ...remote, id: remote.id, files: remote.files }
  const loc = local as unknown as Record<string, unknown>
  const res = out as unknown as Record<string, unknown>
  const zeroBlank = new Set(['rating', 'difficulty', 'duration'])
  const handled = new Set<string>([
    'id', 'files', 'favorite', 'createdAt', 'modifiedAt', 'lastPlayedAt', 'playCount', 'pageSettings', 'pageOrder',
    'bookmarks', 'links', 'smartButtons', 'audio', 'display', 'text', 'metronome', 'autoScroll', ...GROUP_FIELDS,
  ])
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (handled.has(k)) continue
    const rv = (remote as unknown as Record<string, unknown>)[k]
    if (blank(rv) || (zeroBlank.has(k) && rv === 0)) {
      if (loc[k] !== undefined) res[k] = loc[k]
    } else res[k] = rv
  }
  if (blank(remote.pageOrder) && local.pageOrder?.length) out.pageOrder = local.pageOrder.map(mapRef)
  else out.pageOrder = remote.pageOrder
  if (out.pageOrder === undefined) delete out.pageOrder

  for (const k of ['display', 'text', 'metronome', 'autoScroll'] as const) {
    const merged = { ...(local[k] ?? {}), ...Object.fromEntries(Object.entries(remote[k] ?? {}).filter(([, v]) => v !== undefined)) }
    if (Object.keys(merged).length) res[k] = merged
    else delete res[k]
  }

  for (const g of GROUP_FIELDS) out[g] = [...new Set([...(remote[g] ?? []), ...(local[g] ?? [])])]

  out.favorite = !!(local.favorite || remote.favorite)
  out.createdAt = Math.min(local.createdAt, remote.createdAt)
  out.modifiedAt = Math.max(local.modifiedAt, remote.modifiedAt)
  const lp = Math.max(local.lastPlayedAt ?? -Infinity, remote.lastPlayedAt ?? -Infinity)
  if (Number.isFinite(lp)) out.lastPlayedAt = lp
  else delete out.lastPlayedAt
  out.playCount = (local.playCount || 0) + (remote.playCount || 0)

  const ps: Song['pageSettings'] = {}
  for (const [k, v] of Object.entries(local.pageSettings ?? {})) ps[mapKey(k)] = v
  Object.assign(ps, remote.pageSettings ?? {})
  out.pageSettings = ps

  out.bookmarks = unionBy(remote.bookmarks, local.bookmarks, (b) => canonicalJson([b.name, b.pageIndex]))
  out.links = unionBy(remote.links, local.links, (x) => canonicalJson([x.from, x.to]))

  const audioKey = (a: AudioTrack) => canonicalJson([a.name, a.url ?? ''])
  out.audio = unionBy(remote.audio, local.audio, audioKey)
  const trackMap = new Map<string, string>()
  for (const a of local.audio ?? []) {
    const r = out.audio.find((x) => audioKey(x) === audioKey(a))
    if (r && r.id !== a.id) trackMap.set(a.id, r.id)
  }
  if (remote.smartButtons || local.smartButtons) {
    const lsb = (local.smartButtons ?? []).map((b) => (b.trackId && trackMap.has(b.trackId) ? { ...b, trackId: trackMap.get(b.trackId) } : b))
    out.smartButtons = unionBy(remote.smartButtons, lsb, (b) => canonicalJson([b.label, b.pageIndex, b.x, b.y]))
  }
  return out
}

/**
 * Merge L's layers into R's by layer name (§10.3). Returns the merged layers (R's `current` kept) and
 * L layer id -> merged layer id, for remapping annotation `layer` fields.
 */
export function joinLayers(local: SongLayers | undefined, remote: SongLayers | undefined): { layers: SongLayers | undefined; map: Map<string, string> } {
  const map = new Map<string, string>()
  if (!local) return { layers: remote, map }
  const out: Layer[] = [...(remote?.layers ?? [])]
  const byName = new Map(out.map((l) => [l.name.trim().toLowerCase(), l.id]))
  const ids = new Set(out.map((l) => l.id))
  for (const l of local.layers) {
    const hit = byName.get(l.name.trim().toLowerCase())
    if (hit !== undefined) {
      map.set(l.id, hit)
      continue
    }
    let id = l.id
    for (let i = 2; ids.has(id); i++) id = `${l.id}-${i}`
    ids.add(id)
    byName.set(l.name.trim().toLowerCase(), id)
    out.push({ ...l, id })
    map.set(l.id, id)
  }
  const current = remote?.current && out.some((l) => l.id === remote.current) ? remote.current : (map.get(local.current) ?? out[0]?.id ?? 'default')
  return { layers: { layers: out, current }, map }
}

/**
 * Re-key L's annotation pages to R (§10.3): file ids by position, layers through `layerMap`, items
 * unioned with R's page (annotation ids differ, so nothing collides; R's items stay below L's).
 */
export function joinPages(
  local: PageAnnotations[],
  remote: PageAnnotations[],
  fileMap: Map<string, string>,
  remoteSongId: string,
  layerMap: Map<string, string> = new Map(),
): PageAnnotations[] {
  const byId = new Map(remote.map((p) => [p.id, p]))
  const out = new Map<string, PageAnnotations>()
  for (const p of local) {
    const fileId = fileMap.get(p.fileId)
    if (!fileId) continue
    const id = annId(remoteSongId, fileId, p.page)
    const items: Annotation[] = p.items.map((it) => (layerMap.has(it.layer) ? { ...it, layer: layerMap.get(it.layer)! } : it))
    const base = out.get(id) ?? byId.get(id) ?? { id, songId: remoteSongId, fileId, page: p.page, items: [] }
    const seen = new Set(base.items.map((x) => x.id))
    out.set(id, { ...base, items: [...base.items, ...items.filter((x) => !seen.has(x.id))] })
  }
  return [...out.values()]
}

/** Point setlist entries at the remote songs they were combined into. */
export function remapSetlist(s: Setlist, songMap: Map<string, string>): Setlist {
  let changed = false
  const entries: SetlistEntry[] = s.entries.map((e) => {
    const to = songMap.get(e.songId)
    if (to === undefined) return e
    changed = true
    return { ...e, songId: to }
  })
  return changed ? { ...s, entries } : s
}
