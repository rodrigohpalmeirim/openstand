// @vitest-environment node
// Property-style tests with a seeded PRNG (no fast-check): the CRDT laws of mergeDelta on random deltas,
// and convergence + quiescence of 2–3 simulated devices under random edits and delivery orders.
import { describe, expect, it } from 'vitest'
import type { Annotation, KV, Setlist, Song, SongLayers } from '../db/schema'
import { canonicalJson } from './hash'
import { formatHlc } from './hlc'
import { materialize, mergeDelta } from './merge'
import { clone, DEV, hash, page, rng, setlist, SimDevice, song, stroke, T0, type Rng } from './merge.test-helper'
import type { Collection, CollectionRows, Hlc, Json, RecordDelta } from './model'

const C = canonicalJson

// ---------------------------------------------------------------------------------------------
// 1. Algebra on random deltas
// ---------------------------------------------------------------------------------------------

/** Small value spaces so hlc ties (even identical hlcs carrying different values) happen often. */
function randomDelta(r: Rng, c: 'song' | 'setlist'): RecordDelta {
  const h = (): Hlc => formatHlc(T0 + r.int(4), r.int(3), r.pick(DEV))
  const d: RecordDelta = { c, id: 'x' }
  if (r.chance(0.5)) d.a = [h(), r.chance(0.6)]
  if (r.chance(0.8)) {
    d.f = {}
    for (const k of ['title', 'notes', 'metronome.bpm', 'metronome.sound', 'futureField']) {
      if (r.chance(0.5)) d.f[k] = r.chance(0.2) ? [h()] : [h(), r.pick<Json>(['a', 'b', 1, 2, null, { z: 1 }, [1, 2]])]
    }
  }
  if (r.chance(0.6)) {
    d.m = {}
    for (const k of ['createdAt', 'modifiedAt', 'lastPlayedAt', 'unknownNum']) if (r.chance(0.5)) d.m[k] = r.int(10)
  }
  if (r.chance(0.8)) {
    d.l = {}
    for (const [k, val] of [['tags', () => true], ['bookmarks', () => ({ name: r.pick(['A', 'B']), pageIndex: r.int(3) })], ['entries', () => ({ songId: r.pick(['s1', 's2']) })]] as const) {
      if (!r.chance(0.6)) continue
      const ld: NonNullable<RecordDelta['l']>[string] = {}
      if (r.chance(0.3)) ld.o = [h(), r.shuffle(['e0', 'e1', 'e2', 'e3', 'e4']).slice(0, r.int(5))]
      if (r.chance(0.8)) {
        ld.e = {}
        for (let i = 0; i < 5; i++) if (r.chance(0.4)) ld.e[`e${i}`] = [h(), r.chance(0.3) ? null : (val() as Json), h()]
      }
      d.l[k] = ld
    }
  }
  if (r.chance(0.5)) {
    d.n = { playCount: {} }
    for (const dev of DEV) if (r.chance(0.6)) d.n.playCount[dev] = [r.int(6), r.int(3)]
  }
  return d
}

// Thousands of randomised cases: well under 5 s alone, but not under full-suite load.
const SLOW = 30_000

describe('mergeDelta laws (1,000 seeds)', () => {
  it('is commutative, associative and idempotent', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(seed)
      const c = r.chance(0.5) ? 'song' : 'setlist'
      const [x, y, z] = [randomDelta(r, c), randomDelta(r, c), randomDelta(r, c)]
      const xy = mergeDelta(x, y)
      expect(C(xy), `comm seed ${seed}`).toBe(C(mergeDelta(y, x)))
      expect(C(mergeDelta(xy, z)), `assoc seed ${seed}`).toBe(C(mergeDelta(x, mergeDelta(y, z))))
      expect(C(mergeDelta(xy, y)), `idem seed ${seed}`).toBe(C(xy))
      expect(C(mergeDelta(xy, xy)), `idem seed ${seed}`).toBe(C(xy))
      expect(C(mergeDelta(mergeDelta(undefined, x), x)), `idem seed ${seed}`).toBe(C(mergeDelta(undefined, x)))
      // Any delivery order of a batch of ops gives the same state, hence the same row.
      const ops = [x, y, z, randomDelta(r, c)]
      const s1 = ops.reduce<RecordDelta | undefined>((s, op) => mergeDelta(s, op), undefined)!
      const s2 = r.shuffle(ops).reduce<RecordDelta | undefined>((s, op) => mergeDelta(s, op), undefined)!
      expect(C(s2), `order seed ${seed}`).toBe(C(s1))
      expect(C(materialize(c, s2)), `row seed ${seed}`).toBe(C(materialize(c, s1)))
    }
  }, SLOW)
})

