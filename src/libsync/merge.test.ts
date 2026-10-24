// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Bookmark, KV, Setlist, Song, SongLayers } from '../db/schema'
import { canonicalJson, valueHash } from './hash'
import { formatHlc, HLC_ZERO } from './hlc'
import { compact, deltaHlcMax, diff, dropStale, fromShadow, materialize, mergeDelta, orderKeys, project, rebase, toShadow } from './merge'
import { clone, connect, DEV, hash, page, setlist, SimDevice, song, stroke, T0 } from './merge.test-helper'
import type { Collection, CollectionRows, RecordDelta } from './model'

const H = (wall: number, counter = 0, dev: string = DEV[0]) => formatHlc(T0 + wall, counter, dev)

/** New-record state for a row, as the creating device publishes it. */
const created = <C extends Collection>(c: C, row: CollectionRows[C], h = H(0)) => diff(c, project(c, row), undefined, h, DEV[0])!

function fullSong(): Song {
  return song('s1', {
    title: 'Autumn Leaves',
    sortTitle: 'Autumn',
    artists: ['Kosma', 'Prévert'],
    composers: ['Kosma'],
    tags: ['jazz', 'standard', 'ballad'],
    years: ['1945'],
    rating: 4,
    difficulty: 7,
    duration: 210,
    notes: 'Watch the bridge',
    keywords: 'fall',
    sourcePage: 12,
    songNumber: 77,
    tempos: [120, 90, 120],
    files: [
      { id: 'f2', name: 'lead.pdf', kind: 'pdf', blobId: hash('b2'), pageCount: 2, size: 1000, sourcePath: 'x/lead.pdf' },
      { id: 'f1', name: 'lyrics.cho', kind: 'chordpro', blobId: hash('b1'), pageCount: 1, size: 20 },
    ],
    pageOrder: [{ fileId: 'f2', page: 1 }, { fileId: 'f2', page: 0 }, { fileId: 'f1', page: 0 }],
    pageSettings: { 'f2:0': { rotation: 90 }, 'f2:1': { crop: { top: 0.1, bottom: 0, left: 0, right: 0.05 } } },
    display: { mode: 'double', zoom: 1.2 },
    text: { transpose: -2, showChords: true },
    metronome: { bpm: 120, beatsPerBar: 4, sound: 'wood' },
    autoScroll: { mode: 'speed', speed: 30, delay: 2, pageDelay: 1 },
    midiOnLoad: [{ type: 'programChange', channel: 1, data1: 5 }, { type: 'batch', channel: 1, children: [{ type: 'noteOn', channel: 2, data1: 60, data2: 100 }] }],
    midiRecall: { type: 'programChange', channel: 3, data1: 9 },
    bookmarks: [{ id: 'bm2', name: 'Bridge', pageIndex: 1 }, { id: 'bm1', name: 'Coda', pageIndex: 2, showInLibrary: true }],
    links: [{ id: 'ln1', from: { pageIndex: 2, x: 0.5, y: 0.9 }, to: { pageIndex: 0, x: 0.1, y: 0.1 }, label: 'D.S.' }],
    smartButtons: [{ id: 'sb1', label: 'Click', pageIndex: 0, x: 0.9, y: 0.1, kind: 'action', action: 'metronome.toggle' }],
    audio: [
      { id: 'au1', name: 'take.mp3', blobId: hash('b3'), loopStart: 3, volume: 0.8 },
      { id: 'au0', name: 'stream', url: 'https://example.com/a.mp3' },
    ],
    favorite: true,
    createdAt: T0 - 5000,
    modifiedAt: T0,
    lastPlayedAt: T0 - 100,
    playCount: 7,
    ...({ futureField: { nested: [1, 2] } } as object),
  })
}

