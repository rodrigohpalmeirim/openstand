// @vitest-environment node
import 'fake-indexeddb/auto'
import { PDFDocument } from 'pdf-lib'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, putBlob } from '../../db/db'
import { emptySong, type FileKind, type PageAnnotations, type Song, type SongFile } from '../../db/schema'
import { resolvePageRefs } from '../../files/pageRefs'
import { jpegOrientation } from '../../files/imagePage'
import { applyCombine, combinedName, combineFiles, mergeToPdf, planCombine, remapAnnotations } from './combine'

const f = (id: string, pageCount: number, kind: FileKind = 'pdf'): SongFile => ({ id, name: `${id}.${kind}`, kind, blobId: 'b' + id, pageCount, size: 1 })
const merged = (pageCount: number): SongFile => ({ id: 'M', name: 'M.pdf', kind: 'pdf', blobId: 'bM', pageCount, size: 1 })
const refs = (s: Song) => resolvePageRefs(s).map((r) => `${r.fileId}${r.page}`)

function song(): Song {
  const s = emptySong({ id: 's', title: 'Tune', files: [f('a', 2), f('b', 3), f('t', 1, 'chordpro'), f('i', 1, 'image')] })
  s.pageSettings = { 'a:1': { rotation: 90 }, 'b:2': { crop: { top: 0.1, bottom: 0, left: 0, right: 0.2 } }, 'i:0': { rotation: 180 }, 't:0': { rotation: 90 } }
  s.bookmarks = [{ id: 'bm', name: 'Coda', pageIndex: 4 }]
  s.links = [{ id: 'l', from: { pageIndex: 6, x: 0.5, y: 0.5 }, to: { pageIndex: 1, x: 0.1, y: 0.1 } }]
  s.smartButtons = [{ id: 'sb', label: 'Go', pageIndex: 3, x: 0.5, y: 0.5, kind: 'page', page: 6 }]
  return s
}

describe('planCombine', () => {
  it('needs two or more PDF/image files', () => {
    expect(() => planCombine(song(), ['a'])).toThrow(/at least two/)
    expect(() => planCombine(song(), ['a', 't'])).toThrow(/text file/)
  })
  it('orders the selection like the song and computes offsets', () => {
    const p = planCombine(song(), ['i', 'a', 'b'])
    expect(p.files.map((x) => x.id)).toEqual(['a', 'b', 'i'])
    expect([...p.offsets]).toEqual([['a', 0], ['b', 2], ['i', 5]])
    expect(p.pageCount).toBe(6)
    expect(combinedName(song(), p.files)).toBe('Tune.pdf')
    expect(combinedName({ ...song(), title: ' ' }, p.files)).toBe('a.pdf')
  })
})

describe('applyCombine', () => {
  it('keeps the default order when the merged files were adjacent', () => {
    const s = song()
    const plan = planCombine(s, ['a', 'b'])
    const n = applyCombine(s, plan, merged(5))
    expect(n.files.map((x) => x.id)).toEqual(['M', 't', 'i'])
    expect(n.pageOrder).toBeUndefined()
    expect(refs(n)).toEqual(['M0', 'M1', 'M2', 'M3', 'M4', 't0', 'i0'])
    expect(n.pageSettings).toEqual({ 'M:1': { rotation: 90 }, 'M:4': s.pageSettings['b:2'], 'i:0': { rotation: 180 }, 't:0': { rotation: 90 } })
  })

  it('keeps the shown sequence (and so bookmarks, links, smart buttons) when files around another are merged', () => {
    const s = song()
    const before = resolvePageRefs(s)
    const n = applyCombine(s, planCombine(s, ['a', 'b', 'i']), merged(6))
    expect(n.files.map((x) => x.id)).toEqual(['M', 't'])
    // a0 a1 b0 b1 b2 t0 i0 -> the text file stays between the merged pages.
    expect(refs(n)).toEqual(['M0', 'M1', 'M2', 'M3', 'M4', 't0', 'M5'])
    expect(resolvePageRefs(n)).toHaveLength(before.length)
    expect(n.pageSettings['M:5']).toEqual({ rotation: 180 })
    expect(n.bookmarks).toEqual(s.bookmarks)
    expect(n.links).toEqual(s.links)
    expect(n.smartButtons).toEqual(s.smartButtons)
  })

  it('remaps a custom page order with repeats and skipped pages', () => {
    const s = song()
    s.pageOrder = [
      { fileId: 'b', page: 2 },
      { fileId: 'a', page: 0 },
      { fileId: 'a', page: 0 },
      { fileId: 't', page: 0 },
      { fileId: 'b', page: 0 },
    ]
    const n = applyCombine(s, planCombine(s, ['a', 'b']), merged(5))
    expect(n.pageOrder?.map((r) => `${r.fileId}${r.page}`)).toEqual(['M4', 'M0', 'M0', 't0', 'M2'])
    // The file list replaces the first selected file in place.
    expect(n.files[0].id).toBe('M')
  })

  it('places the new file where the first selected file was', () => {
    const s = song()
    const n = applyCombine(s, planCombine(s, ['b', 'i']), merged(4))
    expect(n.files.map((x) => x.id)).toEqual(['a', 'M', 't'])
    expect(refs(n)).toEqual(['a0', 'a1', 'M0', 'M1', 'M2', 't0', 'M3'])
  })

  it('refuses a merged file with the wrong page count', () => {
    const s = song()
    expect(() => applyCombine(s, planCombine(s, ['a', 'b']), merged(4))).toThrow()
  })
})

