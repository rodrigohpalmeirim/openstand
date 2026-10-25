import { describe, expect, it } from 'vitest'
import { emptySong, type Song } from '../../db/schema'
import {
  buildLetterIndex,
  filterCount,
  formatDuration,
  groupValues,
  indexLetter,
  keyRank,
  matchesFilter,
  matchesTerms,
  moveItem,
  normalize,
  parseArticles,
  queryTerms,
  quickGroupValue,
  removeFromList,
  renameInList,
  searchText,
  setQuickGroup,
  shuffled,
  sortArtist,
  sortGroups,
  sortSongs,
  sortTitle,
  stripArticle,
  uniqueTitle,
} from './logic'

let n = 0
const song = (title: string, p: Partial<Song> = {}): Song => emptySong({ id: `s${++n}`, title, ...p })
const opts = { ignoreArticles: true, articles: parseArticles('A, An, The'), locale: 'en' }
const titles = (xs: Song[]) => xs.map((s) => s.title)

describe('normalize', () => {
  it('strips diacritics, punctuation and case', () => {
    expect(normalize('Ça va, l’été!')).toBe('ca va lete')
    expect(normalize('  Dvořák:  Humoresque (Op. 101) ')).toBe('dvorak humoresque op 101')
    expect(normalize('Øresund Straße')).toBe('oresund strasse')
  })
  it('keeps sharps so keys stay searchable', () => {
    expect(normalize('C#m')).toBe('c#m')
  })
})

describe('articles', () => {
  const a = parseArticles('A, An, The, L\'')
  it('parses the list', () => expect(a).toEqual(['a', 'an', 'the', "l'"]))
  it('strips one leading article', () => {
    expect(stripArticle('The Girl from Ipanema', a)).toBe('Girl from Ipanema')
    expect(stripArticle('A Night in Tunisia', a)).toBe('Night in Tunisia')
    expect(stripArticle("L'amour", a)).toBe('amour')
  })
  it('leaves words that merely start with an article alone', () => {
    expect(stripArticle('Theme from X', a)).toBe('Theme from X')
    expect(stripArticle('Anthem', a)).toBe('Anthem')
    expect(stripArticle('The', a)).toBe('The')
  })
  it('sortTitle prefers an explicit sort title', () => {
    expect(sortTitle({ title: 'The End', sortTitle: 'Zzz' }, opts)).toBe('Zzz')
    expect(sortTitle({ title: 'The End' }, opts)).toBe('End')
    expect(sortTitle({ title: 'The End' }, { ...opts, ignoreArticles: false })).toBe('The End')
  })
})

describe('A–Z index', () => {
  it('buckets letters, accents and digits', () => {
    expect(indexLetter('Émotion')).toBe('E')
    expect(indexLetter('42nd Street')).toBe('#')
    expect(indexLetter('"Quoted"')).toBe('Q')
  })
  it('records the first row of each letter', () => {
    const m = buildLetterIndex(['10 Bars', 'Alpha', 'Amber', 'Beta'])
    expect([...m.entries()]).toEqual([
      ['#', 0],
      ['A', 1],
      ['B', 3],
    ])
  })
})

describe('sortSongs', () => {
  const list = [
    song('The Zebra'),
    song('apple'),
    song('Éclair'),
    song('Song 10'),
    song('Song 2'),
    song('Banana', { artists: ['Zed'] }),
  ]
  it('collates by title ignoring articles, case and accents, numerically', () => {
    expect(titles(sortSongs(list, { field: 'title', dir: 'asc' }, opts))).toEqual([
      'apple',
      'Banana',
      'Éclair',
      'Song 2',
      'Song 10',
      'The Zebra',
    ])
  })
  it('reverses for desc', () => {
    expect(titles(sortSongs(list, { field: 'title', dir: 'desc' }, opts))[0]).toBe('The Zebra')
  })
  it('puts missing values last in both directions', () => {
    const xs = [song('A', { rating: 0 }), song('B', { rating: 5 }), song('C', { rating: 3 })]
    expect(titles(sortSongs(xs, { field: 'rating', dir: 'desc' }, opts))).toEqual(['B', 'C', 'A'])
    expect(titles(sortSongs(xs, { field: 'rating', dir: 'asc' }, opts))).toEqual(['C', 'B', 'A'])
  })
  it('sorts by artist then title, artistless last', () => {
    const xs = [song('X'), song('B', { artists: ['Miles'] }), song('A', { artists: ['Miles'] }), song('C', { artists: ['Bill'] })]
    expect(titles(sortSongs(xs, { field: 'artist', dir: 'asc' }, opts))).toEqual(['C', 'A', 'B', 'X'])
  })
  it('ignores leading articles in artist names when asked', () => {
    const xs = [song('1', { artists: ['The Police'] }), song('2', { artists: ['Queen'] }), song('3', { composers: ['A Composer'] })]
    expect(titles(sortSongs(xs, { field: 'artist', dir: 'asc' }, opts))).toEqual(['3', '1', '2'])
    expect(titles(sortSongs(xs, { field: 'artist', dir: 'asc' }, { ...opts, ignoreArticles: false }))).toEqual(['3', '2', '1'])
    expect(sortArtist(xs[0], opts)).toBe('Police')
    expect(sortArtist(song('none'), opts)).toBeUndefined()
  })
  it('sorts by musical key', () => {
    const xs = [song('1', { keys: ['G'] }), song('2', { keys: ['C#m'] }), song('3', { keys: ['Db'] }), song('4', { keys: ['C'] }), song('5')]
    expect(titles(sortSongs(xs, { field: 'key', dir: 'asc' }, opts))).toEqual(['4', '3', '2', '1', '5'])
  })
})

