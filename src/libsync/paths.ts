/**
 * Storage key builders and parsers. Keys are relative to the backend root
 * (bucket + user prefix). Builders throw on invalid parts, so a bug can never write a stray key;
 * parsers return `null` for anything that isn't a well-formed key.
 *
 *   os1/<libraryId>/meta
 *   os1/<libraryId>/devices/<dev>
 *   os1/<libraryId>/heads/<dev>/<seq10>
 *   os1/<libraryId>/log/<dev>/<seq10>
 *   os1/<libraryId>/snap/<dev>/<n10>
 *   os1/<libraryId>/blobs/<blobName>
 */

export const ROOT = 'os1'

export const LIBRARY_ID = /^[a-z2-7]{26}$/
export const DEVICE_ID = /^[0-9a-f]{16}$/
export const BLOB_NAME = /^[a-z2-7]{52}$/
const SEQ10 = /^\d{10}$/
/** Largest seq/n that fits 10 digits. */
export const MAX_SEQ = 9_999_999_999

function check(re: RegExp, v: string, what: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw new TypeError(`invalid ${what}: ${JSON.stringify(v)}`)
  return v
}

/** 10-digit zero-padded decimal, from 1 (`0000000001`), so lexicographic order is numeric order. */
export function pad10(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SEQ) throw new RangeError(`seq out of range: ${n}`)
  return String(n).padStart(10, '0')
}

/** Inverse of `pad10`; `null` if `s` isn't exactly 10 digits in range. */
export function parse10(s: string): number | null {
  if (!SEQ10.test(s)) return null
  const n = Number(s)
  return n >= 1 ? n : null
}

const lib = (libraryId: string) => `${ROOT}/${check(LIBRARY_ID, libraryId, 'libraryId')}/`
const dev = (deviceId: string) => check(DEVICE_ID, deviceId, 'deviceId')

/** `os1/<libraryId>/`: everything a library owns (used by "Delete synced data"). */
export const libraryPrefix = (libraryId: string) => lib(libraryId)
export const metaKey = (libraryId: string) => `${lib(libraryId)}meta`
export const devicesPrefix = (libraryId: string) => `${lib(libraryId)}devices/`
export const deviceKey = (libraryId: string, deviceId: string) => `${devicesPrefix(libraryId)}${dev(deviceId)}`
/** All devices' heads (one LIST per poll), or one device's. */
export const headsPrefix = (libraryId: string, deviceId?: string) =>
  `${lib(libraryId)}heads/${deviceId === undefined ? '' : dev(deviceId) + '/'}`
export const headKey = (libraryId: string, deviceId: string, seq: number) => `${headsPrefix(libraryId, deviceId)}${pad10(seq)}`
export const logPrefix = (libraryId: string, deviceId?: string) =>
  `${lib(libraryId)}log/${deviceId === undefined ? '' : dev(deviceId) + '/'}`
export const logKey = (libraryId: string, deviceId: string, seq: number) => `${logPrefix(libraryId, deviceId)}${pad10(seq)}`
export const snapPrefix = (libraryId: string, deviceId?: string) =>
  `${lib(libraryId)}snap/${deviceId === undefined ? '' : dev(deviceId) + '/'}`
export const snapKey = (libraryId: string, deviceId: string, n: number) => `${snapPrefix(libraryId, deviceId)}${pad10(n)}`
export const blobsPrefix = (libraryId: string) => `${lib(libraryId)}blobs/`
export const blobKey = (libraryId: string, name: string) => `${blobsPrefix(libraryId)}${check(BLOB_NAME, name, 'blobName')}`

/** `os1/.check-<rand>`: the scratch object `check()` writes and deletes. Outside every library. */
export const checkKey = (rand: string) => `${ROOT}/.check-${check(/^[a-z0-9]{1,32}$/, rand, 'check id')}`

export type ParsedKey =
  | { type: 'meta'; libraryId: string }
  | { type: 'device'; libraryId: string; deviceId: string }
  | { type: 'head' | 'log' | 'snap'; libraryId: string; deviceId: string; seq: number }
  | { type: 'blob'; libraryId: string; name: string }

const SEQ_TYPES = { heads: 'head', log: 'log', snap: 'snap' } as const

/** Parses a root-relative key. Unknown or malformed keys give `null`. */
export function parseKey(key: string): ParsedKey | null {
  const p = key.split('/')
  if (p[0] !== ROOT || p.length < 3 || !LIBRARY_ID.test(p[1])) return null
  const libraryId = p[1]
  if (p.length === 3 && p[2] === 'meta') return { type: 'meta', libraryId }
  if (p.length === 4 && p[2] === 'devices' && DEVICE_ID.test(p[3])) return { type: 'device', libraryId, deviceId: p[3] }
  if (p.length === 4 && p[2] === 'blobs' && BLOB_NAME.test(p[3])) return { type: 'blob', libraryId, name: p[3] }
  if (p.length === 5 && Object.hasOwn(SEQ_TYPES, p[2]) && DEVICE_ID.test(p[3])) {
    const seq = parse10(p[4])
    if (seq !== null) return { type: SEQ_TYPES[p[2] as keyof typeof SEQ_TYPES], libraryId, deviceId: p[3], seq }
  }
  return null
}

/**
 * Reduces a `heads/` listing to each device's latest seq (readers take the max). Keys that aren't
 * heads of `libraryId` are ignored.
 */
export function latestHeads(libraryId: string, keys: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) {
    const p = parseKey(k)
    if (p?.type === 'head' && p.libraryId === libraryId && p.seq > (out[p.deviceId] ?? 0)) out[p.deviceId] = p.seq
  }
  return out
}
