/**
 * Batch, meta, device and snapshot encoding (docs/SYNC.md §3, §3.1, §4.1, §4.2).
 *
 * - Envelopes (`meta`, `devices/<d>`, `log/<d>/<seq>`): `seal(gzip(JSON))`.
 * - Snapshots: gzip NDJSON (header line, then one `RecordDelta` per line) inside a chunked container with
 *   random nonces. Both directions stream, so neither the JSON nor the plaintext is ever whole in memory.
 *
 * Compression is the native `CompressionStream('gzip')`.
 */
import { BackendError, type StorageBackend } from './backends/types'
import {
  CHUNK_OVERHEAD,
  FormatError,
  ab,
  blobSource,
  concatBytes,
  decryptChunk,
  decryptStream,
  encryptChunks,
  open,
  parseContainerHeader,
  seal,
  utf8,
  HEADER_BYTES,
  type ContainerContext,
  type EncryptedSource,
  type LibraryKeys,
} from './crypto'
import { CHUNK, RANGE, type Batch, type DeviceRecord, type MetaRecord, type RecordDelta, type SnapshotHeader } from './model'

// ---------------------------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------------------------

/** Decompressed envelopes larger than this are rejected (a batch op may be 16 MiB; leave headroom). */
export const MAX_ENVELOPE_PLAINTEXT = 64 * 1024 * 1024

async function collect(stream: ReadableStream<Uint8Array>, max = Infinity): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = []
  let n = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) {
      await reader.cancel()
      throw new FormatError('corrupt', 'decompressed data too large')
    }
    parts.push(value)
  }
  return concatBytes(parts)
}

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

export function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return collect(streamOf(bytes).pipeThrough(new CompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>))
}

export async function gunzip(bytes: Uint8Array, max = MAX_ENVELOPE_PLAINTEXT): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await collect(streamOf(bytes).pipeThrough(new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>), max)
  } catch (e) {
    throw e instanceof FormatError ? e : new FormatError('corrupt', 'bad gzip data', e)
  }
}

