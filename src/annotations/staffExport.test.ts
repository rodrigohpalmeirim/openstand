import 'fake-indexeddb/auto'
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawAnnotations, type PageBox } from '../backup/pdfExport'
import type { Annotation } from '../db/schema'

// 1x1 white PNG, as a snippet would be stored.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

describe('burning piano staves and snippets into PDFs', () => {
  it('draws the staff as vector paths and embeds the snippet image', async () => {
    const items: Annotation[] = [
      { id: 's', type: 'staff', layer: 'default', color: '#1f2937', opacity: 1, createdAt: 1, width: 0.0012, a: { x: 0.1, y: 0.1 }, b: { x: 0.9, y: 0.25 }, measures: 4 },
      { id: 'i', type: 'image', layer: 'default', color: '#000', opacity: 1, createdAt: 1, a: { x: 0.1, y: 0.5 }, b: { x: 0.5, y: 0.6 }, src: PNG },
    ]
    const doc = await PDFDocument.create()
    const page = doc.addPage([600, 800])
    const box: PageBox = { x: 0, y: 0, width: 600, height: 800 }
    await drawAnnotations(doc, page, items, box, 0)
    const back = await PDFDocument.load(await doc.save())
    const p = back.getPage(0)
    const contents = p.node.Contents()
    const streams = contents && 'asArray' in contents ? contents.asArray() : [contents]
    let ops = ''
    for (const ref of streams) {
      const s = back.context.lookup(ref as never)
      if (s instanceof PDFRawStream) ops += new TextDecoder().decode(decodePDFRawStream(s).decode())
    }
    // Strokes (S) for staff lines/bars/clef, fills (f) for brace/clef/final bar, and a drawn image (Do).
    expect(ops).toMatch(/\bS\b/)
    expect(ops).toMatch(/\bf\b/)
    expect(ops).toMatch(/\bDo\b/)
  })
})
