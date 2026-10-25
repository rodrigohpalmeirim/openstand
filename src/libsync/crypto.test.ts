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
  HASH_INLINE_MAX,
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
  sha256Blob,
  sha256Hex,
  utf8,
  type ContainerContext,
  type LibraryKeys,
} from './crypto'
import { CHUNK } from './model'
import { pad10 } from './paths'

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

/** node:crypto, loaded by name so the app tsconfig (no Node types) still compiles this file. */
type NodeCrypto = {
  hkdfSync(d: string, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number): ArrayBuffer
  createHmac(d: string, key: Uint8Array): { update(b: Uint8Array): { digest(): Uint8Array } }
  createDecipheriv(
    alg: string,
    key: Uint8Array,
    iv: Uint8Array,
  ): { setAAD(a: Uint8Array): void; setAuthTag(t: Uint8Array): void; update(b: Uint8Array): Uint8Array; final(): Uint8Array }
}
const nodeCrypto = () => import(/* @vite-ignore */ 'node:' + 'crypto') as Promise<NodeCrypto>

/** A v1-format writer (the format before 2026-10-24), to check that v1 objects are recognised and refused. */
async function v1Writer(secret: Uint8Array) {
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('openstand-sync-v1'), info: utf8('enc-key/0') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const gcm = async (nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array) =>
    new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: new Uint8Array(aad) }, key, new Uint8Array(pt)))
  return {
    async seal(aad: string, pt: Uint8Array) {
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      return concatBytes([Uint8Array.of(1, 0), nonce, await gcm(nonce, utf8(aad), pt)])
    },
    async container(ctxStr: string, data: Uint8Array, deterministic: boolean) {
      const h = new Uint8Array(16)
      h.set(utf8('OSC1'))
      h.set([1, 0, 20, deterministic ? 1 : 0], 4)
      new DataView(h.buffer).setBigUint64(8, BigInt(data.length))
      const n = chunkCount(data.length)
      const out: Uint8Array[] = [h]
      for (let i = 0; i < n; i++) {
        const nonce = crypto.getRandomValues(new Uint8Array(12))
        out.push(nonce, await gcm(nonce, concatBytes([h, utf8(`|${ctxStr}|${i}|${i === n - 1 ? 1 : 0}`)]), data.subarray(i * CHUNK, (i + 1) * CHUNK)))
      }
      return concatBytes(out)
    },
  }
}

