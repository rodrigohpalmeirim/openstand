/**
 * Canonical JSON and a fast 64-bit value hash (docs/SYNC.md §1, §6.2). Used only for change detection
 * (row projection vs. `syncShadow` hashes), never for security.
 */
import type { Json } from './model'

/**
 * JSON with object keys sorted (by UTF-16 code units), so equal values give equal strings regardless of
 * key order. Follows `JSON.stringify` otherwise: `undefined` object members are dropped, `undefined`
 * array items and non-finite numbers become `null`, and `-0` is `0`. Top-level `undefined` is `null`.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v)
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null'
    case 'boolean':
      return v ? 'true' : 'false'
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canonicalJson(x))).join(',') + ']'
      const o = v as Record<string, unknown>
      const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
    }
    default:
      return 'null'
  }
}

/** cyrb53-style string hash widened to 64 bits: 16 lowercase hex chars. */
export function hash64(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/**
 * Hash of a register value as stored in `ShadowRecord`: `''` for `undefined` (unset / tombstone),
 * otherwise 16 hex chars of the canonical JSON (never `''`).
 */
export function valueHash(v: Json | undefined): string {
  return v === undefined ? '' : hash64(canonicalJson(v))
}

/**
 * Deep copy into plain JSON: drops `undefined` members, `undefined` array items and non-finite numbers
 * become `null` (as `JSON.stringify` would). Top-level `undefined` stays `undefined`.
 */
export function toJson(v: unknown): Json | undefined {
  if (v === undefined || typeof v === 'function') return undefined
  if (v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map((x) => toJson(x) ?? null)
  if (typeof v === 'object') {
    const out: { [k: string]: Json } = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const j = toJson(x)
      if (j !== undefined) out[k] = j
    }
    return out
  }
  return undefined
}

export const jsonEqual = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
