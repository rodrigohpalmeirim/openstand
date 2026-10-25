/**
 * Join-flow state (§10.3, §12.2): scan or paste → preview → mode → progress. A cloud-drive code
 * (SYNC-DRIVES.md §7.2) adds a sign-in step after the scan: redirect to the provider, back to the sign-in
 * step's success state, then the preview. Pure.
 */
import type { AccountInfo, JoinPreview } from '../api'
import { LibSyncFailure } from '../api'
import { PairingError, type JoinMode, type PairingPayload } from '../model'
import { errorText, failureText, fmtBytes, plural } from './format'
import { drive, isDrive, type SignInProblem } from './signin'

export type JoinStep = 'scan' | 'checking' | 'signin' | 'preview' | 'joining' | 'done'

export interface JoinState {
  step: JoinStep
  payload?: PairingPayload
  /** The code as scanned (drives: carried across the sign-in redirect). */
  code?: string
  preview?: JoinPreview
  mode: JoinMode
  error?: string
  /** Drives: who this device signed in as. */
  account?: AccountInfo
  /** Drives: leaving for the provider's sign-in page. */
  signingIn?: boolean
  /** Drives: why the sign-in (or the check right after it) didn't work. */
  signInError?: SignInProblem
  /** Drives: the code names another account than the one signed in (§7.2 step 4; a hint, can be overridden). */
  mismatch?: boolean
  /** Drives: the library isn't in the signed-in account (§7.3); offers "Scan another code". */
  wrongAccount?: boolean
}

export type JoinAction =
  | { type: 'code' }
  | { type: 'parsed'; payload: PairingPayload }
  | { type: 'previewed'; preview: JoinPreview }
  | { type: 'failed'; error: string }
  | { type: 'mode'; mode: JoinMode }
  | { type: 'join' }
  | { type: 'joined' }
  | { type: 'back' }
  /** Drives: the code is for a cloud drive; sign in before anything can be read. */
  | { type: 'needsSignIn'; payload: PairingPayload; code: string }
  | { type: 'signInStart' }
  | { type: 'signInFailed'; problem: SignInProblem; wrongAccount?: boolean }
  /** Drives: back from the provider, completing the sign-in. */
  | { type: 'resume' }
  /** Drives: signed in; checks the account against the code's hint. */
  | { type: 'signedIn'; payload: PairingPayload; code: string; account: AccountInfo }
  /** Drives: the account hint didn't match, and the user goes on anyway. */
  | { type: 'continueAnyway' }
  /** Drives: run the preview (again) with the signed-in account. */
  | { type: 'check' }

export const initialJoin = (): JoinState => ({ step: 'scan', mode: 'newLibrary' })

/** §7.3 layer 1: both ids known and different. Emails change, so this is a hint, never a block. */
export const accountsDiffer = (p: PairingPayload, a?: AccountInfo) => {
  const want = isDrive(p.b.kind) ? (p.b as { accountId?: string }).accountId : undefined
  return !!(want && a?.id && want !== a.id)
}

const noSignIn = { account: undefined, signingIn: false, signInError: undefined, mismatch: false, wrongAccount: false }

export function joinReducer(s: JoinState, a: JoinAction): JoinState {
  switch (a.type) {
    case 'code':
      return { ...s, ...noSignIn, step: 'checking', error: undefined, payload: undefined, code: undefined, preview: undefined }
    case 'parsed':
      return { ...s, payload: a.payload }
    case 'previewed':
      // §15.4: a non-empty library defaults to a separate new library; merge is an explicit choice.
      return { ...s, step: 'preview', preview: a.preview, mode: a.preview.suggested, signInError: undefined }
    case 'failed':
      // A failed join goes back to the preview so the user can retry; a bad code back to scanning; a
      // signed-in drive check back to the sign-in step (its "Continue" retries).
      return { ...s, step: s.step === 'joining' ? 'preview' : s.account ? 'signin' : 'scan', error: a.error }
    case 'mode':
      return s.step === 'preview' ? { ...s, mode: a.mode } : s
    case 'join':
      return s.step === 'preview' ? { ...s, step: 'joining', error: undefined } : s
    case 'joined':
      return { ...s, step: 'done' }
    case 'back':
      return s.step === 'preview' || s.step === 'signin' ? { ...initialJoin() } : s
    case 'needsSignIn':
      return { ...s, ...noSignIn, step: 'signin', payload: a.payload, code: a.code, preview: undefined, error: undefined }
    case 'signInStart':
      return s.step === 'signin' ? { ...s, signingIn: true, signInError: undefined, error: undefined } : s
    case 'signInFailed':
      return { ...s, step: 'signin', signingIn: false, signInError: a.problem, wrongAccount: !!a.wrongAccount, mismatch: false, error: undefined }
    case 'resume':
      return { ...initialJoin(), step: 'checking' }
    case 'signedIn': {
      const mismatch = accountsDiffer(a.payload, a.account)
      return { ...s, ...noSignIn, payload: a.payload, code: a.code, account: a.account, mismatch, step: mismatch ? 'signin' : 'checking', error: undefined }
    }
    case 'continueAnyway':
      return s.mismatch ? { ...s, mismatch: false, step: 'checking' } : s
    case 'check':
      return s.account ? { ...s, step: 'checking', error: undefined, signInError: undefined, wrongAccount: false } : s
  }
}