const dec = new TextDecoder()

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(dec.decode(bytes))
  } catch (e) {
    throw new FormatError('corrupt', 'bad JSON', e)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `v` must be 1; a higher number means a newer writer (`newerFormat`), anything else is `corrupt`. */
function checkV(o: unknown, what: string): asserts o is Record<string, unknown> & { v: 1 } {
  if (!isObj(o)) throw new FormatError('corrupt', `${what}: not an object`)
  if (o.v === 1) return
  if (typeof o.v === 'number' && o.v > 1) throw new FormatError('newerFormat', `${what}: version ${o.v}`)
  throw new FormatError('corrupt', `${what}: bad version`)
}

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

/** `seal(gzip(JSON(batch)))`, bound to `log/<batch.d>/<batch.s>`. Goes into `OutboxRow.bytes`. */
export async function encodeBatch(keys: LibraryKeys, batch: Batch): Promise<Uint8Array<ArrayBuffer>> {
  return seal(keys, { kind: 'batch', deviceId: batch.d, seq: batch.s }, await gzip(utf8(JSON.stringify(batch))))
}

/** Opens a `log/<deviceId>/<seq>` object. Throws `FormatError` (`corrupt` / `newerFormat`). */
export async function decodeBatch(keys: LibraryKeys, bytes: Uint8Array, at: { deviceId: string; seq: number }): Promise<Batch> {
  const b = parseJson(await gunzip(await open(keys, { kind: 'batch', deviceId: at.deviceId, seq: at.seq }, bytes)))
  checkV(b, 'batch')
  if (b.d !== at.deviceId || b.s !== at.seq) throw new FormatError('corrupt', 'batch device/seq mismatch')
  if (typeof b.t !== 'number' || typeof b.hlcMax !== 'string' || !Array.isArray(b.ops) || !b.ops.every(isObj))
    throw new FormatError('corrupt', 'malformed batch')
  if (b.blobsReady !== undefined && !(Array.isArray(b.blobsReady) && b.blobsReady.every((x) => typeof x === 'string')))
    throw new FormatError('corrupt', 'malformed blobsReady')
  return b as unknown as Batch
}

export async function encodeMeta(keys: LibraryKeys, meta: MetaRecord): Promise<Uint8Array<ArrayBuffer>> {
  return seal(keys, { kind: 'meta' }, await gzip(utf8(JSON.stringify(meta))))
}

/** Decrypting `meta` proves the secret on join: a `corrupt` here means `wrongSecret` (§10.3). */
export async function decodeMeta(keys: LibraryKeys, bytes: Uint8Array): Promise<MetaRecord> {
  const m = parseJson(await gunzip(await open(keys, { kind: 'meta' }, bytes)))
  checkV(m, 'meta')
  if (typeof m.createdAt !== 'number' || typeof m.name !== 'string') throw new FormatError('corrupt', 'malformed meta')
  return m as unknown as MetaRecord
}

export async function encodeDevice(keys: LibraryKeys, d: DeviceRecord): Promise<Uint8Array<ArrayBuffer>> {
  return seal(keys, { kind: 'device', deviceId: d.id }, await gzip(utf8(JSON.stringify(d))))
}

export async function decodeDevice(keys: LibraryKeys, bytes: Uint8Array, deviceId: string): Promise<DeviceRecord> {
  const d = parseJson(await gunzip(await open(keys, { kind: 'device', deviceId }, bytes)))
  checkV(d, 'device')
  if (d.id !== deviceId || typeof d.name !== 'string' || typeof d.createdAt !== 'number' || typeof d.lastSeenAt !== 'number')
    throw new FormatError('corrupt', 'malformed device record')
  return d as unknown as DeviceRecord
}

// ---------------------------------------------------------------------------------------------
// Snapshots (§3.1)
// ---------------------------------------------------------------------------------------------

export type SnapshotInfo = Omit<SnapshotHeader, 'v' | 'kind'>

export interface WrittenSnapshot {
  /** The encrypted container, ready for `backend.upload(snapKey(...), body, …)`. */
  body: EncryptedSource
  header: SnapshotHeader
  /** gzip size (plaintext of the container). */
  gzipBytes: number
}

const LINE_BATCH = 64 * 1024

/**
 * Streams `records` as gzip NDJSON into a temporary `Blob` (only gzip output is held), then wraps it in
 * an encrypted container. `info.records` must equal the number of records yielded: the header is line 1,
 * so the count has to be known up front; a mismatch throws.
 */
export async function writeSnapshot(
  keys: LibraryKeys,
  info: SnapshotInfo,
  records: AsyncIterable<RecordDelta> | Iterable<RecordDelta>,
): Promise<WrittenSnapshot> {
  const header: SnapshotHeader = { v: 1, kind: 'snapshot', ...info }
  let count = 0
  async function* lines(): AsyncGenerator<Uint8Array> {
    let buf = JSON.stringify(header) + '\n'
    for await (const r of records) {
      count++
      buf += JSON.stringify(r) + '\n'
      if (buf.length >= LINE_BATCH) {
        yield utf8(buf)
        buf = ''
      }
    }
    if (buf) yield utf8(buf)
  }
  const it = lines()
  const plain = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await it.next()
      if (done) c.close()
      else c.enqueue(value)
    },
    async cancel() {
      await it.return(undefined)
    },
  })
  const parts: Uint8Array<ArrayBuffer>[] = []
  const reader = plain.pipeThrough(new CompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(ab(value))
  }
  if (count !== info.records) throw new Error(`snapshot header says ${info.records} records, got ${count}`)
  const gz = new Blob(parts)
  return {
    body: encryptChunks(keys, blobSource(gz), { kind: 'snap', deviceId: info.d, n: info.n }),
    header,
    gzipBytes: gz.size,
  }
}

type ByteStreamInput = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array

function toStream(src: ByteStreamInput): ReadableStream<Uint8Array> {
  if (src instanceof Uint8Array) return streamOf(src)
  if (src instanceof ReadableStream) return src
  const it = src[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await it.next()
      if (done) c.close()
      else c.enqueue(value)
    },
    async cancel() {
      await it.return?.()
    },
  })
}

function checkSnapshotHeader(h: unknown, ctx?: { deviceId: string; n: number }): SnapshotHeader {
  checkV(h, 'snapshot')
  if (
    h.kind !== 'snapshot' ||
    typeof h.d !== 'string' ||
    typeof h.n !== 'number' ||
    typeof h.t !== 'number' ||
    typeof h.records !== 'number' ||
    typeof h.hlcMax !== 'string' ||
    !isObj(h.vector) ||
    !isObj(h.horizon)
  )
    throw new FormatError('corrupt', 'malformed snapshot header')
  if (ctx && (h.d !== ctx.deviceId || h.n !== ctx.n)) throw new FormatError('corrupt', 'snapshot device/n mismatch')
  return h as unknown as SnapshotHeader
}

/** Splits a text stream into lines (without the `\n`). */
async function* splitLines(text: ReadableStream<string>): AsyncGenerator<string> {
  const reader = text.getReader()
  let rest = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += value
      let nl: number
      while ((nl = rest.indexOf('\n')) >= 0) {
        yield rest.slice(0, nl)
        rest = rest.slice(nl + 1)
      }
    }
    if (rest) yield rest
  } finally {
    reader.releaseLock()
  }
}