describe('project → materialize round-trips', () => {
  const cases: [Collection, () => CollectionRows[Collection]][] = [
    ['song', fullSong],
    ['song', () => song('s0')],
    ['setlist', () => setlist('set1', {
      notes: 'n', date: '2026-10-24', venue: 'Club',
      entries: [{ key: 'k2', songId: 's2', note: 'segue' }, { key: 'k1', songId: 's1', transpose: 2 }, { key: 'k3', songId: '', isBreak: true, breakLabel: 'Break' }],
      lastPlayedAt: T0,
    })],
    ['ann', () => page('s1', 'f1', 0, [stroke('z2'), stroke('a1', 'l2'), { id: 't', type: 'text', layer: 'default', color: '#f00', opacity: 1, createdAt: T0, at: { x: 0.5, y: 0.5 }, text: 'rit.', size: 0.03 }])],
    ['kv', () => ({ key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'l2', name: 'Fingering', visible: false }], current: 'default' } })],
    ['kv', () => ({ key: 'library:savedFilters', value: [{ name: 'Jazz', query: 'x', field: 'all', filter: {} }, { name: 'A', query: '', field: 'title', filter: { favorite: true } }] })],
    ['kv', () => ({ key: 'library:emptyCollections', value: ['Gig', 'Archive'] })],
    ['kv', () => ({ key: 'library:recentClearedAt', value: T0 })],
    ['kv', () => ({ key: 'textLayout:s1', value: { width: 800, height: 600, sig: 'abc' } })],
  ]
  it.each(cases)('%s', (c, make) => {
    const row = make()
    const state = created(c, row)
    expect(materialize(c, state)).toEqual(row)
    // ...including through the wire (JSON) and through a shadow + row.
    const wire = JSON.parse(JSON.stringify(state)) as RecordDelta
    expect(materialize(c, wire)).toEqual(row)
    expect(canonicalJson(fromShadow(toShadow(state), project(c, row)))).toBe(canonicalJson(state))
  })

  it('files and audio travel as content hashes with a mime, never as blob ids', () => {
    const s = fullSong()
    s.files[0].blobId = 'legacy-uuid'
    const ctx = { blobHash: (id: string) => (id === 'legacy-uuid' ? hash('b2') : id), blobMime: (id: string) => (id === 'legacy-uuid' ? 'application/pdf' : undefined) }
    const st = diff('song', project('song', s, ctx), undefined, H(0), DEV[0])!
    const files = st.l!.files.e!
    expect(files.f2[1]).toEqual({ name: 'lead.pdf', kind: 'pdf', pageCount: 2, size: 1000, sourcePath: 'x/lead.pdf', blob: hash('b2'), mime: 'application/pdf' })
    expect(files.f1[1]).toMatchObject({ blob: hash('b1'), mime: 'text/plain' })
    expect(JSON.stringify(st)).not.toContain('blobId')
    expect(st.l!.audio.e!.au0[1]).toEqual({ name: 'stream', url: 'https://example.com/a.mp3' })
    // Materialising elsewhere: hashes become local ids via ctx, or stay as the hash (download pending).
    const remote = materialize('song', st, null, { blobId: (h) => (h === hash('b1') ? 'local-b1' : h) })!
    expect(remote.files.map((f) => f.blobId)).toEqual([hash('b2'), 'local-b1'])
    // The device that has the legacy id keeps it.
    const back = materialize('song', st, s, ctx)!
    expect(back.files[0].blobId).toBe('legacy-uuid')
  })
})

