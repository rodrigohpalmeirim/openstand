import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '../state/settings'
import { abcjsNow, layoutAbc, layoutWidthFor, loadAbcjs, splitPageHint, type AbcLine } from './engine'

/** Inner padding of an ABC page as a fraction of its width (matches text pages). */
export const ABC_PAGE_PADDING = 0.05

export function useAbcjsReady(needed = true): boolean {
  const [ready, setReady] = useState(() => !!abcjsNow())
  useEffect(() => {
    if (!needed || ready) return
    let alive = true
    loadAbcjs()
      .then(() => alive && setReady(true))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [needed, ready])
  return ready
}

/** One laid-out staff line, scaled to the container width (keeps its aspect ratio). */
export function AbcLineView({ line }: { line: AbcLine }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.replaceChildren(line.svg.cloneNode(true))
  }, [line])
  return <div ref={ref} style={{ width: '100%', aspectRatio: `${line.width} / ${line.height}` }} />
}

/**
 * Renders ABC notation as SVG with abcjs. Every tune in the file is shown; when the source carries
 * a page hint (see engine.withPageHint) only that page's staff lines are drawn.
 */
export function AbcView({ source, transpose, width }: { source: string; transpose: number; width: number }) {
  const naming = useSettings((s) => s.s.text.naming)
  const ready = useAbcjsReady()
  const hint = useMemo(() => splitPageHint(source), [source])
  const pad = width * ABC_PAGE_PADDING
  const layoutWidth = hint.layoutWidth ?? layoutWidthFor(width - pad * 2)
  const layout = useMemo(
    () => (ready ? layoutAbc(hint.body, { layoutWidth, transpose, naming }) : null),
    [ready, hint.body, layoutWidth, transpose, naming],
  )
  if (!ready) return <div className="p-6 text-xs text-black/50">Loading notation…</div>
  if (!layout || !layout.lines.length)
    return (
      <div className="p-6 text-black">
        {layout?.error && <div className="mb-2 text-xs text-red-700">Could not render this ABC file: {layout.error}</div>}
        <pre className="whitespace-pre-wrap text-xs">{hint.body}</pre>
      </div>
    )
  const lines = layout.lines.slice(hint.from ?? 0, hint.to ?? layout.lines.length)
  return (
    <div style={{ width, padding: pad, color: '#000' }}>
      {lines.map((l, i) => (
        <AbcLineView key={(hint.from ?? 0) + i} line={l} />
      ))}
    </div>
  )
}

/** ABC embedded in a ChordPro song ({start_of_abc}); scales to the column width. */
export function AbcBlock({ source, transpose }: { source: string; transpose: number }) {
  const naming = useSettings((s) => s.s.text.naming)
  const layout = abcjsNow() ? layoutAbc(source, { layoutWidth: 640, transpose, naming }) : null
  if (!layout?.lines.length) return <pre className="whitespace-pre-wrap font-mono text-[0.75em]">{source}</pre>
  return (
    <div style={{ color: '#000' }}>
      {layout.lines.map((l, i) => (
        <AbcLineView key={i} line={l} />
      ))}
    </div>
  )
}
