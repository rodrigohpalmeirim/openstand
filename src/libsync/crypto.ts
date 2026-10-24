/**
 * Library sync cryptography (docs/SYNC.md §2, §4.1, §4.2, §4.3).
 *
 * - `deriveLibraryKeys(secret)`: HKDF-SHA256 → libraryId, roomId and separate AES-GCM keys for envelopes,
 *   blob chunks and snapshots, plus HMAC keys (all non-extractable).
 * - `seal` / `open`: small sealed envelopes (meta, devices, batches, notices) with the AAD bound to the key path.
 * - `encryptChunks` / `decryptChunk`: the chunked container for blobs and snapshots. Encryption is lazy and
 *   random-access (a `ByteSource` that encrypts only the chunks a read touches), so memory stays bounded.
 * - `blobName`, `sealNotice` / `openNotice`, streaming SHA-256 (`sha256Blob`, `createSha256`).
 *
 * Wire format v2 (§4). v1 objects are never read: they are recognised (only when they authenticate under
 * the v1 key) and reported as `oldFormat`, which the user resolves with "Reset sync".
 *
 * Everything here is WebCrypto (browsers, workers, Node ≥ 20), except streaming SHA-256 for large files,
 * which lazy-loads @noble/hashes.
 */
import type { ByteSource } from './backends/types'
import { CHUNK, type NoticeFrame, type NoticePayload } from './model'
import { pad10 } from './paths'

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Data that can't be read (§4.4). Only authenticated bytes ever produce a format verdict:
 *
 * - `corrupt`: this one object can't be read: authentication failed, truncated, malformed, a hash
 *   mismatch, or an unknown version/epoch byte (unauthenticated, so it can't be trusted to mean "newer").
 * - `newerFormat`: the object authenticated and its JSON says a newer `v` than this build knows.
 * - `oldFormat`: the object authenticated under the v1 key with the v1 layout: written by a pre-v2 build.
 *   Nothing reads v1; the user has to "Reset sync" (§10.5).
 */
export type FormatErrorCode = 'corrupt' | 'newerFormat' | 'oldFormat'

export class FormatError extends Error {
  readonly code: FormatErrorCode
  constructor(code: FormatErrorCode, message?: string, cause?: unknown) {
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

/** Incremental SHA-256 (@noble/hashes, loaded on first use): memory stays at one piece. */
export interface Sha256Stream {
  update(piece: Uint8Array): void
  /** Lowercase hex. */
  hex(): string
}

export async function createSha256(): Promise<Sha256Stream> {
  const { sha256 } = await import('@noble/hashes/sha2.js')
  const h = sha256.create()
  return {
    update: (piece) => void h.update(piece),
    hex: () => bytesToHex(h.digest()),
  }
}

/** Files up to this size are hashed in one WebCrypto call (fast, native); larger ones stream. */
export const HASH_INLINE_MAX = 32 * 1024 * 1024

/**
 * SHA-256 hex of a Blob (or of Blob parts, in order) of any size. Small inputs use WebCrypto; larger ones
 * are read `piece` bytes at a time into a streaming hash, so memory stays bounded.
 */
export async function sha256Blob(data: Blob | readonly Blob[], piece = 1024 * 1024): Promise<string> {
  const parts = data instanceof Blob ? [data] : data
  let total = 0
  for (const p of parts) total += p.size
  if (total <= HASH_INLINE_MAX) return sha256Hex(parts.length === 1 ? parts[0] : new Blob(parts as Blob[]))
  const h = await createSha256()
  for (const p of parts) for (let o = 0; o < p.size; o += piece) h.update(new Uint8Array(await p.slice(o, Math.min(p.size, o + piece)).arrayBuffer()))
  return h.hex()
}

// ---------------------------------------------------------------------------------------------
// §2 Keys
// ---------------------------------------------------------------------------------------------

export const SECRET_BYTES = 32
/** Unchanged since v1, so `libraryId`, `roomId` and blob names stay where they were. */
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
  /** AES-GCM-256 `envKey[epoch]`: sealed envelopes (meta, devices, batches, notices). */
  readonly enc: ReadonlyMap<number, CryptoKey>
  /** AES-GCM-256 `blobKey[epoch]`: blob container chunks. */
  readonly blob: ReadonlyMap<number, CryptoKey>
  /** AES-GCM-256 `snapKey[epoch]`: snapshot container chunks. */
  readonly snap: ReadonlyMap<number, CryptoKey>
  /** HMAC-SHA-256 `nonceKey[epoch]` for deterministic, content-derived blob chunk nonces. */
  readonly nonce: ReadonlyMap<number, CryptoKey>
  /** HMAC-SHA-256 `nameKey` for blob object names. */
  readonly name: CryptoKey
  /** The v1 AES-GCM key (decrypt only): recognises authentic v1 objects so they report `oldFormat`. */
  readonly v1: CryptoKey
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
  const aes = (label: string, usages: KeyUsage[] = ['encrypt', 'decrypt']) =>
    crypto.subtle.deriveKey(p(label), ikm, { name: 'AES-GCM', length: 256 }, false, usages)
  const e = KEY_EPOCH
  const [libraryId, roomId, envKey, blobKey, snapKey, nameKey, nonceKey, v1Key] = await Promise.all([
    bits('library-id').then(base32),
    bits('room-id').then(base32),
    aes(`v2/envelope/${e}`),
    aes(`v2/blob/${e}`),
    aes(`v2/snapshot/${e}`),
    hmac('blob-name'),
    hmac(`v2/blob-nonce/${e}`),
    aes('enc-key/0', ['decrypt']),
  ])
  return {
    libraryId,
    roomId,
    epoch: e,
    enc: new Map([[e, envKey]]),
    blob: new Map([[e, blobKey]]),
    snap: new Map([[e, snapKey]]),
    nonce: new Map([[e, nonceKey]]),
    name: nameKey,
    v1: v1Key,
  }
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

/** The key for `epoch`. An unknown epoch byte is unauthenticated, so it is `corrupt`, never `newerFormat`. */
function keyFor<K>(map: ReadonlyMap<number, K>, epoch: number): K {
  const k = map.get(epoch)
  if (!k) throw new FormatError('corrupt', `unknown key epoch ${epoch} (unauthenticated)`)
  return k
}

/** Whether `ct` authenticates under the v1 key: only then is a v1-looking object reported as `oldFormat`. */
async function isAuthenticV1(keys: LibraryKeys, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<boolean> {
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aad) }, keys.v1, ab(ct))
    return true
  } catch {
    return false
  }
}

