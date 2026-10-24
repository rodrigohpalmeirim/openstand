// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CHUNK_OVERHEAD,
  FIRST_CHUNK_RANGE,
  FormatError,
  HEADER_BYTES,
  b64url,
  base32,
  bytesEqual,
  blobContext,
  blobName,
  bytesSource,
  blobSource,
  chunkByteRange,
  chunkCount,
  ciphertextSize,
  concatBytes,
  decryptChunk,
  decryptChunks,
  decryptContainer,
  decryptStream,
  deriveLibraryKeys,
  encryptChunks,
  fromB64url,
  hexToBytes,
  newDeviceId,
  newSecret,
  open,
  openNotice,
  parseContainerHeader,
  seal,
  sealAad,
  sealNotice,
  sha256Hex,
  utf8,
  type ContainerContext,
  type LibraryKeys,
} from './crypto'
import { CHUNK } from './model'

/** Byte equality without vitest's element-by-element deep diff (slow for MiBs). */
function same(a: Uint8Array, b: Uint8Array) {
  if (bytesEqual(a, b)) return
  let i = 0
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
  expect.fail(`bytes differ: lengths ${a.length}/${b.length}, first difference at ${i}`)
}

const SECRET = new Uint8Array(32).map((_, i) => i)
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Deterministic test bytes. */
function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 255
  }
  return out
}

async function encryptAll(keys: LibraryKeys, data: Uint8Array, ctx: ContainerContext) {
  const src = encryptChunks(keys, bytesSource(data), ctx)
  return src.read(0, src.size)
}

const keysP = deriveLibraryKeys(SECRET)
const otherKeysP = deriveLibraryKeys(new Uint8Array(32).fill(9))

describe('encodings', () => {
  it('base32 matches RFC 4648 vectors (lowercase, unpadded)', () => {
    const v: [string, string][] = [['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi']]
    for (const [i, o] of v) expect(base32(utf8(i))).toBe(o)
  })
  it('base64url round-trips and rejects garbage', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33, 100]) expect(fromB64url(b64url(bytes(n, n + 1)))).toEqual(bytes(n, n + 1))
    expect(b64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect(() => fromB64url('ab+c')).toThrow()
    expect(() => fromB64url('a')).toThrow()
  })
  it('ids have the right shape', () => {
    expect(newDeviceId()).toMatch(/^[0-9a-f]{16}$/)
    expect(newSecret().length).toBe(32)
  })
})

describe('deriveLibraryKeys', () => {
  it('golden vectors: a fixed secret gives fixed ids and blob names', async () => {
    const k = await keysP
    expect(k.libraryId).toBe('y6tckgvmfobn7lk4m5ieh6ji2y')
    expect(k.roomId).toBe('ios6urygac43ie2duawuxltqru')
    expect(await blobName(k, EMPTY_SHA)).toBe('ir7a7dutsfja5nuvhe7su7j3ct7c5k55zdvpm2jq6bcv3agpppjq')
  })

  it('matches an independent HKDF/HMAC implementation (node:crypto)', async () => {
    // Loaded by name so the app tsconfig (no Node types) still compiles this file.
    const nc = (await import(/* @vite-ignore */ 'node:' + 'crypto')) as {
      hkdfSync(d: string, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number): ArrayBuffer
      createHmac(d: string, key: Uint8Array): { update(b: Uint8Array): { digest(): Uint8Array } }
    }
    const k = await keysP
    const h = (info: string, n: number) => new Uint8Array(nc.hkdfSync('sha256', SECRET, utf8('openstand-sync-v1'), utf8(info), n))
    expect(k.libraryId).toBe(base32(h('library-id', 16)))
    expect(k.roomId).toBe(base32(h('room-id', 16)))
    const sha = 'ab'.repeat(32)
    expect(await blobName(k, sha)).toBe(base32(nc.createHmac('sha256', h('blob-name', 32)).update(hexToBytes(sha)).digest()))
  })

  it('accepts the base64url form, rejects other lengths, keys are non-extractable', async () => {
    const k = await deriveLibraryKeys(b64url(SECRET))
    expect(k.libraryId).toBe((await keysP).libraryId)
    expect(k.libraryId).toMatch(/^[a-z2-7]{26}$/)
    expect(k.enc.get(0)!.extractable).toBe(false)
    expect(k.name.extractable).toBe(false)
    await expect(deriveLibraryKeys(new Uint8Array(31))).rejects.toThrow()
  })

  it('blobName needs a lowercase sha256 hex', async () => {
    const k = await keysP
    expect(await blobName(k, EMPTY_SHA)).toMatch(/^[a-z2-7]{52}$/)
    await expect(blobName(k, EMPTY_SHA.toUpperCase())).rejects.toThrow()
    await expect(blobName(k, 'abc')).rejects.toThrow()
  })
})

