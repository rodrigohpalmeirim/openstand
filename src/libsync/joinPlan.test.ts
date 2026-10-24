// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Song, SongFile } from '../db/schema'
import { joinFileMap, joinLayers, joinPages, joinSong, normTitle, planJoin, remapSetlist } from './joinPlan'
import { hash, page, setlist, song, stroke, T0 } from './merge.test-helper'

/** Local songs use legacy uuid blob ids; remote ones use the hash as the id (§8.7). */
const legacy = new Map<string, string>()
const hashOf = (blobId: string) => legacy.get(blobId) ?? (/^[0-9a-f]{64}$/.test(blobId) ? blobId : '')
const file = (id: string, content: string, local = false): SongFile => {
  const h = hash(content)
  const blobId = local ? `uuid-${content}-${id}` : h
  if (local) legacy.set(blobId, h)
  return { id, name: `${content}.pdf`, kind: 'pdf', blobId, pageCount: 2, size: 10 }
}

describe('planJoin match rules (§10.3)', () => {
  const remoteSongs = [
    song('R1', { title: 'Autumn Leaves', files: [file('rf1', 'leaves'), file('rf2', 'leaves-lyrics')] }),
    song('R2', { title: 'Blue Bossa', files: [file('rf3', 'bossa')] }),
    song('R3', { title: 'No Files' }),
    song('R4', { title: 'Misty', files: [file('rf4', 'misty')] }),
    song('R5', { title: 'Dup', files: [file('rf5', 'dup')] }),
  ]

  it('matches identical ordered file hashes plus equal normalised titles, regardless of blob ids', () => {
    const local = [
      song('L1', { title: 'The autumn   LEAVES!', files: [file('lf1', 'leaves', true), file('lf2', 'leaves-lyrics', true)] }),
      song('L2', { title: 'Blue Bossa (live)', files: [file('lf3', 'bossa', true)] }), // renamed: separate
      song('L3', { title: 'Misty', files: [file('lf4', 'other', true)] }), // same title, other files: separate
      song('L4', { title: 'Autumn Leaves', files: [file('lf5', 'leaves-lyrics', true), file('lf6', 'leaves', true)] }), // order differs
      song('L5', { title: 'No Files' }), // no files: never matches
    ]
    const plan = planJoin({ songs: local, setlists: [] }, { songs: remoteSongs, setlists: [] }, hashOf)
    expect([...plan.songMap]).toEqual([['L1', 'R1']])
    expect(plan.added).toEqual({ songs: 4, setlists: 0 })
    expect(normTitle('The Autumn Leaves')).toBe(normTitle('autumn leaves'))
  })

  it('songs with a file whose data is unknown never match', () => {
    const l = song('L', { title: 'Misty', files: [{ ...file('x', 'misty'), blobId: 'missing' }] })
    const r = song('R', { title: 'Misty', files: [{ ...file('y', 'misty'), blobId: '' }] })
    expect(planJoin({ songs: [l], setlists: [] }, { songs: [r], setlists: [] }, hashOf).songMap.size).toBe(0)
  })

  it('is one-to-one: local duplicates are not collapsed into one remote song', () => {
    const local = [song('L1', { title: 'Dup', files: [file('a', 'dup', true)] }), song('L2', { title: 'Dup', files: [file('b', 'dup', true)] })]
    const remote = [...remoteSongs, song('R6', { title: 'dup', files: [file('rf6', 'dup')] })]
    const plan = planJoin({ songs: local, setlists: [] }, { songs: remote, setlists: [] }, hashOf)
    expect([...plan.songMap]).toEqual([['L1', 'R5'], ['L2', 'R6']])
    const plan2 = planJoin({ songs: local, setlists: [] }, { songs: remoteSongs, setlists: [] }, hashOf)
    expect([...plan2.songMap]).toEqual([['L1', 'R5']])
    expect(plan2.added.songs).toBe(1)
  })

  it('setlists match on normalised name and the mapped song sequence (breaks included)', () => {
    const local = [song('L1', { title: 'Autumn Leaves', files: [file('lf1', 'leaves', true), file('lf2', 'leaves-lyrics', true)] }), song('L9', { title: 'Mine' })]
    const ls = [
      setlist('ls1', { name: 'Friday Gig', entries: [{ key: 'a', songId: 'L1' }, { key: 'b', songId: '', isBreak: true }, { key: 'c', songId: 'R2' }] }),
      setlist('ls2', { name: 'Friday gig', entries: [{ key: 'a', songId: 'L1' }, { key: 'c', songId: 'R2' }] }), // no break
      setlist('ls3', { name: 'Other', entries: [{ key: 'a', songId: 'L9' }] }),
      setlist('ls4', { name: 'Empty' }),
    ]
    const rs = [
      setlist('rs1', { name: 'friday gig!', entries: [{ key: 'x', songId: 'R1' }, { key: 'y', songId: '', isBreak: true }, { key: 'z', songId: 'R2' }] }),
      setlist('rs2', { name: 'Other', entries: [{ key: 'x', songId: 'R9' }] }),
      setlist('rs3', { name: 'empty' }),
    ]
    const plan = planJoin({ songs: local, setlists: ls }, { songs: remoteSongs, setlists: rs }, hashOf)
    expect([...plan.setlistMap]).toEqual([['ls1', 'rs1'], ['ls4', 'rs3']])
    expect(plan.added).toEqual({ songs: 1, setlists: 2 })
  })

  it('remapSetlist points entries at the combined songs', () => {
    const s = setlist('s', { entries: [{ key: 'a', songId: 'L1' }, { key: 'b', songId: 'X' }] })
    expect(remapSetlist(s, new Map([['L1', 'R1']])).entries.map((e) => e.songId)).toEqual(['R1', 'X'])
    expect(remapSetlist(s, new Map())).toBe(s)
  })
})

