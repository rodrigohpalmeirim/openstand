import { create } from 'zustand'
import type { LibraryFilter, SearchField } from '../library/browse/logic'

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
  /** Field the search box looks in. */
  searchField: SearchField
  setSearchField: (f: SearchField) => void
  /** Active library filter (quick + advanced). */
  filter: LibraryFilter
  setFilter: (f: LibraryFilter) => void
  /** Bumped when the active library (IndexedDB) changes so views remount and re-query. */
  libraryEpoch: number
  bumpLibrary: () => void
}

export const useNav = create<NavState>((set) => ({
  route: { name: 'library', section: 'songs' },
  go: (route) => set({ route }),
  query: '',
  setQuery: (query) => set({ query }),
  searchField: 'all',
  setSearchField: (searchField) => set({ searchField }),
  filter: {},
  setFilter: (filter) => set({ filter }),
  libraryEpoch: 0,
  bumpLibrary: () =>
    set((s) => ({ libraryEpoch: s.libraryEpoch + 1, route: { name: 'library', section: 'songs' }, query: '', filter: {} })),
}))
