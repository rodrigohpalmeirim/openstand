/**
 * Annotation tool bar, shown under the viewer's top bar while annotating. One scrollable row on
 * phones; popovers hold the less frequent options (palette, size, stamps, presets, layers).
 */
import {
  ArrowDown,
  ArrowUp,
  BringToFront,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Ellipsis,
  Eraser,
  Eye,
  EyeOff,
  Highlighter,
  Image as ImageIcon,
  LassoSelect,
  Layers as LayersIcon,
  Minus,
  MoveUpRight,
  Pencil,
  PenLine,
  Plus,
  Redo2,
  Square,
  Circle,
  Star,
  Trash2,
  Type,
  Undo2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Annotation, Song } from '../db/schema'
import { uid } from '../db/db'
import { settings, useSettings } from '../state/settings'
import { confirmDialog, cx, Popover, promptDialog, Segmented, Slider, toast, Toggle, useMenu } from '../ui/primitives'
import { registerActions, runAction } from '../viewer/actions'
import { itemSize } from './geometry'
import { addLayer, countLayerItems, deleteLayer, moveLayer, renameLayer, setCurrentLayer, setLayerVisible, useSongLayers } from './layers'
import {
  addImage,
  applyStyle,
  clearPages,
  clearSong,
  copySelection,
  deleteSelection,
  duplicateSelection,
  hasClipboard,
  moveSelectionToLayer,
  nudgeSelection,
  paste,
  patchToolConfig,
  reorderSelection,
  selectAll,
  setTool,
} from './ops'
import { StampGlyph } from './StampGlyph'
import { STAMP_GROUPS, STAMPS } from './stamps'
import { flush, getItems, historySize, NO_PAGE, redo, resetHistory, undo, useAnnotHistory, useAnnotUI, usePageItems, visibleKeys } from './store'
import { isShapeTool, PALETTE, SIZE_RANGE, SHAPE_TOOLS, TOOL_KEYS, TOOL_LABEL, toolConfig, type AnnotationPreset, type ShapeTool, type ToolConfig, type ToolId } from './tools'

/* ------------------------------------------------------------------ Icons */

function HairpinIcon({ open, className }: { open: 'right' | 'left'; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {open === 'right' ? <path d="M21 6L3 12L21 18" /> : <path d="M3 6L21 12L3 18" />}
    </svg>
  )
}

export function ToolIcon({ tool, className = 'size-[18px]' }: { tool: ToolId; className?: string }) {
  switch (tool) {
    case 'pen':
      return <PenLine className={className} />
    case 'highlighter':
      return <Highlighter className={className} />
    case 'eraser':
      return <Eraser className={className} />
    case 'select':
      return <LassoSelect className={className} />
    case 'text':
      return <Type className={className} />
    case 'stamp':
      return <Star className={className} />
    case 'line':
      return <Minus className={cx(className, '-rotate-45')} />
    case 'arrow':
      return <MoveUpRight className={className} />
    case 'rect':
      return <Square className={className} />
    case 'ellipse':
      return <Circle className={className} />
    case 'crescendo':
      return <HairpinIcon open="right" className={className} />
    case 'decrescendo':
      return <HairpinIcon open="left" className={className} />
  }
}

/* --------------------------------------------------------------- Buttons */

function TB({ label, active, disabled, onClick, children, className, btnRef }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode; className?: string; btnRef?: (el: HTMLButtonElement | null) => void }) {
  return (
    <button
      ref={btnRef}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl transition pointer-coarse:size-11 disabled:opacity-30',
        active ? 'bg-white text-neutral-900 shadow' : 'text-white/85 hover:bg-white/10 active:bg-white/15',
        className,
      )}
    >
      {children}
    </button>
  )
}

const Sep = () => <div className="mx-1 h-6 w-px shrink-0 bg-white/15" />

/**
 * The viewer is always dark, but theme tokens resolve at :root, so a nested `.dark` class does
 * not re-theme primitives. Re-declare the colour tokens for popover content instead.
 */
const DARK_VARS = {
  '--color-bg': '#0f1011',
  '--color-surface': '#17181a',
  '--color-surface-2': '#1e1f22',
  '--color-surface-3': '#2a2b2f',
  '--color-line': '#2c2d31',
  '--color-fg': '#ecebe8',
  '--color-muted': '#a09d96',
  '--color-faint': '#6f6c66',
  colorScheme: 'dark',
} as React.CSSProperties

