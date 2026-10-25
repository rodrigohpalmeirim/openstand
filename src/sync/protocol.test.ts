import { describe, expect, it } from 'vitest'
import { DepartedSet, EchoGuard, SeenSet, followsSong, obeys, parseEnvelope, pickMatch, randomRoom, resolveQueue, rosterExpire, rosterReduce, sends, type Envelope } from './protocol'

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

  it('a reloaded tab replaces its old entry, even when the bye was lost', () => {
    let r = rosterReduce({}, env('old', { type: 'hello' }), 100)
    r = rosterReduce(r, env('other', { type: 'hello' }), 100)
    r = rosterReduce(r, env('new', { type: 'hello', replaces: 'old' }), 200)
    expect(Object.keys(r).sort()).toEqual(['new', 'other'])
    // Naming an unknown or its own id changes nothing else.
    expect(Object.keys(rosterReduce(r, env('new', { type: 'hello', replaces: 'new' }), 300)).sort()).toEqual(['new', 'other'])
  })

  it('ignores messages that arrive after their sender’s bye (over a slower transport)', () => {
    const d = new DepartedSet()
    let r = rosterReduce({}, env('a', { type: 'hello' }, { seq: 1 }), 100)
    const bye = env('a', { type: 'bye' }, { seq: 3 })
    expect(d.accept(bye)).toBe(true)
    r = rosterReduce(r, bye, 200)
    const late = env('a', { type: 'hello', reply: true }, { seq: 2 })
    expect(d.accept(late)).toBe(false)
    expect(r).toEqual({})
    // The same tab back from the back/forward cache keeps counting up.
    expect(d.accept(env('a', { type: 'hello' }, { seq: 4 }))).toBe(true)
    expect(d.accept(env('b', { type: 'hello' }, { seq: 1 }))).toBe(true)
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

describe('following page turns', () => {
  it('applies turns to the same song or the one it was matched to, never to a leftover song', () => {
    expect(followsSong('a', 'a', undefined)).toBe(true)
    expect(followsSong('a', undefined, undefined)).toBe(true)
    expect(followsSong('local1', 'remote1', { remote: 'remote1', local: 'local1' })).toBe(true)
    // The leader moved to a song this library lacks: the pair has no local song.
    expect(followsSong('local1', 'remote2', { remote: 'remote2' })).toBe(false)
    expect(followsSong('local1', 'remote2', { remote: 'remote1', local: 'local1' })).toBe(false)
  })

  it('suppresses only the echo of a remotely applied page', () => {
    const g = new EchoGuard(700)
    g.arm(1000, 4)
    expect(g.isEcho(5, 1100)).toBe(false) // the user turned to another page meanwhile: send it
    expect(g.isEcho(4, 1200)).toBe(true)
    expect(g.isEcho(4, 1300)).toBe(false) // consumed
    g.arm(2000) // an action: the next change is its echo, whatever the page
    expect(g.isEcho(9, 2100)).toBe(true)
    g.arm(3000, 2)
    expect(g.isEcho(2, 3800)).toBe(false) // too late
  })
})

describe('rooms', () => {
  it('makes distinct, typeable room names', () => {
    const a = randomRoom()
    expect(a).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/)
    expect(a).not.toMatch(/[ilo01]/)
    expect(randomRoom()).not.toBe(a)
  })
})
