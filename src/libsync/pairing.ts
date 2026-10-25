/**
 * Pairing codes: `"OSJ1." + base64url(deflateRaw(JSON(PairingPayload)))`. The same
 * string goes in the QR code (byte mode, ECC M) and the "Copy code" text.
 */
import type { BackendConfig } from './backends/types'
import { SECRET_BYTES, b64url, fromB64url, utf8 } from './crypto'
import { PairingError, type PairingPayload } from './model'

export { PairingError, type PairingPayload, type PairingErrorCode } from './model'

export const PAIRING_PREFIX = 'OSJ1.'
/** Codes longer than this are rejected before inflating (a typical S3 code is ~300 chars). */
const MAX_CODE = 8192
const MAX_JSON = 32 * 1024

async function pipe(bytes: Uint8Array, t: TransformStream<Uint8Array, Uint8Array>, max = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t).getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) {
      await reader.cancel()
      throw new Error('too large')
    }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export async function encodePairing(p: PairingPayload): Promise<string> {
  const payload = validatePayload(p) // never emit a code we couldn't read back
  const deflated = await pipe(utf8(JSON.stringify(payload)), new CompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>)
  return PAIRING_PREFIX + b64url(deflated)
}

/**
 * Accepts the code alone or embedded in pasted text (surrounding whitespace and words are ignored).
 * Throws `PairingError('version')` for a newer code (`OSJ2.`, or `v > 1` inside), `PairingError('format')`
 * for anything else.
 */
export async function decodePairing(text: string): Promise<PairingPayload> {
  const m = /OSJ(\d+)\.([A-Za-z0-9_-]+)/.exec(String(text ?? '').trim())
  if (!m) throw new PairingError('format')
  if (m[1] !== '1') {
    if (Number(m[1]) > 1) throw new PairingError('version')
    throw new PairingError('format')
  }
  if (m[2].length > MAX_CODE) throw new PairingError('format', 'Pairing code is too long')
  let json: unknown
  try {
    const raw = await pipe(fromB64url(m[2]), new DecompressionStream('deflate-raw') as TransformStream<Uint8Array, Uint8Array>, MAX_JSON)
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new PairingError('format')
  }
  return validatePayload(json)
}

const str = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A Google Drive file id. */
const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]{10,200}$/

/**
 * The optional, non-secret account hints of an OAuth backend: `account` (display,
 * usually the email) ≤ 320 chars, `accountId` ≤ 200 chars. Kept only when present; a wrong type or length
 * is a malformed code.
 */
function accountHints(b: Record<string, unknown>): { account?: string; accountId?: string } {
  const out: { account?: string; accountId?: string } = {}
  for (const [f, max] of [['account', 320], ['accountId', 200]] as const) {
    const v = b[f]
    if (v === undefined) continue
    if (!str(v) || v.length > max) throw new PairingError('format')
    out[f] = v
  }
  return out
}

function validateBackend(b: unknown): BackendConfig {
  if (!isObj(b) || !str(b.kind)) throw new PairingError('format')
  switch (b.kind) {
    case 's3': {
      const fields = ['endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey'] as const
      if (!fields.every((f) => str(b[f])) || typeof b.pathStyle !== 'boolean') throw new PairingError('format')
      if (!['r2', 'b2', 'aws', 'minio', 'other'].includes(b.provider as string)) throw new PairingError('format')
      if (!b.bucket || !b.accessKeyId || !b.secretAccessKey) throw new PairingError('format')
      try {
        if (!/^https?:$/.test(new URL(b.endpoint as string).protocol)) throw new Error()
      } catch {
        throw new PairingError('format')
      }
      return {
        kind: 's3',
        provider: b.provider as Extract<BackendConfig, { kind: 's3' }>['provider'],
        endpoint: b.endpoint as string,
        region: b.region as string,
        bucket: b.bucket as string,
        prefix: b.prefix as string,
        accessKeyId: b.accessKeyId as string,
        secretAccessKey: b.secretAccessKey as string,
        pathStyle: b.pathStyle,
      }
    }
    case 'dropbox':
      if (!str(b.root)) throw new PairingError('format')
      return { kind: 'dropbox', root: b.root, ...accountHints(b) }
    case 'gdrive':
      if (!str(b.folder) || !DRIVE_FOLDER_ID.test(b.folder)) throw new PairingError('format')
      return { kind: 'gdrive', folder: b.folder, ...accountHints(b) }
    case 'onedrive':
      if (!str(b.folder)) throw new PairingError('format')
      return { kind: 'onedrive', folder: b.folder, ...accountHints(b) }
    case 'memory':
      if (!str(b.name)) throw new PairingError('format')
      return { kind: 'memory', name: b.name }
    default:
      // A backend kind this build doesn't know comes from a newer app.
      throw new PairingError('version')
  }
}

/** Checks shape and drops unknown fields. Throws `PairingError`. */
export function validatePayload(p: unknown): PairingPayload {
  if (!isObj(p)) throw new PairingError('format')
  if (p.v !== 1) throw new PairingError(typeof p.v === 'number' && p.v > 1 ? 'version' : 'format')
  if (!str(p.s)) throw new PairingError('format')
  try {
    if (fromB64url(p.s).length !== SECRET_BYTES) throw new Error()
  } catch {
    throw new PairingError('format')
  }
  if (p.n !== undefined && !str(p.n)) throw new PairingError('format')
  if (p.r !== undefined && p.r !== null && !str(p.r)) throw new PairingError('format')
  const out: PairingPayload = { v: 1, s: p.s, b: validateBackend(p.b) }
  if (p.n !== undefined) out.n = p.n as string
  if (p.r !== undefined) out.r = p.r as string | null
  return out
}
