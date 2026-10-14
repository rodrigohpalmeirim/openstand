import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { PAPER } from './geometry'
import { packBits } from './image'
import { buildScanPdf } from './pdf'

// A 1×1 baseline JPEG header (pdf-lib only reads up to the frame header for embedding).
const TINY_JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  ),
  (c) => c.charCodeAt(0),
)

describe('buildScanPdf', () => {
  it('makes one page per scan, A4-sized for A4-shaped scans, with a 1-bit image for B&W', async () => {
    const w = 210 * 4
    const h = 297 * 4
    const bin = new Uint8Array(w * h).fill(255)
    for (let x = 0; x < w; x++) bin[100 * w + x] = 0
    const bytes = await buildScanPdf(
      [
        { kind: 'bits', bytes: packBits(bin, w, h), width: w, height: h },
        { kind: 'jpeg', bytes: TINY_JPEG, width: 1, height: 1 },
      ],
      'Test scan',
    )
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(2)
    const [p1, p2] = doc.getPages()
    expect(p1.getWidth()).toBeCloseTo(PAPER.a4.w)
    expect(p1.getHeight()).toBeCloseTo(PAPER.a4.h)
    expect(p2.getWidth()).toBeCloseTo(PAPER.a4.h) // square → long side of A4
    expect(doc.getTitle()).toBe('Test scan')
    // The B&W page's image is a Flate-compressed 1-bit DeviceGray XObject, much smaller than raw.
    const images = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    const mono = images.find((o) => o.dict.get(PDFName.of('BitsPerComponent'))?.toString() === '1')!
    expect(mono).toBeTruthy()
    expect(mono.dict.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceGray'))
    expect(mono.contents.length).toBeLessThan((w * h) / 8 / 20)
  })
})
