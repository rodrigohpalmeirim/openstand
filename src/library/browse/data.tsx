import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { db } from '../../db/db'
import type { Setlist, Song } from '../../db/schema'
import { useSettings } from '../../state/settings'
import { getExtraCollections } from './ops'
import { parseArticles, type SortOptions } from './logic'

export interface LibraryData {
  loaded: boolean
  songs: Song[]
  byId: Map<string, Song>
  setlists: Setlist[]
  /** Collections created without songs yet. */
  extraCollections: string[]
}

const Ctx = createContext<LibraryData>({ loaded: false, songs: [], byId: new Map(), setlists: [], extraCollections: [] })

/** One live query for the whole library; every view derives from it (fast enough for many thousands of songs). */
export function LibraryDataProvider({ children }: { children: ReactNode }) {
  const songs = useLiveQuery(() => db.songs.toArray(), [])
  const setlists = useLiveQuery(() => db.setlists.toArray(), [])
  const extra = useLiveQuery(() => getExtraCollections(), [])
  const value = useMemo<LibraryData>(
    () => ({
      loaded: songs !== undefined && setlists !== undefined,
      songs: songs ?? [],
      byId: new Map((songs ?? []).map((s) => [s.id, s])),
      setlists: setlists ?? [],
      extraCollections: extra ?? [],
    }),
    [songs, setlists, extra],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useLibrary = () => useContext(Ctx)

export function useSortOptions(): SortOptions {
  const ignoreArticles = useSettings((s) => s.s.ignoreArticles)
  const articles = useSettings((s) => s.s.articles)
  return useMemo(() => ({ ignoreArticles, articles: parseArticles(articles) }), [ignoreArticles, articles])
}
