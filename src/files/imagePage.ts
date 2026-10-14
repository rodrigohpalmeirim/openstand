/**
 * Put an image file on a PDF page at its natural aspect (pdf-lib). Shared by the PDF export and
 * "Combine files". JPEG EXIF orientation is honoured the way browsers show the image: plain turns
 * become the page's /Rotate (lossless); mirrored orientations are re-encoded through a canvas.
 */
import { degrees, type PDFDocument, type PDFImage, type PDFPage } from 'pdf-lib'

export interface EmbeddedImage {
  image: PDFImage
  /** Clockwise page rotation that shows the image upright. */
  rotation: 0 | 90 | 180 | 270
}

/** Long side of an image page in points (A4 height), so pages print and annotate sensibly. */
const LONG_SIDE = 842

/** EXIF orientation (1..8) of a JPEG, 1 when absent or unreadable. */
export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1
  let i = 2
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return 1
    const marker = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    // APP1 "Exif\0\0"
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10
      const le = b[t] === 0x49
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1])
      const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0)
      const ifd = t + u32(t + 4)
      if (ifd + 2 > b.length) return 1
      const n = u16(ifd)
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12
        if (e + 10 > b.length) return 1
        if (u16(e) === 0x0112) {
          const v = u16(e + 8)
          return v >= 1 && v <= 8 ? v : 1
        }
      }
      return 1
    }
    // Start of scan: no more metadata.
    if (marker === 0xda) return 1
    i += 2 + len
  }
  return 1
}

const TURN: Record<number, EmbeddedImage['rotation']> = { 1: 0, 3: 180, 6: 90, 8: 270 }

/** Embed an image blob. Returns null when the format can't be read here (e.g. no canvas in Node). */
export async function embedImageBlob(doc: PDFDocument, blob: Blob): Promise<EmbeddedImage | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { image: await doc.embedPng(bytes), rotation: 0 }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const turn = TURN[jpegOrientation(bytes)]
      if (turn !== undefined) return { image: await doc.embedJpg(bytes), rotation: turn }
      // Mirrored orientations: let the browser apply them.
      const img = await embedViaCanvas(doc, blob, 'image/jpeg')
      return img && { image: img, rotation: 0 }
    }
  } catch {
    /* fall through to the canvas */
  }
  const img = await embedViaCanvas(doc, blob, 'image/png').catch(() => null)
  return img && { image: img, rotation: 0 }
}

/** Add a page showing the whole image; display aspect = the image's (oriented) aspect. */
export function addImagePage(doc: PDFDocument, e: EmbeddedImage): PDFPage {
  const { width, height } = e.image
  const k = LONG_SIDE / Math.max(width, height)
  const page = doc.addPage([width * k, height * k])
  page.drawImage(e.image, { x: 0, y: 0, width: width * k, height: height * k })
  if (e.rotation) page.setRotation(degrees(e.rotation))
  return page
}

/** WebP/GIF/BMP/AVIF (or mirrored JPEG): decode in the browser and re-encode (browser only). */
async function embedViaCanvas(doc: PDFDocument, blob: Blob, type: 'image/png' | 'image/jpeg'): Promise<PDFImage | null> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return null
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92))
  if (!out) return null
  const bytes = new Uint8Array(await out.arrayBuffer())
  return type === 'image/png' ? doc.embedPng(bytes) : doc.embedJpg(bytes)
}
