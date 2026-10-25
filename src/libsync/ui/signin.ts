/**
 * Cloud-drive sign-in for the UI: provider wording, sign-in error messages,
 * and resuming after the full-page redirect. Pure apart from `takeSignInReturn`, which reads the pending
 * slot and calls `completeSignIn` once.
 */
import { LibSyncFailure, type AccountInfo, type BackendKind, type OAuthKind, type SignInErrorCode, type SignInIntent, type SignInResult } from '../api'
import { readPending } from '../oauth/callback'
import { PROVIDERS as DRIVES } from '../oauth/config'
import type { ProviderSpec } from '../oauth/types'
import { completeSignIn, currentPayload, signInReturnPending, startSignIn } from './client'

export const DRIVE_KINDS: OAuthKind[] = ['dropbox', 'gdrive', 'onedrive']

export const isDrive = (k: BackendKind | string | undefined): k is OAuthKind => k === 'dropbox' || k === 'gdrive' || k === 'onedrive'

export const drive = (k: OAuthKind): ProviderSpec => DRIVES[k]

/** The provider's own web UI, for "Open Dropbox" when the drive is full and no folder link is known. */
export const DRIVE_HOME: Record<OAuthKind, string> = {
  dropbox: 'https://www.dropbox.com/home',
  gdrive: 'https://drive.google.com/',
  onedrive: 'https://onedrive.live.com/',
}

/** The account hint people recognise: the email, else the name. */
export const accountLabel = (a?: AccountInfo) => a?.email || a?.name || undefined

/** The account hints in a drive backend config (the pairing payload's `b`). */
export const accountOf = (b?: { kind: string } | null) => (b && isDrive(b.kind) ? (b as { account?: string }).account : undefined)
export const accountIdOf = (b?: { kind: string } | null) => (b && isDrive(b.kind) ? (b as { accountId?: string }).accountId : undefined)

/**
 * Sign in to the library's drive again (Settings and the indicator): as the same account, or picking
 * one with `chooseAccount`. Leaves the page when it works.
 */
export async function signInAgain(kind: OAuthKind, chooseAccount?: boolean): Promise<void> {
  const b = (await currentPayload())?.b
  const account = accountOf(b)
  await startSignIn(kind, { type: 'reauth', accountId: accountIdOf(b) }, { ...(account ? { loginHint: account } : {}), ...(chooseAccount ? { chooseAccount: true } : {}) })
}

/* ---------------------------------------------------------------- Errors */

/** What a sign-in problem offers: try the same sign-in again, pick another account, or nothing. */
export type SignInAction = 'retry' | 'chooseAccount'

export interface SignInProblem {
  message: string
  action?: SignInAction
}

const SIGN_IN_CODES: SignInErrorCode[] = ['denied', 'expired', 'scope', 'wrongAccount', 'exchange', 'notConfigured', 'network']

/** A sentence (not a bare identifier like "unknown" or "denied"). */
const sentence = (m?: string) => (m && /\s/.test(m.trim()) ? m.trim() : undefined)

/** "You signed in as X, but this library is in Y’s Dropbox." with whatever of X and Y is known. */
export function wrongAccountText(kind: OAuthKind, got?: string, want?: string): string {
  const name = drive(kind).name
  if (got && want) return `You signed in as ${got}, but this library is in ${want}’s ${name}.`
  if (want) return `This library is in ${want}’s ${name}, not in the account you signed in with.`
  if (got) return `You signed in as ${got}, but this library isn’t in that ${name} account.`
  return `This library isn’t in the ${name} account you signed in with.`
}

/** The code's library isn't in the signed-in account (join preview). */
export function joinWrongAccountText(kind: OAuthKind, got?: string, want?: string): string {
  const name = drive(kind).name
  return (
    `This library isn’t in the ${name} account you signed in with${got ? ` (${got})` : ''}.` +
    (want ? ` The code was made for ${want}.` : '') +
    ' Sign in with that account, or get a new code if the library was deleted.'
  )
}

/**
 * The message and action for a failed sign-in. `completeSignIn` and `startSignIn` reject with a
 * `LibSyncFailure` carrying the sentence (provider name filled in): `unknown` with `detail`
 * `denied`/`expired`/`exchange`/`notConfigured`; `reauth` with `detail` `scope`; `wrongAccount` with `detail`
 * = the account the library is in; `network`. The facade's sentence wins; ours is the fallback.
 */