describe('remapAnnotations', () => {
  it('re-keys the merged pages of this song only', () => {
    const s = song()
    const plan = planCombine(s, ['a', 'b'])
    const item = { id: 'x', type: 'text' as const, layer: 'default', color: '#000', opacity: 1, createdAt: 1, at: { x: 0.2, y: 0.3 }, text: 'rit.', size: 0.03 }
    const rec = (songId: string, fileId: string, page: number, items = [item]): PageAnnotations => ({ id: `${songId}:${fileId}:${page}`, songId, fileId, page, items })
    const out = remapAnnotations([rec('s', 'b', 1), rec('s', 'a', 0), rec('s', 't', 0), rec('other', 'b', 0), rec('s', 'a', 1, [])], 's', plan, 'M')
    expect(out.map((r) => r.id)).toEqual(['s:M:3', 's:M:0'])
    expect(out[0]).toMatchObject({ songId: 's', fileId: 'M', page: 3, items: [item] })
  })
})

/* -------------------------------------------------------------- PDF merge */

// 4x2 px RGB PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAI0lEQVR4nGNg0AioWHDig4RDxoQdDFFNqy79UvIqmnXolRAAjfYL2e3ccK8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0))

async function pdf(...sizes: [number, number][]) {
  const d = await PDFDocument.create()
  for (const s of sizes) d.addPage(s)
  return new Blob([(await d.save()) as Uint8Array<ArrayBuffer>], { type: 'application/pdf' })
}

describe('mergeToPdf', () => {
  it('concatenates PDF pages and image pages at their natural aspect', async () => {
    const blobs: Record<string, Blob> = {
      ba: await pdf([100, 200], [110, 200]),
      bb: await pdf([120, 200], [130, 200], [140, 200]),
      bi: new Blob([PNG], { type: 'image/png' }),
    }
    const bytes = await mergeToPdf([f('a', 2), f('b', 3), f('i', 1, 'image')], { load: async (id) => blobs[id] })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(6)
    expect(doc.getPages().slice(0, 5).map((p) => p.getWidth())).toEqual([100, 110, 120, 130, 140])
    const img = doc.getPage(5)
    expect(img.getWidth() / img.getHeight()).toBeCloseTo(2)
  })

  it('throws instead of dropping pages', async () => {
    const blobs: Record<string, Blob> = { ba: await pdf([100, 200]), bb: new Blob(['not a pdf']) }
    await expect(mergeToPdf([f('a', 2), f('b', 1)], { load: async (id) => blobs[id] })).rejects.toThrow(/1 pages but the song expects 2/)
    await expect(mergeToPdf([f('b', 1)], { load: async (id) => blobs[id] })).rejects.toThrow(/Could not read/)
  })

  it('reads JPEG EXIF orientation', () => {
    // SOI, APP1 Exif (big-endian TIFF, one IFD entry: Orientation = 6), SOS.
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, app1.length + 2, ...app1, 0xff, 0xda, 0, 2])
    expect(jpegOrientation(jpg)).toBe(6)
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1)
    expect(jpegOrientation(PNG)).toBe(1)
  })
})

describe('combineFiles', () => {
  beforeEach(async () => {
    await Promise.all([db.songs.clear(), db.blobs.clear(), db.annotations.clear()])
  })

  it('stores the merged PDF and copies annotations, leaving the originals intact', async () => {
    const put = async (b: Blob) => (await putBlob(await b.arrayBuffer(), b.type)).id
    const a = { ...f('a', 2), blobId: await put(await pdf([100, 200], [100, 200])) }
    const b = { ...f('b', 1), blobId: await put(await pdf([100, 200])) }
    const s = emptySong({ id: 's', title: 'Two parts', files: [a, b] })
    await db.songs.put(s)
    // Another song shares file b's blob.
    await db.songs.put(emptySong({ id: 'o', title: 'Other', files: [{ ...b, id: 'ob' }] }))
    const items = [{ id: 'x', type: 'pen' as const, layer: 'default', color: '#000', opacity: 1, createdAt: 1, width: 0.01, points: [{ x: 0.1, y: 0.1 }] }]
    await db.annotations.put({ id: 's:b:0', songId: 's', fileId: 'b', page: 0, items })

    const { file, plan } = await combineFiles(s, ['a', 'b'])
    expect(file).toMatchObject({ name: 'Two parts.pdf', kind: 'pdf', pageCount: 3 })
    const stored = await db.blobs.get(file.blobId)
    expect((await PDFDocument.load(await stored!.data.arrayBuffer())).getPageCount()).toBe(3)
    expect((await db.annotations.get(`s:${file.id}:2`))?.items).toEqual(items)
    // Originals untouched (the draft may be cancelled; other songs share blobs).
    expect(await db.annotations.get('s:b:0')).toBeTruthy()
    expect(await db.blobs.get(b.blobId)).toBeTruthy()
    const next = applyCombine(s, plan, file)
    expect(next.files).toEqual([file])
  })
})
