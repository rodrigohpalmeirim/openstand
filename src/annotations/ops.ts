/** Editing operations used by the toolbar, keyboard shortcuts and the page layer. */
import { uid } from '../db/db'
import type { Annotation, ImageAnnotation } from '../db/schema'
import { terms } from '../library/browse/terms'
import { settings, useSettings } from '../state/settings'
import { bboxNorm, resizeItem, round, stretchY, translateItem, unionRect, type Vec } from './geometry'
import { itemAnchor, snapDelta } from './grid'
import { getLayers } from './layers'
import { clampMeasures } from './staff'
import { commit, getItems, loadSong, mountedElement, parseKey, selectedItems, setSelection, update, useAnnotUI, visibleKeys, type PageChange } from './store'
import { pushRecent, toolConfig, type ToolConfig, type ToolId } from './tools'

/* ----------------------------------------------------------- Tool config */

export function setTool(tool: ToolId) {
  useSettings.getState().setIn('annotations', { tool })
  if (tool !== 'select') useAnnotUI.setState({ selection: null })
}

export function currentConfig(tool = settings().annotations.tool): ToolConfig {
  return toolConfig(tool, settings().annotations.tools)
}

/** Update the config of a tool (defaults to the current one). */
export function patchToolConfig(patch: Partial<ToolConfig>, tool = settings().annotations.tool) {
  const a = settings().annotations
  const next = { ...(a.tools[tool] ?? {}), ...patch }
  const recentColors = patch.color ? pushRecent(a.recentColors, patch.color) : a.recentColors
  useSettings.getState().setIn('annotations', { tools: { ...a.tools, [tool]: next }, recentColors })
}

const rememberColor = (color: string | undefined) => {
  if (!color) return
  const a = settings().annotations
  useSettings.getState().setIn('annotations', { recentColors: pushRecent(a.recentColors, color) })
}

/**
 * Change style. With a selection, the selected items change (one undo step); while re-editing an existing
 * text, that text's own style does (saved with the text); otherwise the current tool's settings do.
 * `size` scales selected items proportionally.
 */
export function applyStyle(patch: Partial<ToolConfig>, opts: { sizeFrom?: number } = {}) {
  const sel = selectedItems()
  if (!sel) {
    const editing = useAnnotUI.getState().editing
    if (!editing?.id) return patchToolConfig(patch)
    rememberColor(patch.color)
    useAnnotUI.setState({ editing: { ...editing, style: { ...editing.style, ...patch } } })
    return
  }
  rememberColor(patch.color)
  const ids = new Set(sel.items.map((i) => i.id))
  update(sel.key, 'Change style', (items) =>
    items.map((it) => {
      if (!ids.has(it.id)) return it
      let next: Annotation = it
      if (patch.color !== undefined && it.type !== 'image') next = { ...next, color: patch.color }
      if (patch.opacity !== undefined) next = { ...next, opacity: patch.opacity }
      if (patch.size !== undefined && opts.sizeFrom) next = resizeItem(next, patch.size / opts.sizeFrom)
      if (patch.dashed !== undefined && (next.type === 'pen' || next.type === 'line' || next.type === 'rect' || next.type === 'ellipse' || next.type === 'arrow'))
        next = { ...next, dashed: patch.dashed }
      if (patch.fill !== undefined && (next.type === 'rect' || next.type === 'ellipse')) next = { ...next, fill: patch.fill }
      if (patch.measures !== undefined && next.type === 'staff') next = { ...next, measures: clampMeasures(patch.measures) }
      if (next.type === 'text') {
        if (patch.bold !== undefined) next = { ...next, bold: patch.bold }
        if (patch.italic !== undefined) next = { ...next, italic: patch.italic }
        if (patch.font !== undefined) next = { ...next, font: patch.font }
        if (patch.background !== undefined) next = { ...next, background: patch.background ? '#ffffff' : undefined }
      }
      return next
    }),
  )
}

/* ------------------------------------------------------------- Selection */

export function deleteSelection() {
  const sel = selectedItems()
  if (!sel) return
  const ids = new Set(sel.items.map((i) => i.id))
  update(sel.key, sel.items.length > 1 ? `Delete ${sel.items.length} annotations` : 'Delete annotation', (items) => items.filter((i) => !ids.has(i.id)))
  useAnnotUI.setState({ selection: null })
}

const cloneWithId = (it: Annotation): Annotation => ({ ...it, id: uid(), createdAt: Date.now() })

export function duplicateSelection() {
  const sel = selectedItems()
  if (!sel) return
  const copies = sel.items.map((i) => translateItem(cloneWithId(i), 0.02, 0.02))
  update(sel.key, 'Duplicate', (items) => [...items, ...copies])
  setSelection(sel.key, copies.map((c) => c.id))
}

/**
 * In-app annotation clipboard (copied annotations or a snipped page region). `aspect` is the
 * height/width of the source page, so pasting onto a differently shaped page keeps proportions.
 */
let clipboard: { items: Annotation[]; aspect: number; key?: string } = { items: [], aspect: 1.3 }

/** Height / width of a page that is on screen (falls back to a portrait page). */
export function pageAspect(key: string): number {
  const el = mountedElement(key) ?? document.querySelector<HTMLElement>(`[data-annot-key="${CSS.escape(key)}"]`)
  return el && el.clientWidth > 0 ? el.clientHeight / el.clientWidth : 1.3
}

export function setClipboard(items: Annotation[], aspect: number, key?: string) {
  clipboard = { items, aspect, key }
}

export function copySelection(cut = false): number {
  const sel = selectedItems()
  if (!sel) return 0
  setClipboard(sel.items, pageAspect(sel.key), sel.key)
  if (cut) deleteSelection()
  return clipboard.items.length
}

