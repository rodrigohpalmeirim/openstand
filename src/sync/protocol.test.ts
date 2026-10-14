import { describe, expect, it } from 'vitest'
import { SeenSet, obeys, parseEnvelope, pickMatch, resolveQueue, rosterExpire, rosterReduce, sends, type Envelope } from './protocol'

const env = (from: string, body: Envelope['body'], extra: Partial<Envelope> = {}): Envelope => ({ v: 1, from, name: from.toUpperCase(), role: 'peer', seq: 1, t: 0, body, ...extra })

describe('roles', () => {
  it('leaders send, followers obey', () => {
    expect(sends('leader')).toBe(true)
    expect(sends('peer')).toBe(true)
    expect(sends('follower')).toBe(false)
    expect(obeys('follower', 'leader')).toBe(true)
    expect(obeys('follower', 'peer')).toBe(true)
    expect(obeys('peer', 'peer')).toBe(true)
    expect(obeys('leader', 'peer')).toBe(false)
    expect(obeys('peer', 'follower')).toBe(false)
  })
})

describe('envelopes', () => {
  it('parses valid envelopes and rejects junk', () => {
    const e = env('a', { type: 'hello' })
    expect(parseEnvelope(JSON.stringify(e))).toEqual({ ...e, to: undefined })
    expect(parseEnvelope('not json')).toBeNull()
    expect(parseEnvelope({ v: 1, from: 'a', seq: 1, role: 'boss', body: { type: 'hello' } })).toBeNull()
    expect(parseEnvelope({ v: 1, from: 'a', role: 'peer', body: { type: 'hello' } })).toBeNull()
  })
  it('dedupes by sender and sequence', () => {
    const s = new SeenSet(2)
    expect(s.add({ from: 'a', seq: 1 })).toBe(true)
    expect(s.add({ from: 'a', seq: 1 })).toBe(false)
    expect(s.add({ from: 'b', seq: 1 })).toBe(true)
    s.add({ from: 'c', seq: 1 })
    expect(s.add({ from: 'a', seq: 1 })).toBe(true) // evicted
  })
})

describe('roster', () => {
  it('tracks hello, songs, bye and expiry', () => {
    let r = rosterReduce({}, env('a', { type: 'hello' }, { role: 'leader' }), 100)
    expect(r.a).toMatchObject({ name: 'A', role: 'leader', lastSeen: 100 })
    r = rosterReduce(r, env('a', { type: 'openSong', song: { id: '1', title: 'Song' }, position: 0, queue: [], index: 0 }), 200)
    expect(r.a.song).toBe('Song')
    r = rosterReduce(r, env('b', { type: 'hello' }), 300)
    expect(Object.keys(r)).toEqual(['a', 'b'])
    expect(rosterExpire(r, 30_200, 29_950)).toHaveProperty('b')
    expect(rosterExpire(r, 30_200, 29_950)).not.toHaveProperty('a')
    r = rosterReduce(r, env('b', { type: 'bye' }), 400)
    expect(Object.keys(r)).toEqual(['a'])
  })
})

describe('song matching', () => {
  const songs = [
    { id: 'x1', title: 'The Girl from Ipanema', artists: ['Jobim'] },
    { id: 'x2', title: 'Autumn Leaves', artists: ['Kosma'] },
    { id: 'x3', title: 'Autumn Leaves', artists: ['Cannonball Adderley'] },
    { id: 'x4', title: 'Café Society', artists: [] },
  ]
  it('matches by id, then title and artist, then title', () => {
    expect(pickMatch({ id: 'x2', title: 'whatever' }, songs)).toBe('x2')
    expect(pickMatch({ id: 'zz', title: 'autumn  leaves', artist: 'cannonball adderley' }, songs)).toBe('x3')
    expect(pickMatch({ id: 'zz', title: 'Autumn Leaves', artist: 'Unknown' }, songs)).toBe('x2')
    expect(pickMatch({ id: 'zz', title: 'Girl From Ipanema' }, songs)).toBe('x1')
    expect(pickMatch({ id: 'zz', title: 'cafe society!' }, songs)).toBe('x4')
    expect(pickMatch({ id: 'zz', title: 'Nope' }, songs)).toBeUndefined()
  })
  it('resolves queues around missing songs', () => {
    const q = [
      { id: 'a', title: 'Autumn Leaves' },
      { id: 'b', title: 'Missing' },
      { id: 'c', title: 'Cafe Society' },
    ]
    expect(resolveQueue(q, 2, (r) => pickMatch(r, songs))).toEqual({ ids: ['x2', 'x4'], index: 1, missing: 1 })
    expect(resolveQueue(q, 1, (r) => pickMatch(r, songs)).index).toBe(-1)
  })
})
