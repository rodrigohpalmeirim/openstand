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

export type LibraryRoute = { name: 'library'; section: Section; group?: string; setlistId?: string }
export type Route = LibraryRoute | { name: 'settings'; page?: string }

const ROUTE_KEY = 'openstand-route'
const HOME: LibraryRoute = { name: 'library', section: 'songs' }

/** The library route saved by the last session (validated against the library later, see Library.tsx). */
function savedRoute(): LibraryRoute {
  try {
    const r = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? 'null') as Partial<LibraryRoute> | null
    if (r?.name === 'library' && typeof r.section === 'string')
      return {
        name: 'library',
        section: r.section,
        ...(typeof r.group === 'string' ? { group: r.group } : {}),
        ...(typeof r.setlistId === 'string' ? { setlistId: r.setlistId } : {}),
      }
  } catch {
    /* corrupt or unavailable storage */
  }
  return HOME
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false
  if (a.name === 'settings') return a.page === (b as typeof a).page
  const c = b as LibraryRoute
  return a.section === c.section && a.group === c.group && a.setlistId === c.setlistId
}

interface NavState {
  route: Route
  go: (r: Route) => void
  /** Last library route (where Settings returns to). */
  lastLibrary: LibraryRoute
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

const initial = savedRoute()

export const useNav = create<NavState>((set) => ({
  route: initial,
  go: (route) => set(route.name === 'library' ? { route, lastLibrary: route } : { route }),
  lastLibrary: initial,
  query: '',
  setQuery: (query) => set({ query }),
  searchField: 'all',
  setSearchField: (searchField) => set({ searchField }),
  filter: {},
  setFilter: (filter) => set({ filter }),
  libraryEpoch: 0,
  bumpLibrary: () =>
    set((s) => ({ libraryEpoch: s.libraryEpoch + 1, route: HOME, lastLibrary: HOME, query: '', filter: {} })),
}))

// Remember the library section across reloads.
useNav.subscribe((s, prev) => {
  if (s.lastLibrary === prev.lastLibrary) return
  try {
    localStorage.setItem(ROUTE_KEY, JSON.stringify(s.lastLibrary))
  } catch {
    /* storage full or blocked */
  }
})
