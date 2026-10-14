import { create } from 'zustand'

export type Panel = null | 'setlist' | 'bookmarks' | 'display' | 'metronome' | 'audio' | 'notes' | 'text' | 'goto' | 'links' | 'midi' | 'pages'

export interface ViewerState {
  /** Songs being performed in order (a setlist, a filtered library list, or a single song). */
  queue: string[]
  /** Index in queue of the current song. */
  index: number
  setlistId?: string
  /** Page position within the current song, in display-page units (0.5 steps for half-page turns). */
  position: number
  /** Position to restore when returning from a followed link. */
  linkReturn: number[]
  toolbar: boolean
  annotating: boolean
  panel: Panel
  /** Session-only text overrides keyed by song id */
  transpose: Record<string, number>
  /** Session zoom for text songs */
  textZoom: number
  hideAnnotations: boolean
  metronomeOn: boolean
  autoScrollOn: boolean

  open: (queue: string[], index?: number, opts?: { setlistId?: string; position?: number }) => void
  close: () => void
  goSong: (index: number, position?: number) => void
  setPosition: (p: number) => void
  set: (patch: Partial<ViewerState>) => void
}

export const useViewer = create<ViewerState>((set) => ({
  queue: [],
  index: 0,
  position: 0,
  linkReturn: [],
  toolbar: true,
  annotating: false,
  panel: null,
  transpose: {},
  textZoom: 1,
  hideAnnotations: false,
  metronomeOn: false,
  autoScrollOn: false,

  open: (queue, index = 0, opts = {}) =>
    set({
      queue,
      index,
      setlistId: opts.setlistId,
      position: opts.position ?? 0,
      linkReturn: [],
      toolbar: true,
      annotating: false,
      panel: null,
      autoScrollOn: false,
    }),
  close: () => set({ queue: [], index: 0, setlistId: undefined, annotating: false, panel: null, metronomeOn: false, autoScrollOn: false }),
  goSong: (index, position = 0) => set({ index, position, linkReturn: [], autoScrollOn: false }),
  setPosition: (position) => set({ position }),
  set: (patch) => set(patch),
}))

export const currentSongId = () => {
  const s = useViewer.getState()
  return s.queue[s.index]
}
