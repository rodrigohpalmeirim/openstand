/**
 * OAuth sign-in contract. Type-only.
 *
 * CONTRACT: change only additively.
 */
import type { AccountInfo, OAuthKind } from '../backends/types'

export type { AccountInfo, OAuthKind } from '../backends/types'

/** Why a sign-in was started; it resumes from this after the redirect. */
export type SignInIntent =
  | { type: 'setup' }
  /** `pairing`: the OSJ1. code, so the join resumes after the redirect. */
  | { type: 'join'; pairing: string }
  /** Must come back as the same account. */
  | { type: 'reauth'; accountId?: string }

/** The one `localStorage` slot `openstand-oauth:pending` (TTL 15 min; overwritten by a new start). */
export interface PendingSignIn {
  v: 1
  kind: OAuthKind
  state: string
  verifier: string
  redirectUri: string
  /** Library DB name the tokens belong to. */
  db: string
  intent: SignInIntent
  /** Wall ms. */
  createdAt: number
  /** Set by the callback page (`oauth/callback.ts`). */
  ret?: { code: string } | { error: string; description?: string }
}

export interface SignInResult {
  kind: OAuthKind
  intent: SignInIntent
  account: AccountInfo
}

/**
 * Reaches the UI as `LibSyncFailure` codes: `denied`, `expired`, `exchange` and `notConfigured` become
 * `unknown` with fixed messages; `scope` becomes `reauth`; `wrongAccount` and `network` stay.
 */
export type SignInErrorCode = 'denied' | 'expired' | 'scope' | 'wrongAccount' | 'exchange' | 'notConfigured' | 'network'

/** One row of the provider table, as data (`PROVIDERS` in `oauth/config.ts`). */
export interface ProviderSpec {
  kind: OAuthKind
  /** Product name for messages: "Dropbox", "Google Drive", "OneDrive". */
  name: string
  /** Who you sign in with (button text "Sign in with …"): "Dropbox", "Google", "Microsoft". */
  signInWith: string
  /** Where the data lives, for people, e.g. "Dropbox › Apps › OpenStand". */
  location: string
  authorizeUrl: string
  /** Fixed authorize parameters, including `scope` (PKCE `code_challenge`, `state`, `client_id` and `redirect_uri` are added per request). */
  authorizeParams: Record<string, string>
  /** Added for "Use a different account" (`o.chooseAccount`); these override `authorizeParams` (Google's `prompt`). */
  chooseAccountParams: Record<string, string>
  /** Authorize parameter for `o.loginHint` (join, reauth); `null` = not supported. */
  loginHintParam: string | null
  /** Absolute (Dropbox) or same-origin Worker route (`/api/oauth/<kind>/token`). */
  tokenUrl: string
  /** The token exchange goes through our Worker, which holds the client secret. */
  viaWorker: boolean
  /** Scope that must be granted, else the sign-in fails with `scope` (OneDrive matches case-insensitively, with or without the Graph prefix). */
  requiredScope: string
  /** Refresh responses carry a new refresh token that replaces the old one. */
  rotatesRefreshToken: boolean
  /** Account pages for disconnecting the app on every device (the leave dialog). */
  disconnectUrls: { label: string; url: string }[]
}
