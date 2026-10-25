// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { isCaptureOn } from '../db/capture'
import { openLibrary, pruneAnnotations } from '../db/db'
import type { SongLayers } from '../db/schema'
import { SyncError } from './engine'
import { deleteRemote, join, leave, retireBeforeDelete } from './join'
import { decodeDevice } from './codec'
import { deviceKey, headsPrefix, libraryPrefix, logKey, logPrefix } from './paths'
import { uniqueDeviceName } from '../sync/deviceName'
import { getConfig, getState, putState } from './state'
import { addSong, bytes, converge, enableDevice, joinDevice, outgoing, page, pairing, setlist, settle, stroke, view, world } from './sync.test-helper'

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
    expect(await previewJoin(B, await pairing(A), w.opts())).toEqual({ remoteSongs: 2, remoteBytes: 400, localSongs: 3, demoSongs: 0, matches: 1, suggested: 'newLibrary' })

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
    const { previewJoin } = await import('./join')
    const { pairing } = await import('./sync.test-helper')
    expect(await previewJoin(B, await pairing(A), w.opts({ isUntouchedDemo: async (s) => s.id === 'demo' }))).toMatchObject({ localSongs: 0, demoSongs: 1, suggested: 'here' })
    const eB = await joinDevice(w, B, A, 'here', { isUntouchedDemo: async (s) => s.id === 'demo' })
    await converge(eA, eB)
    expect((await A.songs.toArray()).map((s) => s.id)).toEqual(['s1'])
    expect((await B.songs.toArray()).map((s) => s.id)).toEqual(['s1'])
  })

  it('rejoining after the library was deleted and set up again merges local edits to records with the same ids', async () => {
    // QA: A deletes the synced data and sets sync up again (same song ids); C, which edited meanwhile, joins
    // the new library in merge mode. The re-uploaded versions used to overwrite C's edits.
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Speed the Plough', { files: [{ id: 'f1', data: bytes(1, 300) }], patch: { tags: ['folk'], playCount: 3, notes: '' } })
    await A.annotations.put(page('s1', 'f1', [stroke('a1')]))
    await A.kv.put({ key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: true }], current: 'default' } })
    await A.setlists.put(setlist('SL', 'Gig', ['s1']))
    const eA = await enableDevice(w, A)
    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    await converge(eA, eC)

    await deleteRemote(A, eA, w.opts())
    await expect(eC.sync()).rejects.toMatchObject({ code: 'libraryGone' })
    // C's edits after the library went away: a tag, a note, a stroke, a layer, a setlist entry, a play.
    await addSong(C, 'c2', 'Only on C')
    await C.table('songs').update('s1', { tags: ['folk', 'gone-two'], notes: 'from C', playCount: 4 })
    await C.annotations.put(page('s1', 'f1', [stroke('a1'), stroke('c1', 'fing')]))
    await C.kv.put({
      key: 'layers:s1',
      value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'fing', name: 'Fingering', visible: true }], current: 'fing' },
    })
    await C.setlists.put({ ...setlist('SL', 'Gig', ['s1', 'c2']), modifiedAt: 2000 })
    await leave(C, eC, w.opts())
    expect((await getState(C, 'unsynced'))?.ops.length).toBeGreaterThan(0)
    // After leaving nothing is captured: a set member only C has is merged by value; a field C had kept
    // unsynced and changed again is replayed with its latest value.
    await C.table('songs').update('s1', { tags: ['folk', 'gone-two', 'after-leave'], notes: 'later on C' })

    w.advance(60_000)
    const eA2 = await enableDevice(w, A)
    // A first attempt fails in its bootstrap; the rejoin flow leaves again before retrying, and the kept
    // edits survive that.
    const failing = w.backend()
    failing.fail({ op: 'get', key: /\/snap\//, times: Infinity })
    await expect(join(C, await pairing(A), 'merge', w.opts({ backend: failing }))).rejects.toBeTruthy()
    await leave(C, undefined, w.opts({ backend: failing }))
    expect(await getState(C, 'unsynced')).toMatchObject({ resolved: true, libraryId: eC.config.libraryId })
    const eC2 = await joinDevice(w, C, A, 'merge')
    await converge(eA2, eC2)
    for (const d of [A, C]) {
      const s1 = (await d.songs.get('s1'))!
      expect([[...s1.tags].sort(), s1.notes, s1.playCount]).toEqual([['after-leave', 'folk', 'gone-two'], 'later on C', 4])
      expect(ids((await d.annotations.get('s1:f1:0'))?.items).sort()).toEqual(['a1', 'c1'])
      expect(((await d.kv.get('layers:s1'))!.value as SongLayers).layers.map((l) => l.name).sort()).toEqual(['Default', 'Fingering'])
      expect((await d.setlists.get('SL'))!.entries.map((e) => e.songId)).toEqual(['s1', 'c2'])
    }
    expect(await view(C)).toEqual(await view(A))
    expect(await getState(C, 'unsynced')).toBeUndefined()
  })

  describe('rejoining the same library replays kept edits with their own timestamps', () => {
    async function scenario(away: number) {
      const w = world()
      const A = w.db('A')
      await addSong(A, 's1', 'Title')
      const eA = await enableDevice(w, A)
      const C = w.db('C')
      const cb = w.backend()
      const eC = await joinDevice(w, C, A, 'here', { backend: cb })
      // C can't push: its edits stay in the outbox and leaving keeps them.
      const heal = cb.fail({ op: 'put', times: Infinity })
      await C.table('songs').update('s1', { title: 'Older title on C', notes: 'Only C set this' })
      await expect(eC.sync()).rejects.toMatchObject({ code: 'network' })
      w.advance(60_000)
      await A.table('songs').update('s1', { title: 'Newer title on A' })
      await eA.sync()
      await leave(C, eC, w.opts({ backend: cb }))
      expect((await getState(C, 'unsynced'))?.libraryId).toBe(eA.config.libraryId)
      heal()
      w.advance(away)
      const eC2 = await joinDevice(w, C, A, 'merge')
      await converge(eA, eC2)
      return { A, C }
    }

    it('a newer edit from another device wins; a field only this device changed is kept', async () => {
      const { A, C } = await scenario(1000)
      for (const d of [A, C]) expect((await d.songs.get('s1'))).toMatchObject({ title: 'Newer title on A', notes: 'Only C set this' })
    })

    it('edits kept longer than 30 days are dropped', async () => {
      const { A, C } = await scenario(31 * DAY)
      for (const d of [A, C]) expect((await d.songs.get('s1'))).toMatchObject({ title: 'Newer title on A', notes: '' })
      expect(await getState(C, 'unsynced')).toBeUndefined()
    })
  })

  it('a row whose remote creation arrives after an edit is left alone until then, then merged', async () => {
    // No snapshot yet: a device's edit can arrive before the creation from another device's log.
    const { Engine } = await import('./engine')
    const { applyOps } = await import('./apply')
    const { captureRecord } = await import('./merge')
    const { formatHlc } = await import('./hlc')
    const w = world()
    const A = w.db('A')
    const eA = await enableDevice(w, A)
    const C = w.db('C')
    await addSong(C, 's1', 'Local title', { patch: { tags: ['local'], playCount: 3 } })
    const eC = await Engine.fromConfig(C, { ...eA.config, deviceId: 'cccccccccccccccc' }, w.opts())
    const dev = 'aaaaaaaaaaaaaaaa'
    const remote = (await import('../db/schema')).emptySong({ id: 's1', title: 'Remote title', tags: ['remote'], playCount: 3, createdAt: 1000, modifiedAt: 1000 })
    const created = captureRecord('song', remote, undefined, formatHlc(w.now(), 0, dev), dev)
    const edited = captureRecord('song', { ...remote, title: 'Remote edit' }, created.shadow, formatHlc(w.now() + 1, 0, dev), dev)
    await applyOps(eC.core, [edited.delta!])
    expect(await C.songs.get('s1')).toMatchObject({ title: 'Local title', tags: ['local'], playCount: 3 })
    await applyOps(eC.core, [created.delta!])
    const s1 = (await C.songs.get('s1'))!
    expect([s1.title, [...s1.tags].sort(), s1.playCount]).toEqual(['Remote edit', ['local', 'remote'], 3])
    expect(await C.syncDirty.get('song/s1')).toBeTruthy()
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
    const lib = eA.core.keys.libraryId
    const myHeads = () => [...w.backend().objects().keys()].filter((k) => k.startsWith(headsPrefix(lib, me)))
    const headsBefore = myHeads()
    await leave(B, eB, w.opts())
    expect(await getConfig(B)).toBeUndefined()
    expect(isCaptureOn(B.name)).toBe(false)
    expect(await B.songs.count()).toBe(1)
    // Its stream stays readable for devices that join later (pruned once a snapshot covers it).
    expect(myHeads()).toEqual(headsBefore)
    const devices = await eA.refreshDevices()
    expect(devices.find((d) => d.id === me)?.retired).toBe(true)
    expect(w.backend().objects().has(deviceKey(lib, me))).toBe(true)
    // Local edits after leaving are not captured.
    await B.table('songs').update('s1', { title: 'local only' })
    expect(await B.syncDirty.count()).toBe(0)
  })

  it('a device that joins after another left still gets the leaver’s published changes', async () => {
    // Found in the two-device browser e2e: B deleted a song, A applied it, B left; a device joining later
    // bootstrapped from A's older snapshot and never saw B's stream, so the deleted song came back there only.
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Keep')
    await addSong(A, 's2', 'Deleted on B')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    await B.songs.delete('s2')
    await converge(eA, eB)
    expect((await A.songs.toArray()).map((s) => s.id)).toEqual(['s1'])
    await leave(B, eB, w.opts())
    const C = w.db('C')
    const eC = await joinDevice(w, C, A)
    await converge(eA, eC)
    expect((await C.songs.toArray()).map((s) => s.id)).toEqual(['s1'])
    expect(await view(C)).toEqual(await view(A))
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
    // Stopping sync on B afterwards (the banner's action) writes nothing back into the deleted library.
    await leave(B, eB, w.opts())
    expect([...w.backend().objects().keys()]).toEqual([])
  })
})