const formatCode = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof FormatError ? e.code : `not a FormatError: ${String(e)}`))

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

  it('v2 keys are separate HKDF outputs per purpose (checked with node:crypto)', async () => {
    const nc = await nodeCrypto()
    const k = await keysP
    const h = (info: string) => new Uint8Array(nc.hkdfSync('sha256', SECRET, utf8('openstand-sync-v1'), utf8(info), 32))
    const gcmOpen = (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ctTag: Uint8Array) => {
      const d = nc.createDecipheriv('aes-256-gcm', key, nonce)
      d.setAAD(aad)
      d.setAuthTag(ctTag.subarray(ctTag.length - 16))
      return concatBytes([d.update(ctTag.subarray(0, ctTag.length - 16)), d.final()])
    }
    // Envelope: envKey = HKDF("v2/envelope/0"), aad = [version, epoch] || path.
    const pt = utf8('{"x":1}')
    const sealed = await seal(k, { kind: 'meta' }, pt)
    same(gcmOpen(h('v2/envelope/0'), sealed.subarray(2, 14), concatBytes([Uint8Array.of(2, 0), utf8(`os1|meta|${k.libraryId}|`)]), sealed.subarray(14)), pt)
    // Blob: blobKey = HKDF("v2/blob/0"); nonce = HMAC(HKDF("v2/blob-nonce/0"), u32be(|aad|) || aad || plaintext)[0..12].
    const data = bytes(CHUNK + 10, 77)
    const ctx = await blobContext(k, await sha256Hex(data))
    const ct = await encryptAll(k, data, ctx)
    const aad0 = concatBytes([ct.subarray(0, 16), utf8(`|blob|${ctx.name}|0|0`)])
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, aad0.length)
    const nonce0 = nc.createHmac('sha256', h('v2/blob-nonce/0')).update(concatBytes([len, aad0, data.subarray(0, CHUNK)])).digest().subarray(0, 12)
    same(ct.subarray(16, 28), nonce0)
    same(gcmOpen(h('v2/blob/0'), nonce0, aad0, ct.subarray(28, 16 + CHUNK + 28)), data.subarray(0, CHUNK))
    // Snapshot: snapKey = HKDF("v2/snapshot/0").
    const sctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 3 } as const
    const sct = await encryptAll(k, utf8('snap'), sctx)
    const saad = concatBytes([sct.subarray(0, 16), utf8(`|snap|${k.libraryId}|0123456789abcdef|${pad10(3)}|0|1`)])
    same(gcmOpen(h('v2/snapshot/0'), sct.subarray(16, 28), saad, sct.subarray(28)), utf8('snap'))
    // No key opens another purpose's ciphertext.
    expect(() => gcmOpen(h('v2/envelope/0'), nonce0, aad0, ct.subarray(28, 16 + CHUNK + 28))).toThrow()
    expect(() => gcmOpen(h('v2/blob/0'), sct.subarray(16, 28), saad, sct.subarray(28))).toThrow()
    expect(() => gcmOpen(h('enc-key/0'), sealed.subarray(2, 14), concatBytes([Uint8Array.of(2, 0), utf8(`os1|meta|${k.libraryId}|`)]), sealed.subarray(14))).toThrow()
  })

  it('accepts the base64url form, rejects other lengths, keys are non-extractable', async () => {
    const k = await deriveLibraryKeys(b64url(SECRET))
    expect(k.libraryId).toBe((await keysP).libraryId)
    expect(k.libraryId).toMatch(/^[a-z2-7]{26}$/)
    for (const key of [k.enc.get(0)!, k.blob.get(0)!, k.snap.get(0)!, k.nonce.get(0)!, k.name, k.v1]) expect(key.extractable).toBe(false)
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
    expect(s[0]).toBe(2)
    expect(s[1]).toBe(0)
    expect(s.length).toBe(2 + 12 + pt.length + 16)
    expect(await open(k, batch, s)).toEqual(pt)
    expect(sealAad(k, batch)).toBe(`os1|batch|${k.libraryId}|0123456789abcdef|7`)
    expect(sealAad(k, { kind: 'meta' })).toBe(`os1|meta|${k.libraryId}|`)
    expect(sealAad(k, { kind: 'notice' })).toBe(`os1|notice|${k.roomId}`)
  })

  it('fails with the wrong AAD (path) or key, and any flipped byte (version and epoch included) is corrupt', async () => {
    const k = await keysP
    const s = await seal(k, batch, utf8('x'))
    expect(await formatCode(open(k, { ...batch, seq: 8 }, s))).toBe('corrupt')
    expect(await formatCode(open(k, { kind: 'batch', deviceId: 'fedcba9876543210', seq: 7 }, s))).toBe('corrupt')
    expect(await formatCode(open(k, { kind: 'device', deviceId: '0123456789abcdef' }, s))).toBe('corrupt')
    expect(await formatCode(open(await otherKeysP, batch, s))).toBe('corrupt')
    for (let i = 0; i < s.length; i++) {
      const t = s.slice()
      t[i] ^= 1
      expect(await formatCode(open(k, batch, t))).toBe('corrupt')
    }
    // Unauthenticated version/epoch bytes never claim a format: not newerFormat, not oldFormat.
    for (const [i, v] of [[0, 1], [0, 3], [0, 255], [1, 1], [1, 255]]) {
      const t = s.slice()
      t[i] = v
      expect(await formatCode(open(k, batch, t))).toBe('corrupt')
    }
    expect(await formatCode(open(k, batch, s.subarray(0, 20)))).toBe('corrupt')
  })

  it('an authentic v1 envelope is oldFormat; a forged or foreign one is corrupt', async () => {
    const k = await keysP
    const v1 = await v1Writer(SECRET)
    const old = await v1.seal(sealAad(k, batch), utf8('{"v":1}'))
    expect(await formatCode(open(k, batch, old))).toBe('oldFormat')
    // v1 still binds the path: elsewhere it doesn't authenticate.
    expect(await formatCode(open(k, { ...batch, seq: 8 }, old))).toBe('corrupt')
    const t = old.slice()
    t[t.length - 1] ^= 1
    expect(await formatCode(open(k, batch, t))).toBe('corrupt')
    expect(await formatCode(open(await otherKeysP, batch, old))).toBe('corrupt')
    const foreign = await (await v1Writer(new Uint8Array(32).fill(9))).seal(sealAad(k, batch), utf8('{}'))
    expect(await formatCode(open(k, batch, foreign))).toBe('corrupt')
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

  it('carry ping/pong for the connection test, validated, and plain notices still need s ≥ 1', async () => {
    const k = await keysP
    const d = '0123456789abcdef'
    const to = 'fedcba9876543210'
    const ping = await sealNotice(k, { d, s: 0, k: 'ping', p: 'nonce-1234567' })
    expect(ping.length).toBeLessThan(300)
    expect(await openNotice(k, ping)).toEqual({ d, s: 0, k: 'ping', p: 'nonce-1234567' })
    const pong = await sealNotice(k, { d, s: 7, k: 'pong', p: 'nonce-1234567', to })
    expect(await openNotice(k, pong)).toEqual({ d, s: 7, k: 'pong', p: 'nonce-1234567', to })
    expect(await openNotice(await otherKeysP, pong)).toBeNull()
    // Only the documented fields are sealed.
    expect(await openNotice(k, await sealNotice(k, { d, s: 3, to } as never))).toEqual({ d, s: 3 })
    // Malformed variants are dropped.
    const bad = async (p: object) => {
      const raw = await seal(k, { kind: 'notice' }, new TextEncoder().encode(JSON.stringify(p)))
      return openNotice(k, JSON.stringify({ v: 1, n: b64url(raw) }))
    }
    expect(await bad({ d, s: 0 })).toBeNull()
    expect(await bad({ d, s: 1, k: 'shout', p: 'nonce-1234567' })).toBeNull()
    expect(await bad({ d, s: 1, k: 'ping', p: 'short' })).toBeNull()
    expect(await bad({ d, s: 1, k: 'ping', p: 'has spaces in it' })).toBeNull()
    expect(await bad({ d, s: -1, k: 'ping', p: 'nonce-1234567' })).toBeNull()
    expect(await bad({ d, s: 1, k: 'pong', p: 'nonce-1234567' })).toBeNull()
    expect(await bad({ d, s: 1, k: 'pong', p: 'nonce-1234567', to: 'nope' })).toBeNull()
  })
})