const OLD_FORMAT_MESSAGE = 'written by an older OpenStand sync format (v1); reset sync to continue'

const TAG = 16
const NONCE = 12
/** AES-GCM nonce length: a container's first `HEADER_BYTES + NONCE_BYTES` bytes fingerprint a blob (§10.2). */
export const NONCE_BYTES = NONCE

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

export const ENVELOPE_VERSION = 2
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

/** v2 AAD: the version and epoch bytes, then the key path. */
const envelopeAad = (version: number, epoch: number, path: string) => concatBytes([Uint8Array.of(version, epoch), utf8(path)])

/** `[0x02, epoch, nonce(12), AES-GCM(envKey, plaintext) || tag]`. The caller gzips first where §4.1 says so. */
export async function seal(keys: LibraryKeys, ctx: SealContext, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE)
  const aad = envelopeAad(ENVELOPE_VERSION, keys.epoch, sealAad(keys, ctx))
  const ct = await gcmEncrypt(keyFor(keys.enc, keys.epoch), nonce, aad, plaintext)
  const out = new Uint8Array(ENV_HEAD + ct.length)
  out[0] = ENVELOPE_VERSION
  out[1] = keys.epoch
  out.set(nonce, 2)
  out.set(ct, ENV_HEAD)
  return out
}

/**
 * Throws `FormatError`: `oldFormat` for an authentic v1 envelope, `corrupt` for anything else that doesn't
 * authenticate (including unknown version or epoch bytes).
 */
export async function open(keys: LibraryKeys, ctx: SealContext, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < ENV_HEAD + TAG) throw new FormatError('corrupt', 'envelope too short')
  const [version, epoch] = sealed
  const nonce = sealed.subarray(2, ENV_HEAD)
  const ct = sealed.subarray(ENV_HEAD)
  if (version === ENVELOPE_VERSION) return gcmDecrypt(keyFor(keys.enc, epoch), nonce, envelopeAad(version, epoch, sealAad(keys, ctx)), ct)
  if (version === 1 && epoch === 0 && (await isAuthenticV1(keys, nonce, utf8(sealAad(keys, ctx)), ct)))
    throw new FormatError('oldFormat', `envelope ${OLD_FORMAT_MESSAGE}`)
  throw new FormatError('corrupt', `unknown envelope version ${version} (unauthenticated)`)
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
export const CONTAINER_VERSION = 2
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

/**
 * Parses the 16-byte header (extra bytes after it are ignored). The header is unauthenticated until a
 * chunk decrypts (it is part of every chunk's AAD). Version 1 parses, so `decryptChunk` can tell an
 * authentic v1 object (`oldFormat`) from tampering; other versions are `corrupt`.
 */
