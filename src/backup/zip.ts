/**
 * Minimal streaming ZIP writer/reader for backups and song packages.
 *
 * Why not fflate's streaming Zip/Unzip: its writer always emits data descriptors and its streaming
 * reader then finds entry ends by scanning for a signature, which can collide with bytes inside a
 * stored PDF. Here CRC and size are computed before each entry is written (headers are exact), and
 * the reader uses the central directory with random access (`Blob.slice`), so stored entries come
 * back as zero-copy slices of the user's file. ZIP64 offsets/counts are supported (single entries
 * must be < 4 GiB). fflate is still used for DEFLATE of JSON entries.
 */
import { deflateSync, inflateSync } from 'fflate'

/* -------------------------------------------------------------------- CRC */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32Update(crc: number, data: Uint8Array): number {
  let c = ~crc
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

export const crc32 = (data: Uint8Array) => crc32Update(0, data)

async function blobCrc(blob: Blob): Promise<number> {
  let crc = 0
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      crc = crc32Update(crc, value)
    }
    return crc
  }
  return crc32(new Uint8Array(await blob.arrayBuffer()))
}

/* ----------------------------------------------------------------- writer */

export type ZipPart = Uint8Array | Blob

/** Where archive bytes go: a file stream, or memory (parts are kept as Blob references). */
export interface ZipSink {
  write(part: ZipPart): Promise<void>
}

export class MemorySink implements ZipSink {
  parts: ZipPart[] = []
  async write(part: ZipPart) {
    this.parts.push(part)
  }
  blob(type = 'application/zip') {
    return new Blob(this.parts as BlobPart[], { type })
  }
}

interface CdEntry {
  name: Uint8Array
  crc: number
  method: number
  compSize: number
  size: number
  offset: number
  time: number
  date: number
}

const U32 = 0xffffffff
const enc = new TextEncoder()

function dosDateTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export class ZipWriter {
  private offset = 0
  private entries: CdEntry[] = []
  private names = new Set<string>()
  private sink: ZipSink
  private when = dosDateTime(new Date())
  private force64: boolean

  /** `zip64` forces ZIP64 records even for small archives (used by tests). */
  constructor(sink: ZipSink, opts: { zip64?: boolean } = {}) {
    this.sink = sink
    this.force64 = !!opts.zip64
  }

  get bytesWritten() {
    return this.offset
  }

  private async emit(part: ZipPart) {
    await this.sink.write(part)
    this.offset += part instanceof Blob ? part.size : part.length
  }

  private async entry(name: string, crc: number, size: number, method: number, data: ZipPart) {
    if (this.names.has(name)) throw new Error(`Duplicate zip entry ${name}`)
    this.names.add(name)
    const compSize = data instanceof Blob ? data.size : data.length
    if (size >= U32 || compSize >= U32) throw new Error(`${name} is too large (4 GB limit per file)`)
    const nameBytes = enc.encode(name)
    const h = new Uint8Array(30 + nameBytes.length)
    const v = new DataView(h.buffer)
    v.setUint32(0, 0x04034b50, true)
    v.setUint16(4, 20, true)
    v.setUint16(6, 0x0800, true) // UTF-8 names
    v.setUint16(8, method, true)
    v.setUint16(10, this.when.time, true)
    v.setUint16(12, this.when.date, true)
    v.setUint32(14, crc, true)
    v.setUint32(18, compSize, true)
    v.setUint32(22, size, true)
    v.setUint16(26, nameBytes.length, true)
    v.setUint16(28, 0, true)
    h.set(nameBytes, 30)
    this.entries.push({ name: nameBytes, crc, method, compSize, size, offset: this.offset, ...this.when })
    await this.emit(h)
    await this.emit(data)
  }

  /** Add in-memory bytes; `compress` deflates them (good for JSON, pointless for PDFs). */
  async addBytes(name: string, data: Uint8Array, compress = false) {
    const crc = crc32(data)
    const body = compress ? deflateSync(data, { level: 6 }) : data
    await this.entry(name, crc, data.length, compress ? 8 : 0, body)
  }

  async addText(name: string, text: string, compress = true) {
    await this.addBytes(name, enc.encode(text), compress)
  }

  /** Add a Blob stored uncompressed; it is read once for the CRC and then passed through by reference. */
  async addBlob(name: string, blob: Blob) {
    const crc = await blobCrc(blob)
    await this.entry(name, crc, blob.size, 0, blob)
  }

  async finish() {
    const cdStart = this.offset
    const parts: Uint8Array[] = []
    for (const e of this.entries) {
      const z64 = this.force64 || e.offset >= U32
      const extra = z64 ? 12 : 0
      const c = new Uint8Array(46 + e.name.length + extra)
      const v = new DataView(c.buffer)
      v.setUint32(0, 0x02014b50, true)
      v.setUint16(4, z64 ? 45 : 20, true)
      v.setUint16(6, z64 ? 45 : 20, true)
      v.setUint16(8, 0x0800, true)
      v.setUint16(10, e.method, true)
      v.setUint16(12, e.time, true)
      v.setUint16(14, e.date, true)
      v.setUint32(16, e.crc, true)
      v.setUint32(20, e.compSize, true)
      v.setUint32(24, e.size, true)
      v.setUint16(28, e.name.length, true)
      v.setUint16(30, extra, true)
      v.setUint32(42, z64 ? U32 : e.offset, true)
      c.set(e.name, 46)
      if (z64) {
        const x = 46 + e.name.length
        v.setUint16(x, 0x0001, true)
        v.setUint16(x + 2, 8, true)
        v.setBigUint64(x + 4, BigInt(e.offset), true)
      }
      parts.push(c)
    }
    for (const p of parts) await this.emit(p)
    const cdSize = this.offset - cdStart
    const count = this.entries.length
    const need64 = this.force64 || count >= 0xffff || cdStart >= U32 || cdSize >= U32
    if (need64) {
      const z = new Uint8Array(56 + 20)
      const v = new DataView(z.buffer)
      const recOffset = this.offset
      v.setUint32(0, 0x06064b50, true)
      v.setBigUint64(4, 44n, true)
      v.setUint16(12, 45, true)
      v.setUint16(14, 45, true)
      v.setBigUint64(24, BigInt(count), true)
      v.setBigUint64(32, BigInt(count), true)
      v.setBigUint64(40, BigInt(cdSize), true)
      v.setBigUint64(48, BigInt(cdStart), true)
      // locator
      v.setUint32(56, 0x07064b50, true)
      v.setBigUint64(64, BigInt(recOffset), true)
      v.setUint32(72, 1, true)
      await this.emit(z)
    }
    const e = new Uint8Array(22)
    const v = new DataView(e.buffer)
    v.setUint32(0, 0x06054b50, true)
    v.setUint16(8, need64 ? 0xffff : count, true)
    v.setUint16(10, need64 ? 0xffff : count, true)
    v.setUint32(12, need64 ? U32 : cdSize, true)
    v.setUint32(16, need64 ? U32 : cdStart, true)
    await this.emit(e)
  }
}

