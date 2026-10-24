// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, putBlob, setKV, sha256, uid, updateSong } from '../db/db'
import { emptySong, type PageAnnotations, type Setlist, type Song } from '../db/schema'
import { importPackageArchive, openArchive, restoreArchive, writeArchive } from './archive'
import { MemorySink } from './zip'

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

async function addSong(title: string, content: string, extra: Partial<Song> = {}): Promise<Song> {
  const { id: blobId, size } = await putBlob(bytes(content), 'application/pdf')
  const song = emptySong({ id: uid(), title, ...extra })
  song.files.push({ id: uid(), name: `${title}.pdf`, kind: 'pdf', blobId, pageCount: 1, size })
  await db.songs.put(song)
  return song
}

async function annotate(song: Song, text: string) {
  const a: PageAnnotations = {
    id: `${song.id}:${song.files[0].id}:0`,
    songId: song.id,
    fileId: song.files[0].id,
    page: 0,
    items: [{ id: uid(), type: 'text', at: { x: 0.1, y: 0.1 }, text, size: 0.03, layer: 'default', color: '#f00', opacity: 1, createdAt: 1 }],
  }
  await db.annotations.put(a)
}

async function archive(kind: 'backup' | 'package', extra: Partial<Parameters<typeof writeArchive>[1]> = {}) {
  const sink = new MemorySink()
  const manifest = await writeArchive(sink, { kind, settings: '{"state":{"s":{"theme":"dark"}}}', ...extra })
  return { blob: sink.blob(), manifest }
}

async function wipe() {
  await Promise.all([db.songs.clear(), db.setlists.clear(), db.annotations.clear(), db.blobs.clear(), db.kv.clear(), db.thumbs.clear()])
}

beforeEach(wipe)

describe('backup archive', () => {
  it('round-trips a whole library with replace', async () => {
    const a = await addSong('Autumn Leaves', '%PDF-autumn', { artists: ['Kosma'] })
    const b = await addSong('Blue Bossa', '%PDF-bossa')
    await annotate(a, 'rit.')
    const sl: Setlist = { id: uid(), name: 'Gig', notes: '', createdAt: 1, modifiedAt: 1, entries: [{ key: uid(), songId: b.id }, { key: uid(), songId: a.id }] }
    await db.setlists.put(sl)
    await setKV('layers', ['default'])
    await setKV('backup.lastAt', 123)

    const { blob, manifest } = await archive('backup')
    expect(manifest.counts).toMatchObject({ songs: 2, setlists: 1, annotations: 1, blobs: 2 })

    await wipe()
    await addSong('Will be replaced', '%PDF-other')
    await setKV('backup.lastAt', 999)

    let settingsRaw = ''
    const opened = await openArchive(blob, 'backup')
    const res = await restoreArchive(opened, { mode: 'replace', restoreSettings: true, applySettings: (r) => (settingsRaw = r) })
    expect(res).toMatchObject({ songsAdded: 2, setlists: 1, missingFiles: 0, settingsRestored: true })
    expect(settingsRaw).toContain('dark')

    const songs = await db.songs.orderBy('title').toArray()
    expect(songs.map((s) => s.title)).toEqual(['Autumn Leaves', 'Blue Bossa'])
    const data = await (await db.blobs.get(songs[0].files[0].blobId))!.data.text()
    expect(data).toBe('%PDF-autumn')
    expect(await db.blobs.count()).toBe(2) // the replaced song's blob was garbage-collected
    expect((await db.annotations.get(`${a.id}:${a.files[0].id}:0`))?.items[0]).toMatchObject({ text: 'rit.' })
    expect((await db.setlists.get(sl.id))?.entries.map((e) => e.songId)).toEqual([b.id, a.id])
    expect((await db.kv.get('layers'))?.value).toEqual(['default'])
    expect((await db.kv.get('backup.lastAt'))?.value).toBe(999) // device-local key untouched
  })

  it('merges keeping the newer song by default', async () => {
    const a = await addSong('Song A', '%PDF-a', { modifiedAt: 100 })
    const { blob } = await archive('backup')
    await db.songs.put({ ...a, notes: 'edited later', modifiedAt: 200 })
    const b = await addSong('Song B', '%PDF-b')
    const res = await restoreArchive(await openArchive(blob), { mode: 'merge', conflict: 'newer' })
    expect(res).toMatchObject({ songsAdded: 0, songsUpdated: 0, songsKept: 1 })
    expect((await db.songs.get(a.id))?.notes).toBe('edited later')
    expect(await db.songs.get(b.id)).toBeTruthy()
  })

  it('merges with keep-both, copying songs and their annotations', async () => {
    const a = await addSong('Song A', '%PDF-a', { modifiedAt: 100 })
    await annotate(a, 'from backup')
    const { blob } = await archive('backup')
    await db.songs.put({ ...a, notes: 'mine', modifiedAt: 200 })
    await annotate(a, 'mine')
    const res = await restoreArchive(await openArchive(blob), { mode: 'merge', conflict: 'keepBoth' })
    expect(res.songsAdded).toBe(1)
    const all = await db.songs.where('title').equals('Song A').toArray()
    expect(all).toHaveLength(2)
    const copy = all.find((s) => s.id !== a.id)!
    expect((await db.annotations.where('songId').equals(copy.id).first())?.items[0]).toMatchObject({ text: 'from backup' })
    expect((await db.annotations.where('songId').equals(a.id).first())?.items[0]).toMatchObject({ text: 'mine' })
    expect(await db.blobs.count()).toBe(1) // same file content shared
  })

  it('rejects other files and packages as backups', async () => {
    await expect(openArchive(new Blob(['nope']))).rejects.toThrow(/not an OpenStand/)
    await addSong('X', '%PDF-x')
    const { blob } = await archive('package')
    await expect(openArchive(blob, 'backup')).rejects.toThrow(/package/)
  })
})

