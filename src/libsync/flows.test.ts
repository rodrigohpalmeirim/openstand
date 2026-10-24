// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { isCaptureOn } from '../db/capture'
import { openLibrary, pruneAnnotations } from '../db/db'
import type { SongLayers } from '../db/schema'
import { SyncError } from './engine'
import { deleteRemote, leave } from './join'
import { deviceKey, headsPrefix, logPrefix } from './paths'
import { getConfig, getState, putState } from './state'
import { addSong, bytes, converge, enableDevice, joinDevice, outgoing, page, setlist, settle, stroke, view, world } from './sync.test-helper'

const DAY = 24 * 60 * 60_000
const ids = (items: { id: string }[] | undefined) => (items ?? []).map((i) => i.id)

describe('join', () => {
  it('merge mode combines matching songs and publishes the rest', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Autumn Leaves', { files: [{ id: 'f1', data: bytes(1, 400) }], patch: { tags: ['jazz'], playCount: 5, rating: 4 } })
    await addSong(A, 's2', 'Remote only')
    await A.kv.put({ key: 'library:emptyCollections', value: ['A coll'] })
    await A.kv.put({ key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: true }], current: 'default' } })
    const eA = await enableDevice(w, A)

    const B = w.db('B')
    await addSong(B, 'L1', 'autumn  leaves', { files: [{ id: 'lf1', data: bytes(1, 400) }], patch: { tags: ['mine'], playCount: 2, favorite: true } })
    await addSong(B, 'L2', 'Only on B', { files: [{ id: 'lf2', data: bytes(2, 300) }] })
    await addSong(B, 'L3', 'Autumn Leaves', { files: [{ id: 'lf3', data: bytes(3, 300) }] }) // same title, other file: separate
    await B.annotations.put(page('L1', 'lf1', [stroke('bA', 'fing')]))
    await B.kv.put({ key: 'layers:L1', value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'fing', name: 'Fingering', visible: true }], current: 'fing' } })
    await B.kv.put({ key: 'library:emptyCollections', value: ['B coll'] })
    await B.setlists.put(setlist('LS', 'Gig', ['L1', 'L2']))

    const { previewJoin } = await import('./join')
    const { pairing } = await import('./sync.test-helper')
    expect(await previewJoin(B, await pairing(A), w.opts())).toEqual({ remoteSongs: 2, remoteBytes: 400, localSongs: 3, matches: 1, suggested: 'newLibrary' })

    const eB = await joinDevice(w, B, A, 'merge')
    await converge(eA, eB)
    expect(await view(B)).toEqual(await view(A))
    const s1 = (await A.songs.get('s1'))!
    expect([s1.playCount, s1.rating, s1.favorite, [...s1.tags].sort()]).toEqual([7, 4, true, ['jazz', 'mine']])
    expect((await A.songs.toArray()).map((s) => s.id).sort()).toEqual(['L2', 'L3', 's1', 's2'])
    expect((await A.setlists.get('LS'))!.entries.map((e) => e.songId)).toEqual(['s1', 'L2'])
    const merged = (await A.annotations.get('s1:f1:0'))!
    const layers = (await A.kv.get('layers:s1'))!.value as SongLayers
    const fing = layers.layers.find((l) => l.name === 'Fingering')!
    expect(merged.items.map((i) => [i.id, i.layer])).toEqual([['bA', fing.id]])
    expect(((await A.kv.get('library:emptyCollections'))!.value as string[]).sort()).toEqual(['A coll', 'B coll'])
    expect(await B.annotations.where('songId').equals('L1').count()).toBe(0)
  })

  it('here mode drops untouched demo songs instead of publishing them', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Synced')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    await addSong(B, 'demo', 'Welcome to OpenStand')
    const eB = await joinDevice(w, B, A, 'here', { isUntouchedDemo: async (s) => s.id === 'demo' })
    await converge(eA, eB)
    expect((await A.songs.toArray()).map((s) => s.id)).toEqual(['s1'])
    expect((await B.songs.toArray()).map((s) => s.id)).toEqual(['s1'])
  })

  it('a wrong secret or deleted library is reported', async () => {
    const w = world()
    const A = w.db('A')
    const eA = await enableDevice(w, A)
    const { join, openPairing } = await import('./join')
    const { pairing } = await import('./sync.test-helper')
    const p = await pairing(A)
    const other = { ...p, s: p.s.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }
    await expect(openPairing(other, w.opts())).rejects.toMatchObject({ code: 'libraryGone' }) // other secret → other path
    // Same path, wrong key: tamper with meta's key by pointing a second library at A's location is not
    // possible, so check the decrypt path through a corrupted meta instead.
    const backend = w.backend()
    const metaKeyA = [...backend.objects().keys()].find((k) => k.endsWith('/meta'))!
    const meta = backend.objects().get(metaKeyA)!
    meta[meta.length - 1] ^= 1
    await backend.put(metaKeyA, meta)
    await expect(join(w.db('B'), p, 'here', w.opts())).rejects.toMatchObject({ code: 'wrongSecret' })
    eA.stop()
  })
})