export function parseContainerHeader(bytes: Uint8Array): ContainerHeader {
  if (bytes.length < HEADER_BYTES) throw new FormatError('corrupt', 'container header truncated')
  const raw = new Uint8Array(bytes.subarray(0, HEADER_BYTES))
  if (new TextDecoder().decode(raw.subarray(0, 4)) !== CONTAINER_MAGIC) throw new FormatError('corrupt', 'not a container')
  if (raw[4] !== CONTAINER_VERSION && raw[4] !== 1) throw new FormatError('corrupt', `unknown container version ${raw[4]} (unauthenticated)`)
  const log2Chunk = raw[6]
  if (log2Chunk < 10 || log2Chunk > 26) throw new FormatError('corrupt', 'bad chunk size')
  const size = new DataView(raw.buffer).getBigUint64(8)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError('corrupt', 'bad size')
  return { version: raw[4], epoch: raw[5], log2Chunk, flags: raw[7], size: Number(size), raw }
}

function containerCtx(keys: LibraryKeys, ctx: ContainerContext): string {
  return ctx.kind === 'blob' ? `blob|${ctx.name}` : `snap|${keys.libraryId}|${ctx.deviceId}|${pad10(ctx.n)}`
}

function chunkAad(header: Uint8Array, ctxStr: string, i: number, last: boolean): Uint8Array<ArrayBuffer> {
  return concatBytes([header, utf8(`|${ctxStr}|${i}|${last ? 1 : 0}`)])
}

/**
 * Deterministic blob chunk nonce: `HMAC(nonceKey, u32be(|aad|) || aad || plaintext)[0..12]`. The AAD holds
 * the header (version, epoch, chunk size, total size), the blob name, the index and the last-flag, so a
 * nonce repeats only for the identical plaintext at the identical position: identical ciphertext.
 */
async function blobNonce(nonceKey: CryptoKey, aad: Uint8Array, pt: Uint8Array): Promise<Uint8Array> {
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, aad.length)
  return (await hmac(nonceKey, concatBytes([len, aad, pt]))).subarray(0, NONCE)
}

const chunkKeyMap = (keys: LibraryKeys, kind: ContainerContext['kind']) => (kind === 'blob' ? keys.blob : keys.snap)

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
 * Blobs use deterministic, content-derived nonces, so any byte range is identical across reads, runs and
 * devices (multipart parts can be re-sent after a crash). Snapshots use random nonces, remembered per
 * chunk index (12 B each) so re-reading a range from the same source is still consistent.
 */
export function encryptChunks(keys: LibraryKeys, src: ByteSource, ctx: ContainerContext): EncryptedSource {
  if (ctx.kind === 'blob' && !SHA256_HEX.test(ctx.sha256)) throw new TypeError('sha256 must be 64 lowercase hex chars')
  const epoch = keys.epoch
  const key = keyFor(chunkKeyMap(keys, ctx.kind), epoch)
  const deterministic = ctx.kind === 'blob'
  const nonceKey = deterministic ? keyFor(keys.nonce, epoch) : null
  const header = buildHeader(src.size, epoch, deterministic)
  const g = chunkGeom({ size: src.size, log2Chunk: LOG2_CHUNK })
  const ctxStr = containerCtx(keys, ctx)
  const randomNonces = new Map<number, Uint8Array>()
  const cache: { i: number; data: Promise<Uint8Array> }[] = []

  const encryptChunk = async (i: number): Promise<Uint8Array> => {
    const start = i * g.chunk
    const pt = await src.read(start, start + g.plainLen(i))
    if (pt.length !== g.plainLen(i)) throw new Error('ByteSource returned a short read')
    const aad = chunkAad(header, ctxStr, i, i === g.n - 1)
    let nonce: Uint8Array
    if (nonceKey) nonce = await blobNonce(nonceKey, aad, pt)
    else {
      nonce = randomNonces.get(i) ?? randomBytes(NONCE)
      randomNonces.set(i, nonce)
    }
    const ct = await gcmEncrypt(key, nonce, aad, pt)
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
  const aad = chunkAad(header.raw, containerCtx(keys, ctx), i, i === g.n - 1)
  const nonce = data.subarray(0, NONCE)
  if (header.version === 1) {
    // v1 used one AES key for everything, with the same chunk layout and AAD shape.
    if (header.epoch === 0 && (await isAuthenticV1(keys, nonce, aad, data.subarray(NONCE))))
      throw new FormatError('oldFormat', `${ctx.kind === 'blob' ? 'file' : 'snapshot'} ${OLD_FORMAT_MESSAGE}`)
    throw new FormatError('corrupt', 'decryption failed (wrong key, wrong location or tampered data)')
  }
  return gcmDecrypt(keyFor(chunkKeyMap(keys, ctx.kind), header.epoch), nonce, aad, data.subarray(NONCE))
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
