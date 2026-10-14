import { useEffect, useMemo, useState } from 'react'
import { looksLikeChordPro, parseChordPro, textToChordPro, type ChordProSong } from '../chordpro/parse'
import { effectiveStyle, songBlocks, type RenderOpts, type TextStyle } from '../chordpro/render'
import { ABC_PAGE_PADDING, useAbcjsReady } from '../abc/AbcView'
import { layoutAbc, layoutWidthFor, paginateAbcLines, withPageHint } from '../abc/engine'
import { instrumentLoaded, loadInstrument } from '../music/diagrams'
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
      /** Text zoom the page was paginated at (must be rendered at the same size). */
      zoom: number
      aspect: number
    }
  | {
      type: 'abc'
      key: string
      file: SongFile
      /** ABC text; paginated pages carry a leading page hint understood by AbcView. */
      source: string
      transpose: number
      aspect: number
      /** Page within the file and page count (ABC files are split by staff lines). */
      page?: number
      count?: number
    }

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
  return parseChordPro(isCp ? text : textToChordPro(text, style.sourceNaming ?? 'english'), { instrument: style.instrument })
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
  // Which song the sizes/texts belong to: they are stale for a moment after switching songs.
  const [loadedId, setLoadedId] = useState<string>()

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
          setLoadedId(song.id)
        }
      }
      setSizes(sz)
      setLoading(false)
      setLoadedId(song.id)
    })()
    return () => {
      cancelled = true
    }
  }, [song, refs])

  // ABC files (and ChordPro {start_of_abc} sections) need abcjs; bottom diagrams need the dictionary.
  const needAbc = !!song?.files.some((f) => f.kind === 'abc' || (texts[f.id] !== undefined && /\{\s*(start_of_abc|soa)\b/.test(texts[f.id])))
  const abcReady = useAbcjsReady(needAbc)
  const [dictReady, setDictReady] = useState(() => instrumentLoaded(style.instrument))
  useEffect(() => {
    if (style.diagrams === 'off' || instrumentLoaded(style.instrument)) return setDictReady(instrumentLoaded(style.instrument))
    let alive = true
    setDictReady(false)
    loadInstrument(style.instrument).then(() => alive && setDictReady(true))
    return () => {
      alive = false
    }
  }, [style.instrument, style.diagrams])

  const pages = useMemo(() => {
    if (!song) return []
    const out: DisplayPage[] = []
    const byId = new Map(song.files.map((f) => [f.id, f]))
    const seenText = new Set<string>()
    // A page order may repeat a page (e.g. a repeated chorus page); React keys must stay unique while
    // the page identity used by annotations remains fileId + page.
    const uses = new Map<string, number>()
    const uniqueKey = (k: string) => {
      const n = uses.get(k) ?? 0
      uses.set(k, n + 1)
      return n ? `${k}#${n}` : k
    }
    const fallbackAspect = Object.values(sizes)[0] ?? DEFAULT_ASPECT
    for (const r of refs) {
      const f = byId.get(r.fileId)
      if (!f) continue
      if (f.kind === 'pdf' || f.kind === 'image') {
        const ps = song.pageSettings[pageSettingsKey(f.id, r.page)]
        out.push({
          type: 'file',
          key: uniqueKey(`${f.id}:${r.page}`),
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
      const aspect = textBox.width / Math.max(1, textBox.height)
      if (f.kind === 'abc') {
        // Split into pages of whole staff lines that fit the page box.
        const pad = textBox.width * ABC_PAGE_PADDING
        const contentW = textBox.width - pad * 2
        const layoutWidth = layoutWidthFor(contentW, opts.zoom)
        const layout = abcReady ? layoutAbc(text, { layoutWidth, transpose: opts.transpose, naming: style.naming }) : null
        const ranges = layout?.lines.length ? paginateAbcLines(layout, contentW, textBox.height - pad * 2) : null
        if (!ranges) out.push({ type: 'abc', key: f.id, file: f, source: text, transpose: opts.transpose, aspect })
        else
          ranges.forEach(([from, to], i) =>
            out.push({
              type: 'abc',
              key: `${f.id}:a${i}`,
              file: f,
              source: withPageHint(text, from, to, layoutWidth),
              transpose: opts.transpose,
              aspect,
              page: i,
              count: ranges.length,
            }),
          )
        continue
      }
      const cp = parseTextFile(f, text, style)
      const eff = effectiveStyle(style, cp)
      const ro: RenderOpts = { style: eff, transpose: opts.transpose, capo: song.text?.capo }
      // An explicit per-song choice beats the file's {columns}, which beats the automatic default.
      const columns = Math.max(1, song.text?.columns ?? cp.columns ?? opts.columns)
      const tp = paginate(songBlocks(cp, ro), textBox, columns, eff, opts.zoom)
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
          zoom: opts.zoom,
          aspect,
        }),
      )
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, refs, sizes, texts, textBox, style, opts.transpose, opts.columns, opts.zoom, abcReady, dictReady])

  return { pages, loading: loading || loadedId !== song?.id }
}
