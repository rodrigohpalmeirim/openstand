// @vitest-environment node
/**
 * Regression tests for the library-sync security review: a paired device sending poisoned timestamps,
 * malicious snapshots, and denial of service by someone with bucket access but without the secret.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { OpenStandDB } from '../db/db'
import type { MemoryBackend } from './backends/memory'
import { encodeBatch, encodeDevice, writeSnapshot } from './codec'
import { bytesEqual, type LibraryKeys } from './crypto'
import { rankSnapshots, snapshotProblem, type Engine } from './engine'
import { formatHlc, hlcWall } from './hlc'
import { previewJoin } from './join'
import type { Batch, RecordDelta, SnapshotHeader } from './model'
import { deviceKey, headKey, logKey, snapKey } from './paths'
import { getState, putState } from './state'
import { addSong, bytes, converge, enableDevice, joinDevice, pairing, settle, world, type World } from './sync.test-helper'

const DAY = 24 * 60 * 60_000
const EVIL = 'eeeeeeeeeeeeeeee'
const titles = async (db: OpenStandDB) => (await db.songs.toArray()).map((s) => s.title).sort()

/** A paired attacker: holds the secret, so it can write a valid device record, batches and snapshots. */
async function pairedAttacker(w: World, keys: LibraryKeys, id = EVIL) {
  const be = w.backend()
  await be.put(deviceKey(keys.libraryId, id), await encodeDevice(keys, { v: 1, id, name: 'Mallory', platform: 'x', appVersion: '0', createdAt: 0, lastSeenAt: 0 }))
  return {
    be,
    async batch(s: number, ops: unknown[], hlcMax?: string) {
      const b = { v: 1, d: id, s, t: w.now(), hlcMax: hlcMax ?? formatHlc(w.now(), 0, id), ops } as unknown as Batch
      await be.put(logKey(keys.libraryId, id, s), await encodeBatch(keys, b))
      await be.put(headKey(keys.libraryId, id, s), new Uint8Array(0))
    },
    async snapshot(n: number, header: Partial<SnapshotHeader>, records: RecordDelta[]) {
      const now = w.now()
      const hlc = formatHlc(now, 0, id)
      const { body } = await writeSnapshot(
        keys,
        { d: id, n, t: now, vector: {}, records: records.length, hlcMax: hlc, horizon: { deadFields: now - 30 * DAY, elementTombs: now - 180 * DAY }, ...header },
        records,
      )
      await be.upload(snapKey(keys.libraryId, id, n), body, {})
    },
  }
}

const songOp = (id: string, title: string, hlc: string): RecordDelta => ({ c: 'song', id, a: [hlc, true], f: { title: [hlc, title] } })

async function edit(db: OpenStandDB, id: string, title: string) {
  await db.table('songs').update(id, { title })
}