describe('no orphans after another device resets or deletes the library', () => {
  it('a device that hasn’t noticed yet writes nothing into the old prefix (device record, logs, blobs)', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'x', { files: [{ id: 'f', data: bytes(1, 10) }] })
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    await eB.sync()
    const old = libraryPrefix(eB.core.keys.libraryId)
    const inOld = () => [...w.backend().objects().keys()].filter((k) => k.startsWith(old))

    // A resets: the old library is deleted and a new one (new secret, new prefix) uploaded.
    await deleteRemote(A, eA, w.opts())
    const eA2 = await enableDevice(w, A)
    expect(eA2.core.keys.libraryId).not.toBe(eB.core.keys.libraryId)
    expect(inOld()).toEqual([])
    w.advance(60_000)

    // The periodic device-record write (maintenance, due daily).
    w.advance(DAY + 1)
    await expect(eB.maintenance()).rejects.toMatchObject({ code: 'libraryGone' })
    expect(inOld()).toEqual([])
    expect(eB.status).toMatchObject({ phase: 'error', error: { code: 'libraryGone' } })

    // A local edit pushed before any pull noticed (push alone, no fresh pull).
    await B.table('songs').update('s1', { title: 'edited on B' })
    await eB.captureNow()
    await expect(eB.push()).rejects.toMatchObject({ code: 'libraryGone' })
    expect(inOld()).toEqual([])

    // A new file's upload.
    await addSong(B, 's2', 'new on B', { files: [{ id: 'g', data: bytes(2, 50) }] })
    await eB.captureNow()
    await settle(eB)
    expect(await B.syncTransfers.count()).toBe(1) // still queued, not uploaded
    expect(inOld()).toEqual([])

    // The local library is untouched, and leaving afterwards writes nothing either.
    expect((await B.songs.toArray()).map((s) => s.title).sort()).toEqual(['edited on B', 'new on B'])
    await leave(B, eB, w.opts())
    expect(inOld()).toEqual([])
  })

  it('the engine checks the library once per write cycle, not once per object', async () => {
    const w = world()
    const A = w.db('A')
    const eA = await enableDevice(w, A)
    const backend = eA.core.backend
    let heads = 0
    const head = backend.head.bind(backend)
    backend.head = (key, o) => {
      if (key.endsWith('/meta')) heads++
      return head(key, o)
    }
    for (let i = 0; i < 5; i++) await addSong(A, `n${i}`, `New ${i}`)
    // One sync = capture, push, pull, capture, push: one HEAD on meta.
    await eA.sync()
    expect(heads).toBe(1)
    expect(await A.syncOutbox.count()).toBe(0)
    // Nothing to push: no HEAD at all.
    heads = 0
    await eA.sync()
    expect(heads).toBe(0)
  })
})

