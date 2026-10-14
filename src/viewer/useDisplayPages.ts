import { useEffect, useMemo, useState } from 'react'
import { looksLikeChordPro, parseChordPro, textToChordPro, type ChordProSong } from '../chordpro/parse'
import { songBlocks, type RenderOpts, type TextStyle } from '../chordpro/render'
import { getBlob } from '../db/db'
import type { Song, SongFile } from '../db/schema'
import { displayAspect, pageSettingsKey, pageSize, resolvePageRefs } from './pageSource'
import { paginate, type TextPage } from './textPagination'

export type DisplayPage =
  | {
      type: 'file'
      key: string
      file: SongFile
      page: number
      rotation: 0 | 90 | 180 | 270
      crop?: import('../db/schema').Crop
      /** width / height after rotation and crop */
      aspect: number
    }
  | {
      type: 'text'
      key: string
      file: SongFile
      page: number
      count: number
      text: TextPage
      columns: number
      cp: ChordProSong
      opts: RenderOpts
      aspect: number
    }
  | { type: 'abc'; key: string; file: SongFile; source: string; transpose: number; aspect: number }

const DEFAULT_ASPECT = 612 / 792

/** Load the text of a file once per blob id. */
const textCache = new Map<string, Promise<string>>()
export function fileText(file: SongFile): Promise<string> {
  let p = textCache.get(file.blobId)
  if (!p) {
    p = getBlob(file.blobId).then((b) => b.text())
    textCache.set(file.blobId, p)
  }
  return p
}

export function parseTextFile(file: SongFile, text: string, style: TextStyle): ChordProSong {
  const isCp = file.kind === 'chordpro' || looksLikeChordPro(text)
  return parseChordPro(isCp ? text : textToChordPro(text, style.naming))
}

/**
 * Expand a song into concrete display pages. Text files are paginated to `textBox` (the CSS size one
 * text page occupies in the current display mode) so they fill the screen like sheet music.
 */
export function useDisplayPages(
  song: Song | undefined,
  textBox: { width: number; height: number },
  style: TextStyle,
  opts: { transpose: number; columns: number; zoom: number },
): { pages: DisplayPage[]; loading: boolean } {
  const refs = useMemo(() => (song ? resolvePageRefs(song) : []), [song])
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  // Page sizes and text contents.
  useEffect(() => {
    if (!song) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const sz: Record<string, number> = {}
      const tx: Record<string, string> = {}
      const byId = new Map(song.files.map((f) => [f.id, f]))
      // Text contents first (small), then page sizes, publishing progressively so big books open fast.
      for (const f of song.files) if (f.kind !== 'pdf' && f.kind !== 'image') tx[f.id] = await fileText(f).catch(() => '')
      if (cancelled) return
      setTexts(tx)
      let n = 0
      for (const r of refs) {
        const f = byId.get(r.fileId)
        if (!f || (f.kind !== 'pdf' && f.kind !== 'image')) continue
        const ps = song.pageSettings[pageSettingsKey(f.id, r.page)]
        try {
          const size = await pageSize(f, r.page)
          sz[`${f.id}:${r.page}`] = displayAspect(size, ps?.rotation ?? 0, ps?.crop)
        } catch {
          sz[`${f.id}:${r.page}`] = DEFAULT_ASPECT
        }
        if (cancelled) return
        if (++n === 2 || n % 16 === 0) {
          setSizes({ ...sz })
          setLoading(false)
        }
      }
      setSizes(sz)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [song, refs])

  const pages = useMemo(() => {
    if (!song) return []
    const out: DisplayPage[] = []
    const byId = new Map(song.files.map((f) => [f.id, f]))
    const seenText = new Set<string>()
    const fallbackAspect = Object.values(sizes)[0] ?? DEFAULT_ASPECT
    for (const r of refs) {
      const f = byId.get(r.fileId)
      if (!f) continue
      if (f.kind === 'pdf' || f.kind === 'image') {
        const ps = song.pageSettings[pageSettingsKey(f.id, r.page)]
        out.push({
          type: 'file',
          key: `${f.id}:${r.page}`,
          file: f,
          page: r.page,
          rotation: ps?.rotation ?? 0,
          crop: ps?.crop,
          aspect: sizes[`${f.id}:${r.page}`] ?? fallbackAspect,
        })
        continue
      }
      if (seenText.has(f.id)) continue
      seenText.add(f.id)
      const text = texts[f.id]
      if (text === undefined) continue
      if (f.kind === 'abc') {
        out.push({ type: 'abc', key: f.id, file: f, source: text, transpose: opts.transpose, aspect: textBox.width / Math.max(1, textBox.height) })
        continue
      }
      const cp = parseTextFile(f, text, style)
      const ro: RenderOpts = { style, transpose: opts.transpose }
      const columns = Math.max(1, cp.columns ?? opts.columns)
      const tp = paginate(songBlocks(cp, ro), textBox, columns, style, opts.zoom)
      tp.forEach((p, i) =>
        out.push({
          type: 'text',
          key: `${f.id}:t${i}`,
          file: f,
          page: i,
          count: tp.length,
          text: p,
          columns,
          cp,
          opts: ro,
          aspect: textBox.width / Math.max(1, textBox.height),
        }),
      )
    }
    return out
  }, [song, refs, sizes, texts, textBox, style, opts.transpose, opts.columns, opts.zoom])

  return { pages, loading }
}