/* ----------------------------------------------------------------- reader */

export interface ZipEntry {
  name: string
  method: number
  crc: number
  compSize: number
  size: number
  offset: number
}

async function readRange(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>()
  private src: Blob
  private constructor(src: Blob) {
    this.src = src
  }

  static async open(blob: Blob): Promise<ZipReader> {
    const r = new ZipReader(blob)
    await r.readDirectory()
    return r
  }

  private async readDirectory() {
    const size = this.src.size
    if (size < 22) throw new Error('Not a ZIP file')
    const tailStart = Math.max(0, size - 22 - 0xffff)
    const tail = await readRange(this.src, tailStart, size)
    let eocd = -1
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no directory found)')
    let count = tail.getUint16(eocd + 10, true)
    let cdSize = tail.getUint32(eocd + 12, true)
    let cdOffset = tail.getUint32(eocd + 16, true)
    if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
      const loc = eocd - 20
      if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('Damaged ZIP64 archive')
      const recOffset = Number(tail.getBigUint64(loc + 8, true))
      const rec = await readRange(this.src, recOffset, recOffset + 56)
      if (rec.getUint32(0, true) !== 0x06064b50) throw new Error('Damaged ZIP64 archive')
      count = Number(rec.getBigUint64(32, true))
      cdSize = Number(rec.getBigUint64(40, true))
      cdOffset = Number(rec.getBigUint64(48, true))
    }
    const cd = await readRange(this.src, cdOffset, cdOffset + cdSize)
    const dec = new TextDecoder()
    let p = 0
    for (let n = 0; n < count; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP directory')
      const method = cd.getUint16(p + 10, true)
      const crc = cd.getUint32(p + 16, true)
      let compSize = cd.getUint32(p + 20, true)
      let size = cd.getUint32(p + 24, true)
      const nameLen = cd.getUint16(p + 28, true)
      const extraLen = cd.getUint16(p + 30, true)
      const commentLen = cd.getUint16(p + 32, true)
      let offset = cd.getUint32(p + 42, true)
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))
      // ZIP64 extra: values present only for fields that are 0xFFFFFFFF, in this order.
      let x = p + 46 + nameLen
      const xEnd = x + extraLen
      while (x + 4 <= xEnd) {
        const id = cd.getUint16(x, true)
        const len = cd.getUint16(x + 2, true)
        if (id === 0x0001) {
          let q = x + 4
          if (size === U32) {
            size = Number(cd.getBigUint64(q, true))
            q += 8
          }
          if (compSize === U32) {
            compSize = Number(cd.getBigUint64(q, true))
            q += 8
          }
          if (offset === U32) offset = Number(cd.getBigUint64(q, true))
        }
        x += 4 + len
      }
      this.entries.set(name, { name, method, crc, compSize, size, offset })
      p += 46 + nameLen + extraLen + commentLen
    }
  }

  has(name: string) {
    return this.entries.has(name)
  }

  private async dataStart(e: ZipEntry) {
    const h = await readRange(this.src, e.offset, e.offset + 30)
    if (h.getUint32(0, true) !== 0x04034b50) throw new Error(`Damaged entry ${e.name}`)
    return e.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true)
  }

  /** Entry contents as a Blob. Stored entries are slices of the archive (no copy). */
  async blob(name: string, type = ''): Promise<Blob> {
    const e = this.entries.get(name)
    if (!e) throw new Error(`Missing ${name} in archive`)
    const start = await this.dataStart(e)
    const raw = this.src.slice(start, start + e.compSize, type)
    if (e.method === 0) return raw
    if (e.method === 8) return new Blob([inflateSync(new Uint8Array(await raw.arrayBuffer())) as BlobPart], { type })
    throw new Error(`Unsupported compression in ${name}`)
  }

  async bytes(name: string, verify = true): Promise<Uint8Array> {
    const data = new Uint8Array(await (await this.blob(name)).arrayBuffer())
    if (verify && crc32(data) !== this.entries.get(name)!.crc) throw new Error(`${name} is corrupted (checksum mismatch)`)
    return data
  }

  async text(name: string) {
    return new TextDecoder().decode(await this.bytes(name))
  }

  async json<T>(name: string): Promise<T> {
    return JSON.parse(await this.text(name)) as T
  }
}