describe('song packages', () => {
  it('exports selected songs and setlists, imports as copies or updates by title', async () => {
    const a = await addSong('Autumn Leaves', '%PDF-autumn', { artists: ['Kosma'], keys: ['Gm'] })
    const b = await addSong('Blue Bossa', '%PDF-bossa')
    await addSong('Not exported', '%PDF-no')
    await annotate(a, 'pkg note')
    const sl: Setlist = { id: uid(), name: 'Jazz', notes: '', createdAt: 1, modifiedAt: 1, entries: [{ key: uid(), songId: b.id }] }
    await db.setlists.put(sl)

    const { blob, manifest } = await archive('package', { songIds: [a.id], setlistIds: [sl.id], settings: null })
    expect(manifest.counts).toMatchObject({ songs: 2, setlists: 1, blobs: 2 })

    // Import as copies: everything gets new ids.
    const r1 = await importPackageArchive(await openArchive(blob), { onConflict: 'copy' })
    expect(r1).toMatchObject({ songs: 2, setlists: 1, updated: 0 })
    expect(await db.songs.where('title').equals('Autumn Leaves').count()).toBe(2)
    expect(await db.blobs.count()).toBe(3) // de-duplicated by id/hash

    // Import as update: matches by title, keeps local id.
    const original = new Set([a.id, b.id])
    await db.songs.filter((s) => s.title !== 'Not exported' && !original.has(s.id)).delete()
    await db.setlists.filter((s) => s.id !== sl.id).delete()
    await updateSong(a.id, { keys: ['Em'] })
    const r2 = await importPackageArchive(await openArchive(blob), { onConflict: 'update' })
    expect(r2.updated).toBe(2)
    expect((await db.songs.get(a.id))?.keys).toEqual(['Gm'])
    expect(await db.songs.where('title').equals('Autumn Leaves').count()).toBe(1)
    const imported = (await db.setlists.where('name').equals('Jazz').toArray()).find((s) => s.id !== sl.id)!
    expect(imported.entries[0].songId).toBe(b.id)
    expect((await db.annotations.where('songId').equals(a.id).first())?.items[0]).toMatchObject({ text: 'pkg note' })
  })
})

describe('archive blob hashes are recomputed, never trusted', () => {
  /** A song whose blob row lies about its hash (as a crafted archive would). */
  async function lyingSong(title: string, content: string, claimed: string, id: string) {
    await db.blobs.put({ id, hash: claimed, mime: 'application/pdf', size: content.length, data: new Blob([content]) })
    const song = emptySong({ id: uid(), title })
    song.files.push({ id: uid(), name: 'x.pdf', kind: 'pdf', blobId: id, pageCount: 1, size: content.length })
    await db.songs.put(song)
    return song
  }

  it('re-keys content under its real SHA-256, for legacy and hash-shaped ids', async () => {
    const claimed = 'ab'.repeat(32)
    const s1 = await lyingSong('Legacy id', '%PDF-one', claimed, 'legacy-uuid')
    const s2 = await lyingSong('Hash-shaped id', '%PDF-two', 'cd'.repeat(32), 'cd'.repeat(32))
    const { blob } = await archive('backup')
    await wipe()
    await restoreArchive(await openArchive(blob, 'backup'), { mode: 'replace' })
    for (const [s, content] of [[s1, '%PDF-one'], [s2, '%PDF-two']] as const) {
      const blobId = (await db.songs.get(s.id))!.files[0].blobId
      const real = await sha256(bytes(content))
      expect(blobId).toBe(real)
      expect(await db.blobs.get(real)).toMatchObject({ id: real, hash: real })
    }
    expect(await db.blobs.where('hash').anyOf(claimed, 'cd'.repeat(32)).count()).toBe(0)
  })

  it('does not de-duplicate against a local file by the claimed hash', async () => {
    const local = await addSong('Local', '%PDF-local')
    const localRow = (await db.blobs.get(local.files[0].blobId))!
    const s = await lyingSong('Impostor', '%PDF-impostor', localRow.hash, 'legacy-2')
    const { blob } = await archive('package', { songIds: [s.id], settings: null })
    await db.songs.delete(s.id)
    await db.blobs.delete('legacy-2')
    await importPackageArchive(await openArchive(blob), { onConflict: 'copy' })
    const copy = (await db.songs.where('title').equals('Impostor').first())!
    const row = (await db.blobs.get(copy.files[0].blobId))!
    expect(await row.data.text()).toBe('%PDF-impostor')
    expect(row.hash).toBe(await sha256(bytes('%PDF-impostor')))
    expect(await (await db.blobs.get(localRow.id))!.data.text()).toBe('%PDF-local')
  })
})
