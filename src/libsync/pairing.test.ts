// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { b64url, newSecret, utf8 } from './crypto'
import { PAIRING_PREFIX, PairingError, decodePairing, encodePairing, validatePayload, type PairingPayload } from './pairing'

const r2: PairingPayload = {
  v: 1,
  s: b64url(new Uint8Array(32).map((_, i) => 200 - i)),
  n: 'Gig library',
  r: '/relay',
  b: {
    kind: 's3',
    provider: 'r2',
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'openstand-music',
    prefix: 'openstand/',
    accessKeyId: 'f3a9c1d2e4b5a6978877665544332211',
    secretAccessKey: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
    pathStyle: true,
  },
}

/** Builds a code from arbitrary JSON (for malformed-payload cases). */
async function rawCode(json: unknown, prefix = PAIRING_PREFIX): Promise<string> {
  const rs = new Blob([utf8(JSON.stringify(json))]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return prefix + b64url(new Uint8Array(await new Response(rs).arrayBuffer()))
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof PairingError ? e.code : `other: ${e}`))

describe('pairing codes', () => {
  it('round-trip, with a typical S3 code ≤ 400 chars of URL-safe text', async () => {
    const c = await encodePairing(r2)
    expect(c.startsWith('OSJ1.')).toBe(true)
    expect(c).toMatch(/^OSJ1\.[A-Za-z0-9_-]+$/)
    expect(c.length).toBeLessThanOrEqual(400)
    expect(await decodePairing(c)).toEqual(r2)
    const minimal: PairingPayload = { v: 1, s: b64url(newSecret()), b: { kind: 'memory', name: 'x' } }
    expect(await decodePairing(await encodePairing(minimal))).toEqual(minimal)
    const noRelay = { ...r2, r: null }
    expect(await decodePairing(await encodePairing(noRelay))).toEqual(noRelay)
  })

  it('finds the code in pasted text and trims whitespace', async () => {
    const c = await encodePairing(r2)
    expect(await decodePairing(`  \n${c}\n `)).toEqual(r2)
    expect(await decodePairing(`Here is my code: ${c} — keep it secret`)).toEqual(r2)
  })

  it('rejects garbage as format', async () => {
    for (const t of ['', 'hello', 'OSJ1.', 'OSJ1.!!!!', 'OSJ1.AAAA', 'OSJ1.a', 'osj1.abc', 'OSJ0.abc'])
      expect(await code(decodePairing(t))).toBe('format')
    const c = await encodePairing(r2)
    expect(await code(decodePairing(c.slice(0, -10)))).toBe('format')
    expect(await code(decodePairing(await rawCode('just a string')))).toBe('format')
    expect(await code(decodePairing(await rawCode({ ...r2, s: 'short' })))).toBe('format')
    expect(await code(decodePairing(await rawCode({ ...r2, b: { ...r2.b, bucket: 5 } })))).toBe('format')
    expect(await code(decodePairing(await rawCode({ ...r2, b: { ...r2.b, endpoint: 'javascript:alert(1)' } })))).toBe('format')
    expect(await code(decodePairing(await rawCode({ ...r2, n: 5 })))).toBe('format')
    expect(await code(decodePairing(await rawCode({ ...r2, v: undefined })))).toBe('format')
  })

  it('rejects newer codes as version', async () => {
    expect(await code(decodePairing('OSJ2.abcdef'))).toBe('version')
    expect(await code(decodePairing(await rawCode({ ...r2, v: 2 })))).toBe('version')
    expect(await code(decodePairing(await rawCode({ ...r2, b: { kind: 'icloud', folder: 'x' } })))).toBe('version')
  })

  it('drops unknown fields and refuses to encode invalid payloads', async () => {
    const extra = { ...r2, junk: 1, b: { ...r2.b, extra: true } }
    expect(validatePayload(extra)).toEqual(r2)
    await expect(encodePairing({ ...r2, s: 'nope' })).rejects.toBeInstanceOf(PairingError)
  })
})

describe('pairing codes for cloud drives (SYNC-DRIVES.md §2.1, §11)', () => {
  const s = b64url(new Uint8Array(32).map((_, i) => i + 1))
  const drives: PairingPayload['b'][] = [
    { kind: 'dropbox', root: '', account: 'rod@example.com', accountId: 'dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc' },
    { kind: 'gdrive', folder: '1Zx9_aBcDeFgHiJkLmNoPqRsTuVwXyZ-0', account: 'rod@example.com', accountId: '01234567890123456789' },
    { kind: 'onedrive', folder: '', account: 'Rod <rod@outlook.com>', accountId: 'b!AbCdEf0123' },
    { kind: 'dropbox', root: '' },
  ]

  it('round-trips the backend kind, folder and account hints, and stays short', async () => {
    for (const b of drives) {
      const p: PairingPayload = { v: 1, s, n: 'Gig library', b, r: '/relay' }
      const c = await encodePairing(p)
      expect(c.length).toBeLessThanOrEqual(400)
      expect(await decodePairing(c)).toEqual(p)
    }
  })

  it('never carries tokens or other unknown fields', () => {
    const b = { kind: 'dropbox', root: '', account: 'a@b.c', accessToken: 'secret', refreshToken: 'secret' }
    expect(validatePayload({ v: 1, s, b })).toEqual({ v: 1, s, b: { kind: 'dropbox', root: '', account: 'a@b.c' } })
  })

  it('rejects bad account hints and Drive folder ids as format', async () => {
    const bad: unknown[] = [
      { kind: 'dropbox', root: '', account: 5 },
      { kind: 'dropbox', root: '', account: 'x'.repeat(321) },
      { kind: 'onedrive', folder: '', accountId: 'x'.repeat(201) },
      { kind: 'onedrive', folder: '', accountId: null },
      { kind: 'gdrive', folder: '' },
      { kind: 'gdrive', folder: 'short' },
      { kind: 'gdrive', folder: '1Zx9 aBcDeFgHiJ' },
      { kind: 'gdrive', folder: 'x'.repeat(201) },
      { kind: 'gdrive' },
    ]
    for (const b of bad) expect(await code(decodePairing(await rawCode({ v: 1, s, b }))), JSON.stringify(b)).toBe('format')
    expect(validatePayload({ v: 1, s, b: { kind: 'dropbox', root: '', account: 'x'.repeat(320), accountId: 'y'.repeat(200) } }).b).toMatchObject({ account: 'x'.repeat(320) })
  })
})