// ---------------------------------------------------------------------------------------------
// 2. Simulated devices
// ---------------------------------------------------------------------------------------------

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'eps']
const ANN = 's1:f1:0'
const LAYERS = 'layers:s1'
const EMPTY = 'library:emptyCollections'

type Edit = (r: Rng, d: SimDevice) => boolean

function editRow<C extends Collection>(d: SimDevice, c: C, id: string, f: (row: CollectionRows[C]) => void): boolean {
  const cur = d.get(c, id)
  if (!cur) return false
  const row = clone(cur)
  f(row)
  d.write(c, id, row)
  return true
}

const songEdit = (f: (s: Song, r: Rng, d: SimDevice) => void, id?: string): Edit => (r, d) =>
  editRow(d, 'song', id ?? r.pick(['s1', 's2']), (s) => {
    f(s, r, d)
    if (r.chance(0.5)) s.modifiedAt = d.wall
  })

const removeAt = <T>(xs: T[], r: Rng) => (xs.length ? xs.splice(r.int(xs.length), 1) : [])

const EDITS: Edit[] = [
  songEdit((s, r) => { s.title = r.pick(WORDS) }),
  songEdit((s, r) => { s.notes = r.pick(WORDS) + r.int(9) }),
  songEdit((s) => { s.favorite = !s.favorite }),
  songEdit((s, r) => { if (r.chance(0.5)) delete s.sortTitle; else s.sortTitle = r.pick(WORDS) }),
  songEdit((s, r) => { const t = r.pick(WORDS); if (!s.tags.includes(t)) s.tags.push(t) }),
  songEdit((s, r) => { removeAt(s.tags, r) }),
  songEdit((s, r) => { s.artists = r.shuffle(s.artists.length ? s.artists : ['x', 'y', 'z']) }),
  songEdit((s, r) => { s.bookmarks.push({ id: `bm${r.int(1e9)}`, name: r.pick(WORDS), pageIndex: r.int(4) }) }),
  songEdit((s, r) => { if (s.bookmarks.length) r.pick(s.bookmarks).name = r.pick(WORDS) }),
  songEdit((s, r) => { removeAt(s.bookmarks, r) }),
  songEdit((s, r) => { s.bookmarks = r.shuffle(s.bookmarks) }),
  songEdit((s, r) => { const [b] = removeAt(s.bookmarks, r); if (b) s.bookmarks.splice(r.int(s.bookmarks.length + 1), 0, b) }),
  songEdit((s, r) => { s.metronome = { ...s.metronome, bpm: 60 + r.int(100) } }),
  songEdit((s, r) => { s.metronome = { ...s.metronome, sound: r.pick(['click', 'wood', 'beep'] as const) } }),
  songEdit((s) => { delete s.metronome }),
  songEdit((s, r) => { s.display = r.chance(0.3) ? undefined : { ...s.display, zoom: r.int(4) } }),
  songEdit((s, _r, d) => { s.playCount++; s.lastPlayedAt = d.wall }),
  songEdit((s, r) => { s.playCount = Math.max(0, s.playCount - r.int(3)) }),
  songEdit((s, r) => { s.pageSettings[`f1:${r.int(3)}`] = { rotation: r.pick([0, 90, 180] as const) } }),
  songEdit((s, r) => { const k = r.pick(Object.keys(s.pageSettings).concat('none')); delete s.pageSettings[k] }),
  songEdit((s, r) => { s.files.push({ id: `f${r.int(1e9)}`, name: r.pick(WORDS), kind: 'pdf', blobId: hash(r.pick(WORDS)), pageCount: 1, size: 1 }) }),
  songEdit((s, r) => { if (s.files.length) r.pick(s.files).name = r.pick(WORDS) }),
  songEdit((s, r) => { removeAt(s.files, r) }),
  songEdit((s, r) => { (s as unknown as Record<string, unknown>).futureField = r.chance(0.3) ? undefined : { v: r.int(5) } }),
  songEdit((s, r) => { s.createdAt = Math.min(s.createdAt, T0 - r.int(1000)) }),
  songEdit((s, r) => { s.smartButtons = [...(s.smartButtons ?? []), { id: `sb${r.int(1e9)}`, label: 'x', pageIndex: 0, x: 0.5, y: 0.5, kind: 'page' }] }),
  // delete / undelete / create
  (r, d) => { const id = r.pick(['s1', 's2']); if (!d.get('song', id)) return false; d.write('song', id, null); return true },
  (r, d) => {
    const id = r.pick(['s1', 's2'])
    const g = d.graveyard.get(`song/${id}`) as Song | undefined
    if (d.get('song', id) || !g) return false
    d.write('song', id, { ...g, modifiedAt: d.wall })
    return true
  },
  (r, d) => { if (d.get('song', 's2') || d.shadows.has('song/s2')) return false; d.write('song', 's2', song('s2', { title: r.pick(WORDS), tags: ['new'] })); return true },
  // setlist
  (r, d) => editRow(d, 'setlist', 'set1', (s: Setlist) => { s.entries.push({ key: `k${r.int(1e9)}`, songId: r.pick(['s1', 's2']) }) }),
  (r, d) => editRow(d, 'setlist', 'set1', (s: Setlist) => { removeAt(s.entries, r) }),
  (r, d) => editRow(d, 'setlist', 'set1', (s: Setlist) => { const [e] = removeAt(s.entries, r); if (e) s.entries.splice(r.int(s.entries.length + 1), 0, e) }),
  (r, d) => editRow(d, 'setlist', 'set1', (s: Setlist) => { if (s.entries.length) r.pick(s.entries).note = r.pick(WORDS) }),
  (r, d) => editRow(d, 'setlist', 'set1', (s: Setlist) => { s.name = r.pick(WORDS) }),
  // annotations
  (r, d) => {
    const p = d.get('ann', ANN)
    const items: Annotation[] = p ? clone(p.items) : []
    items.push(stroke(`st${r.int(1e9)}`, r.pick(['default', 'l2'])))
    d.write('ann', ANN, page('s1', 'f1', 0, items))
    return true
  },
  (r, d) => editRow(d, 'ann', ANN, (p) => { removeAt(p.items, r) }),
  (r, d) => editRow(d, 'ann', ANN, (p) => { const [it] = removeAt(p.items, r); if (it) p.items.push(it) }), // bring to front
  (r, d) => editRow(d, 'ann', ANN, (p) => { if (p.items.length) (r.pick(p.items) as { color: string }).color = r.pick(['#f00', '#0f0']) }),
  (_r, d) => { if (!d.get('ann', ANN)) return false; d.write('ann', ANN, null); return true }, // erase all
  // kv
  (r, d) => editRow(d, 'kv', LAYERS, (k: KV) => {
    const v = k.value as SongLayers
    if (r.chance(0.5)) v.layers.push({ id: `l${r.int(1e9)}`, name: r.pick(WORDS), visible: true })
    else if (v.layers.length > 1) removeAt(v.layers, r)
    v.current = v.layers.length ? r.pick(v.layers).id : 'default'
  }),
  (r, d) => editRow(d, 'kv', LAYERS, (k: KV) => { const ls = (k.value as SongLayers).layers; if (ls.length) { const l = r.pick(ls); l.visible = !l.visible } }),
  (r, d) => {
    const cur = (d.get('kv', EMPTY)?.value as string[] | undefined) ?? []
    const next = r.chance(0.6) ? [...new Set([...cur, r.pick(WORDS)])] : cur.filter((x) => x !== r.pick(WORDS))
    d.write('kv', EMPTY, { key: EMPTY, value: next })
    return true
  },
]

