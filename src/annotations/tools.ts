/** Annotation tools, their settings and defaults. Sizes are in thousandths of the page (see SIZE_UNITS). */

export type ToolId =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'select'
  | 'text'
  | 'stamp'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'crescendo'
  | 'decrescendo'
  | 'staff'
  | 'snip'

export type ShapeTool = 'line' | 'arrow' | 'rect' | 'ellipse' | 'crescendo' | 'decrescendo' | 'staff'
export const SHAPE_TOOLS: ShapeTool[] = ['line', 'arrow', 'rect', 'ellipse', 'crescendo', 'decrescendo', 'staff']
export const isShapeTool = (t: string): t is ShapeTool => (SHAPE_TOOLS as string[]).includes(t)

export type EraserMode = 'stroke' | 'object' | 'box'

export interface ToolConfig {
  color: string
  /**
   * pen/highlighter/shapes: stroke width, eraser: diameter (thousandths of page width);
   * text: font size, stamp: height (thousandths of page height).
   */
  size: number
  /** 0..1 */
  opacity: number
  dashed?: boolean
  fill?: boolean
  bold?: boolean
  italic?: boolean
  /** Text: draw a background box (white). */
  background?: boolean
  font?: 'sans' | 'serif' | 'mono'
  eraser?: EraserMode
  /** Stamp catalogue id. */
  stamp?: string
  /** Hairpin opening, thousandths of page width. */
  height?: number
  /** Piano staff: number of measures. */
  measures?: number
}

export interface AnnotationPreset {
  id: string
  tool: ToolId
  config: ToolConfig
}

export const DEFAULT_TOOLS: Record<ToolId, ToolConfig> = {
  pen: { color: '#1f2937', size: 2.5, opacity: 1 },
  highlighter: { color: '#ffe14d', size: 18, opacity: 0.85 },
  eraser: { color: '#000000', size: 24, opacity: 1, eraser: 'stroke' },
  select: { color: '#000000', size: 2.5, opacity: 1 },
  text: { color: '#c81e1e', size: 22, opacity: 1, font: 'sans', bold: false, italic: false, background: false },
  stamp: { color: '#1f2937', size: 34, opacity: 1, stamp: 'fermata' },
  line: { color: '#1f2937', size: 2.5, opacity: 1 },
  arrow: { color: '#c81e1e', size: 2.5, opacity: 1 },
  rect: { color: '#2563eb', size: 2.5, opacity: 1 },
  ellipse: { color: '#c81e1e', size: 2.5, opacity: 1 },
  crescendo: { color: '#1f2937', size: 2, opacity: 1, height: 18 },
  decrescendo: { color: '#1f2937', size: 2, opacity: 1, height: 18 },
  staff: { color: '#1f2937', size: 1.2, opacity: 1, measures: 4 },
  snip: { color: '#000000', size: 1, opacity: 1 },
}

export const SIZE_RANGE: Record<ToolId, [min: number, max: number, step: number]> = {
  pen: [0.5, 20, 0.5],
  highlighter: [4, 60, 1],
  eraser: [6, 120, 2],
  select: [0.5, 20, 0.5],
  text: [10, 90, 1],
  stamp: [12, 140, 2],
  line: [0.5, 20, 0.5],
  arrow: [0.5, 20, 0.5],
  rect: [0.5, 20, 0.5],
  ellipse: [0.5, 20, 0.5],
  crescendo: [0.5, 12, 0.5],
  decrescendo: [0.5, 12, 0.5],
  staff: [0.5, 5, 0.1],
  snip: [1, 1, 1],
}

export const TOOL_LABEL: Record<ToolId, string> = {
  pen: 'Pen',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
  select: 'Select',
  text: 'Text',
  stamp: 'Stamp',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  crescendo: 'Crescendo',
  decrescendo: 'Decrescendo',
  staff: 'Piano staff',
  snip: 'Snip region',
}

/** Keyboard shortcuts while annotating (KeyboardEvent.code). */
export const TOOL_KEYS: Partial<Record<string, ToolId>> = {
  KeyP: 'pen',
  KeyH: 'highlighter',
  KeyE: 'eraser',
  KeyS: 'select',
  KeyV: 'select',
  KeyT: 'text',
  KeyK: 'stamp',
  KeyL: 'line',
  KeyA: 'arrow',
  KeyR: 'rect',
  KeyO: 'ellipse',
  KeyC: 'crescendo',
}

/** Stroke palette: readable on white paper, distinct from each other, and sensible for highlighting. */
export const PALETTE = [
  '#1f2937', // ink
  '#c81e1e', // red
  '#ea580c', // orange
  '#ffe14d', // highlighter yellow
  '#16a34a', // green
  '#0d9488', // teal
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
  '#8b5a2b', // brown
  '#9ca3af', // grey
  '#ffffff', // white (correction)
]

export const MEASURES_RANGE: [min: number, max: number] = [1, 12]

export function toolConfig(tool: ToolId, stored?: Partial<Record<string, Partial<ToolConfig>>>): ToolConfig {
  return { ...DEFAULT_TOOLS[tool], ...(stored?.[tool] ?? {}) }
}

/** Push a colour to the front of a recent list (deduped, max 8, palette colours excluded). */
export function pushRecent(recent: string[], color: string, max = 8): string[] {
  const c = color.toLowerCase()
  if (PALETTE.includes(c)) return recent
  return [c, ...recent.filter((r) => r.toLowerCase() !== c)].slice(0, max)
}
