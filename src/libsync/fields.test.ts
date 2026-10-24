// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GROUP_FIELDS } from '../db/schema'
import { annId, fieldSpec, fieldTable, numKind, parseAnnId, SETLIST_FIELDS, SONG_FIELDS, syncedKv, validateDelta } from './fields'
import { formatHlc } from './hlc'

const H = formatHlc(1_760_000_000_000, 0, 'aaaaaaaaaaaaaaaa')

describe('field tables', () => {
  it('cover §5.1 and §5.2', () => {
    for (const g of GROUP_FIELDS) expect(SONG_FIELDS[g].kind).toBe('set')
    for (const k of ['title', 'sortTitle', 'rating', 'difficulty', 'duration', 'notes', 'keywords', 'sourcePage', 'songNumber', 'favorite', 'tempos', 'pageOrder', 'midiOnLoad', 'midiRecall'])
      expect(SONG_FIELDS[k].kind).toBe('lww')
    for (const k of ['display', 'text', 'metronome', 'autoScroll']) expect(SONG_FIELDS[k].kind).toBe('flat')
    for (const k of ['files', 'bookmarks', 'links', 'smartButtons', 'audio']) expect(SONG_FIELDS[k]).toMatchObject({ kind: 'list', key: 'id' })
    expect(SONG_FIELDS.files.wire).toBe('file')
    expect(SONG_FIELDS.audio.wire).toBe('audio')
    expect(SONG_FIELDS.pageSettings.kind).toBe('map')
    expect([SONG_FIELDS.createdAt.kind, SONG_FIELDS.modifiedAt.kind, SONG_FIELDS.lastPlayedAt.kind, SONG_FIELDS.playCount.kind]).toEqual(['min', 'max', 'max', 'pn'])
    expect(SETLIST_FIELDS.entries).toMatchObject({ kind: 'list', key: 'key' })
    expect(numKind(SONG_FIELDS, 'createdAt')).toBe('min')
    expect(numKind(SONG_FIELDS, 'unknownCounter')).toBe('max')
    expect(fieldSpec(SONG_FIELDS, 'someFutureField').kind).toBe('lww')
  })

  it('kv allow-list (§5.4)', () => {
    for (const k of ['layers:s1', 'textLayout:s1', 'library:emptyCollections', 'library:savedFilters', 'library:recentClearedAt']) expect(syncedKv(k)).toBe(true)
    for (const k of ['backup.lastAt', 'backup.dir', 'backup.remindedAt', 'backup.autoLastAt', 'layers:', 'textLayout:', 'library:other', 'openstand:hint:x', ''])
      expect(syncedKv(k)).toBe(false)
    expect(fieldTable('kv', 'layers:s1')?.current.kind).toBe('local')
    expect(fieldTable('kv', 'layers:s1')?.layers).toMatchObject({ kind: 'list', key: 'id' })
    expect(fieldTable('kv', 'library:savedFilters')?.value).toMatchObject({ kind: 'list', key: 'name' })
    expect(fieldTable('kv', 'library:emptyCollections')?.value.kind).toBe('set')
    expect(fieldTable('kv', 'library:recentClearedAt')?.value.kind).toBe('max')
    expect(fieldTable('kv', 'textLayout:s1')?.value.kind).toBe('lww')
    expect(fieldTable('kv', 'backup.dir')).toBeNull()
  })

  it('annotation page ids', () => {
    expect(parseAnnId(annId('s-1', 'f-1', 1003))).toEqual({ songId: 's-1', fileId: 'f-1', page: 1003 })
    for (const bad of ['s:f', 's:f:x', ':f:1', 's::1', 's:f:-1', 's:f:01']) expect(parseAnnId(bad)).toBeNull()
  })
})

describe('validateDelta', () => {
  const ok = {
    c: 'song',
    id: 's1',
    a: [H, true],
    f: { title: [H, 'x'], sortTitle: [H], 'metronome.bpm': [H, 120], futureField: [H, { any: 1 }] },
    m: { createdAt: 1, modifiedAt: 2 },
    l: {
      tags: { o: [H, ['a']], e: { a: [H, true, H], b: [H, null, H] } },
      files: { e: { f1: [H, { name: 'a.pdf', kind: 'pdf', pageCount: 1, size: 1, blob: 'ab', mime: 'application/pdf' }, H] } },
    },
    n: { playCount: { aaaaaaaaaaaaaaaa: [3, 1] } },
  }

  it('accepts a well-formed op', () => {
    expect(validateDelta(ok)).toBeNull()
    expect(validateDelta({ c: 'ann', id: 's:f:0', l: { items: { e: { i1: [H, { type: 'pen' }, H] } } } })).toBeNull()
    expect(validateDelta({ c: 'kv', id: 'library:recentClearedAt', m: { value: 5 } })).toBeNull()
  })

  it('checks unknown collections only structurally', () => {
    expect(validateDelta({ c: 'future', id: 'x', f: { anything: [H, [1, 2]] }, l: { q: { e: { k: [H, 5, H] } } } })).toBeNull()
    expect(validateDelta({ c: 'future', id: 'x', f: { anything: ['bad'] } })).toMatch(/bad f/)
  })

  it.each([
    ['not an object', 5, /not an object/],
    ['missing id', { c: 'song' }, /bad id/],
    ['bad hlc in a', { c: 'song', id: 's', a: ['x', true] }, /bad a/],
    ['title not a string', { c: 'song', id: 's', f: { title: [H, 5] } }, /expected str/],
    ['favorite not a bool', { c: 'song', id: 's', f: { favorite: [H, 'yes'] } }, /expected bool/],
    ['whole flat object', { c: 'song', id: 's', f: { metronome: [H, { bpm: 1 }] } }, /is flat/],
    ['sub-register of a non-flat field', { c: 'song', id: 's', f: { 'title.x': [H, 1] } }, /not flat/],
    ['list field sent as lww', { c: 'song', id: 's', f: { files: [H, []] } }, /is list/],
    ['non-finite m', { c: 'song', id: 's', m: { createdAt: 'x' } }, /expected num/],
    ['set element not true', { c: 'song', id: 's', l: { tags: { e: { a: [H, 'a', H] } } } }, /must be true/],
    ['list element not an object', { c: 'song', id: 's', l: { bookmarks: { e: { b: [H, 5, H] } } } }, /expected obj/],
    ['file ref without blob', { c: 'song', id: 's', l: { files: { e: { f: [H, { kind: 'pdf' }, H] } } } }, /bad file ref/],
    ['map with an order', { c: 'song', id: 's', l: { pageSettings: { o: [H, []] } } }, /no order/],
    ['bad born', { c: 'song', id: 's', l: { tags: { e: { a: [H, true, 'x'] } } } }, /bad l.tags.e.a/],
    ['negative counter', { c: 'song', id: 's', n: { playCount: { d: [-1, 0] } } }, /bad n/],
    ['counter on a non-pn field', { c: 'song', id: 's', n: { title: { d: [1, 0] } } }, /not a counter/],
    ['kv key that does not sync', { c: 'kv', id: 'backup.dir', f: { value: [H, 1] } }, /does not sync/],
    ['bad annotation id', { c: 'ann', id: 'nope', l: {} }, /annotation page id/],
    ['non-JSON value', { c: 'song', id: 's', f: { notes: [H, NaN] } }, /not JSON/],
  ])('rejects %s', (_name, op, re) => {
    expect(validateDelta(op)).toMatch(re)
  })
})