describe('keyRank', () => {
  it('orders pitch classes with major before minor', () => {
    expect(keyRank('C')).toBeLessThan(keyRank('Cm'))
    expect(keyRank('C#')).toBe(keyRank('Db'))
    expect(keyRank('Bb')).toBe(keyRank('A#'))
    expect(keyRank('Cmaj7')).toBe(keyRank('C'))
    expect(keyRank('?')).toBe(Infinity)
  })
})

describe('search', () => {
  const s = song('Garota de Ipanema', { artists: ['João Gilberto'], keywords: 'bossa', notes: 'Capo 2', keys: ['F'] })
  it('matches across fields, accent/punctuation-insensitive, all terms', () => {
    const h = searchText(s, 'all')
    expect(matchesTerms(h, queryTerms('joao ipan'))).toBe(true)
    expect(matchesTerms(h, queryTerms('bossa capo'))).toBe(true)
    expect(matchesTerms(h, queryTerms('joao samba'))).toBe(false)
  })
  it('restricts to a field', () => {
    expect(matchesTerms(searchText(s, 'title'), queryTerms('joao'))).toBe(false)
    expect(matchesTerms(searchText(s, 'artists'), queryTerms('joão'))).toBe(true)
  })
  it('keeps quoted phrases together', () => {
    expect(queryTerms('"de Ipanema" x')).toEqual(['de ipanema', 'x'])
    expect(matchesTerms(searchText(s, 'all'), queryTerms('"ipanema de"'))).toBe(false)
  })
})

describe('filters', () => {
  const a = song('A', { genres: ['Jazz'], rating: 4, difficulty: 3, audio: [{ id: 'x', name: 'x' }], metronome: { bpm: 120 } })
  const b = song('B', { genres: ['Rock', 'Pop'], rating: 2 })
  const c = song('C', { favorite: true })
  it('include / exclude / assigned / unassigned', () => {
    const inc = { groups: { genres: { mode: 'include' as const, values: ['jazz', 'pop'] } } }
    expect([a, b, c].filter((s) => matchesFilter(s, inc)).map((s) => s.title)).toEqual(['A', 'B'])
    const exc = { groups: { genres: { mode: 'exclude' as const, values: ['Rock'] } } }
    expect([a, b, c].filter((s) => matchesFilter(s, exc)).map((s) => s.title)).toEqual(['A', 'C'])
    const una = { groups: { genres: { mode: 'unassigned' as const, values: [] } } }
    expect([a, b, c].filter((s) => matchesFilter(s, una)).map((s) => s.title)).toEqual(['C'])
    const asg = { groups: { genres: { mode: 'assigned' as const, values: [] } } }
    expect([a, b, c].filter((s) => matchesFilter(s, asg)).map((s) => s.title)).toEqual(['A', 'B'])
  })
  it('rating, difficulty, audio, metronome, favourite', () => {
    expect(matchesFilter(a, { minRating: 3 })).toBe(true)
    expect(matchesFilter(b, { minRating: 3 })).toBe(false)
    expect(matchesFilter(a, { difficulty: [1, 3] })).toBe(true)
    expect(matchesFilter(b, { difficulty: [1, 3] })).toBe(false)
    expect(matchesFilter(a, { audio: 'has' })).toBe(true)
    expect(matchesFilter(b, { audio: 'none' })).toBe(true)
    expect(matchesFilter(a, { metronome: 'configured' })).toBe(true)
    expect(matchesFilter(b, { metronome: 'configured' })).toBe(false)
    expect(matchesFilter(c, { favorite: true })).toBe(true)
    expect(matchesFilter(a, { favorite: true })).toBe(false)
  })
  it('quick filters and counting', () => {
    let f = setQuickGroup({}, 'keys', 'G')
    expect(quickGroupValue(f, 'keys')).toBe('G')
    f = { ...f, minRating: 2 }
    expect(filterCount(f)).toBe(2)
    f = setQuickGroup(f, 'keys', null)
    expect(filterCount(f)).toBe(1)
    expect(filterCount({ groups: { genres: { mode: 'include', values: [] } } })).toBe(0)
  })
})

describe('groups', () => {
  it('counts distinct values, merging case/accent variants', () => {
    const xs = [song('1', { artists: ['Björk'], duration: 60 }), song('2', { artists: ['bjork', 'Sia'], duration: 30 }), song('3')]
    const g = groupValues(xs, 'artists')
    expect(g).toEqual([
      { name: 'Björk', count: 2, duration: 90 },
      { name: 'Sia', count: 1, duration: 30 },
    ])
    expect(sortGroups(g, 'name-desc', 'artists', opts).map((x) => x.name)).toEqual(['Sia', 'Björk'])
    expect(sortGroups(g, 'count-asc', 'artists', opts).map((x) => x.name)).toEqual(['Sia', 'Björk'])
  })
  it('renames with merge and removes', () => {
    expect(renameInList(['Old', 'New'], 'old', 'New')).toEqual(['New'])
    expect(renameInList(['A'], 'B', 'C')).toBeNull()
    expect(removeFromList(['A', 'B'], 'a')).toEqual(['B'])
  })
})

describe('misc', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3725)).toBe('1:02:05')
  })
  it('makes unique titles', () => {
    expect(uniqueTitle('Song', ['Other'])).toBe('Song')
    expect(uniqueTitle('Song', ['Song', 'Song (1)'])).toBe('Song (2)')
    expect(uniqueTitle('Song (1)', ['Song (1)'])).toBe('Song (2)')
  })
  it('shuffles and moves without mutating', () => {
    const a = [1, 2, 3, 4]
    expect(shuffled(a, () => 0).sort()).toEqual([1, 2, 3, 4])
    expect(a).toEqual([1, 2, 3, 4])
    expect(moveItem(a, 0, 2)).toEqual([2, 3, 1, 4])
  })
})
