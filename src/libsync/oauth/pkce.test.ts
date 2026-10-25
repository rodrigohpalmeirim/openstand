import { describe, expect, it } from 'vitest'
import { b64url, challengeS256, fromB64url, newState, newVerifier } from './pkce'

describe('PKCE (RFC 7636)', () => {
  it('matches the appendix B vector', async () => {
    expect(await challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('makes 43-character verifiers and 22-character states from the unreserved alphabet, all different', () => {
    const vs = new Set(Array.from({ length: 50 }, newVerifier))
    expect(vs.size).toBe(50)
    for (const v of vs) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const s = newState()
    expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newState()).not.toBe(s)
  })

  it('base64url round-trips without padding', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 251) & 0xff)
      const s = b64url(bytes)
      expect(s).not.toMatch(/[+/=]/)
      expect(fromB64url(s)).toEqual(bytes)
    }
  })
})
