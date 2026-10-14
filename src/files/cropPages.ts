import type { Crop, PageSettings, Song, SongFile } from '../db/schema'
import { renderPage } from '../viewer/pageSource'
import { detectCrop, isNoCrop } from './autoCrop'

/** Width of the low-resolution render used for margin detection. */
const PROBE_WIDTH = 256

/** Detect the margins of one page as displayed (after `rotation`). */
export async function autoCropPage(file: SongFile, page: number, rotation = 0, aggressive = false): Promise<Crop> {
  const bmp = await renderPage(file, page, PROBE_WIDTH, rotation)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(bmp, 0, 0)
  const crop = detectCrop(ctx.getImageData(0, 0, c.width, c.height), { aggressive })
  c.width = c.height = 0
  return crop
}

export const cropable = (f: SongFile) => f.kind === 'pdf' || f.kind === 'image'

/** Auto-crop every page of every PDF/image file; returns the new pageSettings (other settings kept). */
export async function autoCropSong(
  song: Song,
  opts: { aggressive?: boolean; pages?: { fileId: string; page: number }[]; onProgress?: (done: number, total: number) => void } = {},
): Promise<Record<string, PageSettings>> {
  const out = structuredClone(song.pageSettings)
  const files = new Map(song.files.map((f) => [f.id, f]))
  const pages =
    opts.pages ??
    song.files.filter(cropable).flatMap((f) => Array.from({ length: f.pageCount }, (_, page) => ({ fileId: f.id, page })))
  let done = 0
  for (const { fileId, page } of pages) {
    const f = files.get(fileId)
    if (!f || !cropable(f)) continue
    const key = `${fileId}:${page}`
    const crop = await autoCropPage(f, page, out[key]?.rotation ?? 0, opts.aggressive)
    const { crop: _old, ...rest } = out[key] ?? {}
    out[key] = isNoCrop(crop) ? rest : { ...rest, crop }
    opts.onProgress?.(++done, pages.length)
  }
  return out
}