describe('snapshots and pruning', () => {
  it('prunes covered logs; a new device bootstraps from the snapshot; a lagging one recovers the gap', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'v0')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    for (let i = 1; i <= 4; i++) {
      await A.table('songs').update('s1', { title: `v${i}` })
      await addSong(A, `n${i}`, `New ${i}`)
      await eA.sync()
      if (i === 1) await eB.sync() // B stops following after the first edit
    }
    await A.annotations.put(page('s1', 'nofile', [stroke('o')])) // an orphan page: deferred, stays local, doesn't block snapshots
    const header = await eA.writeSnapshot()
    expect(header?.vector[eA.config.deviceId]).toBe(5)
    w.advance(15 * DAY)
    const deleted = await eA.prune()
    expect(deleted).toBeGreaterThan(0)
    const lib = eA.core.keys.libraryId
    const logs = [...w.backend().objects().keys()].filter((k) => k.startsWith(logPrefix(lib, eA.config.deviceId)))
    expect(logs).toEqual([])
    // Only the latest head is kept.
    expect([...w.backend().objects().keys()].filter((k) => k.startsWith(headsPrefix(lib, eA.config.deviceId)))).toHaveLength(1)

    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    const synced = async (d: typeof A) => ({ ...(await view(d)), annotations: [] })
    expect(await view(C)).toEqual(await synced(A))

    await eB.sync() // log 3.. are gone: merges the snapshot instead
    await settle(eB)
    expect(await view(B)).toEqual(await synced(A))
    expect((await getState(B, 'cursors'))?.[eA.config.deviceId]).toBe(5)
    await converge(eA, eB, eC)
    expect(await view(B)).toEqual(await view(C))
  })

  it('keeps the latest two own snapshots', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'x')
    const eA = await enableDevice(w, A)
    for (let i = 0; i < 3; i++) {
      await A.table('songs').update('s1', { title: `t${i}` })
      await eA.sync()
      await eA.writeSnapshot()
      w.advance(2 * DAY)
    }
    await eA.prune()
    const snaps = (await eA.listSnapshots()).map((s) => s.n).sort()
    expect(snaps).toEqual([3, 4])
  })

  it('a device away past the tombstone horizon drops what was deleted meanwhile (stale catch-up)', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Song', { files: [{ id: 'f1', data: bytes(5, 64) }] })
    await addSong(A, 's2', 'Deleted while B was away')
    await A.annotations.put(page('s1', 'f1', [stroke('keep'), stroke('erased')]))
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)

    w.advance(DAY)
    await A.annotations.put(page('s1', 'f1', [stroke('keep')]))
    await A.songs.delete('s2')
    await eA.sync()
    w.advance(200 * DAY)
    await addSong(A, 's3', 'Much later')
    await eA.sync()
    await eA.writeSnapshot() // drops the 200-day-old element tombstone
    w.advance(2 * DAY)
    await eA.prune()

    await eB.sync()
    expect(ids((await B.annotations.get('s1:f1:0'))?.items)).toEqual(['keep'])
    expect((await B.songs.toArray()).map((s) => s.id).sort()).toEqual(['s1', 's3'])
    expect(await outgoing(B)).toEqual({ dirty: 0, outbox: 0 })
    await converge(eA, eB)
    expect(await view(B)).toEqual(await view(A))
  })
})

