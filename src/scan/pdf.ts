/** Assemble scanned pages into one PDF (one page per scan, image filling the page). */
import { pageSizeFor } from './geometry'

export type EncodedPage =
  | { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number }
  /** 1 bit per pixel, MSB first, rows padded to bytes; 1 = white. */
  | { kind: 'bits'; bytes: Uint8Array; width: number; height: number }

export async function buildScanPdf(pages: EncodedPage[], title?: string): Promise<Uint8Array> {
  const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  if (title) doc.setTitle(title)
  doc.setCreator('OpenStand scanner')
  doc.setProducer('OpenStand')
  for (const p of pages) {
    const size = pageSizeFor(p.width / p.height)
    const page = doc.addPage([size.w, size.h])
    if (p.kind === 'jpeg') {
      const img = await doc.embedJpg(p.bytes)
      page.drawImage(img, { x: 0, y: 0, width: size.w, height: size.h })
    } else {
      // pdf-lib has no 1-bit image API, so add the image XObject by hand (Flate-compressed bits).
      const stream = doc.context.flateStream(p.bytes, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: p.width,
        Height: p.height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
      })
      const ref = doc.context.register(stream)
      const name = page.node.newXObject('Scan', ref)
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(size.w, 0, 0, size.h, 0, 0), drawObject(name), popGraphicsState())
    }
  }
  return doc.save()
}
