/**
 * Bookkeeping for "Correct pages" (image correction of an existing PDF/image file), as pure functions.
 *
 * Rotation is never baked into the corrected file: the editor shows each page with its saved rotation
 * setting, and whatever rotation the user ends with is written back as that setting. The page itself is
 * only re-drawn for its outline (corners, bent edges) and the filter. So a page whose outline is the
 * whole page keeps its exact geometry: its crop and annotations stay valid, and annotations turn with a
 * changed rotation the usual way (the song editor does that on save).
 */
import type { PageSettings, Song, SongFile } from '../../db/schema'
import type { PageEdit } from '../../scan/correct'
import { FULL_QUAD, isStraight, type Quad } from '../../scan/geometry'
import type { FilterParams } from '../../scan/image'
import { replaceFile, rotateSetting, tidySettings } from './songEdit'

export const isWholePage = (q: Quad) => q.every((p, i) => Math.abs(p.x - FULL_QUAD[i].x) < 1e-6 && Math.abs(p.y - FULL_QUAD[i].y) < 1e-6)

/** The page content moves: corners off the page edges, or bent edges. */
export const geometryChanged = (e: PageEdit) => !isWholePage(e.quad) || !isStraight(e.bend)

/** "Colour" with no adjustments leaves pixels as they are. */
export const filterIsIdentity = (p: FilterParams) => p.filter === 'color' && !p.brightness && !p.contrast

/** Whether page i has to be redrawn; the others are copied unchanged from the original file. */
export const needsRender = (e: PageEdit, params: FilterParams) => e.ready && (geometryChanged(e) || !filterIsIdentity(params))

/** Quarter turns the editor starts a page with. */
export const startTurns = (s: PageSettings | undefined) => Math.round((s?.rotation ?? 0) / 90) % 4

/** A page's settings after correcting it. */
export function correctedSetting(old: PageSettings | undefined, e: PageEdit): PageSettings | undefined {
  if (!e.ready) return old
  const next: PageSettings = { ...old }
  // The crop was measured on the old picture; once the content moves it no longer frames the same area.
  if (geometryChanged(e)) delete next.crop
  const delta = (((e.rotation % 4) + 4) % 4) * 90 - (old?.rotation ?? 0)
  // Turns a kept crop with the page so the same area stays visible.
  const turned = delta ? rotateSetting(next, delta) : next
  return turned.crop || turned.rotation ? turned : undefined
}

export interface CorrectionPlan {
  /** Pages (0-based) to redraw; the rest are copied as they are. */
  render: number[]
  /** Pages whose content moves and that carry annotations: the user is asked first. */
  warn: number[]
  /** Pages whose crop is dropped. */
  cropsDropped: number[]
}

export function planCorrection(
  fileId: string,
  settings: Record<string, PageSettings>,
  edits: PageEdit[],
  params: FilterParams,
  annotated: ReadonlySet<number>,
): CorrectionPlan {
  const plan: CorrectionPlan = { render: [], warn: [], cropsDropped: [] }
  edits.forEach((e, i) => {
    if (needsRender(e, params)) plan.render.push(i)
    if (!e.ready || !geometryChanged(e)) return
    if (annotated.has(i)) plan.warn.push(i)
    if (settings[`${fileId}:${i}`]?.crop) plan.cropsDropped.push(i)
  })
  return plan
}

/**
 * The song with the corrected file in place of `fileId` (`repl` null: the file content stays, only
 * settings change). The file keeps its id, so page order and annotations (keyed by file id and page)
 * still point at the same pages.
 */
export function applyCorrection(song: Song, fileId: string, repl: SongFile | null, edits: PageEdit[]): Song {
  if (repl && repl.pageCount !== edits.length) throw new Error('Page count changed')
  const next = repl ? replaceFile(song, fileId, repl) : song
  // replaceFile drops the settings when the kind changes (image → PDF); these are the same pages, so
  // they are recomputed from the old settings either way.
  const ps = { ...next.pageSettings }
  edits.forEach((e, i) => {
    const k = `${fileId}:${i}`
    const s = correctedSetting(song.pageSettings[k], e)
    if (s) ps[k] = s
    else delete ps[k]
  })
  return { ...next, pageSettings: tidySettings(ps) }
}

/** "Waltz.jpg" → "Waltz.pdf"; PDFs keep their name. */
export function correctedName(f: SongFile) {
  return f.kind === 'pdf' ? f.name : `${f.name.replace(/\.[^./\\]+$/, '') || f.name}.pdf`
}

/** "page 2", "pages 2 and 5", "pages 1, 3 and 4" (1-based). */
export function pageList(pages: number[]) {
  const n = pages.map((p) => String(p + 1))
  if (n.length <= 1) return `page ${n[0] ?? ''}`.trim()
  return `pages ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}