describe('diff', () => {
  it('emits nothing when nothing changed, and only the changed registers otherwise', () => {
    const s = fullSong()
    const sh = toShadow(created('song', s))
    expect(diff('song', project('song', s), sh, H(1), DEV[0])).toBeNull()
    const e = { ...clone(s), notes: 'new', metronome: { ...s.metronome, bpm: 96 }, modifiedAt: T0 + 1 }
    expect(diff('song', project('song', e), sh, H(1), DEV[0])).toEqual({
      c: 'song', id: 's1', f: { notes: [H(1), 'new'], 'metronome.bpm': [H(1), 96] }, m: { modifiedAt: T0 + 1 },
    })
  })

  it('unsets removed lww fields and every sub-register of a reset flat field', () => {
    const s = fullSong()
    const sh = toShadow(created('song', s))
    const e = clone(s)
    delete e.sortTitle
    delete e.metronome
    const d = diff('song', project('song', e), sh, H(1), DEV[0])!
    expect(d.f).toEqual({ sortTitle: [H(1)], 'metronome.bpm': [H(1)], 'metronome.beatsPerBar': [H(1)], 'metronome.sound': [H(1)] })
    const m = materialize('song', mergeDelta(created('song', s), d), s)!
    expect(m.metronome).toBeUndefined()
    expect('metronome' in m).toBe(false)
    expect(m.sortTitle).toBeUndefined()
  })

  it('missing rows: delete for records, item tombstones for annotation pages, nothing without a shadow', () => {
    const s = song('s1')
    expect(diff('song', null, undefined, H(1), DEV[0])).toBeNull()
    const del = diff('song', null, toShadow(created('song', song('s1', { tags: ['t'], sortTitle: 'x' }))), H(1), DEV[0])!
    expect(del.a).toEqual([H(1), false])
    // ...and every value it knew is unset / tombstoned (hashes only, no values travel).
    expect(del.f!.title).toEqual([H(1)])
    expect(del.f!.sortTitle).toEqual([H(1)])
    expect(del.l!.tags.e!.t).toEqual([H(1), null, H(0)])
    expect(del.m).toBeUndefined()
    expect(del.n).toBeUndefined()
    expect(diff('song', null, toShadow(mergeDelta(created('song', s), del)), H(2), DEV[0])).toBeNull()
    const p = page('s1', 'f1', 0, [stroke('i1'), stroke('i2')])
    const st = created('ann', p)
    expect(st.a).toBeUndefined() // pages are never record-tombstoned
    const d = diff('ann', null, toShadow(st), H(1), DEV[0])!
    expect(d.a).toBeUndefined()
    expect(Object.keys(d.l!.items.e!)).toEqual(['i1', 'i2'])
    expect(Object.values(d.l!.items.e!).every((r) => r[1] === null && r[2] === H(0))).toBe(true)
  })

  it('an append carries no order register; a reorder does; a delete does not', () => {
    const s = song('s1', { bookmarks: [{ id: 'b', name: 'B', pageIndex: 0 }, { id: 'a', name: 'A', pageIndex: 1 }] })
    let state = created('song', s)
    expect(state.l!.bookmarks.o).toEqual([H(0), ['b', 'a']]) // initial order isn't (born, key) order
    const step = (row: Song, h: string) => {
      const d = diff('song', project('song', row), toShadow(state), h, DEV[0])
      if (d) state = mergeDelta(state, d)
      return d
    }
    const appended = { ...s, bookmarks: [...s.bookmarks, { id: '0', name: 'New', pageIndex: 2 }] }
    const d1 = step(appended, H(1))!
    expect(d1.l!.bookmarks).toEqual({ e: { '0': [H(1), { name: 'New', pageIndex: 2 }, H(1)] } })
    const removed = { ...appended, bookmarks: appended.bookmarks.filter((b) => b.id !== 'b') }
    expect(step(removed, H(2))!.l!.bookmarks).toEqual({ e: { b: [H(2), null, H(0)] } })
    const moved = { ...removed, bookmarks: [removed.bookmarks[1], removed.bookmarks[0]] }
    expect(step(moved, H(3))!.l!.bookmarks).toEqual({ o: [H(3), ['0', 'a']] })
    const edited = { ...moved, bookmarks: moved.bookmarks.map((b) => (b.id === 'a' ? { ...b, name: 'A2' } : b)) }
    expect(step(edited, H(4))!.l!.bookmarks).toEqual({ e: { a: [H(4), { name: 'A2', pageIndex: 1 }, H(0)] } })
    expect(materialize('song', state)!.bookmarks.map((b) => b.id)).toEqual(['0', 'a'])
  })

  it('sets drop duplicates, keeping the first', () => {
    const s = song('s1', { artists: ['B', 'A', 'B', 'C', 'A'] })
    expect(materialize('song', created('song', s))!.artists).toEqual(['B', 'A', 'C'])
  })

  it('counters publish the difference to the materialised total as this device’s own inc/dec totals', () => {
    let state = created('song', song('s1', { playCount: 2 }))
    expect(state.n).toEqual({ playCount: { [DEV[0]]: [2, 0] } })
    const step = (count: number, dev: string, h: string) => {
      const d = diff('song', project('song', song('s1', { playCount: count })), toShadow(state), h, dev)
      if (d) state = mergeDelta(state, d)
      return d
    }
    expect(step(2, DEV[1], H(1))).toBeNull()
    expect(step(5, DEV[1], H(2))!.n).toEqual({ playCount: { [DEV[1]]: [3, 0] } })
    expect(step(1, DEV[0], H(3))!.n).toEqual({ playCount: { [DEV[0]]: [2, 4] } })
    expect(materialize('song', state)!.playCount).toBe(1)
  })

  it('undelete re-registers every field with the new hlc', () => {
    const s = song('s1', { tags: ['x'], bookmarks: [{ id: 'b', name: 'B', pageIndex: 0 }] })
    let state = created('song', s)
    state = mergeDelta(state, diff('song', null, toShadow(state), H(1), DEV[0])!)
    expect(materialize('song', state)).toBeNull()
    const d = diff('song', project('song', s), toShadow(state), H(2), DEV[1])!
    expect(d.a).toEqual([H(2), true])
    expect(d.f!.title).toEqual([H(2), 'Song s1'])
    expect(d.l!.tags.e!.x).toEqual([H(2), true, H(2)]) // the delete tombstoned it, so it is born again
    expect(d.l!.bookmarks.e!.b[0]).toBe(H(2))
    expect(materialize('song', mergeDelta(state, d))).toEqual(s)
  })
})

describe('mergeDelta', () => {
  it('is pure and normalises', () => {
    const a = created('song', fullSong())
    const snap = canonicalJson(a)
    const b: RecordDelta = { c: 'song', id: 's1', f: { title: [H(5), 'x'] }, l: { tags: { e: { new: [H(5), true, H(5)] } } } }
    const m = mergeDelta(a, b)
    expect(canonicalJson(a)).toBe(snap)
    expect(m.f!.title).toEqual([H(5), 'x'])
    expect(canonicalJson(mergeDelta(m, m))).toBe(canonicalJson(m))
    expect(mergeDelta(undefined, { c: 'song', id: 'x', f: {}, l: { tags: {} } })).toEqual({ c: 'song', id: 'x' })
    expect(() => mergeDelta(a, { c: 'song', id: 'other' })).toThrow()
  })

  it('breaks exact hlc ties deterministically', () => {
    const x: RecordDelta = { c: 'song', id: 's', f: { title: [H(1), 'a'] } }
    const y: RecordDelta = { c: 'song', id: 's', f: { title: [H(1), 'b'] } }
    expect(mergeDelta(x, y)).toEqual(mergeDelta(y, x))
  })

  it('max/min registers and unknown numeric fields (max)', () => {
    const x: RecordDelta = { c: 'song', id: 's', m: { createdAt: 10, modifiedAt: 10, lastPlayedAt: 3, future: 1 } }
    const y: RecordDelta = { c: 'song', id: 's', m: { createdAt: 5, modifiedAt: 20, lastPlayedAt: 1, future: 9 } }
    expect(mergeDelta(x, y).m).toEqual({ createdAt: 5, modifiedAt: 20, lastPlayedAt: 3, future: 9 })
  })

  it('keeps unknown collections and registers', () => {
    const x: RecordDelta = { c: 'future' as Collection, id: 'q', f: { z: [H(1), 1] }, l: { w: { e: { k: [H(1), { v: 1 }, H(1)] } } } }
    const sh = toShadow(x)
    expect(sh.x).toEqual(x)
    expect(fromShadow(sh, null)).toEqual(x)
  })

  it('deltaHlcMax', () => {
    expect(deltaHlcMax({ c: 'song', id: 's' })).toBe(HLC_ZERO)
    expect(deltaHlcMax({ c: 'song', id: 's', a: [H(1), true], f: { t: [H(3)] }, l: { x: { o: [H(2), []], e: { k: [H(4), null, H(0)] } } } })).toBe(H(4))
  })
})