describe('poisoned timestamps from a paired device (review finding 1)', () => {
  it('skips ops stamped far ahead or past the format; the clock, local capture and the other streams carry on', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const evil = await pairedAttacker(w, eA.core.keys)
    const ok = formatHlc(w.now(), 0, EVIL)
    // Year ~10889, still a valid HLC; then the largest value the format allows (counter overflow).
    const far = 'fffffffffff0' + '0000' + EVIL
    const max = 'f'.repeat(16) + EVIL
    await evil.batch(1, [songOp('evil-far', 'pwned', far), songOp('fine', 'Fine', ok)], far)
    await evil.batch(2, [songOp('evil-max', 'pwned', max)], max)

    await eB.sync()
    expect(await titles(B)).toEqual(['Fine', 'One'])
    // Neither the in-memory nor the persisted clock moved into the future.
    expect(hlcWall(eB.core.clock.last)).toBeLessThan(w.now() + DAY)
    expect(hlcWall((await getState(B, 'clock'))!)).toBeLessThan(w.now() + DAY)
    expect(eB.status.error).toBeUndefined()
    expect(eB.status.warning?.code).toBe('clockAhead')
    expect((await getState(B, 'cursors'))![EVIL]).toBe(2)

    // Local capture still works, and A and B keep syncing both ways.
    await eA.sync()
    expect(await titles(A)).toEqual(['Fine', 'One'])
    expect(hlcWall(eA.core.clock.last)).toBeLessThan(w.now() + DAY)
    await edit(B, 's1', 'One (B)')
    await edit(A, 'fine', 'Fine (A)')
    await converge(eA, eB)
    expect(await titles(A)).toEqual(['Fine (A)', 'One (B)'])
    expect(await titles(B)).toEqual(['Fine (A)', 'One (B)'])

    // A new device can still join.
    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    await eC.sync()
    expect(await titles(C)).toEqual(['Fine (A)', 'One (B)'])
    expect(hlcWall(eC.core.clock.last)).toBeLessThan(w.now() + DAY)
  })

  it('a malformed batch (hlcMax "nope") holds back that device only, as a non-fatal warning', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const evil = await pairedAttacker(w, eA.core.keys)
    await evil.batch(1, [songOp('x', 'x', formatHlc(w.now(), 0, EVIL))], 'nope')

    await expect(eB.sync()).resolves.toBeTruthy()
    expect(eB.status.phase).not.toBe('error')
    expect(eB.status.error).toBeUndefined()
    expect(eB.status.streams?.[EVIL]).toBeTruthy()
    expect(eB.status.warning).toBeTruthy()
    expect(await B.songs.get('x')).toBeUndefined()

    await edit(A, 's1', 'One (A)')
    await eA.sync()
    await edit(B, 's1', 'One (A, B)')
    await converge(eA, eB)
    expect(await titles(A)).toEqual(['One (A, B)'])
    expect(await titles(B)).toEqual(['One (A, B)'])
    const C = w.db('C')
    await joinDevice(w, C, A)
    expect(await titles(C)).toEqual(['One (A, B)'])
  })

  it('a clock a few days ahead holds the stream until ours catches up, then applies it (no lost edits)', async () => {
    const w = world()
    const A = w.db('A')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const evil = await pairedAttacker(w, eA.core.keys, 'aaaaaaaaaaaaaaaa')
    const ahead = formatHlc(w.now() + 3 * DAY, 0, 'aaaaaaaaaaaaaaaa')
    await evil.batch(1, [songOp('late', 'From the future', ahead)])

    await eB.sync()
    expect(await B.songs.get('late')).toBeUndefined()
    expect(eB.status.streams?.aaaaaaaaaaaaaaaa?.code).toBe('clockAhead')
    expect((await getState(B, 'cursors'))!.aaaaaaaaaaaaaaaa ?? 0).toBe(0)

    w.advance(2 * DAY + 60_000)
    await eB.sync()
    expect((await B.songs.get('late'))?.title).toBe('From the future')
    expect(eB.status.streams).toEqual({})
  })
})

