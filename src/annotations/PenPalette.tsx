/**
 * Quick palette for writing while reading. A pen always writes, so there is no mode to enter: the palette
 * wakes when a pen comes near (see pen.ts), offers the few things worth changing between two notes and
 * goes back to sleep. Everything else stays in the annotation mode, behind "More tools".
 */
import { Ellipsis, GripVertical, Pencil, Plus, Redo2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { cx, Slider } from '../ui/primitives'
import { DarkPop } from '../viewer/dark'
import { Swatch, ToolIcon } from './AnnotationToolbar'
import { applyStyle, setTool } from './ops'
import { clampPalette, DEFAULT_PALETTE_POS, normalisePalette, placePalette, type Area, type Px, type Size } from './palettePos'
import { holdAwake, pokePen, usePen } from './pen'
import { redo, undo, useAnnotHistory, useAnnotUI } from './store'
import { PALETTE, SIZE_RANGE, TOOL_LABEL, toolConfig, type ToolId } from './tools'

const TOOLS: ToolId[] = ['pen', 'highlighter', 'eraser', 'select', 'text']
/** Phones keep the three that matter mid-rehearsal; Select, Text and Redo fold into "More tools". */
const COMPACT_TOOLS: ToolId[] = ['pen', 'highlighter', 'eraser']
const hasSize = (t: ToolId) => t !== 'select' && t !== 'snip'
const hasColor = (t: ToolId) => t !== 'eraser' && t !== 'select' && t !== 'snip'

const FADE_MS = 160
/** Space kept between the palette and the viewer's bars. */
const GAP = 8
/** Arrow-key step when moving the palette from the keyboard. */
const NUDGE = 24

interface Geo {
  /** The screen inside the safe-area margins: what the stored position refers to. */
  full: Area
  /** `full` without the viewer's bars while they show. */
  safe: Area
  size: Size
}

const sameArea = (a: Area, b: Area) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

type PopKind = 'size' | 'color' | 'more'

function PB({ label, title, active, disabled, popup, menu, onClick, children }: { label: string; title?: string; active?: boolean; disabled?: boolean; /** Opens a popover: whether it is open. */ popup?: boolean; menu?: boolean; onClick: (el: HTMLButtonElement) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      aria-haspopup={popup === undefined ? undefined : menu ? 'menu' : 'dialog'}
      aria-expanded={popup}
      disabled={disabled}
      onClick={(e) => onClick(e.currentTarget)}
      className={cx(
        'relative inline-flex size-10 min-w-9 shrink items-center justify-center rounded-xl transition-colors pointer-coarse:size-11 disabled:opacity-30',
        active ? 'bg-white text-neutral-900 shadow' : 'text-white/85 hover:bg-white/10 active:bg-white/15',
      )}
    >
      {children}
    </button>
  )
}

const Sep = () => <div className="mx-1 h-6 w-px shrink-0 bg-white/15" aria-hidden />

const menuItem = 'flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-white/10 disabled:opacity-40 pointer-coarse:min-h-11'

/** Mounts with the palette's wake state and stays for the fade out. */
export function PenPalette({ compact }: { compact: boolean }) {
  const awake = usePen((p) => p.awake)
  const annotating = useViewer((v) => v.annotating)
  const locked = useSettings((s) => s.s.display.performanceLock)
  const shown = awake && !annotating && !locked
  const [mounted, setMounted] = useState(shown)
  if (shown && !mounted) setMounted(true)
  useEffect(() => {
    if (shown) return
    const t = window.setTimeout(() => setMounted(false), FADE_MS + 40)
    return () => clearTimeout(t)
  }, [shown])
  return mounted ? <Palette shown={shown} compact={compact} /> : null
}

function Palette({ shown, compact }: { shown: boolean; compact: boolean }) {
  const a = useSettings((s) => s.s.annotations)
  const toolbar = useViewer((v) => v.toolbar)
  const tempEraser = useAnnotUI((s) => s.tempEraser)
  // While re-editing a text, colour and size show (and change, see applyStyle) that text's own style.
  const editStyle = useAnnotUI((s) => (s.editing?.id ? s.editing.style : undefined))
  const { canUndo, canRedo } = useAnnotHistory()
  const tool: ToolId = tempEraser ? 'eraser' : a.tool
  const styleTool: ToolId = editStyle ? 'text' : tool
  const cfg = editStyle ? { ...toolConfig('text', a.tools), ...editStyle } : toolConfig(tool, a.tools)
  const pos = a.palettePos ?? DEFAULT_PALETTE_POS

  const bounds = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const grip = useRef<HTMLButtonElement>(null)
  const popBox = useRef<HTMLDivElement>(null)
  /** The last input on the palette was a key: popovers then take focus, so they can be used without a pointer. */
  const byKey = useRef(false)

  /* ----------------------------------------------------------- Position */

  const [geo, setGeo] = useState<Geo | null>(null)
  const measure = useCallback(() => {
    const c = bounds.current
    const el = bar.current
    if (!c || !el) return
    const cs = getComputedStyle(c)
    const pad = (v: string) => parseFloat(v) || 0
    const full: Area = {
      left: pad(cs.paddingLeft),
      top: pad(cs.paddingTop),
      width: c.clientWidth - pad(cs.paddingLeft) - pad(cs.paddingRight),
      height: c.clientHeight - pad(cs.paddingTop) - pad(cs.paddingBottom),
    }
    // The bars keep their height while hidden (they slide away), so only count them while they show.
    const barH = (sel: string) => (toolbar ? (c.parentElement?.querySelector<HTMLElement>(sel)?.offsetHeight ?? 0) : 0)
    const top = Math.max(full.top, barH('[data-viewer-top]') + GAP)
    const bottom = Math.min(full.top + full.height, c.clientHeight - barH('[data-bottom-bar]') - GAP)
    const safe: Area = { left: full.left, top, width: full.width, height: Math.max(0, bottom - top) }
    const size: Size = { width: el.offsetWidth, height: el.offsetHeight }
    setGeo((g) => (g && sameArea(g.full, full) && sameArea(g.safe, safe) && g.size.width === size.width && g.size.height === size.height ? g : { full, safe, size }))
  }, [toolbar])

  // `entered` flips after the first measure (which computes the hidden style), so the fade in runs.
  const [entered, setEntered] = useState(false)
  // The slide that follows the top bar must not also run from (0, 0) on the first placement.
  const [settled, setSettled] = useState(false)
  useLayoutEffect(() => {
    measure()
    setEntered(true)
    const c = bounds.current
    if (!c || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(c)
    if (bar.current) ro.observe(bar.current)
    for (const sel of ['[data-viewer-top]', '[data-bottom-bar]']) {
      const el = c.parentElement?.querySelector(sel)
      if (el) ro.observe(el)
    }
    return () => ro.disconnect()
  }, [measure])
  useEffect(() => {
    if (entered) setSettled(true)
  }, [entered])

  const savePos = (p: Px) => {
    if (geo) useSettings.getState().setIn('annotations', { palettePos: normalisePalette(p, geo.full, geo.size, pos) })
  }

  const drag = useRef<{ id: number; dx: number; dy: number; at: Px; moved: boolean } | null>(null)
  const [dragAt, setDragAt] = useState<Px | null>(null)
  const placed = dragAt ?? (geo ? placePalette(pos, geo.full, geo.size, geo.safe) : null)

  const gripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!geo || !placed || drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, dx: e.clientX - placed.left, dy: e.clientY - placed.top, at: placed, moved: false }
    setDragAt(placed)
  }
  const gripMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !geo) return
    d.at = clampPalette({ left: e.clientX - d.dx, top: e.clientY - d.dy }, geo.safe, geo.size)
    d.moved = true
    setDragAt(d.at)
  }
  const gripEnd = (e: React.PointerEvent, keep: boolean) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setDragAt(null)
    if (keep && d.moved) savePos(d.at)
  }

  /* ----------------------------------------------------------- Popovers */

  const [pop, setPop] = useState<{ kind: PopKind; anchor: HTMLElement } | null>(null)
  const closePop = () => setPop(null)
  const togglePop = (kind: PopKind, anchor: HTMLElement) => setPop((p) => (p?.kind === kind ? null : { kind, anchor }))
  // A popover belongs to the tool and layout it was opened for.
  useEffect(() => setPop(null), [styleTool, compact, shown])
  useEffect(() => {
    if (pop && byKey.current) popBox.current?.querySelector<HTMLElement>('button:not(:disabled), input')?.focus({ preventScroll: true })
  }, [pop])

  const busy = !!pop || !!dragAt
  useEffect(() => (busy ? holdAwake() : undefined), [busy])

  const pickTool = (t: ToolId, el?: HTMLElement) => {
    if (el && t === tool && hasSize(t)) return togglePop('size', el)
    setPop(null)
    setTool(t)
  }
  const moreTools = () => {
    setPop(null)
    useViewer.getState().set({ annotating: true, toolbar: true })
  }

  /* -------------------------------------------------------------- Input */

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    byKey.current = true
    pokePen()
    const k = e.key
    const t = e.target as HTMLElement
    const arrow = k.startsWith('Arrow')
    // Keys pressed in a popover bubble here through React, not through the DOM.
    const inBar = e.currentTarget.contains(t)
    let list: HTMLElement[] | null = null
    let step = 0
    if (inBar && t === grip.current && arrow) {
      if (placed && geo) savePos(clampPalette({ left: placed.left + (k === 'ArrowLeft' ? -NUDGE : k === 'ArrowRight' ? NUDGE : 0), top: placed.top + (k === 'ArrowUp' ? -NUDGE : k === 'ArrowDown' ? NUDGE : 0) }, geo.safe, geo.size))
    } else if (inBar && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End')) {
      list = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')]
      step = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : k === 'Home' ? -Infinity : Infinity
    } else if (!inBar && arrow && t.tagName !== 'INPUT' && popBox.current?.contains(t)) {
      list = [...popBox.current.querySelectorAll<HTMLElement>('button:not(:disabled), input')]
      step = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1
    } else if ((k === ' ' || k === 'Enter') && t.closest('button')) {
      // Presses the button; must not also turn the page.
      return e.stopPropagation()
    } else return
    if (list?.length) {
      const at = list.indexOf(t)
      const next = step === -Infinity ? 0 : step === Infinity ? list.length - 1 : (at + step + list.length) % list.length
      list[next].focus({ preventScroll: true })
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const open = shown && entered && !!geo
  const row = compact ? COMPACT_TOOLS : TOOLS
  // A tool that is not in the row (chosen in the menu or in the annotation mode) shows next to it while active.
  const shownTools = row.includes(tool) ? row : [...row, tool]
  const sizeLabel = styleTool === 'eraser' ? 'Eraser size' : styleTool === 'text' ? 'Font size' : styleTool === 'stamp' ? 'Stamp size' : 'Thickness'
  const [min, max, step] = SIZE_RANGE[styleTool]
  const color = cfg.color.toLowerCase()

  return (
    <div
      ref={bounds}
      className="pointer-events-none absolute inset-0 z-[25] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <div
        ref={bar}
        role="toolbar"
        aria-label="Pen tools"
        data-pen-palette=""
        data-keeps-text-edit=""
        style={{ left: placed?.left ?? 0, top: placed?.top ?? 0, maxWidth: geo?.full.width, visibility: geo ? undefined : 'hidden' }}
        className={cx(
          'absolute flex w-max touch-none items-center rounded-2xl border border-white/15 bg-neutral-950/90 p-1 text-white shadow-[0_6px_24px_rgba(0,0,0,0.45)] backdrop-blur-md duration-150 ease-out motion-reduce:transition-none',
          settled && !dragAt ? 'transition-[opacity,translate,top]' : 'transition-[opacity,translate]',
          open ? 'pointer-events-auto translate-y-0 opacity-100' : '-translate-y-1.5 opacity-0',
        )}
        // The page must not see what happens here: no ink, no page turn, no tap zone.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerDownCapture={() => {
          byKey.current = false
          pokePen()
        }}
        onClick={pokePen}
        // A pointer press leaves the focus where it was (a text being typed, or nothing: pedals keep turning pages).
        onMouseDown={(e) => {
          if (!(e.target as Element).closest('input, textarea, select')) e.preventDefault()
        }}
        onKeyDown={onKeyDown}
      >
        <button
          ref={grip}
          type="button"
          aria-label="Move palette"
          title="Drag to move (or use the arrow keys)"
          onPointerDown={gripDown}
          onPointerMove={gripMove}
          onPointerUp={(e) => gripEnd(e, true)}
          onPointerCancel={(e) => gripEnd(e, false)}
          onLostPointerCapture={(e) => gripEnd(e, true)}
          className={cx(
            'inline-flex h-10 shrink-0 items-center justify-center rounded-lg text-white/45 transition-colors hover:text-white/80 pointer-coarse:h-11',
            compact ? 'w-6' : 'w-8',
            dragAt ? 'cursor-grabbing text-white/80' : 'cursor-grab',
          )}
        >
          <GripVertical className="size-[18px]" />
        </button>

        {shownTools.map((t) => {
          const active = t === tool
          const sizes = active && hasSize(t)
          return (
            <PB key={t} label={TOOL_LABEL[t]} title={sizes ? `${TOOL_LABEL[t]}: tap again for size` : undefined} active={active} popup={sizes ? pop?.kind === 'size' : undefined} onClick={(el) => pickTool(t, el)}>
              <ToolIcon tool={t} />
              {sizes && <span className="absolute bottom-1.5 right-1.5 size-0 border-b-[5px] border-l-[5px] border-b-current border-l-transparent opacity-50" aria-hidden />}
            </PB>
          )
        })}

        {!compact && <Sep />}
        <PB label="Colour" disabled={!hasColor(styleTool)} popup={pop?.kind === 'color'} onClick={(el) => togglePop('color', el)}>
          <span className="size-6 rounded-full border-2 border-white/80 shadow" style={{ background: cfg.color, opacity: Math.max(0.35, cfg.opacity) }} />
        </PB>
        {!compact && <Sep />}

        <PB label="Undo" disabled={!canUndo} onClick={() => undo()}>
          <Undo2 className="size-[18px]" />
        </PB>
        {!compact && (
          <PB label="Redo" disabled={!canRedo} onClick={() => redo()}>
            <Redo2 className="size-[18px]" />
          </PB>
        )}
        {!compact && <Sep />}

        {compact ? (
          <PB label="More tools" popup={pop?.kind === 'more'} menu onClick={(el) => togglePop('more', el)}>
            <Ellipsis className="size-[18px]" />
          </PB>
        ) : (
          <PB label="More tools" title="More tools: open the annotation mode" onClick={moreTools}>
            <Ellipsis className="size-[18px]" />
          </PB>
        )}

        <DarkPop anchor={pop?.anchor ?? null} open={pop?.kind === 'size'} onClose={closePop} align="center" className="w-[min(92vw,16rem)] p-3">
          <div ref={popBox} role="dialog" aria-label={sizeLabel}>
            <div className="mb-1 flex justify-between text-xs text-muted">
              <span>{sizeLabel}</span>
              <span className="tabular-nums">{Math.round(cfg.size * 10) / 10}</span>
            </div>
            <Slider label={sizeLabel} className="-mb-1 h-8" value={Math.min(max, Math.max(min, Math.round(cfg.size / step) * step))} min={min} max={max} step={step} onChange={(v) => applyStyle({ size: v })} />
          </div>
        </DarkPop>

        <DarkPop anchor={pop?.anchor ?? null} open={pop?.kind === 'color'} onClose={closePop} align="center" className="w-[min(92vw,20rem)] p-3">
          <div ref={popBox} role="dialog" aria-label="Colour">
            <div className="grid grid-cols-6 justify-items-center gap-2">
              {PALETTE.map((c) => (
                <Swatch key={c} color={c} active={c === color} onClick={() => applyStyle({ color: c })} />
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <label className="relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-white/30 text-white/70 hover:bg-white/10" title="Custom colour">
                <Plus className="size-4" />
                <input type="color" value={cfg.color} onChange={(e) => applyStyle({ color: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Custom colour" />
              </label>
              <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto p-1">
                {a.recentColors.map((c) => (
                  <Swatch key={c} color={c} size="sm" active={c.toLowerCase() === color} onClick={() => applyStyle({ color: c })} label={`Recent ${c}`} />
                ))}
                {!a.recentColors.length && <span className="self-center text-xs text-muted">Custom colours appear here</span>}
              </div>
            </div>
          </div>
        </DarkPop>

        <DarkPop anchor={pop?.anchor ?? null} open={pop?.kind === 'more'} onClose={closePop} align="end" className="min-w-56">
          <div ref={popBox} role="menu">
            {(['select', 'text'] as ToolId[]).map((t) => (
              <button key={t} type="button" role="menuitem" className={menuItem} onClick={() => pickTool(t)}>
                <ToolIcon tool={t} className="size-4 text-white/55" />
                {TOOL_LABEL[t]}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              disabled={!canRedo}
              onClick={() => {
                setPop(null)
                redo()
              }}
            >
              <Redo2 className="size-4 text-white/55" />
              Redo
            </button>
            <div className="my-1 h-px bg-white/10" />
            <button type="button" role="menuitem" className={menuItem} onClick={moreTools}>
              <Pencil className="size-4 text-white/55" />
              All tools…
            </button>
          </div>
        </DarkPop>
      </div>
    </div>
  )
}
