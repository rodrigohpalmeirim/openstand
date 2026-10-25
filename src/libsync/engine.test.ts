// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { capture } from './apply'
import { MemoryBackend } from './backends/memory'
import { metaKey } from './paths'
import { addSong, bytes, converge, enableDevice, joinDevice, outgoing, page, setlist, settle, stroke, view, world } from './sync.test-helper'
import type { Setlist, Song } from '../db/schema'

// Byte compare (vitest's deep equality is far too slow on megabytes).
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const titles = async (db: import('../db/db').OpenStandDB) => (await db.songs.toArray()).map((s) => s.title).sort()

describe('library sync: two and three devices', () => {
  it('first device uploads an existing library; a second device joins into an empty library', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Autumn Leaves', { files: [{ id: 'f1', data: bytes(1, 3000) }], patch: { tags: ['jazz'], playCount: 4 } })
    await addSong(A, 's2', 'Blue Bossa', { files: [{ id: 'f2', data: bytes(2, 5000), legacy: true }] })
    await A.setlists.put(setlist('L1', 'Friday', ['s1', 's2']))
    await A.annotations.put(page('s1', 'f1', [stroke('a1'), stroke('a2', 'fingering')]))
    await A.kv.bulkPut([
      { key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'fingering', name: 'Fingering', visible: false }], current: 'fingering' } },
      { key: 'library:emptyCollections', value: ['Christmas'] },
      { key: 'backup.lastAt', value: 123 },
    ])
    const eA = await enableDevice(w, A)

    const objects = [...w.backend().objects().keys()]
    const lib = eA.core.keys.libraryId
    expect(objects).toContain(metaKey(lib))
    expect(objects.filter((k) => k.includes('/blobs/'))).toHaveLength(2)
    expect(objects.filter((k) => k.includes('/snap/'))).toHaveLength(1)
    expect(objects.some((k) => k.includes(`/heads/${eA.config.deviceId}/`))).toBe(true)
    expect(await outgoing(A)).toEqual({ dirty: 0, outbox: 0 })

    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const [va, vb] = [await view(A), await view(B)]
    expect(vb).toEqual(va)
    // Local-only kv stays local; the current layer is per device but falls back sensibly.
    expect(await B.kv.get('backup.lastAt')).toBeUndefined()
    expect(((await B.kv.get('layers:s1'))!.value as { current: string }).current).toBe('default')
    // Files arrived with their content.
    const blob = (await B.blobs.toArray()).find((b) => b.size === 5000)!
    expect(new Uint8Array(await blob.data.arrayBuffer())).toEqual(bytes(2, 5000))
    // The legacy uuid blob id became the content hash on the new device.
    expect((await B.songs.get('s2'))!.files[0].blobId).toBe(blob.hash)
    // Nothing to send back: applying never recaptures.
    expect(await outgoing(B)).toEqual({ dirty: 0, outbox: 0 })
    expect((await capture(eB.core)).ops).toBe(0)
  })

  it('concurrent offline edits converge (songs, annotations, setlists, layers) without recapture loops', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Song', { files: [{ id: 'f1', data: bytes(3, 100) }], patch: { tags: ['a'] } })
    await A.annotations.put(page('s1', 'f1', [stroke('x'), stroke('y')]))
    await A.setlists.put(setlist('L', 'Set', ['s1']))
    await A.kv.put({ key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: true }], current: 'default' } })
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)

    // Offline on both:
    await A.table('songs').update('s1', { title: 'Song (live)', tags: ['a', 'fromA'] })
    await B.table('songs').update('s1', { rating: 5, tags: ['fromB'] }) // removes 'a', adds 'fromB'
    await A.annotations.put(page('s1', 'f1', [stroke('x'), stroke('y'), stroke('newA')]))
    await B.annotations.put(page('s1', 'f1', [stroke('x')])) // erases y
    await A.setlists.put({ ...(await A.setlists.get('L'))!, entries: [...(await A.setlists.get('L'))!.entries, { key: 'kA', songId: 's1' }] })
    const lb = (await B.setlists.get('L'))!
    await B.setlists.put({ ...lb, entries: [{ key: 'kB', songId: 's1' }, ...lb.entries] })
    await A.kv.put({ key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: true }, { id: 'la', name: 'A', visible: true }], current: 'la' } })
    await B.kv.put({ key: 'layers:s1', value: { layers: [{ id: 'default', name: 'Default', visible: false }, { id: 'lb', name: 'B', visible: true }], current: 'lb' } })
    w.advance(10)

    await converge(eA, eB)
    const [va, vb] = [await view(A), await view(B)]
    expect(vb).toEqual(va)
    const s = (await A.songs.get('s1'))!
    expect([s.title, s.rating]).toEqual(['Song (live)', 5])
    expect([...s.tags].sort()).toEqual(['fromA', 'fromB'])
    expect((await A.annotations.get('s1:f1:0'))!.items.map((i) => i.id)).toEqual(['x', 'newA'])
    expect((await A.setlists.get('L'))!.entries.map((e) => e.key).sort()).toEqual(['L-k0', 'kA', 'kB'])
    const layers = (await A.kv.get('layers:s1'))!.value as { layers: { id: string; visible: boolean }[]; current: string }
    expect(layers.layers.map((l) => l.id).sort()).toEqual(['default', 'la', 'lb'])
    expect(layers.current).toBe('la') // current stays per device
    expect(((await B.kv.get('layers:s1'))!.value as { current: string }).current).toBe('lb')
    // Quiescent: another round sends and applies nothing.
    expect(await outgoing(A)).toEqual({ dirty: 0, outbox: 0 })
    expect(await outgoing(B)).toEqual({ dirty: 0, outbox: 0 })
    expect((await eA.sync()).ops + (await eB.sync()).ops).toBe(0)
  })

  it('a reorder wins over an older order and keeps concurrent appends', async () => {
    const w = world()
    const A = w.db('A')
    for (const id of ['s1', 's2', 's3']) await addSong(A, id, id)
    await A.setlists.put(setlist('L', 'Set', ['s1', 's2', 's3']))
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const la = (await A.setlists.get('L'))!
    await A.setlists.put({ ...la, entries: [...la.entries].reverse() }) // reorder
    const lb = (await B.setlists.get('L'))!
    await B.setlists.put({ ...lb, entries: [...lb.entries, { key: 'new', songId: 's1' }] }) // append
    await converge(eA, eB)
    const keys = (s: Setlist) => s.entries.map((e) => e.key)
    expect(keys((await A.setlists.get('L'))!)).toEqual(['L-k2', 'L-k1', 'L-k0', 'new'])
    expect(keys((await B.setlists.get('L'))!)).toEqual(keys((await A.setlists.get('L'))!))
  })

  it('deletes propagate; a delete wins over a concurrent edit; undelete by putting the row back', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Keep')
    await addSong(A, 's2', 'Gone', { files: [{ id: 'f2', data: bytes(9, 50) }] })
    await A.annotations.put(page('s2', 'f2', [stroke('z')]))
    await A.setlists.put(setlist('L', 'Set', ['s1']))
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)

    await A.songs.delete('s2')
    await A.annotations.where('songId').equals('s2').delete()
    await B.table('songs').update('s2', { title: 'Edited meanwhile' })
    await A.setlists.delete('L')
    await converge(eA, eB)
    expect(await titles(B)).toEqual(['Keep'])
    expect(await B.annotations.count()).toBe(0)
    expect(await B.setlists.count()).toBe(0)
    expect(await view(A)).toEqual(await view(B))

    // Undo of a setlist delete puts the same row back: it comes back everywhere.
    await A.setlists.put(setlist('L', 'Set', ['s1']))
    await converge(eA, eB)
    expect((await B.setlists.get('L'))?.name).toBe('Set')
  })

  it('a delete that discards newer local edits is reported (lostEdits), an ordinary one is not', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Edited offline')
    await addSong(A, 's2', 'Edited long ago')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    await B.table('songs').update('s2', { title: 'Edited long ago on B' })
    await converge(eA, eB)
    w.advance(1000)
    await A.songs.bulkDelete(['s1', 's2'])
    await eA.sync()
    w.advance(60_000)
    await B.table('songs').update('s1', { title: 'Edited offline on B' })
    const applied = await eB.sync()
    expect([...applied.lostEdits]).toEqual([['s1', 'Edited offline on B']])
    expect(await B.songs.count()).toBe(0)
    expect((await eA.sync()).lostEdits.size).toBe(0)
  })

  it('play counts from offline devices add up', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'Played', { patch: { playCount: 3 } })
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const play = (db: typeof A, at: number) =>
      db.songs
        .where('id')
        .equals('s1')
        .modify((s: Song) => {
          s.playCount++
          s.lastPlayedAt = at
        })
    await play(A, 10)
    await play(A, 20)
    await play(B, 30)
    await play(B, 40)
    await play(B, 50)
    await converge(eA, eB)
    for (const d of [A, B]) {
      const s = (await d.songs.get('s1'))!
      expect([s.playCount, s.lastPlayedAt]).toEqual([8, 50])
    }
  })

  it('three devices converge on concurrent edits', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One', { patch: { tags: [] } })
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const C = w.db('C')
    const eB = await joinDevice(w, B, A)
    const eC = await joinDevice(w, C, A)
    await A.table('songs').update('s1', { notes: 'from A', tags: ['a'] })
    await B.table('songs').update('s1', { keywords: 'from B', tags: ['b'] })
    await C.table('songs').update('s1', { notes: 'from C (later)', tags: ['c'] })
    await addSong(C, 's2', 'Two from C')
    await B.annotations.put(page('s1', 'none', [stroke('orphan')])) // a page whose file doesn't exist: never published
    await converge(eA, eB, eC)
    const v = await view(A)
    expect({ ...(await view(B)), annotations: [] }).toEqual(v) // B's orphan page stays local (deferred)
    expect(await view(C)).toEqual(v)
    const s = (await A.songs.get('s1'))!
    expect([s.notes, s.keywords, [...s.tags].sort()]).toEqual(['from C (later)', 'from B', ['a', 'b', 'c']])
    expect(await titles(B)).toEqual(['One', 'Two from C'])
    expect(await A.annotations.count()).toBe(0)
    expect((await B.syncDirty.toArray()).map((d) => [d.id, !!d.deferredSince])).toEqual([['ann/s1:none:0', true]])
  })

  it('backup replace-restore (clear + bulkPut) nets out to real field changes only', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    await addSong(A, 's2', 'Two')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const rows = await A.songs.toArray()
    await A.transaction('rw', A.songs, async () => {
      await A.songs.clear()
      await A.songs.bulkPut(rows.map((s) => (s.id === 's2' ? { ...s, title: 'Two (restored)' } : s)))
    })
    const stats = await capture(eA.core)
    expect(stats.ops).toBe(1)
    const batch = (await A.syncOutbox.toArray())[0]
    expect(JSON.parse(new TextDecoder().decode(batch.bytes)).ops).toEqual([expect.objectContaining({ c: 'song', id: 's2', f: { title: [expect.any(String), 'Two (restored)'] } })])
    await converge(eA, eB)
    expect(await titles(B)).toEqual(['One', 'Two (restored)'])
  })
})