describe('malicious snapshots (review finding 2)', () => {
  it('a vector past the heads is ignored: the joiner still gets the existing and new songs', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Song one')
    const eA = await enableDevice(w, A)
    const me = eA.config.deviceId
    const evil = await pairedAttacker(w, eA.core.keys)
    const hlc = formatHlc(w.now(), 0, EVIL)
    await evil.snapshot(1, { vector: { [me]: 9_000_000 } }, [songOp('decoy', 'decoy', hlc)])
    // A snapshot from a device without any record is ignored too.
    const ghost = await pairedAttacker(w, eA.core.keys, 'dddddddddddddddd')
    await ghost.be.delete(deviceKey(eA.core.keys.libraryId, 'dddddddddddddddd'))
    await ghost.snapshot(1, { vector: { [me]: 1 } }, [songOp('ghost', 'ghost', hlc)])

    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    const heads = await eA.heads()
    expect((await getState(C, 'cursors'))![me]).toBeLessThanOrEqual(heads[me])
    expect(await titles(C)).toEqual(['Song one'])
    await addSong(A, 's2', 'Song two')
    await eA.sync()
    await eC.sync()
    expect(await titles(C)).toEqual(['Song one', 'Song two'])
  })

  it('gap recovery never deletes rows from a snapshot that does not cover what this device has merged', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Keep me')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    await addSong(C, 'c1', 'From C')
    await converge(eC, eB)
    const lib = eA.core.keys.libraryId
    const me = eA.config.deviceId
    // A writes seq 2; its log goes missing (as if pruned) before B reads it.
    await edit(A, 's1', 'Keep me (A)')
    await eA.sync()
    await w.backend().delete(logKey(lib, me, 2))
    // The only snapshot that covers the gap is consistent with the heads but older than what B merged
    // from C, has a tombstone horizon as late as its codec allows, and lacks s1 and c1.
    const evil = await pairedAttacker(w, eA.core.keys)
    const now = w.now()
    await evil.snapshot(1, { vector: { [me]: 2 }, horizon: { deadFields: now, elementTombs: now } }, [songOp('decoy', 'decoy', formatHlc(now, 0, EVIL))])
    // B was "away" past any horizon.
    await putState(B, 'lastSync', { at: 0, hlc: formatHlc(1, 0, eB.config.deviceId), seq: 0 })

    await eB.sync()
    const t = await titles(B)
    expect(t).toContain('Keep me')
    expect(t).toContain('From C')
  })

  it('snapshotProblem / rankSnapshots: consistency, known authors, live before retired', () => {
    const A = '0123456789abcdef'
    const R = 'fedcba9876543210'
    const now = 1_760_000_000_000
    const h = (vector: Record<string, number>, o: Partial<SnapshotHeader> = {}): SnapshotHeader => ({
      v: 1,
      kind: 'snapshot',
      d: A,
      n: 1,
      t: now,
      vector,
      records: 0,
      hlcMax: formatHlc(now, 0, A),
      horizon: { deadFields: now - 30 * DAY, elementTombs: now - 180 * DAY },
      ...o,
    })
    const heads = { [A]: 5 }
    expect(snapshotProblem(h({ [A]: 5 }), heads, now)).toBeNull()
    expect(snapshotProblem(h({ [A]: 6 }), heads, now)).toMatch(/past its head/)
    expect(snapshotProblem(h(JSON.parse(`{"__proto__": 1}`)), heads, now)).toMatch(/device id/)
    expect(snapshotProblem(h({ [A]: -1 }), heads, now)).toMatch(/bad seq/)
    expect(snapshotProblem(h({}, { t: now + 2 * DAY }), heads, now)).toMatch(/future/)
    expect(snapshotProblem(h({}, { hlcMax: 'f'.repeat(32) }), heads, now)).toMatch(/future/)
    // A device without a trusted head (retired, or unknown) can't be checked, but moves no cursor.
    expect(snapshotProblem(h({ [R]: 99 }), heads, now)).toBeNull()

    const snaps = [
      { deviceId: R, header: h({ [A]: 5 }) },
      { deviceId: A, header: h({ [A]: 4 }) },
      { deviceId: A, header: h({ [A]: 9 }) },
      { deviceId: EVIL, header: h({ [A]: 5 }) },
    ]
    const devices = new Map([
      [A, {}],
      [R, { retired: true }],
    ])
    expect(rankSnapshots(snaps, { heads, devices, now })).toEqual([snaps[1], snaps[0]])
  })
})