describe('device names', () => {
  it('two iPads get distinct default names; a rename overwrites the record and shows in warnings', async () => {
    const w = world()
    const own: Record<string, string> = {}
    // Like the service: the user's own name, else the default made unique against earlier devices.
    const named = (who: string) => ({ deviceName: ({ taken }: { taken: string[] }) => own[who] || uniqueDeviceName('iPad', taken) })
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A, named('A'))
    w.advance(1000)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A, 'here', named('B'))
    await eA.refreshDevices()
    const names = (e: typeof eA) => Object.fromEntries(e.status.devices.map((d) => [d.self ? 'self' : 'other', d.name]))
    expect(names(eA)).toEqual({ self: 'iPad', other: 'iPad 2' })

    // Daily rewrites keep the names (only devices that joined earlier count).
    await eA.putDevice()
    await eB.putDevice()
    await eA.refreshDevices()
    expect(names(eA)).toEqual({ self: 'iPad', other: 'iPad 2' })

    // B renames itself: its record is overwritten at once.
    own.B = 'Stage iPad'
    await eB.rename()
    const rec = await decodeDevice(eB.core.keys, (await w.backend().get(deviceKey(eB.core.keys.libraryId, eB.config.deviceId)))!, eB.config.deviceId)
    expect(rec.name).toBe('Stage iPad')
    await eA.refreshDevices()
    expect(names(eA).other).toBe('Stage iPad')

    // An unreadable entry from B names it by its new name.
    await addSong(B, 's2', 'Two')
    await eB.sync()
    const seq = (await getState(B, 'cursors'))![eB.config.deviceId]
    await w.backend().put(logKey(eB.core.keys.libraryId, eB.config.deviceId, seq), bytes(9, 200))
    await eA.sync()
    expect(eA.status.streams?.[eB.config.deviceId]?.message).toBe('Changes from “Stage iPad” can’t be read right now. Other devices keep syncing.')

    // Deleting the library on B retires its record under its own name, not the default one.
    eB.stop()
    await retireBeforeDelete(B, w.opts(named('B')))
    await eA.refreshDevices()
    expect(eA.status.devices.find((d) => !d.self)).toMatchObject({ name: 'Stage iPad', retired: true })
  })
})

describe('blob GC and repair', () => {
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

describe('prune guard', () => {
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