describe('sealed envelope', () => {
  const batch = { kind: 'batch', deviceId: '0123456789abcdef', seq: 7 } as const

  it('round-trips and has the documented layout', async () => {
    const k = await keysP
    const pt = utf8('{"hello":"world"}')
    const s = await seal(k, batch, pt)
    expect(s[0]).toBe(1)
    expect(s[1]).toBe(0)
    expect(s.length).toBe(2 + 12 + pt.length + 16)
    expect(await open(k, batch, s)).toEqual(pt)
    expect(sealAad(k, batch)).toBe(`os1|batch|${k.libraryId}|0123456789abcdef|7`)
    expect(sealAad(k, { kind: 'meta' })).toBe(`os1|meta|${k.libraryId}|`)
    expect(sealAad(k, { kind: 'notice' })).toBe(`os1|notice|${k.roomId}`)
  })

  it('fails with the wrong AAD (path), key, version or epoch, and on tampering', async () => {
    const k = await keysP
    const s = await seal(k, batch, utf8('x'))
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: FormatError) => e.code)
    expect(await code(open(k, { ...batch, seq: 8 }, s))).toBe('corrupt')
    expect(await code(open(k, { kind: 'batch', deviceId: 'fedcba9876543210', seq: 7 }, s))).toBe('corrupt')
    expect(await code(open(k, { kind: 'device', deviceId: '0123456789abcdef' }, s))).toBe('corrupt')
    expect(await code(open(await otherKeysP, batch, s))).toBe('corrupt')
    for (let i = 2; i < s.length; i++) {
      const t = s.slice()
      t[i] ^= 1
      expect(await code(open(k, batch, t))).toBe('corrupt')
    }
    const v2 = s.slice()
    v2[0] = 2
    expect(await code(open(k, batch, v2))).toBe('newerFormat')
    const e1 = s.slice()
    e1[1] = 1
    expect(await code(open(k, batch, e1))).toBe('newerFormat')
    expect(await code(open(k, batch, s.subarray(0, 20)))).toBe('corrupt')
  })

  it('uses a fresh nonce every time', async () => {
    const k = await keysP
    const a = await seal(k, { kind: 'meta' }, utf8('same'))
    const b = await seal(k, { kind: 'meta' }, utf8('same'))
    expect(a).not.toEqual(b)
  })
})

describe('notices', () => {
  it('round-trip, stay small, and ignore anything else', async () => {
    const k = await keysP
    const frame = await sealNotice(k, { d: '0123456789abcdef', s: 42 })
    expect(frame.length).toBeLessThan(200)
    expect(JSON.parse(frame).v).toBe(1)
    expect(await openNotice(k, frame)).toEqual({ d: '0123456789abcdef', s: 42 })
    expect(await openNotice(await otherKeysP, frame)).toBeNull()
    expect(await openNotice(k, '{"pong":1}')).toBeNull()
    expect(await openNotice(k, 'garbage')).toBeNull()
    expect(await openNotice(k, JSON.stringify({ v: 2, n: JSON.parse(frame).n }))).toBeNull()
    // A notice sealed for the room can't be replayed as a batch envelope, and vice versa.
    const sealed = fromB64url(JSON.parse(frame).n)
    await expect(open(k, { kind: 'meta' }, sealed)).rejects.toBeInstanceOf(FormatError)
  })
})