export function signInProblem(e: unknown, kind: OAuthKind, ctx: { got?: string; want?: string } = {}): SignInProblem {
  const p = drive(kind)
  const isFailure = e instanceof LibSyncFailure || (e as Error)?.name === 'LibSyncFailure'
  const f = (isFailure ? e : {}) as Partial<LibSyncFailure>
  const own = sentence(f.message)
  const detail = SIGN_IN_CODES.includes(f.detail as SignInErrorCode) ? (f.detail as SignInErrorCode) : undefined
  switch (f.code) {
    case 'reauth':
      // `scope`: the folder access wasn't granted. Anything else (`NoTokens`): just not signed in (any more).
      if (f.detail && f.detail !== 'scope') return { message: `Sign in to ${p.name} to continue.`, action: 'retry' }
      return {
        message:
          own ??
          (kind === 'gdrive'
            ? 'OpenStand needs access to its own files in Google Drive. Sign in again and tick the box.'
            : `OpenStand needs access to its own files in ${p.name}. Sign in again and allow it.`),
        action: 'retry',
      }
    case 'wrongAccount':
      return { message: own ?? wrongAccountText(kind, ctx.got, ctx.want ?? f.detail), action: 'chooseAccount' }
    case 'network':
      return { message: own ?? `Can’t reach ${p.name}. Check your connection.`, action: 'retry' }
  }
  switch (detail) {
    case 'denied':
      return { message: own ?? 'Sign-in was cancelled.', action: 'retry' }
    case 'expired':
      return { message: own ?? 'That sign-in took too long or was started elsewhere. Please try again.', action: 'retry' }
    case 'exchange':
      return { message: own ?? `${p.name} didn’t accept the sign-in. Please try again.`, action: 'retry' }
    case 'notConfigured':
      return { message: own ?? `Sign-in with ${p.name} isn’t available on this site.` }
    default:
      return { message: own ?? 'Signing in didn’t work. Please try again.', action: 'retry' }
  }
}

/* ---------------------------------------------------------------- Resume */

export type SignInOutcome = { ok: true; result: SignInResult } | { ok: false; error: unknown }

/** A sign-in that came back from the provider, being completed. */
export interface SignInReturn {
  kind: OAuthKind
  intent: SignInIntent
  done: Promise<SignInOutcome>
  /** Join: the flow's options from before the redirect (`saveJoinUi`). */
  ui: JoinResumeUi
}

let current: SignInReturn | null = null

/**
 * The sign-in that just came back, if any: reads the pending slot (for the provider and why it started,
 * which a failed `completeSignIn` doesn't report) and completes it, once. Repeated calls return the same
 * object until `ackSignInReturn`, so a remount (StrictMode, leaving and reopening Settings) resumes the
 * same screen instead of completing twice.
 */
export function takeSignInReturn(): SignInReturn | null {
  if (current) return current
  if (!signInReturnPending()) return null
  const p = readPending()
  if (!p) return null
  current = {
    kind: p.kind,
    intent: p.intent,
    ui: p.intent.type === 'join' ? takeJoinUi() : {},
    done: completeSignIn().then(
      (result): SignInOutcome => ({ ok: true, result }),
      (error: unknown): SignInOutcome => ({ ok: false, error }),
    ),
  }
  return current
}

/** The screen that resumed the sign-in has shown its outcome (or was closed). */
export function ackSignInReturn(r?: SignInReturn | null) {
  if (!r || r === current) current = null
}

/* ------------------------------------------------------ UI state across the redirect */

const UI_KEY = 'openstand-libsync:signin-ui'

/** Join-flow options that the sign-in intent doesn't carry (`rejoin`, `reason`), kept across the redirect. */
export interface JoinResumeUi {
  rejoin?: boolean
  reason?: 'libraryGone'
}

export function saveJoinUi(ui: JoinResumeUi) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...ui, at: Date.now() }))
  } catch {
    /* storage unavailable: the join resumes with the defaults */
  }
}

/** Read once, then forgotten. Older than the 15-minute sign-in window counts as absent. */
export function takeJoinUi(now = Date.now()): JoinResumeUi {
  try {
    const raw = localStorage.getItem(UI_KEY)
    localStorage.removeItem(UI_KEY)
    const v = JSON.parse(raw ?? 'null') as (JoinResumeUi & { at?: number }) | null
    if (!v || typeof v.at !== 'number' || now - v.at > 15 * 60_000) return {}
    return { rejoin: v.rejoin === true || undefined, reason: v.reason === 'libraryGone' ? 'libraryGone' : undefined }
  } catch {
    return {}
  }
}

/** The `OSJ1.` code inside pasted text (what the join intent carries across the redirect). */
export function codeIn(text: string): string {
  return /OSJ\d+\.[A-Za-z0-9_-]+/.exec(text)?.[0] ?? text.trim()
}

/** Dev on 127.0.0.1: the providers only accept the registered http://localhost:5317. */
export function localhostHint(loc: { hostname: string; port: string; protocol: string } | undefined = typeof location === 'undefined' ? undefined : location): string | undefined {
  if (!loc || loc.hostname !== '127.0.0.1') return undefined
  return `${loc.protocol}//localhost${loc.port ? `:${loc.port}` : ''}`
}