function simulate(seed: number) {
  const r = rng(seed)
  const n = 2 + r.int(2)
  const devs = DEV.slice(0, n).map((id) => new SimDevice(id, r.int(20 * 60_000) - 10 * 60_000))
  const inbox = new Map(devs.map((d) => [d, [] as RecordDelta[]]))
  const sentCount = new Map(devs.map((d) => [d, 0]))
  const post = (from: SimDevice) => {
    for (const op of from.sent.slice(sentCount.get(from))) for (const d of devs) if (d !== from) inbox.get(d)!.push(op)
    sentCount.set(from, from.sent.length)
  }
  const deliver = (d: SimDevice) => {
    const q = inbox.get(d)!
    if (!q.length) return
    const [op] = q.splice(r.int(q.length), 1) // any order, not even FIFO per sender
    d.receive(op)
    if (r.chance(0.1)) q.push(op) // duplicate delivery
  }

  const [d0] = devs
  d0.write('song', 's1', song('s1', { tags: ['a', 'b'], artists: ['x', 'y'], bookmarks: [{ id: 'b0', name: 'Start', pageIndex: 0 }], metronome: { bpm: 100 } }))
  d0.write('setlist', 'set1', setlist('set1', { entries: [{ key: 'k0', songId: 's1' }] }))
  d0.write('kv', LAYERS, { key: LAYERS, value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'l2', name: 'Two', visible: true }], current: 'default' } })
  post(d0)

  const steps = 60 + r.int(60)
  for (let i = 0; i < steps; i++) {
    const d = r.pick(devs)
    const roll = r.next()
    if (roll < 0.45) {
      for (let tries = 0; tries < 5 && !r.pick(EDITS)(r, d); tries++);
      post(d)
    } else if (roll < 0.9) {
      for (let k = r.int(4); k >= 0; k--) deliver(d)
    } else d.tick(r.int(r.chance(0.5) ? 10 : 5 * 60_000))
  }
  // Drain everything, in random order, then once more in full.
  for (const d of devs) while (inbox.get(d)!.length) deliver(d)
  for (const d of devs) for (const o of devs) if (o !== d) for (const op of r.shuffle(o.sent)) d.receive(op)
  return devs
}

