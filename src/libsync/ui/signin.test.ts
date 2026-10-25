import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  completeSignIn: vi.fn(),
}))

const api = await import('../api')
const { LibSyncFailure } = api
const { PENDING_KEY } = await import('../oauth/callback')
const { ackSignInReturn, codeIn, signInProblem, takeJoinUi, saveJoinUi, takeSignInReturn, wrongAccountText, joinWrongAccountText } = await import('./signin')

describe('sign-in problems from the facade’s failures', () => {
  const f = (code: ConstructorParameters<typeof LibSyncFailure>[0], detail?: string, message?: string) => new LibSyncFailure(code, message ?? code, detail)

  it('uses our wording when the facade gives only a code', () => {
    expect(signInProblem(f('unknown', 'denied'), 'dropbox')).toEqual({ message: 'Sign-in was cancelled.', action: 'retry' })
    expect(signInProblem(f('unknown', 'expired'), 'dropbox')).toEqual({ message: 'That sign-in took too long or was started elsewhere. Please try again.', action: 'retry' })
    expect(signInProblem(f('unknown', 'exchange'), 'onedrive')).toEqual({ message: 'OneDrive didn’t accept the sign-in. Please try again.', action: 'retry' })
    expect(signInProblem(f('unknown', 'notConfigured'), 'gdrive')).toEqual({ message: 'Sign-in with Google Drive isn’t available on this site.' })
    expect(signInProblem(f('network', 'network'), 'gdrive')).toEqual({ message: 'Can’t reach Google Drive. Check your connection.', action: 'retry' })
    expect(signInProblem(f('reauth', 'scope'), 'gdrive').message).toBe('OpenStand needs access to its own files in Google Drive. Sign in again and tick the box.')
    expect(signInProblem(f('reauth', 'scope'), 'dropbox').message).toBe('OpenStand needs access to its own files in Dropbox. Sign in again and allow it.')
  })

  it('prefers the facade’s sentence', () => {
    expect(signInProblem(f('unknown', 'denied', 'Sign-in was cancelled.'), 'dropbox').message).toBe('Sign-in was cancelled.')
    expect(signInProblem(f('unknown', 'notConfigured', 'Sign-in with Dropbox isn’t available on this site.'), 'dropbox').action).toBeUndefined()
  })

  it('not signed in (no tokens) is not a scope problem', () => {
    expect(signInProblem(f('reauth', 'NoTokens'), 'onedrive')).toEqual({ message: 'Sign in to OneDrive to continue.', action: 'retry' })
  })

  it('wrong account: `detail` is the account the library is in; offers another account', () => {
    expect(signInProblem(f('wrongAccount', 'rod@example.com'), 'dropbox', { got: 'sam@example.org' })).toEqual({
      message: 'You signed in as sam@example.org, but this library is in rod@example.com’s Dropbox.',
      action: 'chooseAccount',
    })
    expect(signInProblem(f('wrongAccount', 'rod@example.com', 'You signed in as sam@example.org, but this library is in rod@example.com.'), 'dropbox').message).toBe(
      'You signed in as sam@example.org, but this library is in rod@example.com.',
    )
    expect(wrongAccountText('gdrive')).toBe('This library isn’t in the Google Drive account you signed in with.')
    expect(joinWrongAccountText('onedrive', 'sam@example.org', 'rod@example.com')).toBe(
      'This library isn’t in the OneDrive account you signed in with (sam@example.org). The code was made for rod@example.com. Sign in with that account, or get a new code if the library was deleted.',
    )
  })

  it('anything else: a sentence as is, never a bare identifier', () => {
    expect(signInProblem(new Error('boom'), 'dropbox').message).toBe('Signing in didn’t work. Please try again.')
    expect(signInProblem(f('unknown'), 'dropbox').message).toBe('Signing in didn’t work. Please try again.')
  })
})

describe('resuming after the redirect', () => {
  afterEach(() => {
    localStorage.clear()
    ackSignInReturn()
    vi.mocked(api.completeSignIn).mockReset()
  })
  const slot = (ret: unknown, intent: unknown = { type: 'setup' }) =>
    localStorage.setItem(PENDING_KEY, JSON.stringify({ v: 1, kind: 'dropbox', state: 's', verifier: 'v', redirectUri: 'r', db: 'd', intent, createdAt: Date.now(), ret }))

  it('nothing pending: nothing to resume', () => {
    expect(takeSignInReturn()).toBeNull()
    slot(undefined)
    expect(takeSignInReturn()).toBeNull()
  })

  it('completes once, however often it is taken, until acknowledged', async () => {
    slot({ code: 'c' })
    const result = { kind: 'dropbox' as const, intent: { type: 'setup' as const }, account: { id: '1', email: 'rod@example.com' } }
    vi.mocked(api.completeSignIn).mockResolvedValue(result)
    const a = takeSignInReturn()
    const b = takeSignInReturn()
    expect(a).toBe(b)
    expect(a).toMatchObject({ kind: 'dropbox', intent: { type: 'setup' } })
    expect(await a!.done).toEqual({ ok: true, result })
    expect(api.completeSignIn).toHaveBeenCalledTimes(1)
    ackSignInReturn(a)
    localStorage.clear()
    expect(takeSignInReturn()).toBeNull()
  })

  it('knows the provider and intent even when completing fails', async () => {
    slot({ error: 'access_denied' }, { type: 'join', pairing: 'OSJ1.abc' })
    saveJoinUi({ rejoin: true })
    const err = new LibSyncFailure('unknown', 'Sign-in was cancelled.', 'denied')
    vi.mocked(api.completeSignIn).mockRejectedValue(err)
    const r = takeSignInReturn()!
    expect(r).toMatchObject({ kind: 'dropbox', intent: { type: 'join', pairing: 'OSJ1.abc' }, ui: { rejoin: true } })
    expect(await r.done).toEqual({ ok: false, error: err })
  })

  it('join options survive the redirect once, and not for long', () => {
    saveJoinUi({ rejoin: true, reason: 'libraryGone' })
    expect(takeJoinUi()).toEqual({ rejoin: true, reason: 'libraryGone' })
    expect(takeJoinUi()).toEqual({})
    saveJoinUi({ rejoin: true })
    expect(takeJoinUi(Date.now() + 16 * 60_000)).toEqual({})
  })

  it('finds the code in pasted text', () => {
    expect(codeIn('Here: OSJ1.abc_-9 thanks')).toBe('OSJ1.abc_-9')
    expect(codeIn('  nothing  ')).toBe('nothing')
  })
})