describe('orderKeys (§5.5)', () => {
  it('keeps o order for alive keys, then appends the rest by (born, key)', () => {
    const alive = new Map([['c', H(1)], ['a', H(1)], ['z', H(0)], ['b', H(5)], ['y', H(3)]])
    expect(orderKeys(['b', 'gone', 'a', 'b'], alive)).toEqual(['b', 'a', 'z', 'c', 'y'])
    expect(orderKeys(undefined, alive)).toEqual(['z', 'a', 'c', 'y', 'b'])
  })
})

describe('two and three devices', () => {
  const setup = (n = 2, skews: number[] = []) => {
    const devs = DEV.slice(0, n).map((d, i) => new SimDevice(d, skews[i] ?? 0))
    return { devs, net: connect(...devs) }
  }
  const edit = <C extends Collection>(d: SimDevice, c: C, id: string, f: (row: CollectionRows[C]) => void) => {
    const row = clone(d.get(c, id)!)
    f(row)
    return d.write(c, id, row)
  }
  const converged = (devs: SimDevice[]) => {
    for (const k of new Set(devs.flatMap((d) => d.keys()))) {
      const [c, ...rest] = k.split('/')
      const id = rest.join('/')
      const views = devs.map((d) => view(c as Collection, d.get(c as Collection, id)))
      expect(new Set(views).size, k).toBe(1)
      for (const d of devs) expect(d.pending(c as Collection, id), `${d.id} ${k}`).toBeNull()
    }
  }
  const view = (c: Collection, row: unknown) => (row ? canonicalJson(project(c, row as never)) : 'null')

  it('concurrent edits to different fields (and sub-fields) both survive', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1', { metronome: { bpm: 100, sound: 'click' } }))
    net.flushAll()
    edit(a, 'song', 's1', (s) => { s.title = 'From A'; s.metronome!.bpm = 132 })
    edit(b, 'song', 's1', (s) => { s.notes = 'From B'; s.metronome!.sound = 'cowbell'; s.rating = 5 })
    net.flushAll()
    for (const d of [a, b]) {
      expect(d.get('song', 's1')).toMatchObject({ title: 'From A', notes: 'From B', rating: 5, metronome: { bpm: 132, sound: 'cowbell' } })
    }
    converged([a, b])
  })

  it('the same field resolves by hlc, regardless of delivery order', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1'))
    net.flushAll()
    b.tick(10)
    edit(b, 'song', 's1', (s) => { s.title = 'B (later)' })
    edit(a, 'song', 's1', (s) => { s.title = 'A (earlier)' })
    net.flush(b)
    net.flush(a)
    expect(a.get('song', 's1')!.title).toBe('B (later)')
    expect(b.get('song', 's1')!.title).toBe('B (later)')
    converged([a, b])
  })

  it('set adds and removes on different devices both survive, keeping order', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1', { tags: ['x', 'y'], artists: ['Main', 'Second'] }))
    net.flushAll()
    edit(a, 'song', 's1', (s) => { s.tags.push('new-a') })
    b.tick(10) // B's append is born later, so it comes second
    edit(b, 'song', 's1', (s) => { s.tags = s.tags.filter((t) => t !== 'y'); s.tags.push('new-b') })
    edit(b, 'song', 's1', (s) => { s.artists = ['Second', 'Main'] }) // primary artist changed
    net.flushAll()
    expect(a.get('song', 's1')!.tags).toEqual(['x', 'new-a', 'new-b'])
    expect(a.get('song', 's1')!.artists).toEqual(['Second', 'Main'])
    converged([a, b])
  })

  it('list order: appends need no order register; concurrent reorder and append keep both', () => {
    const { devs: [a, b], net } = setup()
    const bm = (id: string): Bookmark => ({ id, name: id.toUpperCase(), pageIndex: 0 })
    a.write('song', 's1', song('s1', { bookmarks: [bm('p'), bm('q'), bm('r')] }))
    net.flushAll()
    b.tick(5)
    const appendOp = edit(a, 'song', 's1', (s) => { s.bookmarks.push(bm('new')) })!
    expect(appendOp.l!.bookmarks.o).toBeUndefined()
    const moveOp = edit(b, 'song', 's1', (s) => { s.bookmarks = [s.bookmarks[2], s.bookmarks[0], s.bookmarks[1]] })!
    expect(moveOp.l!.bookmarks.o![1]).toEqual(['r', 'p', 'q'])
    net.flushAll()
    expect(a.get('song', 's1')!.bookmarks.map((x) => x.id)).toEqual(['r', 'p', 'q', 'new'])
    converged([a, b])
  })

  it('elements unknown to the latest order are appended by born', () => {
    const { devs: [a, b, c], net } = setup(3)
    a.write('setlist', 'set', setlist('set', { entries: [{ key: 'k1', songId: 's1' }, { key: 'k2', songId: 's2' }] }))
    net.flushAll()
    c.tick(3)
    edit(b, 'setlist', 'set', (s) => { s.entries.push({ key: 'kb', songId: 'sb' }) })
    edit(c, 'setlist', 'set', (s) => { s.entries.push({ key: 'kc', songId: 'sc' }) })
    a.tick(10)
    edit(a, 'setlist', 'set', (s) => { s.entries.reverse() })
    net.flushAll()
    // A's reorder (latest) wins; B's and C's appends follow it, oldest first.
    expect(a.get('setlist', 'set')!.entries.map((e) => e.key)).toEqual(['k2', 'k1', 'kb', 'kc'])
    converged([a, b, c])
  })

  it('setlist: concurrent appends both survive; the latest of two reorders wins', () => {
    const { devs: [a, b], net } = setup()
    const e = (k: string) => ({ key: k, songId: `s-${k}` })
    a.write('setlist', 'set', setlist('set', { entries: [e('1'), e('2'), e('3')] }))
    net.flushAll()
    edit(a, 'setlist', 'set', (s) => { s.entries.push(e('a')) })
    b.tick(10)
    edit(b, 'setlist', 'set', (s) => { s.entries.push(e('b')) })
    net.flushAll()
    expect(a.get('setlist', 'set')!.entries.map((x) => x.key)).toEqual(['1', '2', '3', 'a', 'b'])
    edit(a, 'setlist', 'set', (s) => { s.entries = [s.entries[1], s.entries[0], ...s.entries.slice(2)] })
    b.tick(50)
    edit(b, 'setlist', 'set', (s) => { s.entries = [...s.entries.slice(1), s.entries[0]] })
    net.flushAll()
    expect(a.get('setlist', 'set')!.entries.map((x) => x.key)).toEqual(['2', '3', 'a', 'b', '1'])
    converged([a, b])
  })

  it('flat reset unsets every sub-register; a later sub-field edit survives a concurrent reset', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1', { metronome: { bpm: 90, sound: 'beep', volume: 0.5 } }))
    net.flushAll()
    edit(a, 'song', 's1', (s) => { delete s.metronome })
    b.tick(5)
    edit(b, 'song', 's1', (s) => { s.metronome!.bpm = 140 })
    net.flushAll()
    expect(a.get('song', 's1')!.metronome).toEqual({ bpm: 140 })
    edit(a, 'song', 's1', (s) => { s.metronome = undefined })
    net.flushAll()
    expect('metronome' in b.get('song', 's1')!).toBe(false)
    converged([a, b])
  })

  it('per-device play counts add up; decrements and resets propagate', () => {
    const { devs, net } = setup(3)
    const [a, b, c] = devs
    a.write('song', 's1', song('s1', { playCount: 1 }))
    net.flushAll()
    const play = (d: SimDevice, times: number) => {
      for (let i = 0; i < times; i++) edit(d, 'song', 's1', (s) => { s.playCount++; s.lastPlayedAt = d.wall })
    }
    play(a, 3)
    play(b, 2)
    play(c, 4)
    net.flushAll()
    for (const d of devs) expect(d.get('song', 's1')!.playCount).toBe(10)
    expect(a.get('song', 's1')!.lastPlayedAt).toBe(Math.max(...devs.map((d) => d.wall)) - 1)
    edit(b, 'song', 's1', (s) => { s.playCount = 0 }) // user resets the count
    play(c, 1) // concurrent play elsewhere
    net.flushAll()
    for (const d of devs) expect(d.get('song', 's1')!.playCount).toBe(1)
    converged(devs)
  })

  it('max lastPlayedAt / modifiedAt and min createdAt', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1', { createdAt: T0, modifiedAt: T0, lastPlayedAt: T0 + 50 }))
    net.flushAll()
    edit(a, 'song', 's1', (s) => { s.lastPlayedAt = T0 + 10; s.modifiedAt = T0 + 99 }) // can't lower a max
    edit(b, 'song', 's1', (s) => { s.createdAt = T0 - 1000; s.lastPlayedAt = T0 + 70; s.modifiedAt = T0 + 20 })
    net.flushAll()
    for (const d of [a, b]) expect(d.get('song', 's1')).toMatchObject({ createdAt: T0 - 1000, lastPlayedAt: T0 + 70, modifiedAt: T0 + 99 })
    converged([a, b])
  })

  it('delete beats a concurrent (even later-clocked) edit; undelete resurrects', () => {
    const { devs: [a, b], net } = setup()
    a.write('setlist', 'set', setlist('set', { name: 'Friday' }))
    net.flushAll()
    a.write('setlist', 'set', null)
    b.tick(60_000)
    edit(b, 'setlist', 'set', (s) => { s.name = 'Friday gig' })
    net.flushAll()
    expect(a.get('setlist', 'set')).toBeUndefined()
    expect(b.get('setlist', 'set')).toBeUndefined()
    converged([a, b])
    // The undo toast puts the old row back (deleteSetlist's undo).
    a.tick(120_000)
    a.write('setlist', 'set', a.graveyard.get('setlist/set') as Setlist)
    net.flushAll()
    expect(b.get('setlist', 'set')!.name).toBe('Friday')
    expect(b.shadows.get('setlist/set')!.a![1]).toBe(true)
    converged([a, b])
  })

  it('a deleted record keeps its state (and concurrent later edits) in the shadow', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1', { title: 'T' }))
    net.flushAll()
    b.write('song', 's1', null)
    a.tick(60_000)
    edit(a, 'song', 's1', (s) => { s.title = 'T2' }) // concurrent, later clock
    net.flushAll()
    for (const d of [a, b]) {
      const sh = d.shadows.get('song/s1')!
      expect(sh.a![1]).toBe(false)
      expect((sh.x as RecordDelta).f!.title[1]).toBe('T2')
      expect(d.get('song', 's1')).toBeUndefined()
    }
    // B's undo puts its row back; that re-registers every field, so its title wins everywhere.
    b.tick(120_000)
    b.write('song', 's1', b.graveyard.get('song/s1') as Song)
    net.flushAll()
    expect(a.get('song', 's1')!.title).toBe('T')
    converged([a, b])
  })

  it('an edit that arrives before the record’s creation is kept until it does', () => {
    const { devs: [a, b, c] } = setup(3)
    a.write('song', 's1', song('s1', { title: 'Orig', notes: 'n0' }))
    for (const op of a.sent) b.receive(op)
    b.tick(5)
    edit(b, 'song', 's1', (s) => { s.title = 'Edited by B' })
    for (const op of b.sent) c.receive(op) // C sees B's log before A's
    expect(c.get('song', 's1')).toBeUndefined()
    expect(c.pending('song', 's1')).toBeNull()
    for (const op of a.sent) c.receive(op)
    expect(c.get('song', 's1')).toMatchObject({ title: 'Edited by B', notes: 'n0' })
    connect(a, b, c).flushAll()
    converged([a, b, c])
  })

  it('unknown top-level fields are preserved and synced', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', { ...song('s1'), futureField: { v: 1 } } as Song)
    net.flushAll()
    edit(b, 'song', 's1', (s) => { s.title = 'B' })
    net.flushAll()
    expect(a.get('song', 's1')).toMatchObject({ title: 'B', futureField: { v: 1 } })
    expect(b.get('song', 's1')).toMatchObject({ futureField: { v: 1 } })
    converged([a, b])
  })

  it('pageSettings merge per key', () => {
    const { devs: [a, b], net } = setup()
    a.write('song', 's1', song('s1', { pageSettings: { 'f:0': { rotation: 90 } } }))
    net.flushAll()
    edit(a, 'song', 's1', (s) => { s.pageSettings['f:1'] = { rotation: 180 } })
    edit(b, 'song', 's1', (s) => { s.pageSettings['f:2'] = { crop: { top: 0.1, bottom: 0, left: 0, right: 0 } }; delete s.pageSettings['f:0'] })
    net.flushAll()
    expect(a.get('song', 's1')!.pageSettings).toEqual({ 'f:1': { rotation: 180 }, 'f:2': { crop: { top: 0.1, bottom: 0, left: 0, right: 0 } } })
    converged([a, b])
  })

  it('annotations: concurrent strokes both survive, erases propagate, erase-all keeps a concurrent add', () => {
    const { devs: [a, b], net } = setup()
    const id = 's1:f1:0'
    a.write('ann', id, page('s1', 'f1', 0, [stroke('base1'), stroke('base2')]))
    net.flushAll()
    edit(a, 'ann', id, (p) => { p.items.push(stroke('a1')) })
    b.tick(10)
    edit(b, 'ann', id, (p) => { p.items.push(stroke('b1')) })
    edit(b, 'ann', id, (p) => { p.items = p.items.filter((x) => x.id !== 'base1') }) // erase
    net.flushAll()
    expect(a.get('ann', id)!.items.map((x) => x.id)).toEqual(['base2', 'a1', 'b1'])
    converged([a, b])
    // z-order: bring base2 to the front
    edit(a, 'ann', id, (p) => { p.items = [...p.items.filter((x) => x.id !== 'base2'), p.items.find((x) => x.id === 'base2')!] })
    net.flushAll()
    expect(b.get('ann', id)!.items.map((x) => x.id)).toEqual(['a1', 'b1', 'base2'])
    // A erases everything (the row goes) while B draws a new stroke.
    a.write('ann', id, null)
    edit(b, 'ann', id, (p) => { p.items.push(stroke('b2')) })
    net.flushAll()
    expect(a.get('ann', id)!.items.map((x) => x.id)).toEqual(['b2'])
    converged([a, b])
    // Erasing the last stroke deletes the page row everywhere.
    edit(b, 'ann', id, (p) => { p.items = [] })
    net.flushAll()
    expect(a.get('ann', id)).toBeUndefined()
    converged([a, b])
  })

  it('two devices drawing on a page neither had both keep their strokes', () => {
    const { devs: [a, b], net } = setup()
    const id = 's1:f1:3'
    a.write('ann', id, page('s1', 'f1', 3, [stroke('a1')]))
    b.write('ann', id, page('s1', 'f1', 3, [stroke('b1')]))
    net.flushAll()
    expect(a.get('ann', id)!.items.map((x) => x.id).sort()).toEqual(['a1', 'b1'])
    converged([a, b])
  })

  it('layers sync (names, visibility) but `current` stays per device', () => {
    const { devs: [a, b], net } = setup()
    const key = 'layers:s1'
    const v: SongLayers = { layers: [{ id: 'default', name: 'Default', visible: true }], current: 'default' }
    a.write('kv', key, { key, value: v })
    net.flushAll()
    edit(a, 'kv', key, (r: KV) => {
      const x = r.value as SongLayers
      x.layers.push({ id: 'l2', name: 'Bowings', visible: true })
      x.current = 'l2'
    })
    net.flushAll()
    expect((b.get('kv', key)!.value as SongLayers).layers.map((l) => l.id)).toEqual(['default', 'l2'])
    expect((b.get('kv', key)!.value as SongLayers).current).toBe('default')
    edit(b, 'kv', key, (r: KV) => { (r.value as SongLayers).layers[1].visible = false })
    net.flushAll()
    expect(a.get('kv', key)!.value).toEqual({ layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'l2', name: 'Bowings', visible: false }], current: 'l2' })
    // A layer deleted elsewhere moves `current` to the first layer.
    edit(b, 'kv', key, (r: KV) => { (r.value as SongLayers).layers.splice(1, 1) })
    net.flushAll()
    expect((a.get('kv', key)!.value as SongLayers).current).toBe('default')
    converged([a, b])
  })

  it('kv values: set, keyed list and max', () => {
    const { devs: [a, b], net } = setup()
    a.write('kv', 'library:emptyCollections', { key: 'library:emptyCollections', value: ['X'] })
    b.write('kv', 'library:emptyCollections', { key: 'library:emptyCollections', value: ['Y'] })
    a.write('kv', 'library:recentClearedAt', { key: 'library:recentClearedAt', value: T0 + 5 })
    b.write('kv', 'library:recentClearedAt', { key: 'library:recentClearedAt', value: T0 + 9 })
    a.write('kv', 'library:savedFilters', { key: 'library:savedFilters', value: [{ name: 'F', query: 'a', field: 'all', filter: {} }] })
    net.flushAll()
    edit(b, 'kv', 'library:savedFilters', (r: KV) => { (r.value as { query: string }[])[0].query = 'b' })
    net.flushAll()
    expect(new Set(a.get('kv', 'library:emptyCollections')!.value as string[])).toEqual(new Set(['X', 'Y']))
    expect(b.get('kv', 'library:recentClearedAt')!.value).toBe(T0 + 9)
    expect(a.get('kv', 'library:savedFilters')!.value).toEqual([{ name: 'F', query: 'b', field: 'all', filter: {} }])
    converged([a, b])
  })
})