const corruptOn = (e: unknown): never => {
  throw e instanceof FormatError ? e : new FormatError('corrupt', 'snapshot stream failed', e)
}

export interface SnapshotReader {
  header: SnapshotHeader
  /** One full `RecordDelta` per line. Throws `FormatError` on tampering, truncation or a count mismatch. */
  records: AsyncGenerator<RecordDelta, void, undefined>
}

/**
 * Streams a snapshot container (`ctx` = its `snap/<deviceId>/<n>` location): decrypt → gunzip → NDJSON.
 * Resolves once the header line is read; iterate `records` for the rest. Feed it with `objectStream`.
 */
export async function readSnapshot(
  keys: LibraryKeys,
  ctx: { deviceId: string; n: number },
  source: ByteStreamInput,
): Promise<SnapshotReader> {
  const cctx: ContainerContext = { kind: 'snap', deviceId: ctx.deviceId, n: ctx.n }
  const text = toStream(source)
    .pipeThrough(decryptStream(keys, cctx))
    .pipeThrough(new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>)
    .pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>)
  const lines = splitLines(text)
  const first = await lines.next().catch(corruptOn)
  if (first.done) throw new FormatError('corrupt', 'empty snapshot')
  const header = checkSnapshotHeader(parseJson(utf8(first.value)), ctx)
  async function* records(): AsyncGenerator<RecordDelta, void, undefined> {
    let n = 0
    try {
      for (;;) {
        const r = await lines.next().catch(corruptOn)
        if (r.done) break
        if (!r.value) continue
        const d = parseJson(utf8(r.value))
        if (!isObj(d) || typeof d.c !== 'string' || typeof d.id !== 'string') throw new FormatError('corrupt', 'malformed snapshot record')
        n++
        yield d as unknown as RecordDelta
      }
    } finally {
      await lines.return(undefined)
    }
    if (n !== header.records) throw new FormatError('corrupt', `snapshot has ${n} records, header says ${header.records}`)
  }
  return { header, records: records() }
}

/**
 * Reads just the header line from the start of a snapshot container (`bytes` = at least the header and
 * chunk 0: fetch it with `backend.get(key, { range: FIRST_CHUNK_RANGE })`). Used to pick the best
 * snapshot without downloading it (§3.1).
 */
export async function readSnapshotHeader(
  keys: LibraryKeys,
  ctx: { deviceId: string; n: number },
  bytes: Uint8Array,
): Promise<SnapshotHeader> {
  const h = parseContainerHeader(bytes)
  const len0 = Math.min(h.size, 2 ** h.log2Chunk) + CHUNK_OVERHEAD
  if (bytes.length < HEADER_BYTES + len0) throw new FormatError('corrupt', 'snapshot chunk 0 truncated')
  const pt = await decryptChunk(keys, h, { kind: 'snap', deviceId: ctx.deviceId, n: ctx.n }, 0, bytes.subarray(HEADER_BYTES, HEADER_BYTES + len0))
  // Partial gunzip: feed chunk 0 without closing (the rest of the gzip stream is missing), read until '\n'.
  const ds = new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>
  const writer = ds.writable.getWriter()
  writer.write(pt).catch(() => {})
  if (h.size <= 2 ** h.log2Chunk) writer.close().catch(() => {})
  const reader = ds.readable.getReader()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) text += dec.decode(value, { stream: true })
      const nl = text.indexOf('\n')
      if (nl >= 0) return checkSnapshotHeader(parseJson(utf8(text.slice(0, nl))), ctx)
      if (done || text.length > 1024 * 1024) throw new FormatError('corrupt', 'snapshot header line not found')
    }
  } catch (e) {
    return corruptOn(e)
  } finally {
    reader.cancel().catch(() => {})
    writer.abort().catch(() => {})
  }
}

/**
 * Streams an object through range GETs of `RANGE` chunks (4 MiB) at a time, so a large snapshot is never
 * whole in memory. Falls back to one GET when the backend can't do ranges. Errors with
 * `BackendError('notFound')` if the object is missing.
 */
export function objectStream(
  backend: StorageBackend,
  key: string,
  o: { signal?: AbortSignal; rangeBytes?: number } = {},
): ReadableStream<Uint8Array> {
  const step = o.rangeBytes ?? RANGE * (CHUNK + CHUNK_OVERHEAD)
  let pos = 0
  let done = false
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (done) return c.close()
      const range: [number, number] | undefined = backend.caps.rangeGet ? [pos, pos + step - 1] : undefined
      const data = await backend.get(key, { range, signal: o.signal })
      if (data === null) throw new BackendError('notFound', `${key} not found`, { status: 404 })
      pos += data.length
      if (!range || data.length < step) done = true
      if (data.length) c.enqueue(data)
      if (done) c.close()
    },
  })
}
