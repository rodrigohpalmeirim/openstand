/**
 * PKCE (RFC 7636, S256) and the `state` parameter. Used for all three providers,
 * including the confidential Google and Microsoft clients (a stolen code is useless without the verifier).
 */

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

/** 32 random bytes → 43 characters of `[A-Za-z0-9_-]` (RFC 7636 §4.1 allows 43–128). */
export const newVerifier = () => b64url(random(32))

/** 16 random bytes. */
export const newState = () => b64url(random(16))

/** `code_challenge` = base64url(SHA-256(ASCII(verifier))) (RFC 7636 §4.2). */
export async function challengeS256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}
