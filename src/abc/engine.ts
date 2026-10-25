/**
 * abcjs wrapper: lazy loading, line-by-line layout (for pagination) with a small cache, page hints
 * and synth playback. abcjs is MIT-licensed.
 */
import type { NoteNaming } from '../music/chords'

type Abcjs = typeof import('abcjs')
type TuneObject = import('abcjs').TuneObject

let mod: Abcjs | null = null
let loading: Promise<Abcjs> | null = null

export function loadAbcjs(): Promise<Abcjs> {
  loading ??= import('abcjs').then((m) => {
    mod = ((m as unknown as { default?: Abcjs }).default ?? m) as Abcjs
    return mod
  })
  return loading
}

/** The module if it is already loaded (so layout can run synchronously during render). */
export const abcjsNow = () => mod

/* ------------------------------------------------------------ page hints */

/**
 * Pagination passes the line range and layout width of an ABC page inside the source as a leading
 * comment, so the DisplayPage/AbcView contract ({source, transpose, width}) stays unchanged.
 */
const HINT_RE = /^%openstand-page (\d+)-(\d+) (\d+)\n/

export function withPageHint(source: string, from: number, to: number, layoutWidth: number): string {
  return `%openstand-page ${from}-${to} ${Math.round(layoutWidth)}\n${source}`
}

export function splitPageHint(source: string): { body: string; from?: number; to?: number; layoutWidth?: number } {
  const m = HINT_RE.exec(source)
  if (!m) return { body: source }
  return { body: source.slice(m[0].length), from: Number(m[1]), to: Number(m[2]), layoutWidth: Number(m[3]) }
}

/**
 * Layout width (abcjs px) for a display width. Notation is laid out at roughly its natural size
 * (scale ≈ 1, larger with text zoom); narrow layouts reflow to fewer bars per line (see `wrapFor`)
 * instead of squeezing the file's line breaks into a tiny staff.
 */
export function layoutWidthFor(contentWidth: number, zoom = 1): number {
  // Phones: draw slightly smaller than natural size so two bars of quavers still fit a line.
  const natural = contentWidth < WRAP_BELOW ? contentWidth / 0.85 : contentWidth
  return Math.round(Math.max(natural, 260) / Math.max(0.4, zoom))
}

/** Below this layout width the file's own line breaks no longer fit legibly, so abcjs re-wraps. */
export const WRAP_BELOW = 600

export function wrapFor(layoutWidth: number) {
  if (layoutWidth >= WRAP_BELOW) return undefined
  return { preferredMeasuresPerLine: layoutWidth < 360 ? 1 : layoutWidth < 480 ? 2 : 3, minSpacing: 1.4, maxSpacing: 2.4, lastLineLimit: 0.5 }
}

/** Effective transposition: viewer transpose plus a MobileSheets-style %%mstranspose in the file. */
export function fileTranspose(body: string): number {
  const m = /^%%mstranspose\s+(-?\d+)/m.exec(body)
  return m ? Number(m[1]) : 0
}

/* ---------------------------------------------------------------- layout */

export interface AbcLine {
  svg: SVGSVGElement
  width: number
  height: number
  tune: number
}

export interface AbcLayout {
  lines: AbcLine[]
  layoutWidth: number
  error?: string
}

const cache = new Map<string, AbcLayout>()

/**
 * Render every staff line of every tune into separate SVGs at `layoutWidth`. Runs synchronously
 * (abcjs must be loaded) in an off-screen host because abcjs measures text while laying out.
 */
