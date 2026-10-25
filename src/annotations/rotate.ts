/**
 * Annotations are stored relative to the rotated (uncropped) page, so turning a page must turn its
 * annotations in the same change. Shared by the viewer's Display panel and the song editor.
 */
import { db, updateSong } from '../db/db'
import type { Annotation, PageSettings, Song, SongFile } from '../db/schema'
import { rotatePages } from '../library/editor/songEdit'
import { pageSize } from '../viewer/pageSource'
import { rotateItem } from './geometry'
import { flush, getItems, load, pageKey, replacePage } from './store'

export function rotateItems(items: Annotation[], quarterTurns: number, aspect: number): Annotation[] {
  return quarterTurns % 4 ? items.map((it) => rotateItem(it, quarterTurns, aspect)) : items
}

/**
 * The turned annotations of every page whose rotation differs between two page-settings maps
 * (`fileId:page` keys). Nothing is written yet.
 */
async function planRotation(songId: string, files: SongFile[], before: Record<string, PageSettings>, after: Record<string, PageSettings>) {
  const out: { key: string; items: Annotation[] }[] = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const r0 = before[k]?.rotation ?? 0
    const turns = Math.round((((after[k]?.rotation ?? 0) - r0 + 360) % 360) / 90)
    if (!turns) continue
    const i = k.lastIndexOf(':')
    const file = files.find((f) => f.id === k.slice(0, i))
    const page = Number(k.slice(i + 1))
    if (!file || (file.kind !== 'pdf' && file.kind !== 'image')) continue
    const key = pageKey(songId, file.id, page)
    await load(key)
    const items = getItems(key)
    if (!items.length) continue
    const size = await pageSize(file, page)
    const aspect = r0 % 180 ? size.width / size.height : size.height / size.width
    out.push({ key, items: rotateItems(items, turns, aspect) })
  }
  return out
}

let queue: Promise<void> = Promise.resolve()

/** Rotations run one at a time: each reads what the previous one wrote. */
function serial(fn: () => Promise<void>): Promise<void> {
  const run = queue.then(fn)
  queue = run.catch(() => {})
  return run
}

/** Turn the annotations of the pages whose rotation changed from `before` to `after`, and save them. */
export function rotateAnnotations(songId: string, files: SongFile[], before: Record<string, PageSettings>, after: Record<string, PageSettings>) {
  return serial(async () => {
    const plan = await planRotation(songId, files, before, after)
    for (const p of plan) replacePage(p.key, p.items)
    if (plan.length) await flush()
  })
}

/**
 * Rotate pages of a saved song by ±90°: the crop and the annotations turn with them. The song is re-read
 * inside, so quick repeated rotations (the caller's `song` may be stale) turn page and annotations alike.
 */
export function rotateSongPages(song: Song, keys: string[], delta: number) {
  return serial(async () => {
    const latest = (await db.songs.get(song.id)) ?? song
    const next = rotatePages(latest.pageSettings, keys, delta)
    const plan = await planRotation(latest.id, latest.files, latest.pageSettings, next)
    // Swap both in the same tick so the page and its annotations turn together.
    for (const p of plan) replacePage(p.key, p.items)
    await updateSong(latest.id, { pageSettings: next })
    if (plan.length) await flush()
  })
}
