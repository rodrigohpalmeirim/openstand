// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MemoryBackend } from './backends/memory'
import {
  decodeBatch,
  decodeDevice,
  decodeMeta,
  encodeBatch,
  encodeDevice,
  encodeMeta,
  gunzip,
  gzip,
  objectStream,
  readSnapshot,
  readSnapshotHeader,
  SNAPSHOT_MAX_SKEW,
  splitLines,
  writeSnapshot,
  type SnapshotInfo,
} from './codec'
import { FIRST_CHUNK_RANGE, FormatError, b64url, bytesEqual, bytesSource, concatBytes, deriveLibraryKeys, encryptChunks, sealAad, seal, utf8 } from './crypto'
import type { Batch, DeviceRecord, RecordDelta } from './model'
import { snapKey } from './paths'

const keysP = deriveLibraryKeys(new Uint8Array(32).fill(1))
const DEV = '00112233445566ff'
const HLC = '0000018f00000000' + DEV

function records(n: number, big = 0): RecordDelta[] {
  return Array.from({ length: n }, (_, i) => ({
    c: 'song',
    id: `song-${i}`,
    a: [HLC, i % 7 !== 0],
    f: { title: [HLC, `Song ${i} ✓ "quoted"\nline`], notes: big ? [HLC, b64url(crypto.getRandomValues(new Uint8Array(big)))] : [HLC] },
    m: { createdAt: i },
    l: { tags: { e: { rock: [HLC, 'rock', HLC], gone: [HLC, null, HLC] } } },
    n: { playCount: { [DEV]: [i, 0] } },
  }))
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const info = (n: number, recs: number): SnapshotInfo => ({
  d: DEV,
  n,
  t: 1_700_000_000_000,
  vector: { [DEV]: 12, ffeeddccbbaa9988: 3 },
  records: recs,
  hlcMax: HLC,
  horizon: { deadFields: 1, elementTombs: 2 },
})

describe('gzip', () => {
  it('round-trips and rejects garbage and bombs', async () => {
    const data = utf8('hello '.repeat(1000))
    const gz = await gzip(data)
    expect(gz.length).toBeLessThan(100)
    expect(bytesEqual(await gunzip(gz), data)).toBe(true)
    await expect(gunzip(utf8('not gzip'))).rejects.toMatchObject({ code: 'corrupt' })
    await expect(gunzip(gz, 100)).rejects.toMatchObject({ code: 'corrupt' })
  })
})

describe('envelopes', () => {
  const batch: Batch = { v: 1, d: DEV, s: 5, t: 1, hlcMax: HLC, ops: records(3), blobsReady: ['ab'.repeat(32)] }

  it('batch round-trip; bound to its device and seq', async () => {
    const k = await keysP
    const bytes = await encodeBatch(k, batch)
    expect(await decodeBatch(k, bytes, { deviceId: DEV, seq: 5 })).toEqual(batch)
    await expect(decodeBatch(k, bytes, { deviceId: DEV, seq: 6 })).rejects.toMatchObject({ code: 'corrupt' })
    await expect(decodeBatch(k, bytes, { deviceId: 'ffffffffffffffff', seq: 5 })).rejects.toMatchObject({ code: 'corrupt' })
    await expect(decodeBatch(await deriveLibraryKeys(new Uint8Array(32)), bytes, { deviceId: DEV, seq: 5 })).rejects.toBeInstanceOf(FormatError)
  })

  it('a newer batch version is newerFormat; a lying or malformed body is corrupt', async () => {
    const k = await keysP
    const at = { kind: 'batch', deviceId: DEV, seq: 5 } as const
    const mk = async (o: unknown) => seal(k, at, await gzip(utf8(JSON.stringify(o))))
    await expect(decodeBatch(k, await mk({ ...batch, v: 2 }), { deviceId: DEV, seq: 5 })).rejects.toMatchObject({ code: 'newerFormat' })
    await expect(decodeBatch(k, await mk({ ...batch, s: 9 }), { deviceId: DEV, seq: 5 })).rejects.toMatchObject({ code: 'corrupt' })
    await expect(decodeBatch(k, await mk({ ...batch, ops: 'x' }), { deviceId: DEV, seq: 5 })).rejects.toMatchObject({ code: 'corrupt' })
    await expect(decodeBatch(k, await seal(k, at, utf8('{"v":1}')), { deviceId: DEV, seq: 5 })).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('meta and device records round-trip and are bound to their path', async () => {
    const k = await keysP
    const meta = { v: 1 as const, createdAt: 5, name: 'My library' }
    expect(await decodeMeta(k, await encodeMeta(k, meta))).toEqual(meta)
    const dev: DeviceRecord = { v: 1, id: DEV, name: 'iPad', platform: 'ios', appVersion: '0.1.0', createdAt: 1, lastSeenAt: 2, retired: true }
    const bytes = await encodeDevice(k, dev)
    expect(await decodeDevice(k, bytes, DEV)).toEqual(dev)
    await expect(decodeDevice(k, bytes, 'ffffffffffffffff')).rejects.toMatchObject({ code: 'corrupt' })
    await expect(decodeMeta(k, bytes)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(decodeMeta(await deriveLibraryKeys(new Uint8Array(32)), await encodeMeta(k, meta))).rejects.toMatchObject({ code: 'corrupt' })
  })
})

describe('snapshots', () => {
  it('stream round-trip through a container that spans several chunks', async () => {
    const k = await keysP
    const recs = records(400, 6000) // ~2.4 MiB of gzip -> 3 chunks
    async function* gen() {
      yield* recs
    }
    const w = await writeSnapshot(k, info(3, recs.length), gen())
    expect(w.body.size).toBeGreaterThan(2 * 1024 * 1024) // 3 chunks
    expect(w.header).toMatchObject({ v: 1, kind: 'snapshot', d: DEV, n: 3, records: 400 })
    const backend = new MemoryBackend('snap-roundtrip', { caps: { maxSmallPut: 1024 * 1024 }, partSize: 2 * 1024 * 1024 })
    const key = snapKey(k.libraryId, DEV, 3)
    await backend.upload(key, w.body, {})

    // header only, from a range GET of chunk 0
    const first = (await backend.get(key, { range: FIRST_CHUNK_RANGE }))!
    expect(await readSnapshotHeader(k, { deviceId: DEV, n: 3 }, first)).toEqual(w.header)

    // full stream, fetched in small ranges
    const r = await readSnapshot(k, { deviceId: DEV, n: 3 }, objectStream(backend, key, { rangeBytes: 700_000 }))
    expect(r.header).toEqual(w.header)
    expect(await collect(r.records)).toEqual(recs)
  })

  it('small snapshot: sync iterables, header from a short object, empty record set', async () => {
    const k = await keysP
    const w = await writeSnapshot(k, info(1, 2), records(2))
    const bytes = await w.body.read(0, w.body.size)
    expect(await readSnapshotHeader(k, { deviceId: DEV, n: 1 }, bytes)).toEqual(w.header)
    const r = await readSnapshot(k, { deviceId: DEV, n: 1 }, bytes)
    expect(await collect(r.records)).toEqual(records(2))
    const e = await writeSnapshot(k, info(2, 0), [])
    const er = await readSnapshot(k, { deviceId: DEV, n: 2 }, await e.body.read(0, e.body.size))
    expect(er.header.records).toBe(0)
    expect(await collect(er.records)).toEqual([])
  })

  it('rejects a record count that disagrees with the header', async () => {
    const k = await keysP
    await expect(writeSnapshot(k, info(1, 3), records(2))).rejects.toThrow(/3 records/)
  })

  it('fails on tampering, truncation and the wrong location', async () => {
    const k = await keysP
    const recs = records(200, 6000)
    const w = await writeSnapshot(k, info(4, recs.length), recs)
    const bytes = await w.body.read(0, w.body.size)
    await expect(readSnapshot(k, { deviceId: DEV, n: 5 }, bytes)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(readSnapshotHeader(k, { deviceId: DEV, n: 5 }, bytes)).rejects.toMatchObject({ code: 'corrupt' })
    const tampered = bytes.slice()
    tampered[tampered.length - 100] ^= 1
    const readAll = (b: Uint8Array) => readSnapshot(k, { deviceId: DEV, n: 4 }, b).then((r) => collect(r.records))
    expect(w.body.size).toBeGreaterThan(1024 * 1024 + 100) // tampering below hits a later chunk
    await expect(readAll(tampered)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(readAll(bytes.subarray(0, bytes.length - 2000))).rejects.toMatchObject({ code: 'corrupt' })
    await expect(readAll(bytes.subarray(0, 1024 * 1024 + 44))).rejects.toMatchObject({ code: 'corrupt' }) // drop whole chunks
    expect((await readAll(bytes)).length).toBe(recs.length)
  })

  it('objectStream: whole-object fallback and missing objects', async () => {
    const b = new MemoryBackend('objstream', { caps: { rangeGet: false } })
    await b.put('x', utf8('abcdef'))
    const parts: Uint8Array[] = []
    const reader = objectStream(b, 'x', { rangeBytes: 2 }).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(parts.length).toBe(1)
    await expect(objectStream(b, 'missing').getReader().read()).rejects.toMatchObject({ code: 'notFound' })
  })
})

describe('input validation', () => {
  const at = { kind: 'batch', deviceId: DEV, seq: 5 } as const
  const base: Batch = { v: 1, d: DEV, s: 5, t: 1, hlcMax: HLC, ops: records(2) }
  const decodeRaw = async (json: string) => decodeBatch(await keysP, await seal(await keysP, at, await gzip(utf8(json))), { deviceId: DEV, seq: 5 })
  const decode = async (o: unknown) => decodeRaw(JSON.stringify(o))

  it('batches: hlcMax and every HLC in every op must be valid', async () => {
    expect((await decode(base)).ops.length).toBe(2)
    const op = (o: object) => ({ ...base, ops: [{ c: 'song', id: 'x', ...o }] })
    for (const bad of [
      { ...base, hlcMax: 'nope' },
      { ...base, hlcMax: HLC.toUpperCase() },
      { ...base, t: 'soon' },
      op({ a: ['nope', true] }),
      op({ a: [HLC, 'yes'] }),
      op({ f: { title: ['nope', 'x'] } }),
      op({ f: { title: [HLC, 'x', 'extra'] } }),
      op({ f: { title: 'x' } }),
      op({ m: { createdAt: 'x' } }),
      op({ l: { tags: { e: { a: [HLC, 'a', 'nope'] } } } }),
      op({ l: { tags: { e: { a: [HLC, 'a'] } } } }),
      op({ l: { tags: { o: ['nope', ['a']] } } }),
      op({ l: { tags: { o: [HLC, [1]] } } }),
      op({ n: { playCount: { [DEV]: [1, -1] } } }),
      op({ id: 5 }),
      { ...base, ops: [5] },
      { ...base, blobsReady: ['not-a-hash'] },
    ])
      await expect(decode(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('batches: __proto__ keys anywhere in an op are corrupt', async () => {
    const h = JSON.stringify(HLC)
    for (const json of [
      `{"v":1,"d":"${DEV}","s":5,"t":0,"hlcMax":${h},"ops":[{"c":"song","id":"p","f":{"__proto__":[${h},{"polluted":"yes"}],"title":[${h},"t"]}}]}`,
      `{"v":1,"d":"${DEV}","s":5,"t":0,"hlcMax":${h},"ops":[{"c":"song","id":"p","l":{"pageSettings":{"e":{"__proto__":[${h},{"x":1},${h}]}}}}]}`,
      `{"v":1,"d":"${DEV}","s":5,"t":0,"hlcMax":${h},"ops":[{"c":"song","id":"p","l":{"__proto__":{}}}]}`,
      `{"v":1,"d":"${DEV}","s":5,"t":0,"hlcMax":${h},"ops":[{"c":"song","id":"p","n":{"plays":{"__proto__":[1,0]}}}]}`,
    ])
      await expect(decodeRaw(json)).rejects.toMatchObject({ code: 'corrupt' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('snapshot headers are validated strictly', async () => {
    const k = await keysP
    const now = 1_700_000_000_000
    const read = async (over: Record<string, unknown>, o: { now?: number } = { now }) => {
      // Built by hand: writeSnapshot itself refuses a header whose count disagrees.
      const header = JSON.stringify({ v: 1, kind: 'snapshot', ...info(1, 0), ...over }) + '\n'
      const src = encryptChunks(k, bytesSource(await gzip(utf8(header))), { kind: 'snap', deviceId: DEV, n: 1 })
      const bytes = await src.read(0, src.size)
      const viaHeader = await formatCode(readSnapshotHeader(k, { deviceId: DEV, n: 1 }, bytes, o))
      const viaStream = await formatCode(readSnapshot(k, { deviceId: DEV, n: 1 }, bytes, o))
      expect(viaStream).toBe(viaHeader)
      return viaHeader
    }
    expect(await read({})).toBe('ok')
    const vec = (v: Record<string, unknown>) => ({ vector: v })
    for (const bad of [
      vec({ eve: 1 }),
      vec({ [DEV.toUpperCase()]: 1 }),
      vec({ [DEV]: -1 }),
      vec({ [DEV]: 1.5 }),
      vec({ [DEV]: 2 ** 60 }),
      vec({ [DEV]: '3' }),
      { vector: JSON.parse(`{"${DEV}":1,"__proto__":5}`) },
      { vector: [1] },
      { t: now + SNAPSHOT_MAX_SKEW + 60_000 },
      { t: -1 },
      { t: '1' },
      { horizon: { deadFields: now + 1, elementTombs: 0 } },
      { horizon: { deadFields: 0, elementTombs: now + 1 } },
      { horizon: { deadFields: 0 } },
      { records: -1 },
      { records: 1.5 },
      { records: 1e12 },
      { hlcMax: 'nope' },
      { kind: 'snap' },
    ])
      expect(await read({ t: now, ...bad }), JSON.stringify(bad)).toBe('corrupt')
    // A small skew is fine; without a reader clock only the time-independent checks run.
    expect(await read({ t: now + SNAPSHOT_MAX_SKEW - 1000 })).toBe('ok')
    expect(await read({ t: now + 10 * SNAPSHOT_MAX_SKEW }, {})).toBe('ok')
    // The returned header holds only known, validated fields.
    const w = await writeSnapshot(k, { ...info(1, 0), extra: 'x' } as SnapshotInfo, [])
    const h = await readSnapshotHeader(k, { deviceId: DEV, n: 1 }, await w.body.read(0, w.body.size))
    expect(Object.keys(h).sort()).toEqual(['d', 'hlcMax', 'horizon', 'kind', 'n', 'records', 't', 'v', 'vector'])
  })

  it('snapshot records are validated like batch ops, and may not outnumber the header', async () => {
    const k = await keysP
    const bad = { c: 'song', id: 'x', a: ['nope', true] } as unknown as RecordDelta
    const w = await writeSnapshot(k, info(1, 1), [bad])
    const r = await readSnapshot(k, { deviceId: DEV, n: 1 }, await w.body.read(0, w.body.size))
    await expect(collect(r.records)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('splitLines is linear and bounds line length', async () => {
    const stream = (pieces: string[]) =>
      new ReadableStream<string>({
        start(c) {
          for (const p of pieces) c.enqueue(p)
          c.close()
        },
      })
    expect(await collect(splitLines(stream(['a\nb', 'c\n', '', 'd'])))).toEqual(['a', 'bc', 'd'])
    expect(await collect(splitLines(stream(['x'.repeat(10), 'y'.repeat(10), '\n']), 20))).toEqual(['x'.repeat(10) + 'y'.repeat(10)])
    await expect(collect(splitLines(stream(['x'.repeat(10), 'y'.repeat(11), '\n']), 20))).rejects.toMatchObject({ code: 'corrupt' })
    await expect(collect(splitLines(stream(['x'.repeat(30)]), 20))).rejects.toMatchObject({ code: 'corrupt' })
    // One 32 MiB line in 4 KiB pieces, then 200k short lines: fast (was quadratic in the pieces of a line).
    const t0 = performance.now()
    const piece = 'z'.repeat(4096)
    const pieces = Array.from({ length: 8192 }, () => piece)
    pieces.push('\n' + 'ab\n'.repeat(200_000))
    let count = 0
    for await (const line of splitLines(stream(pieces))) count += line ? 1 : 0
    expect(count).toBe(200_001)
    expect(performance.now() - t0).toBeLessThan(3000)
  })

  it('authentic v1 objects are oldFormat through the codec too', async () => {
    const k = await keysP
    const secret = new Uint8Array(32).fill(1)
    const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
    const v1 = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: utf8('openstand-sync-v1'), info: utf8('enc-key/0') },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    )
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const pt = await gzip(utf8(JSON.stringify({ v: 1, createdAt: 1, name: 'old' })))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8(sealAad(k, { kind: 'meta' })) }, v1, pt))
    expect(await formatCode(decodeMeta(k, concatBytes([Uint8Array.of(1, 0), nonce, ct])))).toBe('oldFormat')
  })
})

function formatCode(p: Promise<unknown>) {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof FormatError ? e.code : `not a FormatError: ${String(e)}`),
  )
}