export function layoutAbc(source: string, opts: { layoutWidth: number; transpose: number; naming?: NoteNaming }): AbcLayout | null {
  const abcjs = mod
  if (!abcjs || typeof document === 'undefined') return null
  const transpose = opts.transpose + fileTranspose(source)
  const key = `${opts.layoutWidth}|${transpose}|${opts.naming ?? ''}|${source}`
  const hit = cache.get(key)
  if (hit) return hit
  const host = document.createElement('div')
  Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: `${opts.layoutWidth}px`, visibility: 'hidden' })
  document.body.appendChild(host)
  const lines: AbcLine[] = []
  let error: string | undefined
  try {
    const n = Math.max(1, abcjs.numberOfTunes(source))
    const targets = Array.from({ length: n }, () => host.appendChild(document.createElement('div')))
    const german = opts.naming === 'german' || opts.naming === 'czech' || opts.naming === 'scandinavian'
    abcjs.renderAbc(targets as unknown as Element, source, {
      staffwidth: opts.layoutWidth - 24,
      paddingleft: 12,
      paddingright: 12,
      paddingtop: 6,
      paddingbottom: 6,
      oneSvgPerLine: true,
      wrap: wrapFor(opts.layoutWidth),
      visualTranspose: transpose || undefined,
      germanAlphabet: german || undefined,
      add_classes: true,
    })
    targets.forEach((t, tune) => {
      t.querySelectorAll('svg').forEach((svg) => {
        // Nested <svg> (glyph defs) are not lines.
        if (svg.parentElement?.closest('svg')) return
        const vb = svg.viewBox?.baseVal
        const w = Number(svg.getAttribute('width')) || vb?.width || svg.getBoundingClientRect().width || opts.layoutWidth
        const h = Number(svg.getAttribute('height')) || vb?.height || svg.getBoundingClientRect().height
        if (!h) return
        if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        svg.style.width = '100%'
        svg.style.height = '100%'
        svg.style.display = 'block'
        lines.push({ svg, width: w, height: h, tune })
      })
    })
  } catch (e) {
    error = String(e)
  } finally {
    host.remove()
  }
  const layout: AbcLayout = { lines, layoutWidth: opts.layoutWidth, error }
  cache.set(key, layout)
  if (cache.size > 24) cache.delete(cache.keys().next().value!)
  return layout
}

/**
 * Split laid-out lines into pages: each page holds as many lines as fit `pageHeight` (in the same
 * units as `contentWidth`). A tune always starts on a new page when the previous one is long.
 */
export function paginateAbcLines(layout: AbcLayout, contentWidth: number, pageHeight: number): [number, number][] {
  const k = contentWidth / layout.layoutWidth
  const pages: [number, number][] = []
  let start = 0
  let used = 0
  layout.lines.forEach((l, i) => {
    const h = l.height * k
    const newTune = i > 0 && l.tune !== layout.lines[i - 1].tune && used > pageHeight * 0.5
    if (i > start && (used + h > pageHeight || newTune)) {
      pages.push([start, i])
      start = i
      used = 0
    }
    used += h
  })
  if (layout.lines.length) pages.push([start, layout.lines.length])
  return pages.length ? pages : [[0, 0]]
}

/* -------------------------------------------------------------- playback */

export interface AbcPlayer {
  stop: () => void
  done: Promise<void>
}

/** Play one tune with the abcjs synth (soundfont is fetched on first use). */
export async function playAbc(source: string, opts: { tune?: number; transpose?: number; onEnd?: () => void } = {}): Promise<AbcPlayer> {
  const abcjs = await loadAbcjs()
  if (!abcjs.synth.supportsAudio()) throw new Error('Audio playback is not supported in this browser')
  const { body } = splitPageHint(source)
  const tunes = abcjs.renderAbc('*', body) as unknown as TuneObject[]
  const visualObj = tunes[opts.tune ?? 0]
  if (!visualObj) throw new Error('No tune found')
  const synth = new abcjs.synth.CreateSynth()
  await synth.init({ visualObj, options: { midiTranspose: (opts.transpose ?? 0) + fileTranspose(body) } })
  const { duration } = await synth.prime()
  synth.start()
  let stopped = false
  let timer = 0
  const done = new Promise<void>((resolve) => {
    timer = window.setTimeout(() => {
      stopped = true
      opts.onEnd?.()
      resolve()
    }, duration * 1000 + 300)
  })
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      synth.stop()
      opts.onEnd?.()
    },
    done,
  }
}

/** Tune titles (T: of each X:) for a multi-tune file. */
export function tuneTitles(source: string): string[] {
  const out: string[] = []
  let inHeader = false
  for (const line of splitPageHint(source).body.split(/\r?\n/)) {
    if (/^X:/.test(line)) {
      out.push(`Tune ${out.length + 1}`)
      inHeader = true
    } else if (inHeader && /^T:/.test(line) && out.length) {
      out[out.length - 1] = line.slice(2).trim() || out[out.length - 1]
      inHeader = false
    } else if (/^K:/.test(line)) inHeader = false
  }
  return out.length ? out : ['Tune 1']
}

/** Transpose ABC text with abcjs (rewrites notes and key signatures). */
export async function transposeAbcText(source: string, steps: number): Promise<string> {
  const abcjs = await loadAbcjs()
  const one = (src: string) => abcjs.strTranspose(src, abcjs.renderAbc('*', src), steps)
  // abcjs only handles the first tune of a string, so transpose each X: tune on its own.
  const parts = source.split(/(?=^X:)/m)
  if (!parts.some((p) => p.startsWith('X:'))) return one(source)
  return parts.map((p) => (p.startsWith('X:') ? one(p) : p)).join('')
}