export const hasClipboard = () => clipboard.items.length > 0

/** Snap cell (fraction of page width) when snap-to-grid is on, else 0. */
export function snapCell(): number {
  const g = settings().annotations.grid
  return g?.snap ? g.size / 1000 : 0
}

/**
 * Paste the clipboard. With `at`, the pasted group's top-left goes to that point of page `key`
 * (long-press paste); otherwise it keeps its position, offset a little on its source page.
 */
export async function paste(at?: { key: string; p: Vec }): Promise<number> {
  const key = at?.key ?? pasteTarget()
  if (!key || !clipboard.items.length) return 0
  const { songId } = parseKey(key)
  const { current } = await getLayers(songId)
  const aspect = pageAspect(key)
  const k = clipboard.aspect / aspect
  const src = clipboard.items
  const top = Math.min(...src.map((i) => bboxNorm(i, clipboard.aspect).y0))
  let copies = src.map((i) => stretchY({ ...cloneWithId(i), layer: current }, top, k))
  const box = unionRect(copies.map((c) => bboxNorm(c, aspect)))!
  let dx = 0
  let dy = 0
  if (at) {
    dx = at.p.x - box.x0
    dy = at.p.y - box.y0
  } else if (clipboard.key === key || getItems(key).some((i) => src.some((c) => c.id === i.id))) {
    dx = dy = 0.02
  }
  // Keep the group on the page.
  dx = Math.min(Math.max(dx, -box.x0), Math.max(-box.x0, 1 - box.x1))
  dy = Math.min(Math.max(dy, -box.y0), Math.max(-box.y0, 1 - box.y1))
  const cell = snapCell()
  if (cell) ({ dx, dy } = snapDelta(itemAnchor(copies[0], aspect), dx, dy, cell, aspect))
  if (dx || dy) copies = copies.map((c) => translateItem(c, dx, dy))
  update(key, 'Paste', (items) => [...items, ...copies])
  if (settings().annotations.tool !== 'select') setTool('select')
  setSelection(key, copies.map((c) => c.id))
  return copies.length
}

function pasteTarget(): string | null {
  const vis = visibleKeys()
  const active = useAnnotUI.getState().activeKey
  return active && vis.includes(active) ? active : (vis[0] ?? active)
}

export function moveSelectionToLayer(layerId: string) {
  const sel = selectedItems()
  if (!sel) return
  const ids = new Set(sel.items.map((i) => i.id))
  update(sel.key, 'Move to layer', (items) => items.map((i) => (ids.has(i.id) ? { ...i, layer: layerId } : i)))
}

/** Bring to front / send to back within the page. */
export function reorderSelection(front: boolean) {
  const sel = selectedItems()
  if (!sel) return
  const ids = new Set(sel.items.map((i) => i.id))
  update(sel.key, front ? 'Bring to front' : 'Send to back', (items) => {
    const picked = items.filter((i) => ids.has(i.id))
    const rest = items.filter((i) => !ids.has(i.id))
    return front ? [...rest, ...picked] : [...picked, ...rest]
  })
}

export function nudgeSelection(dx: number, dy: number) {
  const sel = selectedItems()
  if (!sel) return
  const ids = new Set(sel.items.map((i) => i.id))
  update(sel.key, 'Nudge', (items) => items.map((i) => (ids.has(i.id) ? translateItem(i, dx, dy) : i)))
}

export function selectAll() {
  const key = pasteTarget()
  if (!key) return
  setSelection(key, getItems(key).map((i) => i.id))
}

/* ------------------------------------------------------------ Clearing */

export function clearPages(keys: string[]): number {
  const changes: PageChange[] = keys.map((key) => ({ key, before: getItems(key), after: [] }))
  const n = changes.reduce((a, c) => a + c.before.length, 0)
  if (n) commit('Clear page', changes)
  useAnnotUI.setState({ selection: null })
  return n
}

export async function clearSong(songId: string): Promise<number> {
  const keys = await loadSong(songId)
  const changes: PageChange[] = keys.map((key) => ({ key, before: getItems(key), after: [] }))
  const n = changes.reduce((a, c) => a + c.before.length, 0)
  if (n) commit(`Clear ${terms(settings()).song}`, changes)
  useAnnotUI.setState({ selection: null })
  return n
}

/* --------------------------------------------------------------- Images */

async function downscale(file: File, max = 1200): Promise<{ src: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  const png = file.type === 'image/png' || file.type === 'image/svg+xml' || file.type === 'image/gif'
  return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85), w, h }
}

/** Place a picture on the visible page, 30 % of the page wide, selected for positioning. */
export async function addImage(file: File): Promise<boolean> {
  const key = pasteTarget()
  if (!key) return false
  const { songId } = parseKey(key)
  const { current } = await getLayers(songId)
  const img = await downscale(file)
  const el = document.querySelector<HTMLElement>(`[data-annot-key="${CSS.escape(key)}"]`)
  const aspect = el ? el.clientHeight / Math.max(1, el.clientWidth) : 1.3
  const wN = 0.3
  const hN = (wN * img.h) / img.w / aspect
  const item: ImageAnnotation = {
    id: uid(),
    type: 'image',
    layer: current,
    color: '#000000',
    opacity: 1,
    createdAt: Date.now(),
    a: { x: round(0.5 - wN / 2), y: round(0.4 - hN / 2) },
    b: { x: round(0.5 + wN / 2), y: round(0.4 + hN / 2) },
    src: img.src,
  }
  update(key, 'Add image', (items) => [...items, item])
  setTool('select')
  setSelection(key, [item.id])
  return true
}
