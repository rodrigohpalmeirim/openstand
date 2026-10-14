import type { GroupField } from '../../db/schema'
import type { Section } from '../../state/nav'
import { useSettings, type Settings } from '../../state/settings'

const PLURAL: Record<GroupField, string> = {
  artists: 'Artists',
  composers: 'Composers',
  albums: 'Albums',
  genres: 'Genres',
  collections: 'Collections',
  keys: 'Keys',
  signatures: 'Time signatures',
  sources: 'Sources',
  years: 'Years',
  tags: 'Tags',
  custom: 'Custom',
  custom2: 'Custom 2',
}
const SINGULAR: Record<GroupField, string> = {
  artists: 'Artist',
  composers: 'Composer',
  albums: 'Album',
  genres: 'Genre',
  collections: 'Collection',
  keys: 'Key',
  signatures: 'Time signature',
  sources: 'Source',
  years: 'Year',
  tags: 'Tag',
  custom: 'Custom',
  custom2: 'Custom 2',
}

/** Group sections that can appear under "Browse by" (setlists/collections live in the top block). */
export const BROWSE_GROUPS: GroupField[] = ['artists', 'composers', 'albums', 'genres', 'keys', 'signatures', 'sources', 'years', 'tags', 'custom', 'custom2']

export const CLASSICAL_GROUPS = ['setlists', 'collections', 'composers', 'albums', 'genres', 'years', 'keys', 'signatures', 'sources', 'tags']

export interface Terms {
  song: string
  songs: string
  Song: string
  Songs: string
  /** Plural label of a group field (user-customisable). */
  group: (f: GroupField) => string
  /** Singular label of a group field. */
  one: (f: GroupField) => string
  section: (s: Section) => string
  count: (n: number) => string
}

export function terms(s: Pick<Settings, 'terminology' | 'fieldLabels'>): Terms {
  const piece = s.terminology === 'piece'
  const song = piece ? 'piece' : 'song'
  const songs = piece ? 'pieces' : 'songs'
  const cap = (x: string) => x[0].toUpperCase() + x.slice(1)
  const group = (f: GroupField) => s.fieldLabels[f]?.trim() || (piece && f === 'albums' ? 'Books' : PLURAL[f])
  const one = (f: GroupField) => {
    const custom = s.fieldLabels[f]?.trim()
    if (custom) return custom.length > 3 && custom.endsWith('s') && !custom.endsWith('ss') ? custom.slice(0, -1) : custom
    return piece && f === 'albums' ? 'Book' : SINGULAR[f]
  }
  return {
    song,
    songs,
    Song: cap(song),
    Songs: cap(songs),
    group,
    one,
    section: (sec) => {
      switch (sec) {
        case 'songs':
          return cap(songs)
        case 'recent':
          return 'Recent'
        case 'favorites':
          return 'Favorites'
        case 'setlists':
          return 'Setlists'
        case 'bookmarks':
          return 'Bookmarks'
        default:
          return group(sec)
      }
    },
    count: (n) => `${n.toLocaleString()} ${n === 1 ? song : songs}`,
  }
}

export function useTerms(): Terms {
  const terminology = useSettings((st) => st.s.terminology)
  const fieldLabels = useSettings((st) => st.s.fieldLabels)
  return terms({ terminology, fieldLabels })
}

export function isGroupSection(s: Section): s is GroupField {
  return s === 'collections' || (BROWSE_GROUPS as string[]).includes(s)
}
