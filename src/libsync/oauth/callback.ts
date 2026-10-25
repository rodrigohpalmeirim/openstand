/**
 * The `/oauth/callback` page (docs/SYNC-DRIVES.md §5.2) and the pending sign-in slot. Tiny and
 * synchronous: `main.tsx` imports it statically and runs `handleOAuthCallback()` before the first render.
 * The exchange itself happens later, lazily, in `completeSignIn` (oauth/flow.ts).
 */
import { useNav } from '../../state/nav'
import type { OAuthKind } from '../backends/types'
import type { PendingSignIn } from './types'

export const PENDING_KEY = 'openstand-oauth:pending'
/** A sign-in must come back within this long (§5.2). */
export const PENDING_TTL = 15 * 60 * 1000
export const CALLBACK_PATH = '/oauth/callback'

// Inlined rather than importing backends/types at runtime: this file is in the startup bundle.
const isOAuthKind = (k: unknown): k is OAuthKind => k === 'dropbox' || k === 'gdrive' || k === 'onedrive'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The pending sign-in, or `null` (none, unreadable, or malformed). Doesn't check the TTL. */
export function readPending(): PendingSignIn | null {
  try {
    const p: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null')
    if (!isObj(p) || p.v !== 1 || !isOAuthKind(p.kind) || typeof p.state !== 'string' || !p.state) return null
    if (typeof p.verifier !== 'string' || typeof p.redirectUri !== 'string' || typeof p.db !== 'string') return null
    if (typeof p.createdAt !== 'number' || !isObj(p.intent) || typeof p.intent.type !== 'string') return null
    return p as unknown as PendingSignIn
  } catch {
    return null
  }
}

export function writePending(p: PendingSignIn): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify(p))
}

export function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* storage unavailable */
  }
}

/** A callback has come back and waits for `completeSignIn` (sync; no imports beyond this file). */
export function signInReturnPending(): boolean {
  return !!readPending()?.ret
}

const MAX_PARAM = 4096
const clip = (v: string | null) => (v === null ? undefined : v.slice(0, MAX_PARAM))

/**
 * Runs on `/oauth/callback?code=…&state=…` (or `?error=…`): removes the code from the URL first, records
 * the result in the pending slot, and sends the app to Settings › Library sync, which completes the
 * sign-in. A wrong or stale `state` records `{error: 'expired'}`. Without a pending slot there is nothing
 * to resume, so it only cleans the URL and the app opens normally.
 */
export function handleOAuthCallback(now = Date.now()): void {
  const params = new URLSearchParams(location.search)
  history.replaceState(null, '', '/')
  const pending = readPending()
  if (!pending) return
  const code = params.get('code')
  const error = params.get('error')
  if (params.get('state') !== pending.state || now - pending.createdAt > PENDING_TTL)
    pending.ret = { error: 'expired' }
  else if (error !== null) pending.ret = { error: clip(error)!, description: clip(params.get('error_description')) }
  else if (code) pending.ret = { code: code.slice(0, MAX_PARAM) }
  else pending.ret = { error: 'invalid_request' }
  try {
    writePending(pending)
  } catch {
    return // storage full or blocked: nothing to resume from
  }
  useNav.getState().go({ name: 'settings', page: 'libsync' })
}