describe('joinSong (§10.3 step 8)', () => {
  const R = (): Song => song('R', {
    title: 'Autumn Leaves', notes: '', rating: 0, difficulty: 6, sortTitle: undefined,
    artists: ['Kosma'], tags: ['jazz'],
    files: [file('rf1', 'leaves'), file('rf2', 'lyrics')],
    pageSettings: { 'rf1:0': { rotation: 90 } },
    metronome: { bpm: 120 },
    bookmarks: [{ id: 'rb1', name: 'Bridge', pageIndex: 1 }],
    links: [{ id: 'rl1', from: { pageIndex: 0, x: 0.5, y: 0.5 }, to: { pageIndex: 1, x: 0, y: 0 } }],
    audio: [{ id: 'ra1', name: 'take.mp3', blobId: hash('take') }],
    favorite: false, createdAt: T0, modifiedAt: T0 + 10, lastPlayedAt: T0 + 5, playCount: 4,
  })
  const L = (): Song => song('L', {
    title: 'autumn leaves', notes: 'local notes', rating: 4, difficulty: 2, sortTitle: 'Leaves',
    artists: ['Prévert', 'Kosma'], tags: ['ballad'],
    files: [file('lf1', 'leaves', true), file('lf2', 'lyrics', true)],
    pageSettings: { 'lf1:0': { rotation: 180 }, 'lf2:0': { rotation: 270 } },
    pageOrder: [{ fileId: 'lf2', page: 0 }, { fileId: 'lf1', page: 0 }],
    metronome: { bpm: 90, sound: 'wood' },
    bookmarks: [{ id: 'lb1', name: 'Bridge', pageIndex: 1 }, { id: 'lb2', name: 'Coda', pageIndex: 2 }],
    links: [{ id: 'll1', from: { pageIndex: 0, x: 0.5, y: 0.5 }, to: { pageIndex: 1, x: 0, y: 0 } }, { id: 'll2', from: { pageIndex: 1, x: 0, y: 0 }, to: { pageIndex: 0, x: 0, y: 0 } }],
    smartButtons: [{ id: 'ls1', label: 'Play', pageIndex: 0, x: 0.1, y: 0.1, kind: 'audio', trackId: 'la1' }],
    audio: [{ id: 'la1', name: 'take.mp3', blobId: 'uuid-take' }, { id: 'la2', name: 'other.mp3', url: 'https://x/o.mp3' }],
    favorite: true, createdAt: T0 - 100, modifiedAt: T0 + 3, lastPlayedAt: T0 + 50, playCount: 3,
  })

  it('applies the field rules', () => {
    const out = joinSong(L(), R())
    expect(out.id).toBe('R')
    expect(out.files).toEqual(R().files)
    expect(out.title).toBe('Autumn Leaves') // R wins
    expect(out.difficulty).toBe(6)
    expect(out.notes).toBe('local notes') // R blank: L fills
    expect(out.rating).toBe(4) // 0 means unset
    expect(out.sortTitle).toBe('Leaves')
    expect(out.artists).toEqual(['Kosma', 'Prévert'])
    expect(out.tags).toEqual(['jazz', 'ballad'])
    expect(out.metronome).toEqual({ bpm: 120, sound: 'wood' })
    expect(out.favorite).toBe(true)
    expect(out.createdAt).toBe(T0 - 100)
    expect(out.modifiedAt).toBe(T0 + 10)
    expect(out.lastPlayedAt).toBe(T0 + 50)
    expect(out.playCount).toBe(7)
  })

  it('remaps L file ids by position for pageSettings and pageOrder', () => {
    const out = joinSong(L(), R())
    expect(joinFileMap(L(), R())).toEqual(new Map([['lf1', 'rf1'], ['lf2', 'rf2']]))
    expect(out.pageSettings).toEqual({ 'rf1:0': { rotation: 90 }, 'rf2:0': { rotation: 270 } })
    expect(out.pageOrder).toEqual([{ fileId: 'rf2', page: 0 }, { fileId: 'rf1', page: 0 }])
  })

  it('unions bookmarks, links, smart buttons and audio without duplicates', () => {
    const out = joinSong(L(), R())
    expect(out.bookmarks.map((b) => b.id)).toEqual(['rb1', 'lb2'])
    expect(out.links.map((x) => x.id)).toEqual(['rl1', 'll2'])
    expect(out.audio.map((a) => a.id)).toEqual(['ra1', 'la2'])
    // L's smart button played L's copy of the track, which became R's.
    expect(out.smartButtons).toEqual([{ id: 'ls1', label: 'Play', pageIndex: 0, x: 0.1, y: 0.1, kind: 'audio', trackId: 'ra1' }])
    const dupBtn = { ...L(), smartButtons: [{ id: 'x', label: 'Play', pageIndex: 0, x: 0.1, y: 0.1, kind: 'page' as const }] }
    const r = { ...R(), smartButtons: [{ id: 'y', label: 'Play', pageIndex: 0, x: 0.1, y: 0.1, kind: 'page' as const }] }
    expect(joinSong(dupBtn, r).smartButtons!.map((b) => b.id)).toEqual(['y'])
  })

  it('drops lastPlayedAt only when neither side has one, and leaves R alone when L adds nothing', () => {
    const r = R()
    const out = joinSong({ ...song('L', { files: L().files }), title: r.title, createdAt: r.createdAt, modifiedAt: 0, playCount: 0 }, { ...r, lastPlayedAt: undefined })
    expect('lastPlayedAt' in out).toBe(false)
    expect(out).toMatchObject({ title: r.title, playCount: 4, pageSettings: r.pageSettings, bookmarks: r.bookmarks })
  })
})

