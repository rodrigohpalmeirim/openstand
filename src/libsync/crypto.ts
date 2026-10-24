/**
 * Library sync cryptography (docs/SYNC.md §2, §4.1, §4.2, §4.3).
 *
 * - `deriveLibraryKeys(secret)`: HKDF-SHA256 → libraryId, roomId, AES-GCM and HMAC keys (non-extractable).
 * - `seal` / `open`: small sealed envelopes (meta, devices, batches, notices) with the AAD bound to the key path.
 * - `encryptChunks` / `decryptChunk`: the chunked container for blobs and snapshots. Encryption is lazy and
 *   random-access (a `ByteSource` that encrypts only the chunks a read touches), so memory stays bounded.
 * - `blobName`, `sealNotice` / `openNotice`.
 *
 * Everything here is pure WebCrypto: it runs in browsers, workers and Node ≥ 20.
 */
import type { ByteSource } from './backends/types'
import { CHUNK, type NoticeFrame, type NoticePayload } from './model'
import { pad10 } from './paths'

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Data that can't be read. `corrupt`: authentication failed, truncated or malformed (wrong key, tampering,
 * or a bug). `newerFormat`: a version or key epoch this build doesn't know (§2, §10.1). The codes match
 * `LibSyncErrorCode`, so the engine can surface them as is.
 */
export class FormatError extends Error {
  readonly code: 'corrupt' | 'newerFormat'
  constructor(code: 'corrupt' | 'newerFormat', message?: string, cause?: unknown) {
    super(message ?? code, cause === undefined ? undefined : { cause })
    this.name = 'FormatError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------
// Byte helpers (exported: pairing, codec and the engine use them too)
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder()
export const utf8 = (s: string): Uint8Array<ArrayBuffer> => enc.encode(s)

/** WebCrypto wants `ArrayBuffer`-backed views; copy only when the input is backed by something else. */
export function ab(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return u.buffer instanceof ArrayBuffer ? (u as Uint8Array<ArrayBuffer>) : new Uint8Array(u)
}

export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. */
export function base32(b: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (let i = 0; i < b.length; i++) {
    acc = (acc << 8) | b[i]
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
  return out
}

/** base64url without padding. */
export function b64url(b: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Strict base64url decode (padding optional). Throws `TypeError` on anything else. */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.replace(/=+$/, '').length % 4 === 1) throw new TypeError('invalid base64url')
  const t = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n))

/** A new 32-byte library secret (§2). */
export const newSecret = (): Uint8Array<ArrayBuffer> => randomBytes(32)

/** 16 lowercase hex chars (64 random bits). New on every join, never reused (§2). */
export const newDeviceId = (): string => bytesToHex(randomBytes(8))

export async function sha256Hex(data: Uint8Array | Blob): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : ab(data)
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
}

// ---------------------------------------------------------------------------------------------
// §2 Keys
// ---------------------------------------------------------------------------------------------

export const SECRET_BYTES = 32
const SALT = utf8('openstand-sync-v1')
/** Current key epoch (§2). Epoch > 0 is reserved for a future keyring. */
export const KEY_EPOCH = 0

export interface LibraryKeys {
  /** 26 chars `[a-z2-7]`: the storage path segment. */
  readonly libraryId: string
  /** 26 chars `[a-z2-7]`: the relay room. Independent of `libraryId`. */
  readonly roomId: string
  /** Epoch new ciphertexts are written with. */
  readonly epoch: number
  /** AES-GCM-256 `encKey[epoch]`. Readers reject epochs that are not in here (`newerFormat`). */
  readonly enc: ReadonlyMap<number, CryptoKey>
  /** HMAC-SHA-256 `nonceKey[epoch]` for deterministic blob chunk nonces. */
  readonly nonce: ReadonlyMap<number, CryptoKey>
  /** HMAC-SHA-256 `nameKey` for blob object names. */
  readonly name: CryptoKey
}