describe('blobs', () => {
  it('a blob that arrives after its song: waiting → downloading → local', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's0', 'Seed')
    let aOnline = true
    const env = { visible: () => true, online: () => aOnline, performing: () => false, idle: () => true }
    const eA = await enableDevice(w, A, { env })
    aOnline = false // A's transfers are held back: its metadata goes out, its file doesn't
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const { blobStateOf } = await import('./api')

    const big = bytes(7, 2.5 * 1024 * 1024)
    await addSong(A, 's1', 'With file', { files: [{ id: 'f1', data: big }] })
    // A publishes the song but hasn't uploaded the file yet.
    await eA.sync()
    await eB.sync()
    const hash = (await B.songs.get('s1'))!.files[0].blobId
    expect(['queued', 'downloading', 'waiting']).toContain((await blobStateOf(B, hash)).state)
    await settle(eB)
    expect(await blobStateOf(B, hash)).toEqual({ state: 'waiting' })

    // A uploads; its next batch announces the blob and wakes B's download.
    aOnline = true
    await settle(eA)
    await eA.sync()
    const states: string[] = []
    const stop = setInterval(() => void blobStateOf(B, hash).then((s) => states.push(s.state)), 1)
    await eB.sync()
    await settle(eB)
    clearInterval(stop)
    expect(await blobStateOf(B, hash)).toEqual({ state: 'local' })
    const got = await (await B.blobs.get(hash))!.data.arrayBuffer()
    expect(same(new Uint8Array(got), big)).toBe(true)
    expect(states).not.toContain('missing')
  })

  it('uploads and downloads resume after failures', async () => {
    const w = world({ backendOptions: { caps: { maxSmallPut: 64 * 1024 }, partSize: (1 << 20) + 28, partHead: 16 } })
    const A = w.db('A')
    const backendA = w.backend()
    const data = bytes(11, 6 * 1024 * 1024 + 5) // 7 chunks
    await addSong(A, 's1', 'Big', { files: [{ id: 'f1', data }] })
    // The 3rd part fails: the upload keeps its session and resumes with the missing parts only.
    let parts = 0
    backendA.hook = (op) => {
      if (op === 'uploadPart' && ++parts === 3) throw new Error('connection reset')
    }
    const { enable } = await import('./join')
    const eA = await enable(A, { ...w.opts({ backend: backendA }), backendConfig: w.cfg, relay: null, name: 'L' })
    await eA.sync()
    await settle(eA)
    const row = (await A.syncTransfers.toArray())[0]
    expect(row.state).toBe('queued')
    expect(row.upload?.done).toBeGreaterThan(0)
    backendA.hook = undefined
    await A.syncTransfers.update(['up', row.hash], { nextAt: 0 })
    const before = backendA.calls.filter((c) => c.op === 'uploadPart').length
    await settle(eA)
    expect(await A.syncTransfers.count()).toBe(0)
    expect(backendA.calls.filter((c) => c.op === 'uploadPart').length - before).toBe(7 - 2) // 7 parts (part 1 carries the header), 2 kept
    await eA.sync()

    // Download: the second range GET fails; the retry continues after the stored chunks.
    const B = w.db('B')
    const backendB = w.backend()
    let gets = 0
    backendB.hook = (op, key) => {
      if (op === 'get' && key.includes('/blobs/') && ++gets === 2) throw new Error('flaky')
    }
    const { join } = await import('./join')
    const { pairing } = await import('./sync.test-helper')
    const eB = await join(B, await pairing(A), 'here', w.opts({ backend: backendB }))
    await settle(eB)
    const t = (await B.syncTransfers.toArray())[0]
    expect(t.doneChunks).toBe(4)
    expect(await B.syncChunks.count()).toBe(4)
    backendB.hook = undefined
    await B.syncTransfers.update(['down', t.hash], { nextAt: 0 })
    const blobGets = () => backendB.calls.filter((c) => c.op === 'get' && c.key.includes('/blobs/')).length
    const g0 = blobGets()
    await settle(eB)
    expect(blobGets() - g0).toBe(2) // header + the remaining chunks, not chunks 0-3 again
    expect(await B.syncChunks.count()).toBe(0)
    expect(same(new Uint8Array(await (await B.blobs.get(t.hash))!.data.arrayBuffer()), data)).toBe(true)
  })

  it('lists both devices after pairing, without waiting for idle maintenance', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    const { getState } = await import('./state')
    const ids = async (d: typeof A) => ((await getState(d, 'devices')) ?? []).map((x) => x.id).sort()
    const both = [eA.config.deviceId, eB.config.deviceId].sort()
    // The joining device lists itself before it has published anything.
    await eB.sync()
    expect(await ids(B)).toEqual(both)
    await B.table('songs').update('s1', { title: 'One (B)' })
    await converge(eA, eB)
    expect(await ids(A)).toEqual(both)
    expect(await ids(B)).toEqual(both)
  })
})

