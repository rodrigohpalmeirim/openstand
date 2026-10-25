import { ChevronLeft, ChevronRight, RotateCcw, RotateCw, ScanLine, Undo2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Crop, PageRef, PageSettings, Song } from '../../db/schema'
import { clampCrop, isNoCrop, NO_CROP } from '../../files/autoCrop'
import { autoCropPage } from '../../files/cropPages'
import { useSettings } from '../../state/settings'
import { Button, cx, IconButton, Segmented, Toggle, toast } from '../../ui/primitives'
import { displayAspect, pageSize, renderPage, resolvePageRefs } from '../../viewer/pageSource'
import { useTerms } from '../browse/terms'
import { Sheet } from './Sheet'
import { croppablePages, pageKey, rotatePages, scopeKeys, tidySettings } from './songEdit'

type Edge = 'top' | 'bottom' | 'left' | 'right'
type Handle = Edge | 'tl' | 'tr' | 'bl' | 'br' | 'move'
const HANDLE_EDGES: Record<Handle, Edge[]> = {
  top: ['top'],
  bottom: ['bottom'],
  left: ['left'],
  right: ['right'],
  tl: ['top', 'left'],
  tr: ['top', 'right'],
  bl: ['bottom', 'left'],
  br: ['bottom', 'right'],
  move: [],
}
const MIN = 0.08