describe('shadow round-trip and horizons', () => {
  it('fromShadow(toShadow(state), project(materialize(state))) is the state', () => {
    const st = created('song', fullSong())
    const row = materialize('song', st)!
    expect(canonicalJson(fromShadow(toShadow(st), project('song', row)))).toBe(canonicalJson(st))
    const sh = toShadow(st)
    expect(sh.f.title).toEqual([H(0), valueHash('Autumn Leaves')])
    expect(sh.x).toBeUndefined()
  })

  it('compact drops values of long-dead records and old element tombstones only', () => {
    const DAY = 86_400_000
    const st: RecordDelta = {
      c: 'song', id: 's', a: [H(0), true], f: { title: [H(0), 't'] }, n: { playCount: { d: [1, 0] } },
      l: { tags: { e: { old: [H(0), null, H(0)], recent: [H(10 * DAY), null, H(0)], alive: [H(0), true, H(0)] } } },
    }
    const c1 = compact(st, { deadFields: T0 + DAY, elementTombs: T0 + DAY })
    expect(Object.keys(c1.l!.tags.e!)).toEqual(['recent', 'alive'])
    expect(c1.f).toEqual(st.f)
    const dead = { ...st, a: [H(1), false] as [string, boolean] }
    expect(compact(dead, { deadFields: T0 + DAY, elementTombs: 0 })).toEqual({ c: 'song', id: 's', a: dead.a, n: st.n })
    expect(compact(dead, { deadFields: T0 - DAY, elementTombs: 0 }).f).toEqual(st.f)
  })

  it('dropStale removes what was born before lastSync and is missing from the snapshot', () => {
    const local: RecordDelta = {
      c: 'ann', id: 's:f:0',
      l: { items: { e: { kept: [H(1), { v: 1 }, H(1)], gone: [H(1), { v: 2 }, H(1)], mine: [H(9), { v: 3 }, H(9)], tomb: [H(1), null, H(1)] } } },
    }
    const snap: RecordDelta = { c: 'ann', id: 's:f:0', l: { items: { e: { kept: [H(1), { v: 1 }, H(1)] } } } }
    expect(Object.keys(dropStale(local, snap, H(5))!.l!.items.e!)).toEqual(['kept', 'mine', 'tomb'])
    const rec: RecordDelta = { c: 'song', id: 's', a: [H(1), true] }
    expect(dropStale(rec, undefined, H(5))).toBeNull()
    expect(dropStale(rec, undefined, H(0))).toEqual(rec)
  })
})

