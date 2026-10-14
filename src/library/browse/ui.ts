/** Library-wide UI state: which dialogs are open. Menus anywhere in the library call these. */
import { create } from 'zustand'
import type { ImportSource } from '../../files/import'

export type EditorTab = 'fields' | 'files' | 'audio' | 'midi'

interface LibraryUI {
  /** `queue`: the list the song was opened from, for the editor's "Save & next". */
  editor: { songId: string | null; tab?: EditorTab; queue?: string[] } | null
  importing: { initial?: ImportSource[] } | null
  addTo: { kind: 'setlist' | 'collection'; ids: string[] } | null
  batch: string[] | null
  libraries: boolean
  prefs: boolean
  drawer: boolean
  set: (p: Partial<Omit<LibraryUI, 'set'>>) => void
}

export const useLibraryUI = create<LibraryUI>((set) => ({
  editor: null,
  importing: null,
  addTo: null,
  batch: null,
  libraries: false,
  prefs: false,
  drawer: false,
  set: (p) => set(p),
}))

export const ui = {
  edit: (songId: string | null, tab?: EditorTab, queue?: string[]) => useLibraryUI.getState().set({ editor: { songId, tab, queue } }),
  import: (initial?: ImportSource[]) => useLibraryUI.getState().set({ importing: { initial } }),
  addTo: (kind: 'setlist' | 'collection', ids: string[]) => useLibraryUI.getState().set({ addTo: { kind, ids } }),
  batch: (ids: string[]) => useLibraryUI.getState().set({ batch: ids }),
  libraries: () => useLibraryUI.getState().set({ libraries: true }),
  prefs: () => useLibraryUI.getState().set({ prefs: true }),
}
