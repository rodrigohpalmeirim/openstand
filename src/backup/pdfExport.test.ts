// @vitest-environment node
import 'fake-indexeddb/auto'
import { PDFDocument, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { db, putBlob, uid } from '../db/db'
import { emptySong, type Annotation } from '../db/schema'
import { applyMatrix, cropToUserBox, displayMatrix, drawAnnotations, normRot, parseColor, songPdf, type PageBox } from './pdfExport'

const box: PageBox = { x: 0, y: 0, width: 600, height: 800 }

describe('display transform', () => {
  it('maps display corners onto user space for each rotation', () => {
    // Display top-left in y-up display space is (0, H).
    expect(applyMatrix(displayMatrix(box, 0), 0, 800)).toEqual({ x: 0, y: 800 })
    // Rotate 90 (clockwise when shown): the user-space bottom-left becomes the display top-left.
    expect(applyMatrix(displayMatrix(box, 90), 0, 600)).toEqual({ x: 0, y: 0 })
    expect(applyMatrix(displayMatrix(box, 180), 0, 800)).toEqual({ x: 600, y: 0 })
    expect(applyMatrix(displayMatrix(box, 270), 0, 600)).toEqual({ x: 600, y: 800 })
    expect(normRot(-90)).toBe(270)
    expect(normRot(450)).toBe(90)
  })
  it('converts display crops to user-space boxes', () => {
    expect(cropToUserBox(box, 0, { top: 0.1, bottom: 0, left: 0.5, right: 0 })).toEqual({ x: 300, y: 0, width: 300, height: 720 })
    // At 90 degrees the display "top" is the user-space left edge.
    expect(cropToUserBox(box, 90, { top: 0.25, bottom: 0, left: 0, right: 0 })).toEqual({ x: 150, y: 0, width: 450, height: 800 })
  })
  it('parses colours', () => {
    expect(parseColor('#ff0000')?.alpha).toBe(1)
    expect(parseColor('#f008')?.alpha).toBeCloseTo(0.533, 2)
    expect(parseColor('rgba(0, 0, 255, 0.5)')?.alpha).toBe(0.5)
    expect(parseColor('none')).toBeNull()
  })
})

const items: Annotation[] = [
  { id: '1', type: 'pen', layer: 'default', color: '#1a5fb4', opacity: 1, createdAt: 1, width: 0.004, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.15 }, { x: 0.3, y: 0.1 }] },
  { id: '2', type: 'highlighter', layer: 'default', color: '#ffe000', opacity: 0.4, createdAt: 1, width: 0.02, points: [{ x: 0.1, y: 0.5 }, { x: 0.6, y: 0.5 }] },
  { id: '3', type: 'arrow', layer: 'default', color: '#e01b24', opacity: 1, createdAt: 1, width: 0.003, a: { x: 0.5, y: 0.5 }, b: { x: 0.7, y: 0.6 } },
  { id: '4', type: 'ellipse', layer: 'default', color: '#e01b24', opacity: 1, createdAt: 1, width: 0.003, a: { x: 0.4, y: 0.4 }, b: { x: 0.6, y: 0.45 }, fill: true },
  { id: '5', type: 'text', layer: 'default', color: '#000', opacity: 1, createdAt: 1, at: { x: 0.1, y: 0.8 }, text: 'rit. — ☃ ñ\nline 2', size: 0.03, bold: true, background: '#fff8' },
  { id: '6', type: 'stamp', layer: 'default', color: '#000', opacity: 1, createdAt: 1, at: { x: 0.5, y: 0.2 }, stamp: 'fermata', size: 0.05 },
  { id: '7', type: 'stamp', layer: 'default', color: '#000', opacity: 1, createdAt: 1, at: { x: 0.6, y: 0.2 }, stamp: 'mf', size: 0.05 },
]

describe('annotation flattening', () => {
  it('draws every annotation type on rotated pages without errors', async () => {
    const doc = await PDFDocument.create()
    for (const r of [0, 90, 180, 270] as const) {
      const p = doc.addPage([600, 800])
      p.setRotation(degrees(r))
      await drawAnnotations(doc, p, items, box, r)
    }
    const bytes = await doc.save()
    const back = await PDFDocument.load(bytes)
    expect(back.getPageCount()).toBe(4)
  })

  it('builds a song PDF with page order, crop, rotation and annotations', async () => {
    const src = await PDFDocument.create()
    src.addPage([600, 800])
    src.addPage([600, 800])
    const { id: blobId, size } = await putBlob((await src.save()).buffer as ArrayBuffer, 'application/pdf')
    const fileId = uid()
    const song = emptySong({ id: uid(), title: 'Test' })
    song.files.push({ id: fileId, name: 't.pdf', kind: 'pdf', blobId, pageCount: 2, size })
    song.pageOrder = [{ fileId, page: 1 }, { fileId, page: 0 }, { fileId, page: 1 }]
    song.pageSettings = { [`${fileId}:1`]: { rotation: 90, crop: { top: 0.1, bottom: 0, left: 0, right: 0 } } }
    await db.songs.put(song)
    await db.annotations.put({ id: `${song.id}:${fileId}:0`, songId: song.id, fileId, page: 0, items })
    const out = await songPdf(song, { annotations: true })
    expect(out?.result.pages).toBe(3)
    const doc = await PDFDocument.load(out!.bytes)
    expect(doc.getPage(0).getRotation().angle).toBe(90)
    expect(doc.getPage(0).getCropBox().width).toBeCloseTo(540)
    expect(doc.getPage(1).getRotation().angle).toBe(0)
  })
})