/** `secret`: the raw 32 bytes, or their base64url form (`SyncConfig.secret`, `PairingPayload.s`). */
export async function deriveLibraryKeys(secret: Uint8Array | string): Promise<LibraryKeys> {
  const raw = typeof secret === 'string' ? fromB64url(secret) : ab(secret)
  if (raw.length !== SECRET_BYTES) throw new TypeError(`library secret must be ${SECRET_BYTES} bytes`)
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey'])
  const p = (label: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: utf8(label) })
  const bits = async (label: string) => new Uint8Array(await crypto.subtle.deriveBits(p(label), ikm, 128))
  const hmac = (label: string) =>
    crypto.subtle.deriveKey(p(label), ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  const e = KEY_EPOCH
  const [libraryId, roomId, encKey, nameKey, nonceKey] = await Promise.all([
    bits('library-id').then(base32),
    bits('room-id').then(base32),
    crypto.subtle.deriveKey(p(`enc-key/${e}`), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    hmac('blob-name'),
    hmac(`blob-nonce/${e}`),
  ])
  return { libraryId, roomId, epoch: e, enc: new Map([[e, encKey]]), nonce: new Map([[e, nonceKey]]), name: nameKey }
}

async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ab(data)))
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** `blobs/<blobName>`: base32(HMAC(nameKey, sha256 bytes)), 52 chars (§2). */
export async function blobName(keys: LibraryKeys, sha256: string): Promise<string> {
  if (!SHA256_HEX.test(sha256)) throw new TypeError('sha256 must be 64 lowercase hex chars')
  return base32(await hmac(keys.name, hexToBytes(sha256)))
}

function encKeyFor(keys: LibraryKeys, epoch: number): CryptoKey {
  const k = keys.enc.get(epoch)
  if (!k) throw new FormatError('newerFormat', `unknown key epoch ${epoch}`)
  return k
}

const TAG = 16
const NONCE = 12

async function gcmEncrypt(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad) }, key, ab(pt)))
}

async function gcmDecrypt(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad) }, key, ab(ct)))
  } catch (e) {
    throw new FormatError('corrupt', 'decryption failed (wrong key, wrong location or tampered data)', e)
  }
}

// ---------------------------------------------------------------------------------------------
// §4.1 Sealed envelope
// ---------------------------------------------------------------------------------------------

/** What an envelope is bound to (its AAD). `notice` is bound to the relay room instead of the library. */
export type SealContext =
  | { kind: 'meta' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'batch'; deviceId: string; seq: number }
  | { kind: 'notice' }

export const ENVELOPE_VERSION = 1
const ENV_HEAD = 2 + NONCE

export function sealAad(keys: LibraryKeys, ctx: SealContext): string {
  switch (ctx.kind) {
    case 'meta':
      return `os1|meta|${keys.libraryId}|`
    case 'device':
      return `os1|device|${keys.libraryId}|${ctx.deviceId}`
    case 'batch':
      return `os1|batch|${keys.libraryId}|${ctx.deviceId}|${ctx.seq}`
    case 'notice':
      return `os1|notice|${keys.roomId}`
  }
}

/** `[0x01, epoch, nonce(12), AES-GCM(plaintext) || tag]`. The caller gzips first where §4.1 says so. */
export async function seal(keys: LibraryKeys, ctx: SealContext, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE)
  const ct = await gcmEncrypt(encKeyFor(keys, keys.epoch), nonce, utf8(sealAad(keys, ctx)), plaintext)
  const out = new Uint8Array(ENV_HEAD + ct.length)
  out[0] = ENVELOPE_VERSION
  out[1] = keys.epoch
  out.set(nonce, 2)
  out.set(ct, ENV_HEAD)
  return out
}

/** Throws `FormatError`: `newerFormat` for an unknown version or epoch, `corrupt` for anything else. */
export async function open(keys: LibraryKeys, ctx: SealContext, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < ENV_HEAD + TAG) throw new FormatError('corrupt', 'envelope too short')
  if (sealed[0] !== ENVELOPE_VERSION) throw new FormatError('newerFormat', `unknown envelope version ${sealed[0]}`)
  const key = encKeyFor(keys, sealed[1])
  return gcmDecrypt(key, sealed.subarray(2, ENV_HEAD), utf8(sealAad(keys, ctx)), sealed.subarray(ENV_HEAD))
}

// ---------------------------------------------------------------------------------------------
// §4.3 Relay notices
// ---------------------------------------------------------------------------------------------

const DEVICE_ID = /^[0-9a-f]{16}$/

/** The full relay text frame `{"v":1,"n":"…"}` (JSON, not gzipped, ≤ 1 KiB). */
export async function sealNotice(keys: LibraryKeys, p: NoticePayload): Promise<string> {
  const sealed = await seal(keys, { kind: 'notice' }, utf8(JSON.stringify({ d: p.d, s: p.s })))
  const frame: NoticeFrame = { v: 1, n: b64url(sealed) }
  return JSON.stringify(frame)
}

/**
 * Parses and decrypts a relay frame. Returns `null` for anything that isn't a valid notice for this room
 * (other frames such as `{"pong":1}`, garbage, wrong key): relay traffic is untrusted and never fatal.
 */