describe('leave and delete', () => {
  it('leave retires the device and keeps the library local', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'x')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const me = eB.config.deviceId
    await leave(B, eB, w.opts())
    expect(await getConfig(B)).toBeUndefined()
    expect(isCaptureOn(B.name)).toBe(false)
    expect(await B.songs.count()).toBe(1)
    const lib = eA.core.keys.libraryId
    expect([...w.backend().objects().keys()].filter((k) => k.startsWith(headsPrefix(lib, me)))).toEqual([])
    const devices = await eA.refreshDevices()
    expect(devices.find((d) => d.id === me)?.retired).toBe(true)
    expect(w.backend().objects().has(deviceKey(lib, me))).toBe(true)
    // Local edits after leaving are not captured.
    await B.table('songs').update('s1', { title: 'local only' })
    expect(await B.syncDirty.count()).toBe(0)
  })

  it('deleting synced data makes other devices stop with libraryGone', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'x', { files: [{ id: 'f', data: bytes(1, 10) }] })
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    await deleteRemote(A, eA, w.opts())
    expect(w.backend().objects().size).toBe(0)
    await expect(eB.sync()).rejects.toBeInstanceOf(SyncError)
    expect(eB.status.error?.code).toBe('libraryGone')
    expect(await B.songs.count()).toBe(1)
  })
})

describe('blob GC and repair (§3.2)', () => {
  it('deletes unreferenced blobs after the grace window; repair re-uploads missing ones', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 'keep', 'Keep', { files: [{ id: 'k', data: bytes(1, 100) }] })
    await addSong(A, 'drop', 'Drop', { files: [{ id: 'd', data: bytes(2, 100) }] })
    const eA = await enableDevice(w, A)
    const blobKeys = () => [...w.backend().objects().keys()].filter((k) => k.includes('/blobs/'))
    expect(blobKeys()).toHaveLength(2)
    const dropHash = (await A.songs.get('drop'))!.files[0].blobId
    await A.songs.delete('drop')
    await A.blobs.delete(dropHash) // local GC ran
    expect(await eA.gcBlobs()).toBe(0) // still inside the 30-day grace window
    w.advance(31 * DAY)
    expect(await eA.gcBlobs()).toBe(1)
    expect(blobKeys()).toHaveLength(1)

    // The remaining object vanishes (e.g. GC raced a re-reference): repair puts it back.
    await w.backend().delete(blobKeys()[0])
    expect(await eA.repair()).toEqual({ uploads: 1, downloads: 0 })
    await settle(eA)
    expect(blobKeys()).toHaveLength(1)
  })
})

describe('prune guard (§8.6)', () => {
  it('keeps synced pages whose song is missing; prunes never-synced ones and pages of dead songs', async () => {
    const G = openLibrary(`guard-${Date.now()}`)
    await addSong(G, 'alive', 'Alive', { files: [{ id: 'f', data: bytes(1, 10) }] })
    await G.annotations.bulkPut([
      page('early', 'f', [stroke('a')]), // arrived before its song (synced)
      page('local', 'f', [stroke('b')]), // never synced, song gone
      page('dead', 'f', [stroke('c')]), // song deleted (shadow a = false)
      page('alive', 'gone', [stroke('d')]), // synced page of a removed file
    ])
    await putState(G, 'config', { v: 1 } as never)
    const sh = (id: string, c: 'ann' | 'song', a?: [string, boolean]) => ({ id, c, f: {}, m: {}, l: {}, n: {}, ...(a ? { a } : {}) })
    await G.syncShadow.bulkPut([sh('early:f:0', 'ann'), sh('dead:f:0', 'ann'), sh('dead', 'song', ['0'.repeat(32), false]), sh('alive:gone:0', 'ann')])
    expect(await pruneAnnotations()).toBe(2)
    expect((await G.annotations.toCollection().primaryKeys()).sort()).toEqual(['alive:gone:0', 'early:f:0'])
  })
})