describe('denial of service without the secret (review finding 3)', () => {
  const gets = (e: Engine) => (e.core.backend as MemoryBackend).calls.filter((c) => c.op === 'get').length

  it('fake heads (unknown device, or far past a real head) are not fatal and cost bounded requests', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const lib = eA.core.keys.libraryId
    const me = eA.config.deviceId
    const be = w.backend()
    await be.put(headKey(lib, '0123012301230123', 9_999_999_999), new Uint8Array(0))
    await be.put(headKey(lib, me, 9_999_999_999), new Uint8Array(0))
    await addSong(A, 's2', 'Two')
    await eA.sync()

    const g0 = gets(eB)
    await eB.sync()
    expect(gets(eB) - g0).toBeLessThan(100)
    expect(eB.status.error).toBeUndefined()
    expect(eB.status.phase).not.toBe('error')
    expect(await titles(B)).toEqual(['One', 'Two']) // real entries before the bogus head still arrive
    expect(eB.status.streams?.['0123012301230123']).toBeUndefined() // unknown device: ignored outright
    // The held-back stream isn't retried on every poll.
    const g1 = gets(eB)
    await eB.sync()
    expect(gets(eB) - g1).toBeLessThan(10)

    // The join preview stays bounded too.
    const C = w.db('C')
    const g = w.backend()
    const preview = await previewJoin(C, await pairing(A), w.opts({ backend: g }))
    expect(preview.remoteSongs).toBe(2)
    expect(g.calls.filter((c) => c.op === 'get').length).toBeLessThan(100)
  })

  it('a tampered log entry holds back only its stream; a snapshot covering it heals the stream', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    const lib = eA.core.keys.libraryId
    const me = eA.config.deviceId
    await edit(A, 's1', 'One (A)')
    await eA.sync()
    const key = logKey(lib, me, 2)
    const be = w.backend()
    const bad = be.objects().get(key)!.slice()
    bad[0] ^= 0xff // the unauthenticated version byte
    await be.put(key, bad)
    await addSong(C, 'c1', 'From C')
    await eC.sync()

    await eB.sync()
    expect(eB.status.error).toBeUndefined()
    expect(eB.status.streams?.[me]).toBeTruthy()
    expect(await titles(B)).toEqual(['From C', 'One'])

    await eA.writeSnapshot()
    w.advance(DAY) // past the stall's retry delay
    await eB.sync()
    expect(eB.status.streams?.[me]).toBeUndefined()
    expect(await titles(B)).toEqual(['From C', 'One (A)'])
  })

  it('an object planted at our next log key is overwritten, not a fatal "rejoin"', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const lib = eA.core.keys.libraryId
    const next = (await getState(A, 'seq'))!.next
    await w.backend().put(logKey(lib, eA.config.deviceId, next), new Uint8Array([1, 2, 3]))
    await edit(A, 's1', 'One (A)')
    await expect(eA.sync()).resolves.toBeTruthy()
    const B = w.db('B')
    await joinDevice(w, B, A)
    expect(await titles(B)).toEqual(['One (A)'])
  })

  it('an absurd claimed file size is not queued as such', async () => {
    const w = world()
    const A = w.db('A')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const evil = await pairedAttacker(w, eA.core.keys)
    const hlc = formatHlc(w.now(), 0, EVIL)
    const hash = 'ab'.repeat(32)
    await evil.batch(1, [
      {
        c: 'song',
        id: 'big',
        a: [hlc, true],
        f: { title: [hlc, 'Big'] },
        l: { files: { e: { f1: [hlc, { name: 'x.pdf', kind: 'pdf', blob: hash, mime: 'application/pdf', size: 1e18 }, hlc] } } },
      },
    ])
    await eB.pull()
    const row = await B.syncTransfers.get(['down', hash])
    expect(row?.size).toBe(0)
  })

  it('repair replaces a same-size remote blob whose fingerprint differs', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One', { files: [{ id: 'f1', data: bytes(7, 3000) }] })
    const eA = await enableDevice(w, A)
    const be = w.backend()
    const key = [...be.objects().keys()].find((k) => k.includes('/blobs/'))!
    const good = be.objects().get(key)!.slice()
    const planted = good.slice()
    planted[20] ^= 0xff // inside chunk 0's nonce: same size, other content
    await be.put(key, planted)
    expect((await eA.repair()).uploads).toBe(1)
    await settle(eA)
    expect(bytesEqual(be.objects().get(key)!, good)).toBe(true)
    expect((await eA.repair()).uploads).toBe(0)
  })

  it('a listing that never ends fails the sync as a retryable error, not a fatal one', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const be = eA.core.backend as MemoryBackend
    const list = be.list.bind(be)
    be.list = async (prefix, o) => ({ ...(await list(prefix, o)), cursor: 'again' })
    await expect(eA.sync()).rejects.toMatchObject({ providerCode: 'ListLoop' })
    expect(eA.status.error?.code).toBe('unknown')
    be.list = list
    await expect(eA.sync()).resolves.toBeTruthy()
    expect(eA.status.error).toBeUndefined()
  })
})