describe('layers and annotation pages', () => {
  it('joinLayers merges by name and maps L layer ids', () => {
    const r = { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'r2', name: 'Bowings', visible: false }], current: 'default' }
    const l = { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'l2', name: 'bowings ', visible: true }, { id: 'r2', name: 'Fingering', visible: true }], current: 'l2' }
    const { layers, map } = joinLayers(l, r)
    expect(layers!.layers.map((x) => [x.id, x.name])).toEqual([['default', 'Default'], ['r2', 'Bowings'], ['r2-2', 'Fingering']])
    expect(layers!.current).toBe('default')
    expect(map).toEqual(new Map([['default', 'default'], ['l2', 'r2'], ['r2', 'r2-2']]))
    expect(joinLayers(undefined, r).layers).toBe(r)
    expect(joinLayers(l, undefined).layers!.current).toBe('l2')
  })

  it('joinPages re-keys L pages to R, remaps layers and unions items', () => {
    const fmap = new Map([['lf1', 'rf1'], ['lf2', 'rf2']])
    const lp = [page('L', 'lf1', 0, [stroke('a', 'l2')]), page('L', 'lf2', 1, [stroke('b')]), page('L', 'gone', 0, [stroke('c')])]
    const rp = [page('R', 'rf1', 0, [stroke('r')])]
    const out = joinPages(lp, rp, fmap, 'R', new Map([['l2', 'r2']]))
    expect(out).toEqual([
      { id: 'R:rf1:0', songId: 'R', fileId: 'rf1', page: 0, items: [stroke('r'), stroke('a', 'r2')] },
      { id: 'R:rf2:1', songId: 'R', fileId: 'rf2', page: 1, items: [stroke('b')] },
    ])
  })
})