describe('chunked container', () => {
  const SIZES = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 5]

  it('sizes and ranges follow the chunked container layout', () => {
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
        expect([h.version, h.epoch, h.log2Chunk, h.flags, h.size]).toEqual([2, 0, 20, ctx.kind === 'blob' ? 1 : 0, size])
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
      expect(await fails(t)).toBe('corrupt')
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

  it('unknown version or epoch bytes are corrupt (unauthenticated), never newerFormat', async () => {
    const k = await keysP
    const ctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 1 } as const
    const ct = await encryptAll(k, utf8('hi'), ctx)
    for (const [i, v] of [[4, 3], [4, 255], [4, 0], [4, 1], [5, 1], [5, 255]]) {
      const t = ct.slice()
      t[i] = v
      expect(await formatCode(decryptContainer(k, ctx, t))).toBe('corrupt')
    }
    expect(() => parseContainerHeader(utf8('NOPE0000000000000000'))).toThrow(expect.objectContaining({ code: 'corrupt' }))
  })

  it('authentic v1 containers (blob and snapshot) are oldFormat, in every read path', async () => {
    const k = await keysP
    const v1 = await v1Writer(SECRET)
    const data = bytes(CHUNK + 300, 12)
    const bctx = await blobContext(k, await sha256Hex(data))
    const blob = await v1.container(`blob|${bctx.name}`, data, true)
    expect(await formatCode(decryptContainer(k, bctx, blob))).toBe('oldFormat')
    const h = parseContainerHeader(blob)
    expect(h.version).toBe(1)
    const [s, e] = chunkByteRange(h, 1)
    expect(await formatCode(decryptChunk(k, h, bctx, 1, blob.subarray(s, e + 1)))).toBe('oldFormat')
    const sctx = { kind: 'snap', deviceId: '0123456789abcdef', n: 2 } as const
    const snap = await v1.container(`snap|${k.libraryId}|0123456789abcdef|${pad10(2)}`, utf8('{}'), false)
    const rs = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(snap)
        c.close()
      },
    })
    expect(await formatCode(rs.pipeThrough(decryptStream(k, sctx)).getReader().read())).toBe('oldFormat')
    // Moved, tampered or foreign v1 objects don't authenticate: corrupt.
    expect(await formatCode(decryptContainer(k, { ...sctx, n: 3 }, snap))).toBe('corrupt')
    const t = blob.slice()
    t[40] ^= 1
    expect(await formatCode(decryptContainer(k, bctx, t))).toBe('corrupt')
    expect(await formatCode(decryptContainer(await otherKeysP, bctx, blob))).toBe('corrupt')
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

  it('blob nonces derive from the content: a wrong claimed hash cannot cause nonce reuse', async () => {
    // Regression: v1 derived nonces from the claimed SHA-256 only, so two different files filed under the
    // same (wrong) hash shared nonces and c1 ^ c2 ^ p2 recovered p1.
    const k = await keysP
    const claimed = 'ab'.repeat(32)
    const ctx = await blobContext(k, claimed)
    const p1 = utf8('genuine score bytes ..............')
    const p2 = utf8('attacker-known bytes, same length!')
    expect(p1.length).toBe(p2.length)
    const c1 = await encryptAll(k, p1, ctx)
    const c2 = await encryptAll(k, p2, ctx)
    expect(bytesEqual(c1.subarray(16, 28), c2.subarray(16, 28))).toBe(false)
    const x = c1.subarray(28, 28 + p1.length).map((b, i) => b ^ c2[28 + i] ^ p2[i])
    expect(bytesEqual(x, p1)).toBe(false)
    // Identical content at the same position still gives identical bytes (resumable, idempotent uploads)…
    same(await encryptAll(k, p1, ctx), c1)
    // …and the same chunk content at another index, or in a file of another size, gets another nonce.
    const twice = concatBytes([bytes(CHUNK, 3), bytes(CHUNK, 3)])
    const ct2 = await encryptAll(k, twice, await blobContext(k, await sha256Hex(twice)))
    expect(bytesEqual(ct2.subarray(16, 28), ct2.subarray(16 + CHUNK + 28, 16 + CHUNK + 40))).toBe(false)
    const longer = concatBytes([p1, utf8('!')])
    expect(bytesEqual((await encryptAll(k, longer, ctx)).subarray(16, 28), c1.subarray(16, 28))).toBe(false)
  })

  it('golden vector: v2 blob ciphertext is pinned', async () => {
    const k = await keysP
    const data = bytes(3000, 7)
    const ct = await encryptAll(k, data, await blobContext(k, await sha256Hex(data)))
    expect(await sha256Hex(ct)).toBe('ae9a0357acad8d41935e92ddaf728ac67354cdb9d32240b37307f3bd8f0caff1')
  })
})

describe('sha256Blob', () => {
  it('matches WebCrypto inline and streamed (above HASH_INLINE_MAX), for one Blob and for parts', async () => {
    const small = bytes(100_000, 5)
    expect(await sha256Blob(new Blob([small]))).toBe(await sha256Hex(small))
    const big = bytes(HASH_INLINE_MAX + 12345, 6)
    const want = await sha256Hex(big)
    expect(await sha256Blob(new Blob([big]))).toBe(want)
    const parts = [new Blob([big.subarray(0, CHUNK)]), new Blob([big.subarray(CHUNK, 5 * CHUNK + 7)]), new Blob([big.subarray(5 * CHUNK + 7)])]
    expect(await sha256Blob(parts)).toBe(want)
  })
})