/** What to tell the user when a code can't be read or checked. */
export function joinErrorText(e: unknown, p?: PairingPayload): string {
  if (e instanceof PairingError || (e as Error)?.name === 'PairingError') {
    return (e as PairingError).code === 'version'
      ? 'This code comes from a newer OpenStand. Update this device, then try again.'
      : 'That isn’t an OpenStand pairing code. On the other device open Settings → Library sync → Add a device.'
  }
  if (e instanceof LibSyncFailure || (e as Error)?.name === 'LibSyncFailure') {
    const f = e as LibSyncFailure
    const kind = p?.b.kind
    if (f.code === 'network') return `Can’t reach ${isDrive(kind) ? drive(kind).name : 'the storage'}. Check your connection and try again.`
    return errorText({ code: f.code, message: f.message, detail: f.detail }, kind, isDrive(kind) ? (p!.b as { account?: string }).account : undefined).message
  }
  return failureText(e)
}

/** "Synced library: 1,240 songs, 3.2 GB · This device: 12 songs" */
export function previewLine(p: JoinPreview, name?: string): { remote: string; local: string } {
  return {
    remote: `${name ? `“${name}”` : 'Synced library'}: ${plural(p.remoteSongs, 'song')}${p.remoteBytes ? `, ${fmtBytes(p.remoteBytes)}` : ''}`,
    local: `This device: ${plural(p.localSongs, 'song')}`,
  }
}

/** §10.3: "N of your songs are already in the synced library and will be combined; M will be added." */
export function mergeLine(p: JoinPreview): string {
  const added = Math.max(0, p.localSongs - p.matches)
  if (!p.matches) return `${plural(added, 'song')} from this device will be added to the synced library.`
  return `${p.matches.toLocaleString('en-US')} of your songs ${p.matches === 1 ? 'is' : 'are'} already in the synced library and will be combined; ${added.toLocaleString('en-US')} will be added.`
}

/** Where a pairing code sends this library, for the join preview (so a joiner can spot a code that isn't theirs). */
export interface JoinTarget {
  /** Storage endpoint host, the drive's name, or the backend kind for other backends. */
  storage: string
  /** Cloud drives: the account the library is in (the code's hint). */
  account?: string
  /** `bucket/prefix`, when the backend has one. */
  bucket?: string
  /** Relay host for instant updates; undefined = polling only. */
  relay?: string
  /** Endpoint uses plain `http:` to something other than this machine. */
  insecure: boolean
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function hostOf(url: string, fallbackScheme: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `${fallbackScheme}://${url}`)
  } catch {
    return null
  }
}

export function joinTarget(p: PairingPayload, here: { host: string } | undefined = typeof location === 'undefined' ? undefined : location): JoinTarget {
  let relay: string | undefined
  const r = p.r?.trim()
  if (r) relay = r.startsWith('/') ? (here ? `${here.host} (this site)` : 'this site') : (hostOf(r, 'wss')?.host ?? r)
  const b = p.b
  if (isDrive(b.kind)) return { storage: drive(b.kind).name, ...('account' in b && b.account ? { account: b.account } : {}), relay, insecure: false }
  if (b.kind !== 's3') return { storage: b.kind, relay, insecure: false }
  const u = hostOf(b.endpoint, 'https')
  const host = u?.host || b.endpoint || 'unknown'
  return {
    storage: b.pathStyle || !u ? host : `${b.bucket}.${host}`,
    bucket: `${b.bucket}/${b.prefix}`,
    relay,
    insecure: u?.protocol === 'http:' && !LOCAL_HOSTS.has(u.hostname),
  }
}
