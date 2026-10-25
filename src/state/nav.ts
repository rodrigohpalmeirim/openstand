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
/** Set while Settings is open (its section, '' for the list), so a reload stays there. Per tab (session
 *  storage): a cold start, another window or an "Open with" file launch starts in the library. */
const SETTINGS_KEY = 'openstand-route-settings'
const HOME: LibraryRoute = { name: 'library', section: 'songs' }

function savedSettingsPage(): string | undefined | null {
  try {
    localStorage.removeItem(SETTINGS_KEY) // where older versions kept it
    const page = sessionStorage.getItem(SETTINGS_KEY)
    return page === null ? null : page || undefined
  } catch {
    return null
  }
}

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
const initialSettings = savedSettingsPage()

export const useNav = create<NavState>((set) => ({
  route: initialSettings === null ? initial : { name: 'settings', page: initialSettings },
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

// Remember the library section across sessions, and an open Settings page across reloads of this tab.
useNav.subscribe((s, prev) => {
  try {
    if (s.lastLibrary !== prev.lastLibrary) localStorage.setItem(ROUTE_KEY, JSON.stringify(s.lastLibrary))
    if (s.route !== prev.route) {
      if (s.route.name === 'settings') sessionStorage.setItem(SETTINGS_KEY, s.route.page ?? '')
      else sessionStorage.removeItem(SETTINGS_KEY)
    }
  } catch {
    /* storage full or blocked */
  }
})