export async function openNotice(keys: LibraryKeys, frame: string): Promise<NoticePayload | null> {
  try {
    if (frame.length > 1024) return null
    const f = JSON.parse(frame) as Partial<NoticeFrame>
    if (!f || f.v !== 1 || typeof f.n !== 'string') return null
    const p = JSON.parse(new TextDecoder().decode(await open(keys, { kind: 'notice' }, fromB64url(f.n)))) as NoticePayload
    if (typeof p?.d !== 'string' || !DEVICE_ID.test(p.d) || !Number.isSafeInteger(p.s) || p.s < 1) return null
    return { d: p.d, s: p.s }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// §4.2 Chunked container
// ---------------------------------------------------------------------------------------------

export const CONTAINER_MAGIC = 'OSC1'
export const CONTAINER_VERSION = 1
export const HEADER_BYTES = 16
/** Per-chunk overhead: nonce + tag. */
export const CHUNK_OVERHEAD = NONCE + TAG
const LOG2_CHUNK = Math.log2(CHUNK)
const FLAG_DETERMINISTIC = 1

/** What a container is bound to. `name` = `blobName(keys, sha256)`; use `blobContext` to build it. */
export type BlobContainerContext = { kind: 'blob'; sha256: string; name: string }
export type SnapContainerContext = { kind: 'snap'; deviceId: string; n: number }
export type ContainerContext = BlobContainerContext | SnapContainerContext

export async function blobContext(keys: LibraryKeys, sha256: string): Promise<BlobContainerContext> {
  return { kind: 'blob', sha256, name: await blobName(keys, sha256) }
}

export interface ContainerHeader {
  version: number
  epoch: number
  log2Chunk: number
  flags: number
  /** Plaintext size in bytes. */
  size: number
  /** The 16 header bytes (part of every chunk's AAD). */
  raw: Uint8Array<ArrayBuffer>
}

export const chunkCount = (size: number, chunk = CHUNK): number => Math.max(1, Math.ceil(size / chunk))
/** Encrypted size of a `size`-byte plaintext: `16 + n * 28 + size`. */
export const ciphertextSize = (size: number, chunk = CHUNK): number => HEADER_BYTES + chunkCount(size, chunk) * CHUNK_OVERHEAD + size

function chunkGeom(h: { size: number; log2Chunk: number }) {
  const chunk = 2 ** h.log2Chunk
  const n = chunkCount(h.size, chunk)
  const stride = chunk + CHUNK_OVERHEAD
  const plainLen = (i: number) => (i < n - 1 ? chunk : h.size - (n - 1) * chunk)
  return { chunk, n, stride, plainLen, offset: (i: number) => HEADER_BYTES + i * stride }
}

/**
 * Inclusive ciphertext byte range `[start, end]` covering chunks `first .. first+count-1` (clamped to the
 * last chunk), for `backend.get(key, { range })`. Pass `{ size }` (plaintext size) or a parsed header.
 */
export function chunkByteRange(h: { size: number; log2Chunk?: number }, first: number, count = 1): [number, number] {
  const g = chunkGeom({ size: h.size, log2Chunk: h.log2Chunk ?? LOG2_CHUNK })
  if (!Number.isInteger(first) || first < 0 || first >= g.n || count < 1) throw new RangeError('chunk index out of range')
  const last = Math.min(g.n - 1, first + count - 1)
  return [g.offset(first), g.offset(last) + g.plainLen(last) + CHUNK_OVERHEAD - 1]
}

/** Range for reading the header plus chunk 0 when the size isn't known yet (backends clamp it). */
export const FIRST_CHUNK_RANGE: [number, number] = [0, HEADER_BYTES + CHUNK + CHUNK_OVERHEAD - 1]

function buildHeader(size: number, epoch: number, deterministic: boolean): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(HEADER_BYTES)
  h.set(utf8(CONTAINER_MAGIC), 0)
  h[4] = CONTAINER_VERSION
  h[5] = epoch
  h[6] = LOG2_CHUNK
  h[7] = deterministic ? FLAG_DETERMINISTIC : 0
  new DataView(h.buffer).setBigUint64(8, BigInt(size))
  return h
}

/** Parses the 16-byte header (extra bytes after it are ignored). */
export function parseContainerHeader(bytes: Uint8Array): ContainerHeader {
  if (bytes.length < HEADER_BYTES) throw new FormatError('corrupt', 'container header truncated')
  const raw = new Uint8Array(bytes.subarray(0, HEADER_BYTES))
  if (new TextDecoder().decode(raw.subarray(0, 4)) !== CONTAINER_MAGIC) throw new FormatError('corrupt', 'not a container')
  if (raw[4] !== CONTAINER_VERSION) throw new FormatError('newerFormat', `unknown container version ${raw[4]}`)
  const log2Chunk = raw[6]
  if (log2Chunk < 10 || log2Chunk > 26) throw new FormatError('corrupt', 'bad chunk size')
  const size = new DataView(raw.buffer).getBigUint64(8)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError('corrupt', 'bad size')
  return { version: raw[4], epoch: raw[5], log2Chunk, flags: raw[7], size: Number(size), raw }
}

function containerCtx(keys: LibraryKeys, ctx: ContainerContext): string {
  return ctx.kind === 'blob' ? `blob|${ctx.name}` : `snap|${keys.libraryId}|${ctx.deviceId}|${pad10(ctx.n)}`
}

function chunkAad(header: Uint8Array, ctxStr: string, i: number, last: boolean): Uint8Array {
  return concatBytes([header, utf8(`|${ctxStr}|${i}|${last ? 1 : 0}`)])
}

async function blobNonce(keys: LibraryKeys, epoch: number, sha256: string, log2Chunk: number, i: number): Promise<Uint8Array> {
  const k = keys.nonce.get(epoch)
  if (!k) throw new FormatError('newerFormat', `unknown key epoch ${epoch}`)
  return (await hmac(k, utf8(`${sha256}|${log2Chunk}|${i}`))).subarray(0, NONCE)
}

export interface EncryptedSource extends ByteSource {
  /** The 16 header bytes. */
  readonly header: Uint8Array
  /** Plaintext size. */
  readonly plainSize: number
}

/**
 * The container for `src` as a random-access `ByteSource`: `read(start, end)` encrypts only the chunks
 * that range touches (two most recent chunks cached), so a 2 GB file never sits in memory.
 *
 * Blobs use deterministic nonces, so any byte range is identical across reads, runs and devices
 * (multipart parts can be re-sent after a crash). Snapshots use random nonces, remembered per chunk index
 * (12 B each) so re-reading a range from the same source is still consistent.
 */
export function encryptChunks(keys: LibraryKeys, src: ByteSource, ctx: ContainerContext): EncryptedSource {
  if (ctx.kind === 'blob' && !SHA256_HEX.test(ctx.sha256)) throw new TypeError('sha256 must be 64 lowercase hex chars')
  const epoch = keys.epoch
  const key = encKeyFor(keys, epoch)
  const deterministic = ctx.kind === 'blob'
  const header = buildHeader(src.size, epoch, deterministic)
  const g = chunkGeom({ size: src.size, log2Chunk: LOG2_CHUNK })
  const ctxStr = containerCtx(keys, ctx)
  const randomNonces = new Map<number, Uint8Array>()
  const cache: { i: number; data: Promise<Uint8Array> }[] = []

  const encryptChunk = async (i: number): Promise<Uint8Array> => {
    const start = i * g.chunk
    const pt = await src.read(start, start + g.plainLen(i))
    if (pt.length !== g.plainLen(i)) throw new Error('ByteSource returned a short read')
    let nonce: Uint8Array
    if (deterministic) nonce = await blobNonce(keys, epoch, (ctx as { sha256: string }).sha256, LOG2_CHUNK, i)
    else {
      nonce = randomNonces.get(i) ?? randomBytes(NONCE)
      randomNonces.set(i, nonce)
    }
    const ct = await gcmEncrypt(key, nonce, chunkAad(header, ctxStr, i, i === g.n - 1), pt)
    return concatBytes([nonce, ct])
  }
  const chunkAt = (i: number): Promise<Uint8Array> => {
    const hit = cache.find((c) => c.i === i)
    if (hit) return hit.data
    const data = encryptChunk(i)
    cache.push({ i, data })
    if (cache.length > 2) cache.shift()
    data.catch(() => {
      const k = cache.findIndex((c) => c.data === data)
      if (k >= 0) cache.splice(k, 1)
    })
    return data
  }

  const size = ciphertextSize(src.size)
  return {
    size,
    header,
    plainSize: src.size,
    async read(start: number, end: number): Promise<Uint8Array> {
      if (!(Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= size))
        throw new RangeError(`bad range [${start}, ${end}) of ${size}`)
      const out = new Uint8Array(end - start)
      if (start < HEADER_BYTES) out.set(header.subarray(start, Math.min(end, HEADER_BYTES)), 0)
      let i = Math.floor((Math.max(start, HEADER_BYTES) - HEADER_BYTES) / g.stride)
      for (; i < g.n && g.offset(i) < end; i++) {
        const off = g.offset(i)
        const c = await chunkAt(i)
        const from = Math.max(start, off)
        const to = Math.min(end, off + c.length)
        if (to > from) out.set(c.subarray(from - off, to - off), from - start)
      }
      return out
    },
  }
}

/**
 * Decrypts chunk `i` (`data` = exactly that chunk's `nonce | ciphertext | tag`). The header is needed
 * because it is part of the AAD; read it once with a 16-byte range GET or from the first range.
 */
export async function decryptChunk(
  keys: LibraryKeys,
  header: ContainerHeader,
  ctx: ContainerContext,
  i: number,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const g = chunkGeom(header)
  if (!Number.isInteger(i) || i < 0 || i >= g.n) throw new FormatError('corrupt', `chunk ${i} out of range`)
  if (data.length !== g.plainLen(i) + CHUNK_OVERHEAD) throw new FormatError('corrupt', `chunk ${i} has the wrong length`)
  const key = encKeyFor(keys, header.epoch)
  return gcmDecrypt(key, data.subarray(0, NONCE), chunkAad(header.raw, containerCtx(keys, ctx), i, i === g.n - 1), data.subarray(NONCE))
}

/**
 * Decrypts consecutive whole chunks starting at chunk `first` (`bytes` = what `chunkByteRange(h, first, k)`
 * returned). Returns one plaintext per chunk.
 */
export async function decryptChunks(
  keys: LibraryKeys,
  header: ContainerHeader,
  ctx: ContainerContext,
  first: number,
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const g = chunkGeom(header)
  const out: Uint8Array<ArrayBuffer>[] = []
  let off = 0
  for (let i = first; off < bytes.length; i++) {
    if (i >= g.n) throw new FormatError('corrupt', 'trailing bytes after the last chunk')
    const len = g.plainLen(i) + CHUNK_OVERHEAD
    if (off + len > bytes.length) throw new FormatError('corrupt', `chunk ${i} truncated`)
    out.push(await decryptChunk(keys, header, ctx, i, bytes.subarray(off, off + len)))
    off += len
  }
  return out
}

/** Whole-buffer decrypt (small objects and tests). Checks the total length, so truncation fails. */
export async function decryptContainer(keys: LibraryKeys, ctx: ContainerContext, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const h = parseContainerHeader(bytes)
  if (bytes.length !== ciphertextSize(h.size, 2 ** h.log2Chunk)) throw new FormatError('corrupt', 'container has the wrong length')
  return concatBytes(await decryptChunks(keys, h, ctx, 0, bytes.subarray(HEADER_BYTES)))
}

/**
 * Streaming decrypt: ciphertext bytes in (any split), plaintext chunks out. Errors with `corrupt` on any
 * failed tag, on extra bytes, and when the stream ends before the last chunk (truncation).
 */
export function decryptStream(keys: LibraryKeys, ctx: ContainerContext): TransformStream<Uint8Array, Uint8Array> {
  // Pieces are queued and joined only once a whole header/chunk is available, so tiny input pieces
  // don't cause quadratic copying.
  let pending: Uint8Array[] = []
  let pendingLen = 0
  let header: ContainerHeader | null = null
  let g: ReturnType<typeof chunkGeom> | null = null
  let i = 0
  const take = (n: number): Uint8Array => {
    const all = pending.length === 1 ? pending[0] : concatBytes(pending)
    const rest = all.subarray(n)
    pending = rest.length ? [rest] : []
    pendingLen = rest.length
    return all.subarray(0, n)
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(piece, ctl) {
      if (!piece.length) return
      pending.push(piece)
      pendingLen += piece.length
      if (!header) {
        if (pendingLen < HEADER_BYTES) return
        header = parseContainerHeader(take(HEADER_BYTES))
        g = chunkGeom(header)
      }
      const geo = g as ReturnType<typeof chunkGeom>
      while (i < geo.n) {
        const len = geo.plainLen(i) + CHUNK_OVERHEAD
        if (pendingLen < len) return
        ctl.enqueue(await decryptChunk(keys, header, ctx, i, take(len)))
        i++
      }
      if (pendingLen) throw new FormatError('corrupt', 'trailing bytes after the last chunk')
    },
    flush() {
      if (!g || i < g.n) throw new FormatError('corrupt', 'container truncated')
    },
  })
}

// ---------------------------------------------------------------------------------------------
// ByteSource helpers
// ---------------------------------------------------------------------------------------------

/** Reads a `Blob` with `slice`, so only the requested range is loaded. */
export function blobSource(blob: Blob): ByteSource {
  return { size: blob.size, read: async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer()) }
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (s, e) => bytes.subarray(s, e) }
}
