/**
 * Pure library logic: normalisation, collation, sorting, search, filters and the A–Z index.
 * No DOM / DB access here so everything is unit-testable.
 */
import { GROUP_FIELDS, type GroupField, type Song } from '../../db/schema'

/* ----------------------------------------------------------- Normalisation */

const MARKS = /\p{Mn}+/gu
// Punctuation removed before matching (spec 3: diacritics and punctuation are ignored when searching).
const PUNCT = /[(){},.:;!?<>%'"‘’“”«»[\]]/g

/** Lower-case, strip diacritics and punctuation, collapse whitespace. "Ça va, l'été!" → "ca va lete" */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(MARKS, '')
    // characters that don't decompose under NFD
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .toLowerCase()
    .replace(PUNCT, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse the user's article list ("A, An, The") into lower-case words. */
export function parseArticles(list: string): string[] {
  return list
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
}

export const DEFAULT_ARTICLES = 'A, An, The'

/** Remove one leading article: "The Girl from Ipanema" → "Girl from Ipanema". Keeps the title if it IS the article. */
export function stripArticle(title: string, articles: string[]): string {
  const t = title.trimStart()
  const lower = t.toLowerCase()
  for (const a of articles) {
    if (lower.startsWith(a + ' ') && t.length > a.length + 1) return t.slice(a.length + 1).trimStart()
    // French/Italian elision: "L'amour", "l’été"
    if (a.endsWith("'") && lower.startsWith(a)) return t.slice(a.length)
  }
  return t
}

/** Letter bucket for the A–Z index: "A".."Z" or "#" for digits/symbols. */
export function indexLetter(s: string): string {
  const n = normalize(s)
  const c = n.charAt(0).toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}

export const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

/* --------------------------------------------------------------- Collation */

const collators = new Map<string, Intl.Collator>()
/** Locale-aware, accent-insensitive, numeric ("Song 2" < "Song 10") collator. */
export function collator(locale?: string): Intl.Collator {
  const k = locale ?? ''
  let c = collators.get(k)
  if (!c) {
    c = new Intl.Collator(locale, { sensitivity: 'base', numeric: true, ignorePunctuation: true })
    collators.set(k, c)
  }
  return c
}

/* -------------------------------------------------------------------- Keys */

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11, h: 11 }

/** Sort rank for a musical key: C < C#/Db < D … with major before minor. Unknown → Infinity. */
export function keyRank(key: string | undefined): number {
  if (!key) return Infinity
  const m = /^\s*([A-Ha-h])([#♯b♭]?)\s*(min|m(?!aj)|-)?/.exec(key)
  if (!m) return Infinity
  let p = PITCH[m[1].toLowerCase()]
  if (m[2] === '#' || m[2] === '♯') p += 1
  if (m[2] === 'b' || m[2] === '♭') p -= 1
  p = (p + 12) % 12
  return p * 2 + (m[3] ? 1 : 0)
}

/* ----------------------------------------------------------------- Sorting */

export type SortField =
  | 'title'
  | 'artist'
  | 'createdAt'
  | 'modifiedAt'
  | 'lastPlayedAt'
  | 'playCount'
  | 'rating'
  | 'difficulty'
  | 'duration'
  | 'key'
export interface SortSpec {
  field: SortField
  dir: 'asc' | 'desc'
}

export interface SortOptions {
  ignoreArticles: boolean
  articles: string[]
  locale?: string
}

/** Title used for sorting and the A–Z index. */
export function sortTitle(song: Pick<Song, 'title' | 'sortTitle'>, o: Pick<SortOptions, 'ignoreArticles' | 'articles'>): string {
  if (song.sortTitle?.trim()) return song.sortTitle
  return o.ignoreArticles ? stripArticle(song.title, o.articles) : song.title
}

function numeric(s: Song, f: SortField): number | undefined {
  switch (f) {
    case 'createdAt':
      return s.createdAt
    case 'modifiedAt':
      return s.modifiedAt
    case 'lastPlayedAt':
      return s.lastPlayedAt
    case 'playCount':
      return s.playCount
    case 'rating':
      return s.rating || undefined
    case 'difficulty':
      return s.difficulty || undefined
    case 'duration':
      return s.duration || undefined
    case 'key': {
      const r = keyRank(s.keys[0])
      return r === Infinity ? undefined : r
    }
    default:
      return undefined
  }
}

/** The name a song sorts under when sorting by artist (falls back to the composer). */
export function sortArtist(song: Pick<Song, 'artists' | 'composers'>, o: Pick<SortOptions, 'ignoreArticles' | 'articles'>): string | undefined {
  const a = song.artists[0] ?? song.composers[0]
  return a !== undefined && o.ignoreArticles ? stripArticle(a, o.articles) : a
}

/**
 * Sort songs. Missing values (no rating, never played, …) always go last, whatever the direction;
 * ties fall back to the title so the order is stable and predictable.
 */
export function sortSongs(songs: Song[], spec: SortSpec, o: SortOptions): Song[] {
  const col = collator(o.locale)
  const titles = new Map<string, string>()
  const t = (s: Song) => {
    let v = titles.get(s.id)
    if (v === undefined) titles.set(s.id, (v = sortTitle(s, o)))
    return v
  }
  const byTitle = (a: Song, b: Song) => col.compare(t(a), t(b))
  const sign = spec.dir === 'desc' ? -1 : 1
  let cmp: (a: Song, b: Song) => number
  if (spec.field === 'title') cmp = (a, b) => sign * byTitle(a, b)
  else if (spec.field === 'artist') {
    cmp = (a, b) => {
      const x = sortArtist(a, o)
      const y = sortArtist(b, o)
      if (!x !== !y) return x ? -1 : 1
      return (x && y ? sign * col.compare(x, y) : 0) || byTitle(a, b)
    }
  } else {
    cmp = (a, b) => {
      const x = numeric(a, spec.field)
      const y = numeric(b, spec.field)
      if ((x === undefined) !== (y === undefined)) return x === undefined ? 1 : -1
      return (x !== undefined && y !== undefined ? sign * (x - y) : 0) || byTitle(a, b)
    }
  }
  return [...songs].sort(cmp)
}

/** Default direction when the user picks a sort field (newest/most first for dates and counts). */
export function defaultDir(f: SortField): 'asc' | 'desc' {
  return f === 'createdAt' || f === 'modifiedAt' || f === 'lastPlayedAt' || f === 'playCount' || f === 'rating' ? 'desc' : 'asc'
}

/** Which value the A–Z index letters are taken from for a sort, or null when letters make no sense. */
export function indexSource(spec: SortSpec): 'title' | 'artist' | null {
  return spec.field === 'title' ? 'title' : spec.field === 'artist' ? 'artist' : null
}

/** First row for each letter of the (already sorted) list. */
export function buildLetterIndex(labels: string[]): Map<string, number> {
  const m = new Map<string, number>()
  labels.forEach((l, i) => {
    const k = indexLetter(l)
    if (!m.has(k)) m.set(k, i)
  })
  return m
}

/* ------------------------------------------------------------------ Search */

export type SearchField = 'all' | 'title' | 'notes' | 'keywords' | GroupField

export const SEARCH_FIELDS: SearchField[] = ['all', 'title', ...GROUP_FIELDS, 'keywords', 'notes']

function fieldText(s: Song, f: Exclude<SearchField, 'all'>): string {
  switch (f) {
    case 'title':
      return s.title + (s.sortTitle ? ' ' + s.sortTitle : '')
    case 'notes':
      return s.notes
    case 'keywords':
      return s.keywords
    default:
      return (s[f] ?? []).join(' ')
  }
}

/** Normalised haystack for a song and field. */
export function searchText(s: Song, field: SearchField): string {
  if (field !== 'all') return normalize(fieldText(s, field))
  const parts = [s.title, s.sortTitle ?? '', s.keywords, s.notes, ...GROUP_FIELDS.flatMap((g) => s[g] ?? [])]
  for (const f of s.files) parts.push(f.name)
  for (const b of s.bookmarks) parts.push(b.name)
  return normalize(parts.join(' \u0001 '))
}

/** Split a query into normalised terms; "quoted phrases" stay together. */
export function queryTerms(q: string): string[] {
  const out: string[] = []
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = normalize(m[1] ?? m[2])
    if (t) out.push(t)
  }
  return out
}

/** All terms must occur (AND). Matching is substring based so partial words work while typing. */
export function matchesTerms(haystack: string, terms: string[]): boolean {
  return terms.every((t) => haystack.includes(t))
}

/* ----------------------------------------------------------------- Filters */

export type GroupMode = 'include' | 'exclude' | 'assigned' | 'unassigned'
export interface GroupFilter {
  mode: GroupMode
  values: string[]
}

export interface LibraryFilter {
  groups?: Partial<Record<GroupField, GroupFilter>>
  /** Inclusive difficulty range (1..15). */
  difficulty?: [number, number]
  /** Minimum star rating (1..5). */
  minRating?: number
  audio?: 'has' | 'none'
  metronome?: 'configured' | 'none'
  favorite?: boolean
}

export function emptyFilter(): LibraryFilter {
  return {}
}

/** Number of active conditions (for the filter button badge). */
export function filterCount(f: LibraryFilter): number {
  let n = 0
  for (const g of Object.values(f.groups ?? {})) if (g && isActiveGroup(g)) n++
  if (f.difficulty) n++
  if (f.minRating) n++
  if (f.audio) n++
  if (f.metronome) n++
  if (f.favorite) n++
  return n
}

function isActiveGroup(g: GroupFilter) {
  return g.mode === 'assigned' || g.mode === 'unassigned' || g.values.length > 0
}

/** The song has its own tempo (the metronome plays the tempo list; older versions saved metronome.bpm). */
export function hasMetronome(s: Song): boolean {
  return !!s.tempos?.some((t) => t > 0) || (!!s.metronome && typeof s.metronome.bpm === 'number' && s.metronome.bpm > 0)
}

/** Group values are compared case-/accent-insensitively ("Bärenreiter" == "barenreiter"). */
function sameValue(a: string, b: string) {
  return normalize(a) === normalize(b)
}

export function matchGroup(values: string[], g: GroupFilter): boolean {
  switch (g.mode) {
    case 'assigned':
      return values.length > 0
    case 'unassigned':
      return values.length === 0
    case 'include':
      return g.values.length === 0 || values.some((v) => g.values.some((w) => sameValue(v, w)))
    case 'exclude':
      return !values.some((v) => g.values.some((w) => sameValue(v, w)))
  }
}

export function matchesFilter(s: Song, f: LibraryFilter): boolean {
  if (f.favorite && !s.favorite) return false
  if (f.minRating && (s.rating ?? 0) < f.minRating) return false
  if (f.difficulty) {
    const d = s.difficulty ?? 0
    if (!d || d < f.difficulty[0] || d > f.difficulty[1]) return false
  }
  if (f.audio === 'has' && !s.audio.length) return false
  if (f.audio === 'none' && s.audio.length) return false
  if (f.metronome === 'configured' && !hasMetronome(s)) return false
  if (f.metronome === 'none' && hasMetronome(s)) return false
  if (f.groups) {
    for (const [field, g] of Object.entries(f.groups) as [GroupField, GroupFilter | undefined][]) {
      if (g && !matchGroup(s[field] ?? [], g)) return false
    }
  }
  return true
}

/** Set (or clear with null) a single-value include filter: what the quick filter dropdowns do. */
export function setQuickGroup(f: LibraryFilter, field: GroupField, value: string | null): LibraryFilter {
  const groups = { ...f.groups }
  if (value === null) delete groups[field]
  else groups[field] = { mode: 'include', values: [value] }
  return { ...f, groups }
}

/** The single include value of a quick filter, if that's what's set. */
export function quickGroupValue(f: LibraryFilter, field: GroupField): string | null {
  const g = f.groups?.[field]
  return g && g.mode === 'include' && g.values.length === 1 ? g.values[0] : null
}

/* ------------------------------------------------------------------ Groups */

export interface GroupValue {
  name: string
  count: number
  /** Sum of song durations (seconds). */
  duration: number
}

/** Distinct values of a group field with song counts. Values differing only by case/accents are merged. */
export function groupValues(songs: Song[], field: GroupField): GroupValue[] {
  const m = new Map<string, GroupValue>()
  for (const s of songs) {
    const seen = new Set<string>()
    for (const v of s[field] ?? []) {
      const name = v.trim()
      if (!name) continue
      const k = normalize(name) || name
      if (seen.has(k)) continue
      seen.add(k)
      const g = m.get(k)
      if (g) {
        g.count++
        g.duration += s.duration || 0
      } else m.set(k, { name, count: 1, duration: s.duration || 0 })
    }
  }
  return [...m.values()]
}

export type GroupSort = 'name-asc' | 'name-desc' | 'count-desc' | 'count-asc'

export function sortGroups(groups: GroupValue[], by: GroupSort, field: GroupField, o: SortOptions): GroupValue[] {
  const col = collator(o.locale)
  const label = (g: GroupValue) => stripArticle(g.name, o.ignoreArticles ? o.articles : [])
  const byName = (a: GroupValue, b: GroupValue) =>
    field === 'keys' ? keyRank(a.name) - keyRank(b.name) || col.compare(a.name, b.name) : col.compare(label(a), label(b))
  const out = [...groups]
  switch (by) {
    case 'name-asc':
      return out.sort(byName)
    case 'name-desc':
      return out.sort((a, b) => byName(b, a))
    case 'count-desc':
      return out.sort((a, b) => b.count - a.count || byName(a, b))
    case 'count-asc':
      return out.sort((a, b) => a.count - b.count || byName(a, b))
  }
}

/** Rename (or merge) a group value inside one song's list. Returns null when the song is unaffected. */
export function renameInList(values: string[], from: string, to: string): string[] | null {
  if (!values.some((v) => sameValue(v, from))) return null
  const out: string[] = []
  for (const v of values) {
    const next = sameValue(v, from) ? to : v
    if (!out.some((o) => sameValue(o, next))) out.push(next)
  }
  return out
}

export function removeFromList(values: string[], name: string): string[] | null {
  if (!values.some((v) => sameValue(v, name))) return null
  return values.filter((v) => !sameValue(v, name))
}

export function addToList(values: string[], name: string): string[] | null {
  if (values.some((v) => sameValue(v, name))) return null
  return [...values, name]
}

export function songHasValue(s: Song, field: GroupField, name: string) {
  return (s[field] ?? []).some((v) => sameValue(v, name))
}

/* --------------------------------------------------------------- Formatting */

export function formatDuration(sec: number): string {
  if (!sec || sec < 0) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** Long form for totals: "1 h 12 min", "45 min". */
export function formatTotal(sec: number): string {
  if (!sec) return ''
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim()
}

/** A title that doesn't collide with existing ones: "Song" → "Song (1)" → "Song (2)". */
export function uniqueTitle(base: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((t) => t.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  const stem = base.replace(/\s*\(\d+\)$/, '')
  for (let i = 1; ; i++) {
    const t = `${stem} (${i})`
    if (!taken.has(t.toLowerCase())) return t
  }
}

/** Fisher–Yates shuffle (pure: returns a copy). */
export function shuffled<T>(arr: T[], rnd: () => number = Math.random): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Move an item within an array (pure). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const a = [...arr]
  const [x] = a.splice(from, 1)
  a.splice(to, 0, x)
  return a
}