describe('device record', () => {
  it('a default name that changed (better device detection) is rewritten when the engine starts', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A, { deviceName: () => 'Linux PC' })
    expect(eA.status.devices.find((d) => d.self)?.name).toBe('Linux PC')
    eA.stop()
    const { Engine } = await import('./engine')
    const again = await Engine.open(A, w.opts({ deviceName: () => 'Android tablet' }))
    await again.start()
    for (let i = 0; i < 50 && again.status.devices.find((d) => d.self)?.name !== 'Android tablet'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(again.status.devices.find((d) => d.self)?.name).toBe('Android tablet')
    again.stop()
  })

  it('another device’s “last seen” follows its pushes; list refreshes are throttled unless explicit', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    let lists = 0
    const backendA = new MemoryBackend(w.bucket, { ...w.backendOptions, hook: (op, key) => void (op === 'list' && key.includes('/devices/') && lists++) })
    const eA = await enableDevice(w, A, { backend: backendA })
    const B = w.db('B')
    const eB = await joinDevice(w, B, A)
    await eA.refreshDevices()
    const joined = eA.status.devices.find((d) => !d.self)!.lastSeenAt
    w.advance(3 * 60 * 60_000)
    await B.table('songs').update('s1', { title: 'From B' })
    await eB.sync()
    await eA.sync()
    expect(eA.status.devices.find((d) => !d.self)!.lastSeenAt).toBe(joined + 3 * 60 * 60_000)

    lists = 0
    await eA.refreshDevicesIfStale()
    await eA.refreshDevicesIfStale()
    expect(lists).toBe(1)
    await eA.refreshDevicesIfStale(0) // "Sync now"
    expect(lists).toBe(2)
    w.advance(61_000)
    await eA.refreshDevicesIfStale()
    expect(lists).toBe(3)
  })

  it('a rate-limited sync stays “syncing” while its retry is pending, also after a status refresh', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const backend = w.backend()
    const eA = await enableDevice(w, A, { backend })
    const { BackendError } = await import('./backends/types')
    backend.fail({ times: Infinity, error: () => new BackendError('rateLimited', 'slow down', { retryAfterMs: 60_000 }) })
    await expect(eA.sync()).rejects.toBeTruthy()
    await eA.refreshStatus()
    expect(eA.status.phase).toBe('syncing')
    w.advance(61_000)
    await eA.refreshStatus()
    expect(eA.status.phase).toBe('idle')
  })

  it('rewriting a dirty mark (count unchanged) doesn’t refresh the whole status', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A)
    eA.setPaused(true) // no capture: the dirty mark stays
    await eA.start()
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await A.table('songs').update('s1', { title: 'Typing 1' })
    await sleep(400)
    let refreshes = 0
    const orig = eA.refreshStatus.bind(eA)
    eA.refreshStatus = async () => void (refreshes++, await orig())
    for (let i = 2; i <= 4; i++) {
      await A.table('songs').update('s1', { title: `Typing ${i}` })
      await sleep(300)
    }
    expect(await A.syncDirty.count()).toBe(1)
    expect(refreshes).toBe(0)
    eA.stop()
  })

  it('changes made while the storage is unreachable are counted as waiting to upload', async () => {
    const w = world()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const backend = w.backend()
    const eA = await enableDevice(w, A, { backend })
    expect(eA.status.pendingChanges).toBe(0)
    const heal = backend.fail({ times: Infinity })
    await A.table('songs').update('s1', { title: 'Offline edit' })
    await expect(eA.sync()).rejects.toMatchObject({ code: 'network' })
    for (let i = 0; i < 25 && eA.status.pendingChanges === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(eA.status).toMatchObject({ phase: 'offline', pendingChanges: 1 })
    heal()
    await eA.sync()
    expect(eA.status.pendingChanges).toBe(0)
  })
})
