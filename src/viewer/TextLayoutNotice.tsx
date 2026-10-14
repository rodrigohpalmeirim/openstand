import { Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { getItems, historySize, loadSong, parseKey } from '../annotations/store'
import { getKV, setKV, updateSong } from '../db/db'
import type { Song } from '../db/schema'
import { useViewer } from '../state/viewer'
import type { DisplayPage } from './useDisplayPages'

/**
 * Text pages reflow (text size, columns, key, screen size), but annotations are stored per page in
 * page-relative coordinates. We remember the layout annotations were drawn at and offer to restore
 * it when it differs, plus a one-time hint the first time someone annotates a text page.
 */
export interface TextLayoutSig {
  zoom: number
  columns: number
  width: number
  height: number
  transpose: number
}

export type LayoutChange = 'size' | 'columns' | 'key' | 'screen'

export function layoutChanges(drawn: TextLayoutSig, now: TextLayoutSig): LayoutChange[] {
  const out: LayoutChange[] = []
  if (Math.abs(drawn.zoom - now.zoom) > 0.01) out.push('size')
  if (drawn.columns !== now.columns) out.push('columns')
  if (drawn.transpose !== now.transpose) out.push('key')
  // Width reflows every line; height only moves page breaks, and mobile browser bars nudge it.
  const off = (a: number, b: number, tol: number) => Math.abs(a - b) / Math.max(1, b) > tol
  if (off(drawn.width, now.width, 0.03) || off(drawn.height, now.height, 0.12)) out.push('screen')
  return out
}

const TEXT_PAGE = (page: number) => page >= 1000 && page < 2000
const kvKey = (songId: string) => `textLayout:${songId}`
const HINT_KEY = 'openstand:hint:textAnnotations'
/** Songs whose warning was dismissed this session. */
const dismissed = new Set<string>()

const LABEL: Record<Exclude<LayoutChange, 'screen'>, string> = { size: 'text size', columns: 'columns', key: 'key' }

async function hasTextAnnotations(songId: string) {
  const keys = await loadSong(songId)
  return keys.some((k) => TEXT_PAGE(parseKey(k).page) && getItems(k).length > 0)
}

export function TextLayoutNotice({ song, pages, currentPage, sig, top, fontScale, savedTranspose, annotationsShown }: {
  song: Song
  annotationsShown: boolean
  pages: DisplayPage[]
  currentPage: number
  sig: TextLayoutSig | null
  /** Distance from the top of the stage (below the visible bars). */
  top: number
  fontScale: number
  savedTranspose: number
}) {
  const annotating = useViewer((v) => v.annotating)
  const setV = useViewer((v) => v.set)
  const [drawn, setDrawn] = useState<TextLayoutSig | null>(null)
  const [hint, setHint] = useState(false)
  const [, rerender] = useState(0)
  const hasText = pages.some((p) => p.type === 'text')

  useEffect(() => {
    let alive = true
    setDrawn(null)
    getKV<TextLayoutSig | null>(kvKey(song.id), null).then((v) => alive && setDrawn(v))
    return () => {
      alive = false
    }
  }, [song.id])

  // Leaving annotation mode after changes: remember the layout the text annotations belong to.
  const sigRef = useRef(sig)
  sigRef.current = sig
  const wasAnnotating = useRef(annotating)
  useEffect(() => {
    const was = wasAnnotating.current
    wasAnnotating.current = annotating
    if (annotating) {
      if (pages[currentPage]?.type === 'text' && !localStorage.getItem(HINT_KEY)) setHint(true)
      return
    }
    setHint(false)
    const now = sigRef.current
    if (!was || !hasText || !now || historySize() === 0) return
    const songId = song.id
    void hasTextAnnotations(songId).then(async (any) => {
      const next = any ? now : null
      await setKV(kvKey(songId), next)
      dismissed.delete(songId)
      setDrawn(next)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotating])

  if (!hasText || !sig) return null

  const box = 'absolute left-1/2 z-20 flex w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 items-start gap-2 rounded-2xl border border-white/10 bg-neutral-900/95 py-2 pl-3.5 pr-1.5 text-sm text-white shadow-2xl backdrop-blur-xl animate-pop-in'

  if (annotating && hint)
    return (
      <div role="status" className={box} style={{ top: top + 8 }}>
        <Info className="mt-2.5 size-4 shrink-0 text-[var(--os-accent)]" />
        <p className="flex-1 py-1.5 leading-snug text-white/85">
          Annotations on chord and lyric pages stay where you draw them. Changing the text size, columns, key or screen orientation moves the text underneath, so OpenStand will offer to restore this layout.
        </p>
        <button
          type="button"
          className="h-10 shrink-0 rounded-xl px-3 font-medium text-[var(--os-accent)] hover:bg-white/10"
          onClick={() => {
            localStorage.setItem(HINT_KEY, '1')
            setHint(false)
          }}
        >
          Got it
        </button>
      </div>
    )

  if (!drawn || !annotationsShown || dismissed.has(song.id)) return null
  const changes = layoutChanges(drawn, sig)
  if (!changes.length) return null
  const fixable = changes.filter((c): c is Exclude<LayoutChange, 'screen'> => c !== 'screen')
  const what = fixable.map((c) => LABEL[c])
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]
  const message = fixable.length
    ? `Annotations were drawn with a different ${list}; they may not line up with the text.`
    : 'Annotations were drawn on a different screen size or orientation; they may not line up with the text.'
  const restore = async () => {
    const v = useViewer.getState()
    setV({ textZoom: drawn.zoom / (fontScale || 1), transpose: { ...v.transpose, [song.id]: drawn.transpose - savedTranspose } })
    if (changes.includes('columns')) await updateSong(song.id, { text: { ...song.text, columns: drawn.columns } })
  }
  return (
    <div role="status" className={box} style={{ top: top + 8 }}>
      <Info className="mt-2.5 size-4 shrink-0 text-yellow-300/80" />
      <p className="flex-1 py-1.5 leading-snug text-white/85">{message}</p>
      {fixable.length > 0 && (
        <button type="button" className="h-10 shrink-0 rounded-xl bg-[var(--os-accent)] px-3 font-semibold text-[var(--os-accent-fg)] hover:brightness-110" onClick={restore}>
          Restore
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        className="flex size-10 shrink-0 items-center justify-center rounded-xl text-white/60 hover:bg-white/10"
        onClick={() => {
          dismissed.add(song.id)
          rerender((n) => n + 1)
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
