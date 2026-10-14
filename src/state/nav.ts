import { create } from 'zustand'

/** Library sections. Group sections list distinct values of a song field. */
export type Section =
  | 'songs'
  | 'recent'
  | 'favorites'
  | 'setlists'
  | 'bookmarks'
  | 'collections'
  | 'artists'
  | 'composers'
  | 'albums'
  | 'genres'
  | 'keys'
  | 'signatures'
  | 'sources'
  | 'years'
  | 'tags'
  | 'custom'
  | 'custom2'

export type Route =
  | { name: 'library'; section: Section; group?: string; setlistId?: string }
  | { name: 'settings'; page?: string }

interface NavState {
  route: Route
  go: (r: Route) => void
  /** Search text in the library */
  query: string
  setQuery: (q: string) => void
}

export const useNav = create<NavState>((set) => ({
  route: { name: 'library', section: 'songs' },
  go: (route) => set({ route }),
  query: '',
  setQuery: (query) => set({ query }),
}))