describe('rebase (SongEditor save, §8.4)', () => {
  const base = () => song('s1', {
    title: 'Base', notes: 'base notes', tags: ['a', 'b'], playCount: 3,
    metronome: { bpm: 100, sound: 'click' },
    bookmarks: [{ id: 'b1', name: 'Intro', pageIndex: 0 }, { id: 'b2', name: 'Verse', pageIndex: 1 }],
  })

  it('applies only what the user changed, keeping remote edits to everything else', () => {
    const b = base()
    const draft = clone(b)
    draft.title = 'Draft title'
    draft.tags.push('mine')
    draft.metronome!.bpm = 140
    draft.bookmarks[0].name = 'Intro (draft)'
    draft.bookmarks.push({ id: 'b3', name: 'Coda', pageIndex: 3 })
    draft.modifiedAt = T0 + 100
    // Meanwhile another device changed the stored song.
    const latest = clone(b)
    latest.notes = 'remote notes'
    latest.tags = ['b', 'remote']
    latest.metronome!.sound = 'wood'
    latest.bookmarks[1].name = 'Verse (remote)'
    latest.bookmarks.push({ id: 'r1', name: 'Remote', pageIndex: 2 })
    latest.playCount = 5
    latest.lastPlayedAt = T0 + 50
    latest.modifiedAt = T0 + 50
    const out = rebase('song', b, draft, latest)
    expect(out).toMatchObject({
      title: 'Draft title',
      notes: 'remote notes',
      tags: ['b', 'remote', 'mine'],
      metronome: { bpm: 140, sound: 'wood' },
      playCount: 5,
      lastPlayedAt: T0 + 50,
      modifiedAt: T0 + 100,
    })
    expect(out.bookmarks).toEqual([
      { id: 'b1', name: 'Intro (draft)', pageIndex: 0 },
      { id: 'b2', name: 'Verse (remote)', pageIndex: 1 },
      { id: 'r1', name: 'Remote', pageIndex: 2 },
      { id: 'b3', name: 'Coda', pageIndex: 3 },
    ])
  })

  it('deletes, reorders, unsets, flat resets and counter changes made in the draft', () => {
    const b = base()
    const draft = clone(b)
    draft.bookmarks = [draft.bookmarks[1]] // removed b1
    draft.tags = ['b', 'a'] // reordered
    delete draft.metronome
    draft.playCount = 0 // reset in the editor
    const latest = clone(b)
    latest.bookmarks.push({ id: 'r1', name: 'Remote', pageIndex: 2 })
    latest.tags.push('remote')
    latest.playCount = 4 // one more play elsewhere
    const out = rebase('song', b, draft, latest)
    expect(out.bookmarks.map((x) => x.id)).toEqual(['b2', 'r1'])
    expect(out.tags).toEqual(['b', 'a', 'remote'])
    expect(out.metronome).toBeUndefined()
    expect(out.playCount).toBe(1)
  })

  it('returns latest untouched when the draft has no changes; keeps local-only fields from the draft', () => {
    const b = base()
    const latest = { ...clone(b), notes: 'remote' }
    expect(rebase('song', b, clone(b), latest)).toBe(latest)
    const key = 'layers:s1'
    const lb: KV = { key, value: { layers: [{ id: 'default', name: 'Default', visible: true }], current: 'default' } }
    const le: KV = { key, value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'n', name: 'New', visible: true }], current: 'n' } }
    const ll: KV = { key, value: { layers: [{ id: 'default', name: 'Renamed', visible: true }], current: 'default' } }
    expect(rebase('kv', lb, le, ll).value).toEqual({ layers: [{ id: 'default', name: 'Renamed', visible: true }, { id: 'n', name: 'New', visible: true }], current: 'n' })
  })
})
