/**
 * Batch, meta, device and snapshot encoding.
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
import { isDeviceId, isHlc } from './hlc'
import { CHUNK, CLOCK_AHEAD_MAX, RANGE, type Batch, type DeviceRecord, type MetaRecord, type RecordDelta, type SnapshotHeader } from './model'

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
// Record validation (batch ops and snapshot lines): shapes and HLCs only, values stay opaque
// ---------------------------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/
const isTuple = (v: unknown, n: number): v is unknown[] => Array.isArray(v) && v.length === n
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Map keys that would reach an object's prototype when assigned with `o[k] = v`. */
function checkKeys(o: Record<string, unknown>, what: string) {
  if (Object.prototype.hasOwnProperty.call(o, '__proto__')) throw new FormatError('corrupt', `${what}: forbidden key __proto__`)
}

/**
 * Throws `corrupt` unless `d` is a well-formed `RecordDelta`: string `c`/`id`, every register's HLC valid,
 * register tuples of the right length, numeric max/min and counters, no `__proto__` keys. Unknown
 * top-level properties are ignored (forward compatible); field names and values are not interpreted.
 */
export function checkRecordDelta(d: unknown, what = 'record'): asserts d is RecordDelta {
  const bad = (why: string): never => {
    throw new FormatError('corrupt', `${what}: ${why}`)
  }
  if (!isObj(d) || typeof d.c !== 'string' || typeof d.id !== 'string') bad('malformed')
  const r = d as Record<string, unknown>
  if (r.a !== undefined && !(isTuple(r.a, 2) && isHlc(r.a[0]) && typeof r.a[1] === 'boolean')) bad('bad alive register')
  if (r.f !== undefined) {
    if (!isObj(r.f)) bad('bad fields')
    const f = r.f as Record<string, unknown>
    checkKeys(f, what)
    for (const k in f) {
      const v = f[k]
      if (!Array.isArray(v) || (v.length !== 1 && v.length !== 2) || !isHlc(v[0])) bad(`bad register ${k}`)
    }
  }
  if (r.m !== undefined) {
    if (!isObj(r.m)) bad('bad max/min registers')
    const m = r.m as Record<string, unknown>
    checkKeys(m, what)
    for (const k in m) if (!isNum(m[k])) bad(`bad max/min register ${k}`)
  }
  if (r.l !== undefined) {
    if (!isObj(r.l)) bad('bad lists')
    const l = r.l as Record<string, unknown>
    checkKeys(l, what)
    for (const k in l) {
      const ld = l[k]
      if (!isObj(ld)) bad(`bad list ${k}`)
      const { o, e } = ld as { o?: unknown; e?: unknown }
      if (o !== undefined && !(isTuple(o, 2) && isHlc(o[0]) && Array.isArray(o[1]) && o[1].every((x) => typeof x === 'string'))) bad(`bad order of ${k}`)
      if (e !== undefined) {
        if (!isObj(e)) bad(`bad elements of ${k}`)
        checkKeys(e as Record<string, unknown>, what)
        for (const ek in e as Record<string, unknown>) {
          const v = (e as Record<string, unknown>)[ek]
          if (!(isTuple(v, 3) && isHlc(v[0]) && isHlc(v[2]))) bad(`bad element ${k}.${ek}`)
        }
      }
    }
  }
  if (r.n !== undefined) {
    if (!isObj(r.n)) bad('bad counters')
    const n = r.n as Record<string, unknown>
    checkKeys(n, what)
    for (const k in n) {
      const per = n[k]
      if (!isObj(per)) bad(`bad counter ${k}`)
      checkKeys(per as Record<string, unknown>, what)
      for (const dk in per as Record<string, unknown>) {
        const v = (per as Record<string, unknown>)[dk]
        if (!(isTuple(v, 2) && isNum(v[0]) && isNum(v[1]) && v[0] >= 0 && v[1] >= 0)) bad(`bad counter ${k}.${dk}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

/** `seal(gzip(JSON(batch)))`, bound to `log/<batch.d>/<batch.s>`. Goes into `OutboxRow.bytes`. */
export async function encodeBatch(keys: LibraryKeys, batch: Batch): Promise<Uint8Array<ArrayBuffer>> {
  return seal(keys, { kind: 'batch', deviceId: batch.d, seq: batch.s }, await gzip(utf8(JSON.stringify(batch))))
}

/**
 * Opens a `log/<deviceId>/<seq>` object. Throws `FormatError` (`corrupt` / `newerFormat` / `oldFormat`).
 * `hlcMax` and every op are validated (`checkRecordDelta`); a bad one makes the whole batch `corrupt`.
 */
export async function decodeBatch(keys: LibraryKeys, bytes: Uint8Array, at: { deviceId: string; seq: number }): Promise<Batch> {
  const b = parseJson(await gunzip(await open(keys, { kind: 'batch', deviceId: at.deviceId, seq: at.seq }, bytes)))
  checkV(b, 'batch')
  if (b.d !== at.deviceId || b.s !== at.seq) throw new FormatError('corrupt', 'batch device/seq mismatch')
  if (!isNum(b.t) || !isHlc(b.hlcMax) || !Array.isArray(b.ops)) throw new FormatError('corrupt', 'malformed batch')
  b.ops.forEach((op, i) => checkRecordDelta(op, `batch op ${i}`))
  if (b.blobsReady !== undefined && !(Array.isArray(b.blobsReady) && b.blobsReady.every((x) => typeof x === 'string' && SHA256_HEX.test(x))))
    throw new FormatError('corrupt', 'malformed blobsReady')
  return b as unknown as Batch
}

export async function encodeMeta(keys: LibraryKeys, meta: MetaRecord): Promise<Uint8Array<ArrayBuffer>> {
  return seal(keys, { kind: 'meta' }, await gzip(utf8(JSON.stringify(meta))))
}

/** Decrypting `meta` proves the secret on join: a `corrupt` here means `wrongSecret`. */
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
// Snapshots
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

/** How far a snapshot's `t` may be ahead of the reader's clock: the HLC's `CLOCK_AHEAD_MAX` (24 h). */
export const SNAPSHOT_MAX_SKEW = CLOCK_AHEAD_MAX
/** Upper bound for `records` in a snapshot header. */
export const SNAPSHOT_MAX_RECORDS = 50_000_000
/** Upper bound for the number of devices in a snapshot `vector`. */
const SNAPSHOT_MAX_DEVICES = 100_000
/** A snapshot NDJSON line longer than this (UTF-16 units) is `corrupt` (one op may be 16 MiB of JSON). */
export const MAX_SNAPSHOT_LINE = MAX_ENVELOPE_PLAINTEXT

export interface SnapshotReadOptions {
  /**
   * The reader's wall clock (ms). When given, a header whose `t` is more than `SNAPSHOT_MAX_SKEW` ahead
   * of it is `corrupt`. The engine passes its own clock so tests with a fake clock stay consistent.
   */
  now?: number
}

/**
 * Strict header check. Returns a fresh object holding only the known fields: `d` a deviceId, `n` ≥ 1,
 * `t` a time not in the future (see `SnapshotReadOptions.now`), `records` a bounded safe integer, `hlcMax`
 * an HLC, `vector` deviceId → non-negative safe integer, `horizon` times not after `t`.
 */
function checkSnapshotHeader(h: unknown, ctx?: { deviceId: string; n: number }, o: SnapshotReadOptions = {}): SnapshotHeader {
  checkV(h, 'snapshot')
  const bad = (why: string): never => {
    throw new FormatError('corrupt', `malformed snapshot header: ${why}`)
  }
  if (h.kind !== 'snapshot') bad('kind')
  if (!isDeviceId(h.d)) bad('d')
  if (!Number.isSafeInteger(h.n) || (h.n as number) < 1) bad('n')
  if (!isNum(h.t) || h.t < 0) bad('t')
  const t = h.t as number
  if (o.now !== undefined && t > o.now + SNAPSHOT_MAX_SKEW) bad('t is in the future')
  if (!Number.isSafeInteger(h.records) || (h.records as number) < 0 || (h.records as number) > SNAPSHOT_MAX_RECORDS) bad('records')
  if (!isHlc(h.hlcMax)) bad('hlcMax')
  if (!isObj(h.vector)) bad('vector')
  const src = h.vector as Record<string, unknown>
  const ids = Object.keys(src)
  if (ids.length > SNAPSHOT_MAX_DEVICES) bad('vector too large')
  const vector: Record<string, number> = {}
  for (const id of ids) {
    const seq = src[id]
    if (!isDeviceId(id) || !Number.isSafeInteger(seq) || (seq as number) < 0) bad('vector entry')
    vector[id] = seq as number
  }
  if (!isObj(h.horizon)) bad('horizon')
  const { deadFields, elementTombs } = h.horizon as Record<string, unknown>
  if (!isNum(deadFields) || !isNum(elementTombs) || deadFields > t || elementTombs > t) bad('horizon')
  if (ctx && (h.d !== ctx.deviceId || h.n !== ctx.n)) throw new FormatError('corrupt', 'snapshot device/n mismatch')
  return {
    v: 1,
    kind: 'snapshot',
    d: h.d as string,
    n: h.n as number,
    t,
    vector,
    records: h.records as number,
    hlcMax: h.hlcMax as string,
    horizon: { deadFields: deadFields as number, elementTombs: elementTombs as number },
  }
}

/**
 * Splits a text stream into lines (without the `\n`). Linear in the input, and a line longer than `max`
 * is `corrupt` (bounded memory against a stream without newlines).
 */
export async function* splitLines(text: ReadableStream<string>, max = MAX_SNAPSHOT_LINE): AsyncGenerator<string> {
  const reader = text.getReader()
  let parts: string[] = []
  let partLen = 0
  const tooLong = () => new FormatError('corrupt', `snapshot line longer than ${max} characters`)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let start = 0
      for (let nl = value.indexOf('\n'); nl >= 0; nl = value.indexOf('\n', start)) {
        if (partLen + (nl - start) > max) throw tooLong()
        const tail = value.slice(start, nl)
        const line = parts.length ? parts.join('') + tail : tail
        parts = []
        partLen = 0
        start = nl + 1
        yield line
      }
      if (start < value.length) {
        partLen += value.length - start
        if (partLen > max) throw tooLong()
        parts.push(value.slice(start))
      }
    }
    if (partLen) yield parts.join('')
  } finally {
    reader.cancel().catch(() => {})
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
  o: SnapshotReadOptions = {},
): Promise<SnapshotReader> {
  const cctx: ContainerContext = { kind: 'snap', deviceId: ctx.deviceId, n: ctx.n }
  const text = toStream(source)
    .pipeThrough(decryptStream(keys, cctx))
    .pipeThrough(new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>)
    .pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>)
  const lines = splitLines(text)
  const first = await lines.next().catch(corruptOn)
  if (first.done) throw new FormatError('corrupt', 'empty snapshot')
  const header = checkSnapshotHeader(parseJson(utf8(first.value)), ctx, o)
  async function* records(): AsyncGenerator<RecordDelta, void, undefined> {
    let n = 0
    try {
      for (;;) {
        const r = await lines.next().catch(corruptOn)
        if (r.done) break
        if (!r.value) continue
        const d = parseJson(utf8(r.value))
        checkRecordDelta(d, 'snapshot record')
        if (++n > header.records) throw new FormatError('corrupt', `snapshot has more records than its header says (${header.records})`)
        yield d
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
 * snapshot without downloading it.
 */
export async function readSnapshotHeader(
  keys: LibraryKeys,
  ctx: { deviceId: string; n: number },
  bytes: Uint8Array,
  o: SnapshotReadOptions = {},
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
      if (nl >= 0) return checkSnapshotHeader(parseJson(utf8(text.slice(0, nl))), ctx, o)
      if (done || text.length > 1024 * 1024) throw new FormatError('corrupt', 'snapshot header line not found')
    }
  } catch (e) {
    return corruptOn(e)
  } finally {
    reader.cancel().catch(() => {})
    writer.abort().catch(() => {})
  }
}

/** Largest object `objectStream` accepts in one GET when the backend can't do ranges. */
export const OBJECT_STREAM_MAX = 1024 * 1024 * 1024

/**
 * Streams an object through range GETs of `RANGE` chunks (4 MiB) at a time, so a large snapshot is never
 * whole in memory. Falls back to one GET (of at most `maxBytes`) when the backend can't do ranges. Errors
 * with `BackendError('notFound')` if the object is missing.
 */
export function objectStream(
  backend: StorageBackend,
  key: string,
  o: { signal?: AbortSignal; rangeBytes?: number; maxBytes?: number } = {},
): ReadableStream<Uint8Array> {
  const step = o.rangeBytes ?? RANGE * (CHUNK + CHUNK_OVERHEAD)
  let pos = 0
  let done = false
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (done) return c.close()
      const range: [number, number] | undefined = backend.caps.rangeGet ? [pos, pos + step - 1] : undefined
      const data = await backend.get(key, { range, signal: o.signal, maxBytes: o.maxBytes ?? OBJECT_STREAM_MAX })
      if (data === null) throw new BackendError('notFound', `${key} not found`, { status: 404 })
      pos += data.length
      if (!range || data.length < step) done = true
      if (data.length) c.enqueue(data)
      if (done) c.close()
    },
  })
}