function DarkPop({ className, children, ...rest }: Omit<React.ComponentProps<typeof Popover>, 'className'> & { className?: string }) {
  return (
    <Popover {...rest} className={cx('border-[#2c2d31]! bg-[#17181a]! text-[#ecebe8]!', className)}>
      <div style={DARK_VARS}>{children}</div>
    </Popover>
  )
}

function Swatch({ color, active, onClick, label, size = 'md' }: { color: string; active?: boolean; onClick: () => void; label?: string; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      title={label ?? color}
      aria-label={label ?? `Colour ${color}`}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'shrink-0 rounded-full border border-black/20 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)] transition hover:scale-110',
        size === 'sm' ? 'size-6' : 'size-9',
        active && 'ring-2 ring-[var(--os-accent)] ring-offset-2 ring-offset-[#17181a]',
      )}
      style={{ background: color }}
    />
  )
}

const pop = 'w-[min(92vw,20rem)] p-3'

/* ------------------------------------------------------------- Popovers */

function ColorPopover({ anchor, open, onClose, value, opacity, onPick, onOpacity }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; value: string; opacity: number; onPick: (c: string) => void; onOpacity: (o: number) => void }) {
  const recent = useSettings((s) => s.s.annotations.recentColors)
  return (
    <DarkPop anchor={anchor} open={open} onClose={onClose} align="start" className={pop}>
      <div className="grid grid-cols-6 gap-2">
        {PALETTE.map((c) => (
          <Swatch key={c} color={c} active={c.toLowerCase() === value.toLowerCase()} onClick={() => onPick(c)} />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label className="relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-white/30 text-white/70 hover:bg-white/10" title="Custom colour">
          <Plus className="size-4" />
          <input type="color" value={value} onChange={(e) => onPick(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Custom colour" />
        </label>
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
          {recent.map((c) => (
            <Swatch key={c} color={c} size="sm" active={c.toLowerCase() === value.toLowerCase()} onClick={() => onPick(c)} label={`Recent ${c}`} />
          ))}
          {!recent.length && <span className="self-center text-xs text-muted">Custom colours appear here</span>}
        </div>
      </div>
      <div className="mt-3">
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>Opacity</span>
          <span className="tabular-nums">{Math.round(opacity * 100)}%</span>
        </div>
        <Slider label="Opacity" value={Math.round(opacity * 100)} min={10} max={100} onChange={(v) => onOpacity(v / 100)} />
      </div>
    </DarkPop>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </div>
  )
}

function OptionsPopover({ anchor, open, onClose, tool, cfg, selection }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; tool: ToolId; cfg: ToolConfig; selection: Annotation[] | null }) {
  const selSize = selection ? itemSize(selection.find((i) => itemSize(i) !== undefined) ?? selection[0]) : undefined
  const sizeTool: ToolId = selection ? (selection[0].type === 'text' ? 'text' : selection[0].type === 'stamp' ? 'stamp' : selection[0].type === 'highlighter' ? 'highlighter' : 'pen') : tool
  const [min, max, step] = SIZE_RANGE[sizeTool]
  const size = selSize ?? cfg.size
  const set = (patch: Partial<ToolConfig>) => applyStyle(patch, { sizeFrom: selSize })
  const isText = selection ? selection.some((i) => i.type === 'text') : tool === 'text'
  return (
    <DarkPop anchor={anchor} open={open} onClose={onClose} align="start" className={pop}>
      {(selection ? selSize !== undefined : tool !== 'select') && (
        <div className="py-1">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>{tool === 'eraser' ? 'Eraser size' : sizeTool === 'text' ? 'Font size' : sizeTool === 'stamp' ? 'Stamp size' : 'Thickness'}</span>
            <span className="tabular-nums">{Math.round(size * 10) / 10}</span>
          </div>
          <Slider label="Size" value={Math.min(max, Math.max(min, Math.round(size / step) * step))} min={min} max={max} step={step} onChange={(v) => set({ size: v })} />
        </div>
      )}
      {!selection && tool === 'eraser' && (
        <Row label="Erase">
          <Segmented
            size="sm"
            value={cfg.eraser ?? 'stroke'}
            onChange={(v) => patchToolConfig({ eraser: v })}
            options={[
              { value: 'stroke', label: 'Partial', title: 'Erase only where you rub (ink)' },
              { value: 'object', label: 'Whole', title: 'Erase whole annotations' },
              { value: 'box', label: 'Box', title: 'Drag a box to erase everything it touches' },
            ]}
          />
        </Row>
      )}
      {!selection && (tool === 'pen' || tool === 'line' || tool === 'rect' || tool === 'ellipse' || tool === 'arrow') && (
        <Row label="Dashed">
          <Toggle checked={!!cfg.dashed} onChange={(v) => patchToolConfig({ dashed: v })} label="Dashed" />
        </Row>
      )}
      {!selection && (tool === 'rect' || tool === 'ellipse') && (
        <Row label="Fill">
          <Toggle checked={!!cfg.fill} onChange={(v) => patchToolConfig({ fill: v })} label="Fill" />
        </Row>
      )}
      {!selection && (tool === 'crescendo' || tool === 'decrescendo') && (
        <div className="py-1">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>Opening</span>
            <span className="tabular-nums">{cfg.height ?? 18}</span>
          </div>
          <Slider label="Opening" value={cfg.height ?? 18} min={6} max={60} onChange={(v) => patchToolConfig({ height: v })} />
        </div>
      )}
      {isText && (
        <>
          <Row label="Font">
            <Segmented
              size="sm"
              value={cfg.font ?? 'sans'}
              onChange={(v) => set({ font: v })}
              options={[
                { value: 'sans', label: 'Sans' },
                { value: 'serif', label: 'Serif' },
                { value: 'mono', label: 'Mono' },
              ]}
            />
          </Row>
          <Row label="Bold">
            <Toggle checked={!!cfg.bold} onChange={(v) => set({ bold: v })} label="Bold" />
          </Row>
          <Row label="Italic">
            <Toggle checked={!!cfg.italic} onChange={(v) => set({ italic: v })} label="Italic" />
          </Row>
          <Row label="White box behind">
            <Toggle checked={!!cfg.background} onChange={(v) => set({ background: v })} label="Background" />
          </Row>
        </>
      )}
      {!selection && tool === 'highlighter' && <p className="pt-1 text-xs text-muted">Hold still (or press Shift) to snap to a straight line.</p>}
      {!selection && (tool === 'pen' || tool === 'line' || isShapeTool(tool)) && tool !== 'pen' && <p className="pt-1 text-xs text-muted">Shift snaps angles / draws squares and circles.</p>}
      {selection && <p className="pt-1 text-xs text-muted">Changes apply to the {selection.length} selected annotation{selection.length > 1 ? 's' : ''}.</p>}
    </DarkPop>
  )
}

function StampPopover({ anchor, open, onClose, value, onPick }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; value: string; onPick: (id: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [group, setGroup] = useState(() => STAMPS.find((s) => s.id === value)?.group ?? 'Dynamics')
  return (
    <DarkPop anchor={anchor} open={open} onClose={onClose} align="start" className="w-[min(94vw,24rem)] p-2">
      <div className="flex gap-1 overflow-x-auto pb-2">
        {STAMP_GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroup(g)}
            className={cx('shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium', g === group ? 'bg-white text-neutral-900' : 'text-muted hover:bg-white/10')}
          >
            {g}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1">
        {STAMPS.filter((s) => s.group === group).map((s) => (
          <button
            key={s.id}
            type="button"
            title={s.label}
            aria-label={s.label}
            onClick={() => {
              onPick(s.id)
              onClose()
            }}
            className={cx('flex h-12 items-center justify-center rounded-lg bg-white text-neutral-900 transition hover:brightness-95', s.id === value && 'ring-2 ring-[var(--os-accent)]')}
          >
            <StampGlyph id={s.id} className="max-h-7 max-w-[85%] text-[18px]" />
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-fg hover:bg-white/10"
      >
        <ImageIcon className="size-4 text-muted" /> Place an image…
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          onClose()
          if (!(await addImage(f).catch(() => false))) toast('Could not place the image', 'error')
        }}
      />
    </DarkPop>
  )
}

function presetLabel(p: AnnotationPreset) {
  return `${TOOL_LABEL[p.tool]} · ${Math.round(p.config.size * 10) / 10}`
}

function PresetChip({ p, onClick, active }: { p: AnnotationPreset; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      title={presetLabel(p)}
      aria-label={`Preset: ${presetLabel(p)}`}
      onClick={onClick}
      className={cx('relative inline-flex h-10 shrink-0 items-center gap-1 rounded-xl px-2 text-white/85 hover:bg-white/10 pointer-coarse:h-11', active && 'bg-white/15')}
    >
      <ToolIcon tool={p.tool} className="size-4" />
      <span className="size-3.5 rounded-full border border-white/30" style={{ background: p.config.color, opacity: p.config.opacity }} />
    </button>
  )
}

function applyPreset(p: AnnotationPreset) {
  setTool(p.tool)
  patchToolConfig(p.config, p.tool)
}

function PresetsPopover({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const presets = useSettings((s) => s.s.annotations.presets)
  const save = (list: AnnotationPreset[]) => useSettings.getState().setIn('annotations', { presets: list })
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= presets.length) return
    const l = presets.slice()
    ;[l[i], l[j]] = [l[j], l[i]]
    save(l)
  }
  return (
    <DarkPop anchor={anchor} open={open} onClose={onClose} align="start" className="w-[min(92vw,19rem)] p-2">
      <div className="px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-muted">Presets</div>
      {!presets.length && <p className="px-2 py-2 text-sm text-muted">Save your favourite pens, highlighters and stamps for one-tap access.</p>}
      {presets.map((p, i) => (
        <div key={p.id} className="flex items-center gap-1 rounded-lg hover:bg-white/5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm"
            onClick={() => {
              applyPreset(p)
              onClose()
            }}
          >
            <span className="w-4 text-xs tabular-nums text-faint">{i < 9 ? i + 1 : ''}</span>
            <ToolIcon tool={p.tool} className="size-4" />
            <span className="size-4 shrink-0 rounded-full border border-white/30" style={{ background: p.config.color, opacity: p.config.opacity }} />
            <span className="truncate">{presetLabel(p)}</span>
            {p.tool === 'stamp' && p.config.stamp && <StampGlyph id={p.config.stamp} className="ml-auto h-4 text-sm" />}
          </button>
          <button type="button" aria-label="Move up" className="rounded p-1.5 text-muted hover:bg-white/10 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp className="size-3.5" />
          </button>
          <button type="button" aria-label="Move down" className="rounded p-1.5 text-muted hover:bg-white/10 disabled:opacity-30" disabled={i === presets.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown className="size-3.5" />
          </button>
          <button type="button" aria-label="Delete preset" className="rounded p-1.5 text-muted hover:bg-white/10 hover:text-danger" onClick={() => save(presets.filter((x) => x.id !== p.id))}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          const a = settings().annotations
          if (a.tool === 'select') return toast('Pick a drawing tool first')
          save([...presets, { id: uid(), tool: a.tool, config: toolConfig(a.tool, a.tools) }])
          toast('Preset saved')
        }}
        className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/10"
      >
        <Plus className="size-4 text-muted" /> Save current tool
      </button>
    </DarkPop>
  )
}

function LayersPopover({ anchor, open, onClose, songId, hasSelection }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; songId: string; hasSelection: boolean }) {
  const L = useSongLayers(songId)
  return (
    <DarkPop anchor={anchor} open={open} onClose={onClose} align="end" className="w-[min(92vw,20rem)] p-2">
      <div className="px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-muted">Layers</div>
      {L.layers.map((l, i) => {
        const current = l.id === L.current
        return (
          <div key={l.id} className={cx('flex items-center gap-0.5 rounded-lg', current ? 'bg-white/10' : 'hover:bg-white/5')}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm" onClick={() => setCurrentLayer(songId, l.id)} title="Draw on this layer">
              <span className={cx('flex size-4 items-center justify-center rounded-full border', current ? 'border-[var(--os-accent)] bg-[var(--os-accent)]' : 'border-white/30')}>
                {current && <Check className="size-3 text-[var(--os-accent-fg)]" />}
              </span>
              <span className={cx('truncate', !l.visible && 'text-faint line-through')}>{l.name}</span>
            </button>
            {hasSelection && (
              <button type="button" title="Move selection to this layer" aria-label={`Move selection to ${l.name}`} className="rounded p-1.5 text-muted hover:bg-white/10" onClick={() => moveSelectionToLayer(l.id)}>
                <BringToFront className="size-3.5" />
              </button>
            )}
            <button type="button" aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`} className="rounded p-1.5 text-muted hover:bg-white/10" onClick={() => setLayerVisible(songId, l.id, !l.visible)}>
              {l.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </button>
            <button
              type="button"
              aria-label={`Rename ${l.name}`}
              className="rounded p-1.5 text-muted hover:bg-white/10"
              onClick={async () => {
                const n = await promptDialog({ title: 'Rename layer', initial: l.name })
                if (n) await renameLayer(songId, l.id, n)
              }}
            >
              <Pencil className="size-3.5" />
            </button>
            <button type="button" aria-label="Move layer up" className="rounded p-1.5 text-muted hover:bg-white/10 disabled:opacity-30" disabled={i === 0} onClick={() => moveLayer(songId, l.id, -1)}>
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${l.name}`}
              className="rounded p-1.5 text-muted hover:bg-white/10 hover:text-danger disabled:opacity-30"
              disabled={L.layers.length <= 1}
              onClick={async () => {
                const n = await countLayerItems(songId, l.id)
                const ok = await confirmDialog({
                  title: `Delete layer "${l.name}"?`,
                  message: n ? `Its ${n} annotation${n > 1 ? 's' : ''} on all pages of this song will be deleted (you can undo that).` : 'The layer is empty.',
                  confirmLabel: 'Delete',
                  danger: true,
                })
                if (ok) await deleteLayer(songId, l.id)
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={async () => {
          const n = await promptDialog({ title: 'New layer', label: 'Name', initial: '' })
          if (n !== null) await addLayer(songId, n)
        }}
        className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/10"
      >
        <Plus className="size-4 text-muted" /> New layer
      </button>
      <p className="px-3 pb-1 pt-1 text-xs text-muted">Layers apply to every page of this song. Hidden layers stay hidden while performing.</p>
    </DarkPop>
  )
}

function MorePopover({ anchor, open, onClose, songId }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; songId: string }) {
  const a = useSettings((s) => s.s.annotations)
  const setA = (p: Partial<typeof a>) => useSettings.getState().setIn('annotations', p)
  const item = 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10'
  return (
    <DarkPop anchor={anchor} open={open} onClose={onClose} align="end" className="w-[min(92vw,19rem)] p-2">
      <button
        type="button"
        className={item}
        onClick={async () => {
          onClose()
          const n = await paste()
          if (!n) toast('Nothing to paste')
        }}
      >
        <ClipboardPaste className="size-4 text-muted" /> Paste
      </button>
      <button
        type="button"
        className={item}
        onClick={() => {
          onClose()
          setTool('select')
          selectAll()
        }}
      >
        <LassoSelect className="size-4 text-muted" /> Select all on page
      </button>
      <div className="my-1 h-px bg-white/10" />
      <button
        type="button"
        className={cx(item, 'text-danger')}
        onClick={async () => {
          onClose()
          const keys = visibleKeys()
          const count = keys.reduce((n, k) => n + getItems(k).length, 0)
          if (!count) return toast('No annotations on this page')
          if (await confirmDialog({ title: 'Clear this page?', message: `Delete ${count} annotation${count > 1 ? 's' : ''} on the visible page${keys.length > 1 ? 's' : ''}. You can undo this.`, confirmLabel: 'Clear', danger: true })) {
            clearPages(keys)
            toast('Page cleared', 'info', { label: 'Undo', run: () => undo() })
          }
        }}
      >
        <Trash2 className="size-4" /> Clear page…
      </button>
      <button
        type="button"
        className={cx(item, 'text-danger')}
        onClick={async () => {
          onClose()
          if (await confirmDialog({ title: 'Clear the whole song?', message: 'Delete all annotations on every page of this song. You can undo this while annotating.', confirmLabel: 'Clear all', danger: true })) {
            const n = await clearSong(songId)
            toast(n ? `Deleted ${n} annotations` : 'No annotations in this song', 'info', n ? { label: 'Undo', run: () => undo() } : undefined)
          }
        }}
      >
        <Trash2 className="size-4" /> Clear song…
      </button>
      <button
        type="button"
        className={item}
        onClick={async () => {
          onClose()
          const n = historySize()
          if (!n) return toast('No changes in this session')
          if (await confirmDialog({ title: 'Revert this session?', message: `Undo all ${n} change${n > 1 ? 's' : ''} made since you started annotating.`, confirmLabel: 'Revert', danger: true }))
            while (undo());
        }}
      >
        <Undo2 className="size-4 text-muted" /> Revert session…
      </button>
      <div className="my-1 h-px bg-white/10" />
      <div className="px-3 py-1">
        <Row label="Stylus only (fingers turn pages)">
          <Toggle checked={a.stylusOnly} onChange={(v) => setA({ stylusOnly: v })} label="Stylus only" />
        </Row>
        <Row label="Pressure sensitivity">
          <Toggle checked={a.pressure} onChange={(v) => setA({ pressure: v })} label="Pressure" />
        </Row>
        <Row label="Palm rejection">
          <Toggle checked={a.palmRejection} onChange={(v) => setA({ palmRejection: v })} label="Palm rejection" />
        </Row>
        <div className="py-1.5 text-sm">
          <div className="mb-1.5 text-muted">Ink smoothing</div>
          <Segmented
            size="sm"
            className="w-full"
            value={a.smoothing}
            onChange={(v) => setA({ smoothing: v })}
            options={[
              { value: 0, label: 'Off' },
              { value: 1, label: 'Light' },
              { value: 2, label: 'Medium' },
              { value: 3, label: 'Strong' },
            ]}
          />
        </div>
      </div>
      <p className="px-3 pb-1 pt-1 text-[11px] leading-relaxed text-faint">
        Keys: P pen · H highlighter · E eraser · S select · T text · K stamp · L/A/R/O/C shapes · ⌘Z undo · Del delete · 1–9 presets · D done
      </p>
    </DarkPop>
  )
}

/* ---------------------------------------------------------------- Toolbar */

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

export function AnnotationToolbar({ song, onDone }: { song: Song; onDone: () => void }) {
  const a = useSettings((s) => s.s.annotations)
  const tempEraser = useAnnotUI((s) => s.tempEraser)
  const selection = useAnnotUI((s) => s.selection)
  const { canUndo, canRedo } = useAnnotHistory()
  const layers = useSongLayers(song.id)
  const tool: ToolId = tempEraser ? 'eraser' : a.tool
  const cfg = toolConfig(tool, a.tools)
  const [lastShape, setLastShape] = useState<ShapeTool>(isShapeTool(a.tool) ? a.tool : 'line')
  useEffect(() => {
    if (isShapeTool(a.tool)) setLastShape(a.tool)
  }, [a.tool])

  // Selected items (re-derived when the selection or its page changes).
  const selPage = usePageItems(selection?.key ?? NO_PAGE)
  const selItems = useMemo(() => {
    if (!selection) return null
    const ids = new Set(selection.ids)
    const items = selPage.filter((i) => ids.has(i.id))
    return items.length ? items : null
  }, [selection, selPage])

  const shownColor = selItems ? (selItems.find((i) => i.type !== 'image')?.color ?? cfg.color) : cfg.color
  const shownOpacity = selItems ? selItems[0].opacity : cfg.opacity

  const colorM = useMenu()
  const optsM = useMenu()
  const stampM = useMenu()
  const shapeM = useMenu()
  const presetM = useMenu()
  const layerM = useMenu()
  const moreM = useMenu()

  const doUndo = () => {
    const l = undo()
    if (!l) toast('Nothing to undo')
  }
  const doRedo = () => {
    const l = redo()
    if (!l) toast('Nothing to redo')
  }

  // Undo/redo as performable actions while annotating.
  useEffect(() => registerActions({ undoAnnotation: doUndo, redoAnnotation: doRedo }), [])

  // Session lifecycle: save and forget history when leaving annotation mode.
  useEffect(() => {
    resetHistory()
    return () => {
      useAnnotUI.setState({ selection: null, tempEraser: false })
      // Let an open text editor commit first.
      setTimeout(() => {
        useAnnotUI.setState({ editing: null })
        void flush()
        resetHistory()
      }, 20)
    }
  }, [])

  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.defaultPrevented) return
      const mod = e.ctrlKey || e.metaKey
      const sel = !!useAnnotUI.getState().selection
      let handled = true
      if (mod && e.code === 'KeyZ') {
        if (e.shiftKey) doRedo()
        else doUndo()
      }
      else if (mod && e.code === 'KeyY') doRedo()
      else if (mod && e.code === 'KeyC') {
        const n = copySelection()
        if (n) toast(n > 1 ? `${n} annotations copied` : '1 annotation copied')
      } else if (mod && e.code === 'KeyX') copySelection(true)
      else if (mod && e.code === 'KeyV') void paste()
      else if (mod && e.code === 'KeyD') duplicateSelection()
      else if (mod && e.code === 'KeyA') {
        setTool('select')
        selectAll()
      } else if (mod) handled = false
      else if ((e.code === 'Delete' || e.code === 'Backspace') && sel) deleteSelection()
      else if (e.code === 'Escape') {
        if (sel) useAnnotUI.setState({ selection: null })
        else done.current()
      } else if (e.code === 'KeyD') done.current()
      else if (e.code.startsWith('Arrow') && sel) {
        const step = e.shiftKey ? 0.01 : 0.002
        nudgeSelection(e.code === 'ArrowLeft' ? -step : e.code === 'ArrowRight' ? step : 0, e.code === 'ArrowUp' ? -step : e.code === 'ArrowDown' ? step : 0)
      } else if (['ArrowRight', 'ArrowDown', 'PageDown', 'Space'].includes(e.code)) runAction('nextPage', 'key')
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.code)) runAction('prevPage', 'key')
      else if (/^Digit[1-9]$/.test(e.code)) {
        const p = settings().annotations.presets[Number(e.code.slice(5)) - 1]
        if (p) applyPreset(p)
        else handled = false
      } else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        const t = settings().annotations.tool
        const [min, max, step] = SIZE_RANGE[t]
        const c = toolConfig(t, settings().annotations.tools)
        patchToolConfig({ size: Math.min(max, Math.max(min, c.size + (e.code === 'BracketRight' ? step * 2 : -step * 2))) })
      } else if (TOOL_KEYS[e.code] && !e.altKey) setTool(TOOL_KEYS[e.code]!)
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toolBtn = (t: ToolId) => (
    <TB key={t} label={`${TOOL_LABEL[t]}`} active={tool === t} onClick={() => setTool(t)}>
      <ToolIcon tool={t} />
    </TB>
  )

  const currentLayer = layers.layers.find((l) => l.id === layers.current)
  const sizeDot = Math.max(3, Math.min(18, tool === 'eraser' ? cfg.size / 5 : tool === 'text' || tool === 'stamp' ? cfg.size / 4 : cfg.size * (tool === 'highlighter' ? 0.4 : 1.4)))

  return (
    <div className="border-t border-white/10 bg-neutral-950/85 text-white backdrop-blur-md" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1.5 pl-2 pr-1 [scrollbar-width:none]" role="toolbar" aria-label="Annotation tools">
        <TB label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={doUndo}>
          <Undo2 className="size-[18px]" />
        </TB>
        <TB label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={doRedo}>
          <Redo2 className="size-[18px]" />
        </TB>
        <Sep />
        {(['pen', 'highlighter', 'eraser', 'select', 'text'] as ToolId[]).map(toolBtn)}
        <TB label="Stamp" active={tool === 'stamp'} btnRef={stampM.ref} onClick={() => (tool === 'stamp' ? stampM.toggle() : setTool('stamp'))}>
          {tool === 'stamp' ? <StampGlyph id={cfg.stamp ?? 'fermata'} className="h-5 max-w-8 text-[15px]" /> : <ToolIcon tool="stamp" />}
        </TB>
        <TB label={`Shapes (${TOOL_LABEL[lastShape]})`} active={isShapeTool(tool)} btnRef={shapeM.ref} onClick={() => (isShapeTool(tool) ? shapeM.toggle() : setTool(lastShape))}>
          <ToolIcon tool={isShapeTool(tool) ? tool : lastShape} />
          <span className="absolute bottom-1 right-1 size-0 border-l-[4px] border-t-[4px] border-l-transparent border-t-current opacity-60" />
        </TB>
        <Sep />
        <button
          ref={colorM.ref}
          type="button"
          onClick={colorM.toggle}
          aria-label="Colour and opacity"
          title="Colour and opacity"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl hover:bg-white/10 pointer-coarse:size-11 disabled:opacity-30"
          disabled={tool === 'eraser' || (tool === 'select' && !selItems)}
        >
          <span className="size-6 rounded-full border-2 border-white/80 shadow" style={{ background: shownColor, opacity: Math.max(0.35, shownOpacity) }} />
        </button>
        <div className="hidden items-center gap-1 px-1 lg:flex">
          {PALETTE.slice(0, 7).map((c) => (
            <Swatch key={c} size="sm" color={c} active={c === shownColor} onClick={() => applyStyle({ color: c })} />
          ))}
        </div>
        <TB label="Size and options" btnRef={optsM.ref} onClick={optsM.toggle} disabled={tool === 'select' && !selItems}>
          <span className="rounded-full bg-current" style={{ width: sizeDot, height: sizeDot }} />
        </TB>
        {selItems && (
          <>
            <Sep />
            <span className="shrink-0 px-1 text-xs tabular-nums text-white/60">{selItems.length} selected</span>
            <TB label="Delete selection (Del)" onClick={deleteSelection}>
              <Trash2 className="size-[18px]" />
            </TB>
            <TB label="Duplicate (Ctrl+D)" onClick={duplicateSelection}>
              <CopyPlus className="size-[18px]" />
            </TB>
            <TB
              label="Copy (Ctrl+C)"
              onClick={() => {
                const n = copySelection()
                toast(n > 1 ? `${n} annotations copied` : '1 annotation copied')
              }}
            >
              <Copy className="size-[18px]" />
            </TB>
            <TB label="Bring to front" onClick={() => reorderSelection(true)}>
              <BringToFront className="size-[18px]" />
            </TB>
            <TB label="Deselect (Esc)" onClick={() => useAnnotUI.setState({ selection: null })}>
              <X className="size-[18px]" />
            </TB>
          </>
        )}
        {!selItems && hasClipboard() && tool === 'select' && (
          <TB label="Paste (Ctrl+V)" onClick={() => void paste()}>
            <ClipboardPaste className="size-[18px]" />
          </TB>
        )}
        <Sep />
        <div className="hidden items-center md:flex">
          {a.presets.slice(0, 6).map((p) => (
            <PresetChip key={p.id} p={p} onClick={() => applyPreset(p)} active={p.tool === a.tool && p.config.color === cfg.color && p.config.size === cfg.size} />
          ))}
        </div>
        <TB label="Presets" btnRef={presetM.ref} onClick={presetM.toggle}>
          <Star className="size-[18px]" />
        </TB>
        <TB label={`Layers (${currentLayer?.name ?? 'Default'})`} btnRef={layerM.ref} onClick={layerM.toggle}>
          <LayersIcon className="size-[18px]" />
          {layers.layers.length > 1 && (
            <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-[var(--os-accent)] px-1 text-[10px] font-semibold leading-4 text-[var(--os-accent-fg)]">{layers.layers.length}</span>
          )}
        </TB>
        <TB label="More" btnRef={moreM.ref} onClick={moreM.toggle}>
          <Ellipsis className="size-[18px]" />
        </TB>
        <div className="min-w-2 flex-1" />
        <TB label="Previous page" onClick={() => runAction('prevPage', 'touch')}>
          <ChevronLeft className="size-5" />
        </TB>
        <TB label="Next page" onClick={() => runAction('nextPage', 'touch')}>
          <ChevronRight className="size-5" />
        </TB>
      </div>
        <button
          type="button"
          onClick={onDone}
          aria-label="Done annotating"
          title="Done (D)"
          className="mr-2 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--os-accent)] px-3 text-sm font-semibold text-[var(--os-accent-fg)] shadow-[-12px_0_12px_-6px_rgba(0,0,0,0.6)] hover:brightness-110 pointer-coarse:h-11 sm:px-3.5"
        >
          <Check className="size-4" />
          <span className="hidden sm:inline">Done</span>
        </button>
      </div>
      {a.stylusOnly && <div className="pointer-events-none px-3 pb-1 text-[11px] text-white/50">Stylus mode · fingers scroll and turn pages</div>}

      <ColorPopover
        anchor={colorM.anchor}
        open={colorM.open}
        onClose={colorM.close}
        value={shownColor}
        opacity={shownOpacity}
        onPick={(c) => applyStyle({ color: c })}
        onOpacity={(o) => applyStyle({ opacity: o })}
      />
      <OptionsPopover anchor={optsM.anchor} open={optsM.open} onClose={optsM.close} tool={tool} cfg={cfg} selection={selItems} />
      <StampPopover anchor={stampM.anchor} open={stampM.open} onClose={stampM.close} value={cfg.stamp ?? 'fermata'} onPick={(id) => patchToolConfig({ stamp: id }, 'stamp')} />
      <DarkPop anchor={shapeM.anchor} open={shapeM.open} onClose={shapeM.close} align="start" className="p-1.5">
        <div className="grid grid-cols-3 gap-1">
          {SHAPE_TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTool(t)
                shapeM.close()
              }}
              className={cx('flex w-24 flex-col items-center gap-1 rounded-lg px-2 py-2 text-xs', t === tool ? 'bg-white text-neutral-900' : 'text-fg hover:bg-white/10')}
            >
              <ToolIcon tool={t} className="size-5" />
              {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
      </DarkPop>
      <PresetsPopover anchor={presetM.anchor} open={presetM.open} onClose={presetM.close} />
      <LayersPopover anchor={layerM.anchor} open={layerM.open} onClose={layerM.close} songId={song.id} hasSelection={!!selItems} />
      <MorePopover anchor={moreM.anchor} open={moreM.open} onClose={moreM.close} songId={song.id} />
    </div>
  )
}
