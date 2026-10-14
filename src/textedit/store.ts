import { create } from 'zustand'

/** Open/close state of the full-screen text editor, kept apart from the (large) editor component. */
export interface EditorTarget {
  songId: string
  fileId: string
}

export const useTextEditor = create<{ target: EditorTarget | null }>(() => ({ target: null }))

/** Open the full-screen text editor for a file of a song. */
export function openTextEditor(songId: string, fileId: string) {
  useTextEditor.setState({ target: { songId, fileId } })
}

export function closeTextEditor() {
  useTextEditor.setState({ target: null })
}