/** Drag a crop rectangle over each page; crops are stored as fractions in Song.pageSettings. */
export function CropEditor({
  song,
  startIndex = 0,
  onApply,
  onClose,
}: {
  song: Song
  /** Index into the song's resolved page list to start at. */
  startIndex?: number
  onApply: (pageSettings: Record<string, PageSettings>) => void
  onClose: () => void
}) {
  const t = useTerms()
  const pages = useMemo(() => croppablePages(song), [song])
  const [idx, setIdx] = useState(() => {
    const want = resolvePageRefs(song)[startIndex]
    const i = want ? pages.findIndex((p) => pageKey(p) === pageKey(want)) : Math.min(startIndex, pages.length - 1)
    return Math.max(0, i)
  })
  const [settings, setSettings] = useState(song.pageSettings)
  const [history, setHistory] = useState<Record<string, PageSettings>[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const scope = useSettings((s) => s.s.editor.cropApplyTo)
  const aggressive = useSettings((s) => s.s.editor.aggressiveCrop)
  const setIn = useSettings((s) => s.setIn)
  const ref = pages[idx] as PageRef | undefined
  const file = ref && song.files.find((f) => f.id === ref.fileId)
  const ps = ref ? settings[pageKey(ref)] : undefined
  const crop = ps?.crop ?? NO_CROP
  const rotation = ps?.rotation ?? 0

  const snapshot = () => setHistory((h) => [...h.slice(-49), settings])
  /** Set a crop for the current page and (depending on scope) every other page in scope. */
  const setCrop = (c: Crop, record = true) => {
    if (!ref) return
    if (record) snapshot()
    const keys = scopeKeys(song, ref, scope)
    setSettings((s) => {
      const out = { ...s }
      for (const k of keys) out[k] = { ...out[k], crop: isNoCrop(c) ? undefined : c }
      return tidySettings(out)
    })
  }

  const auto = async () => {
    if (!ref) return
    const keys = scopeKeys(song, ref, scope)
    snapshot()
    const out = { ...settings }
    try {
      let n = 0
      for (const k of keys) {
        const [fileId, p] = k.split(':')
        const f = song.files.find((x) => x.id === fileId)!
        setBusy(keys.length > 1 ? `Detecting ${++n}/${keys.length}` : 'Detecting…')
        const c = await autoCropPage(f, Number(p), out[k]?.rotation ?? 0, aggressive)
        out[k] = { ...out[k], crop: isNoCrop(c) ? undefined : c }
      }
      setSettings(tidySettings(out))
    } catch (e) {
      toast(`Auto-crop failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  const undo = () => {
    if (!history.length) return
    setSettings(history[history.length - 1])
    setHistory((h) => h.slice(0, -1))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('[data-crop-stage]')) return
      if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !(e.target instanceof HTMLInputElement))) setIdx((i) => Math.min(pages.length - 1, i + 1))
      else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement))) setIdx((i) => Math.max(0, i - 1))
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const changed = JSON.stringify(tidySettings(settings)) !== JSON.stringify(tidySettings(song.pageSettings))
  const pct = (v: number) => `${Math.round(v * 100)}%`

  return (
    <Sheet
      size="full"
      onClose={onClose}
      title="Crop pages"
      subtitle={ref && file ? `Page ${idx + 1} of ${pages.length} · ${file.name}${file.pageCount > 1 ? ` p. ${ref.page + 1}` : ''}` : 'No pages to crop'}
      bodyClassName="flex flex-col overflow-hidden lg:flex-row"
      actions={
        <IconButton label="Undo (Ctrl+Z)" disabled={!history.length} onClick={undo}>
          <Undo2 className="size-4.5" />
        </IconButton>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changed} onClick={() => onApply(tidySettings(settings))}>
            Apply
          </Button>
        </>
      }
    >
      <div className="relative flex min-h-0 flex-1 flex-col bg-surface-2">
        {file && ref ? (
          <CropStage key={pageKey(ref)} file={file} page={ref.page} rotation={rotation} crop={crop} onChange={setCrop} onStart={snapshot} />
        ) : (
          <p className="m-auto text-sm text-muted">This {t.song} has no PDF or image pages.</p>
        )}
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-line bg-surface px-2 py-1.5">
          <IconButton label="Previous page" disabled={idx === 0} onClick={() => setIdx(idx - 1)} className="size-11">
            <ChevronLeft className="size-5" />
          </IconButton>
          <span className="min-w-20 text-center text-sm tabular-nums">
            {pages.length ? idx + 1 : 0} / {pages.length}
          </span>
          <IconButton label="Next page" disabled={idx >= pages.length - 1} onClick={() => setIdx(idx + 1)} className="size-11">
            <ChevronRight className="size-5" />
          </IconButton>
        </div>
      </div>
      <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-t border-line p-3 lg:w-80 lg:gap-4 lg:border-l lg:border-t-0 lg:p-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Apply changes to</span>
          <Segmented
            size="sm"
            className="w-full"
            value={scope}
            onChange={(v) => setIn('editor', { cropApplyTo: v })}
            options={[
              { value: 'page', label: 'This page' },
              { value: 'file', label: 'This file' },
              { value: 'song', label: 'All pages' },
            ]}
          />
        </div>
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 lg:grid-cols-2">
          <Button onClick={auto} disabled={!!busy || !ref} icon={<ScanLine className="size-4" />} className="h-11 lg:col-span-2">
            {busy ?? 'Auto-crop'}
          </Button>
          <Button variant="ghost" className="h-11" disabled={!ref} onClick={() => setCrop(NO_CROP)}>
            Reset
          </Button>
          <div className="flex items-center justify-end gap-1">
            <IconButton label="Rotate left" disabled={!ref} className="size-11" onClick={() => ref && (snapshot(), setSettings((s) => rotatePages(s, [pageKey(ref)], -90)))}>
              <RotateCcw className="size-4.5" />
            </IconButton>
            <IconButton label="Rotate right" disabled={!ref} className="size-11" onClick={() => ref && (snapshot(), setSettings((s) => rotatePages(s, [pageKey(ref)], 90)))}>
              <RotateCw className="size-4.5" />
            </IconButton>
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm">
          <Toggle checked={aggressive} onChange={(v) => setIn('editor', { aggressiveCrop: v })} label="Aggressive auto-crop" />
          <span>
            Aggressive
            <span className="block text-xs text-muted">Ignore specks, page numbers and scan borders</span>
          </span>
        </label>
        <div className="hidden grid-cols-4 gap-1 text-center text-xs text-muted sm:grid" aria-live="polite">
          {(['top', 'bottom', 'left', 'right'] as const).map((e) => (
            <div key={e} className="rounded-lg bg-surface-2 py-1.5">
              <div className="capitalize">{e}</div>
              <div className="font-medium tabular-nums text-fg">{pct(crop[e])}</div>
            </div>
          ))}
        </div>
        <p className="hidden text-xs text-faint lg:block">
          Drag the edges or corners, or drag inside to move. Focus a handle and use the arrow keys to nudge (Shift = bigger steps).
          PageUp/PageDown change page.
        </p>
      </aside>
    </Sheet>
  )
}

/** Renders the full (uncropped) page and the draggable crop rectangle. */
function CropStage({
  file,
  page,
  rotation,
  crop,
  onChange,
  onStart,
}: {
  file: import('../../db/schema').SongFile
  page: number
  rotation: number
  crop: Crop
  onChange: (c: Crop, record?: boolean) => void
  onStart: () => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [aspect, setAspect] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    let alive = true
    pageSize(file, page).then((s) => alive && setAspect(displayAspect(s, rotation)))
    return () => {
      alive = false
    }
  }, [file, page, rotation])

  const pad = 24
  let w = 0
  let h = 0
  if (aspect && box.w > 0) {
    w = box.w - pad * 2
    h = w / aspect
    if (h > box.h - pad * 2) {
      h = box.h - pad * 2
      w = h * aspect
    }
    w = Math.max(0, Math.floor(w))
    h = Math.max(0, Math.floor(h))
  }

  useEffect(() => {
    if (w < 2) return
    let alive = true
    setReady(false)
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    renderPage(file, page, w * dpr, rotation).then((bmp) => {
      const c = canvasRef.current
      if (!alive || !c) return
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      setReady(true)
    }, () => {})
    return () => {
      alive = false
    }
  }, [file, page, rotation, w])

  const drag = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !w) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onStart()
    const sx = e.clientX
    const sy = e.clientY
    const c0 = crop
    const moveFn = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / w
      const dy = (ev.clientY - sy) / h
      onChange(applyDelta(c0, handle, dx, dy), false)
    }
    const up = () => {
      window.removeEventListener('pointermove', moveFn)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', moveFn)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const nudge = (handle: Handle) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.02 : 0.004
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation()
    onChange(applyDelta(crop, handle, d[0], d[1]))
  }

  const L = crop.left * w
  const T = crop.top * h
  const R = (1 - crop.right) * w
  const B = (1 - crop.bottom) * h
  const handles: { h: Handle; x: number; y: number; cursor: string; label: string }[] = [
    { h: 'tl', x: L, y: T, cursor: 'nwse-resize', label: 'Top-left corner' },
    { h: 'top', x: (L + R) / 2, y: T, cursor: 'ns-resize', label: 'Top edge' },
    { h: 'tr', x: R, y: T, cursor: 'nesw-resize', label: 'Top-right corner' },
    { h: 'right', x: R, y: (T + B) / 2, cursor: 'ew-resize', label: 'Right edge' },
    { h: 'br', x: R, y: B, cursor: 'nwse-resize', label: 'Bottom-right corner' },
    { h: 'bottom', x: (L + R) / 2, y: B, cursor: 'ns-resize', label: 'Bottom edge' },
    { h: 'bl', x: L, y: B, cursor: 'nesw-resize', label: 'Bottom-left corner' },
    { h: 'left', x: L, y: (T + B) / 2, cursor: 'ew-resize', label: 'Left edge' },
  ]

  return (
    <div ref={stageRef} data-crop-stage className="relative min-h-0 flex-1 touch-none select-none overflow-hidden">
      {w > 0 && (
        <div className="absolute" style={{ left: (box.w - w) / 2, top: (box.h - h) / 2, width: w, height: h }}>
          <canvas ref={canvasRef} className={cx('block size-full bg-white shadow-md transition-opacity', ready ? 'opacity-100' : 'opacity-0')} />
          {!ready && <div className="absolute inset-0 animate-pulse bg-white/60" />}
          {/* Dimmed margins */}
          <svg className="pointer-events-none absolute inset-0" width={w} height={h}>
            <path d={`M0 0H${w}V${h}H0Z M${L} ${T}V${B}H${R}V${T}Z`} fill="rgb(0 0 0 / 0.45)" fillRule="evenodd" />
          </svg>
          <div
            role="button"
            tabIndex={0}
            aria-label="Crop area: drag or use arrow keys to move"
            className="absolute cursor-move border-2 border-accent outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
            style={{ left: L, top: T, width: R - L, height: B - T }}
            onPointerDown={drag('move')}
            onKeyDown={nudge('move')}
          >
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-40">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="border border-white/40" />
              ))}
            </div>
          </div>
          {handles.map((hd) => (
            <div
              key={hd.h}
              role="slider"
              tabIndex={0}
              aria-label={hd.label}
              aria-valuenow={Math.round(crop[HANDLE_EDGES[hd.h][0]] * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="group absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center outline-none"
              style={{ left: hd.x, top: hd.y, cursor: hd.cursor }}
              onPointerDown={drag(hd.h)}
              onKeyDown={nudge(hd.h)}
            >
              <span
                className={cx(
                  'block rounded-full border-2 border-white bg-accent shadow transition group-focus-visible:scale-125 group-focus-visible:ring-4 group-focus-visible:ring-accent/40',
                  hd.h.length === 2 ? 'size-4' : hd.h === 'top' || hd.h === 'bottom' ? 'h-2.5 w-6' : 'h-6 w-2.5',
                )}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Move the handle's edges by (dx, dy) fractions; 'move' shifts the whole rectangle inside the page. */
export function applyDelta(c: Crop, handle: Handle, dx: number, dy: number): Crop {
  if (handle === 'move') {
    const ddx = Math.max(-c.left, Math.min(c.right, dx))
    const ddy = Math.max(-c.top, Math.min(c.bottom, dy))
    return { left: c.left + ddx, right: c.right - ddx, top: c.top + ddy, bottom: c.bottom - ddy }
  }
  const n = { ...c }
  for (const e of HANDLE_EDGES[handle]) {
    if (e === 'left') n.left = Math.max(0, Math.min(1 - n.right - MIN, c.left + dx))
    if (e === 'right') n.right = Math.max(0, Math.min(1 - n.left - MIN, c.right - dx))
    if (e === 'top') n.top = Math.max(0, Math.min(1 - n.bottom - MIN, c.top + dy))
    if (e === 'bottom') n.bottom = Math.max(0, Math.min(1 - n.top - MIN, c.bottom - dy))
  }
  return clampCrop(n, MIN)
}
