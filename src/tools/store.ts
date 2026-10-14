import { create } from 'zustand'
import type { SmartButton } from '../db/schema'
import { useViewer } from '../state/viewer'

/** A position picked on a page (normalised 0..1 like annotations). */
export interface PagePoint {
  pageIndex: number
  x: number
  y: number
}

export type PickPurpose =
  | { kind: 'linkFrom' }
  | { kind: 'linkTo'; from: PagePoint }
  | { kind: 'linkMove'; linkId: string; end: 'from' | 'to' }
  | { kind: 'button'; draft: SmartButton }

/** Transient (session-only) state of the performance tools. */
interface ToolsState {
  /** Index of the next link point "activate link" will follow (list order). */
  linkPointer: number
  /** Index of the next smart button for the next/previous smart button actions. */
  buttonPointer: number
  /** Waiting for the user to tap a page location. */
  pick: PickPurpose | null
  /** Session multiplier on the auto-scroll speed (faster/slower actions). */
  scrollFactor: number
  /** Next auto-scroll start skips the initial delay (e.g. after a metronome count-in). */
  skipScrollDelay: boolean
  /** Auto-scroll status for the progress indicator. */
  scroll: { phase: 'idle' | 'delay' | 'running' | 'paused' | 'turning' | 'done'; progress: number; countdown: number; timed: boolean }
  notesPopup: boolean
  playerVisible: boolean
  /** Links panel tab, so pick flows can return to the right place. */
  linksTab: 'links' | 'buttons'
  set: (p: Partial<ToolsState>) => void
}

export const useTools = create<ToolsState>((set) => ({
  linkPointer: 0,
  buttonPointer: 0,
  pick: null,
  scrollFactor: 1,
  skipScrollDelay: false,
  scroll: { phase: 'idle', progress: 0, countdown: 0, timed: false },
  notesPopup: false,
  playerVisible: false,
  linksTab: 'links',
  set: (p) => set(p),
}))

export function startAutoScroll(opts: { skipDelay?: boolean } = {}) {
  useTools.setState({ skipScrollDelay: !!opts.skipDelay })
  useViewer.setState({ autoScrollOn: true })
}

export function stopAutoScroll() {
  useViewer.setState({ autoScrollOn: false })
}

/** Begin a "tap a location" flow; the side panel is closed so the page is visible. */
export function beginPick(p: PickPurpose) {
  useTools.setState({ pick: p })
  useViewer.setState({ panel: null, toolbar: false })
}

export function cancelPick() {
  useTools.setState({ pick: null })
  useViewer.setState({ panel: 'links' })
}