describe('chunked container', () => {
  const SIZES = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 5]

  it('sizes and ranges follow §4.2', () => {
    expect(ciphertextSize(0)).toBe(16 + 28)
    expect(ciphertextSize(CHUNK)).toBe(16 + 28 + CHUNK)
    expect(ciphertextSize(CHUNK + 1)).toBe(16 + 56 + CHUNK + 1)
    expect(chunkCount(0)).toBe(1)
    expect(chunkCount(3 * CHUNK + 5)).toBe(4)
    expect(chunkByteRange({ size: 3 * CHUNK + 5 }, 1, 2)).toEqual([16 + (CHUNK + 28), 16 + 3 * (CHUNK + 28) - 1])
    expect(chunkByteRange({ size: 3 * CHUNK + 5 }, 3, 4)).toEqual([16 + 3 * (CHUNK + 28), 16 + 3 * (CHUNK + 28) + 5 + 28 - 1])
    expect(() => chunkByteRange({ size: 10 }, 1)).toThrow()
  })

  for (const size of SIZES) {
    it(`round-trips ${size} bytes (blob and snapshot)`, async () => {
      const k = await keysP
      const data = bytes(size, size + 3)
      const sha = await sha256Hex(data)
      for (const ctx of [await blobContext(k, sha), { kind: 'snap', deviceId: '0123456789abcdef', n: 3 } as const]) {
        const ct = await encryptAll(k, data, ctx)
        expect(ct.length).toBe(ciphertextSize(size))
        const h = parseContainerHeader(ct)
        expect([h.version, h.epoch, h.log2Chunk, h.flags, h.size]).toEqual([1, 0, 20, ctx.kind === 'blob' ? 1 : 0, size])
        expect(new TextDecoder().decode(ct.subarray(0, 4))).toBe('OSC1')
        same(await decryptContainer(k, ctx, ct), data)
      }
    })
  }

  it('blob ciphertext is deterministic, byte-identical across runs and range reads', async () => {
    const k = await keysP
    const k2 = await deriveLibraryKeys(b64url(SECRET))
    const data = bytes(2 * CHUNK + 77, 5)
    const ctx = await blobContext(k, await sha256Hex(data))
    const a = await encryptAll(k, data, ctx)
    const b = await encryptAll(k2, data, ctx)
    same(a, b)
    // Arbitrary, chunk-crossing ranges from a fresh source match the whole.
    const src = encryptChunks(k, bytesSource(data), ctx)
    for (const [s, e] of [[0, 5], [10, CHUNK + 100], [CHUNK + 40, 2 * CHUNK + 90], [a.length - 3, a.length], [7, 7]])
      same(await src.read(s, e), a.subarray(s, e))
    // Snapshots use random nonces: different each time, but consistent within one source.
    const sctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 1 } as const
    const s1 = encryptChunks(k, bytesSource(data), sctx)
    const whole = await s1.read(0, s1.size)
    expect(bytesEqual(whole, await encryptAll(k, data, sctx))).toBe(false)
    same(concatBytes([await s1.read(0, CHUNK), await s1.read(CHUNK, s1.size)]), whole)
  })

  it('decrypts any chunk on its own (resume from chunk k) and in ranges', async () => {
    const k = await keysP
    const data = bytes(3 * CHUNK + 5, 9)
    const ctx = await blobContext(k, await sha256Hex(data))
    const ct = await encryptAll(k, data, ctx)
    const h = parseContainerHeader(ct.subarray(0, HEADER_BYTES))
    for (let i = 0; i < 4; i++) {
      const [s, e] = chunkByteRange(h, i)
      const pt = await decryptChunk(k, h, ctx, i, ct.subarray(s, e + 1))
      same(pt, data.subarray(i * CHUNK, Math.min(data.length, (i + 1) * CHUNK)))
    }
    const [s, e] = chunkByteRange(h, 1, 4)
    const parts = await decryptChunks(k, h, ctx, 1, ct.subarray(s, e + 1))
    expect(parts.length).toBe(3)
    same(concatBytes(parts), data.subarray(CHUNK))
    expect(FIRST_CHUNK_RANGE).toEqual([0, 16 + CHUNK + 28 - 1])
  })

  it('detects a flipped bit, reordered chunks, a dropped last chunk, a wrong context or key', async () => {
    const k = await keysP
    const data = bytes(3 * CHUNK + 5, 4)
    const sha = await sha256Hex(data)
    const ctx = await blobContext(k, sha)
    const ct = await encryptAll(k, data, ctx)
    const fails = async (bytes: Uint8Array, c: ContainerContext = ctx, keys = k) => {
      const e = await decryptContainer(keys, c, bytes).then(() => null, (x: unknown) => x)
      expect(e).toBeInstanceOf(FormatError)
      return (e as FormatError).code
    }
    for (const pos of [0, 5, 8, 15, 16, 30, 16 + CHUNK + 27, ct.length - 1]) {
      const t = ct.slice()
      t[pos] ^= 0x10
      expect(await fails(t)).toMatch(/corrupt|newerFormat/)
    }
    // swap chunks 0 and 1 (same length)
    const L = CHUNK + CHUNK_OVERHEAD
    const sw = ct.slice()
    sw.set(ct.subarray(16 + L, 16 + 2 * L), 16)
    sw.set(ct.subarray(16, 16 + L), 16 + L)
    expect(await fails(sw)).toBe('corrupt')
    // drop the last chunk and lie about the size, so the length check passes: the last-flag catches it
    const h = parseContainerHeader(ct)
    const trunc = ct.slice(0, 16 + 3 * L)
    new DataView(trunc.buffer).setBigUint64(8, BigInt(3 * CHUNK))
    expect(await fails(trunc)).toBe('corrupt')
    // …and per chunk: chunk 2 isn't the last one, so it can't pass as last
    const lied = parseContainerHeader(trunc)
    await expect(decryptChunk(k, lied, ctx, 2, ct.subarray(16 + 2 * L, 16 + 3 * L))).rejects.toBeInstanceOf(FormatError)
    expect(await fails(ct.subarray(0, ct.length - 1))).toBe('corrupt')
    expect(await fails(ct, await blobContext(k, 'cd'.repeat(32)))).toBe('corrupt')
    expect(await fails(ct, ctx, await otherKeysP)).toBe('corrupt')
    // a snapshot container moved to another key path fails
    const sctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 4 } as const
    const snap = await encryptAll(k, data.subarray(0, 100), sctx)
    expect(await fails(snap, { ...sctx, n: 5 })).toBe('corrupt')
    expect(h.size).toBe(data.length)
  })

  it('rejects unknown versions and epochs as newerFormat', async () => {
    const k = await keysP
    const ctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 1 } as const
    const ct = await encryptAll(k, utf8('hi'), ctx)
    const v = ct.slice()
    v[4] = 2
    expect(() => parseContainerHeader(v)).toThrow(expect.objectContaining({ code: 'newerFormat' }))
    const e = ct.slice()
    e[5] = 1
    await expect(decryptContainer(k, ctx, e)).rejects.toMatchObject({ code: 'newerFormat' })
    expect(() => parseContainerHeader(utf8('NOPE0000000000000000'))).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })

  it('streams: any split of the input decrypts; truncation and trailing bytes fail', async () => {
    const k = await keysP
    const data = bytes(2 * CHUNK + 999, 8)
    const ctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 2 } as const
    const ct = await encryptAll(k, data, ctx)
    const run = async (input: Uint8Array, step: number) => {
      const rs = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < input.length; i += step) c.enqueue(input.slice(i, i + step))
          c.close()
        },
      })
      const parts: Uint8Array[] = []
      const reader = rs.pipeThrough(decryptStream(k, ctx)).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return concatBytes(parts)
    }
    for (const step of [4093, 65536, CHUNK + 28, ct.length]) same(await run(ct, step), data)
    await expect(run(ct.subarray(0, ct.length - 100), 65536)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(run(ct.subarray(0, 10), 65536)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(run(concatBytes([ct, new Uint8Array(3)]), 65536)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('encrypts a several-MiB Blob through Blob.slice, reading only what each range needs', async () => {
    const k = await keysP
    const data = bytes(6 * CHUNK + 12345, 21)
    const blob = new Blob([data])
    const reads: [number, number][] = []
    const base = blobSource(blob)
    const src = {
      size: base.size,
      read: (s: number, e: number) => {
        reads.push([s, e])
        return base.read(s, e)
      },
    }
    const ctx = await blobContext(k, await sha256Hex(blob))
    const enc = encryptChunks(k, src, ctx)
    const parts: Uint8Array[] = []
    const PART = 8 * (CHUNK + 28)
    for (let s = 0; s < enc.size; ) {
      const e = Math.min(enc.size, s === 0 ? 16 + PART : s + PART)
      parts.push(await enc.read(s, e))
      s = e
    }
    expect(Math.max(...reads.map(([s, e]) => e - s))).toBeLessThanOrEqual(CHUNK)
    expect(reads.length).toBe(chunkCount(data.length))
    same(await decryptContainer(k, ctx, concatBytes(parts)), data)
  })
})