const comparable = (k: string, row: unknown) => {
  if (!row || !k.startsWith('kv/layers:')) return C(row ?? null)
  const { current: _current, ...rest } = (row as KV<SongLayers>).value
  return C(rest)
}

describe('simulated devices converge (300 seeds, 2–3 devices, random interleavings)', () => {
  it('every device ends with the same rows and shadows, and nothing left to publish', () => {
    let checked = 0
    for (let seed = 1; seed <= 300; seed++) {
      const devs = simulate(seed)
      const keys = new Set(devs.flatMap((d) => d.keys()))
      for (const k of keys) {
        const [c, ...rest] = k.split('/')
        const id = rest.join('/')
        const rows = devs.map((d) => comparable(k, d.get(c as Collection, id)))
        expect(new Set(rows).size, `seed ${seed} ${k}\n${rows.join('\n')}`).toBe(1)
        // Alive records: identical shadows. Dead ones: the device that deleted locally captured after its
        // row was gone, so it can't know the alive values (its undo row has them); a, m and n must agree.
        const shadows = devs.map((d) => {
          const sh = d.shadows.get(k)
          return C(sh && sh.a && !sh.a[1] ? { a: sh.a, m: sh.m, n: sh.n } : (sh ?? null))
        })
        expect(new Set(shadows).size, `seed ${seed} ${k} shadows`).toBe(1)
        for (const d of devs) expect(d.pending(c as Collection, id), `seed ${seed} ${d.id} ${k} pending`).toBeNull()
        const layers = devs.map((d) => d.get('kv', LAYERS)?.value as SongLayers | undefined)
        for (const v of layers) if (v?.layers.length) expect(v.layers.some((l) => l.id === v.current), `seed ${seed} current`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(300 * 4)
  }, SLOW)
})
