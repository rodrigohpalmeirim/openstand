/** The cloud-drive screens (SYNC-DRIVES.md §7) with the facade mocked: wizard, join flow, Settings. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendCheck, BackendConfig } from '../backends/types'
import type { PairingPayload } from '../model'
import type { SignInReturn } from './signin'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  oauthProviders: vi.fn(async () => ['dropbox', 'gdrive', 'onedrive']),
  startSignIn: vi.fn(async () => new Promise<void>(() => {})),
  completeSignIn: vi.fn(),
  driveBackendConfig: vi.fn(),
  describeBackend: vi.fn(),
  discardSignIn: vi.fn(async () => {}),
  checkBackend: vi.fn(),
  enableSync: vi.fn(),
  pairingCode: vi.fn(async () => 'OSJ1.code'),
  parsePairingCode: vi.fn(),
  previewJoin: vi.fn(),
  joinSync: vi.fn(),
  leaveSync: vi.fn(async () => {}),
}))
vi.mock('../../library/browse/libraries', async () => {
  const { create } = await import('zustand')
  return { useLibraries: create(() => ({ list: [{ id: 'default', name: 'My Library' }], active: 'default' })) }
})

const api = await import('../api')
const { SetupWizard } = await import('./SetupWizard')
const { JoinFlow } = await import('./JoinFlow')
const { LibrarySyncSettings } = await import('./LibrarySyncSettings')
const { SyncIndicator } = await import('./SyncIndicator')

const ROD = { id: 'dbid:1', email: 'rod@example.com' }
const SAM = { id: 'dbid:2', email: 'sam@example.org' }
const DROPBOX: BackendConfig = { kind: 'dropbox', root: '', account: ROD.email, accountId: ROD.id }
const OK: BackendCheck = { ok: true, steps: (['reach', 'auth', 'list', 'write', 'read', 'delete'] as const).map((id) => ({ id, ok: true })) }
const CODE = 'OSJ1.dropboxcode'
const PAYLOAD: PairingPayload = { v: 1, s: 'secret', n: 'Band book', b: DROPBOX, r: null }
const PREVIEW = { remoteSongs: 5, remoteBytes: 0, localSongs: 0, matches: 0, suggested: 'here' as const }

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const ret = (intent: SignInReturn['intent'], out: Awaited<SignInReturn['done']>): SignInReturn => ({ kind: 'dropbox', intent, done: Promise.resolve(out), ui: {} })

beforeEach(() => {
  vi.mocked(api.driveBackendConfig).mockReset().mockResolvedValue(DROPBOX)
  vi.mocked(api.describeBackend).mockReset().mockResolvedValue({ account: ROD, location: 'Dropbox › Apps › OpenStand', openUrl: 'https://www.dropbox.com/home/Apps/OpenStand', freeBytes: 2e9 })
  vi.mocked(api.checkBackend).mockReset().mockResolvedValue(OK)
  vi.mocked(api.enableSync).mockReset().mockResolvedValue()
  vi.mocked(api.startSignIn).mockClear()
  vi.mocked(api.discardSignIn).mockClear()
  vi.mocked(api.leaveSync).mockClear()
  vi.mocked(api.parsePairingCode).mockReset().mockResolvedValue(PAYLOAD)
  vi.mocked(api.previewJoin).mockReset().mockResolvedValue(PREVIEW)
  vi.mocked(api.joinSync).mockReset().mockResolvedValue()
})
afterEach(() => {
  cleanup()
  api.useLibSync.setState(api.offStatus(), true)
  localStorage.clear()
})

describe('setup wizard with a drive', () => {
  it('offers the drives, explains what is accessed, and redirects to sign in', async () => {
    render(<SetupWizard open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('radio', { name: /^Google Drive/ }))
    expect(screen.getByText(/OpenStand gets its own folder and can’t see your other files/, { selector: '[aria-checked="true"] *' })).toBeTruthy()
    click('Next')
    expect(screen.getByText('Google Drive › OpenStand')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'What OpenStand can access' }).textContent).toMatch(/Only the folder and files OpenStand creates.*account name, email address and free space/s)
    expect((screen.getByRole('link', { name: /Privacy policy/ }) as HTMLAnchorElement).getAttribute('href')).toBe('/privacy')
    click('Sign in with Google')
    expect(api.startSignIn).toHaveBeenCalledWith('gdrive', { type: 'setup' }, undefined)
  })

  it('says Google and Microsoft sign-in passes through the sign-in helper; Dropbox doesn’t', () => {
    render(<SetupWizard open onClose={() => {}} storage="gdrive" />)
    expect(screen.getByText(/Sign-in passes through OpenStand’s sign-in helper, which doesn’t store or log anything/)).toBeTruthy()
    expect(screen.getByText(/only passes sign-in requests on and keeps nothing/)).toBeTruthy()
    cleanup()
    render(<SetupWizard open onClose={() => {}} storage="dropbox" />)
    expect(screen.queryByText(/sign-in helper/)).toBeNull()
    expect(screen.getByText(/None of it is sent to OpenStand or shared with anyone/)).toBeTruthy()
  })

  it('the Dropbox step suggests Selective Sync', async () => {
    render(<SetupWizard open onClose={() => {}} storage="dropbox" />)
    expect(screen.getByText(/exclude/).textContent).toMatch(/Selective Sync/)
  })

  it('a refused redirect shows why and stays on the sign-in step', async () => {
    vi.mocked(api.startSignIn).mockRejectedValueOnce(new api.LibSyncFailure('unknown', 'Sign-in with Dropbox isn’t available on this site.', 'notConfigured'))
    render(<SetupWizard open onClose={() => {}} storage="dropbox" />)
    click('Sign in with Dropbox')
    expect(await screen.findByText('Sign-in with Dropbox isn’t available on this site.')).toBeTruthy()
  })

  it('resumes after the redirect: account, folder, test, start, pairing', async () => {
    render(<SetupWizard open onClose={() => {}} resume={ret({ type: 'setup' }, { ok: true, result: { kind: 'dropbox', intent: { type: 'setup' }, account: ROD } })} />)
    expect(await screen.findByText(/Everything works/)).toBeTruthy()
    expect(screen.getByText('rod@example.com')).toBeTruthy()
    expect(screen.getByText('Signed in to Dropbox')).toBeTruthy()
    expect(screen.getByText(/2.0 GB free/)).toBeTruthy()
    expect(api.checkBackend).toHaveBeenCalledWith(DROPBOX)
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }))
    expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'setup' }, { chooseAccount: true })
    click('Start syncing')
    await screen.findByRole('button', { name: 'Show pairing code' })
    expect(api.enableSync).toHaveBeenCalledWith({ backend: DROPBOX })
  })

  it('a failed sign-in comes back to the sign-in step with the reason', async () => {
    const error = new api.LibSyncFailure('unknown', 'Sign-in was cancelled.', 'denied')
    render(<SetupWizard open onClose={() => {}} resume={ret({ type: 'setup' }, { ok: false, error })} />)
    expect(await screen.findByText('Sign-in was cancelled.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with Dropbox' })).toBeTruthy()
    expect(api.driveBackendConfig).not.toHaveBeenCalled()
  })

  it('cancelling after signing in forgets the sign-in', async () => {
    const onClose = vi.fn()
    render(<SetupWizard open onClose={onClose} resume={ret({ type: 'setup' }, { ok: true, result: { kind: 'dropbox', intent: { type: 'setup' }, account: ROD } })} />)
    await screen.findByText(/Everything works/)
    fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0])
    expect(api.discardSignIn).toHaveBeenCalledWith('dropbox')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('joining with a drive code', () => {
  const paste = (text: string) => {
    fireEvent.change(screen.getByLabelText('Or paste the code'), { target: { value: text } })
    click('Continue')
  }

  it('shows the provider and account, then signs in with that account', async () => {
    render(<JoinFlow open onClose={() => {}} />)
    paste(`my code ${CODE}`)
    expect(await screen.findByText(/This library is stored in/)).toBeTruthy()
    expect(screen.getAllByText('rod@example.com').length).toBeGreaterThan(0)
    expect(api.previewJoin).not.toHaveBeenCalled()
    click('Sign in with Dropbox')
    await waitFor(() => expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'join', pairing: CODE }, { loginHint: 'rod@example.com' }))
  })

  it('back from the provider: signed in, preview, join', async () => {
    render(<JoinFlow open onClose={() => {}} resume={ret({ type: 'join', pairing: CODE }, { ok: true, result: { kind: 'dropbox', intent: { type: 'join', pairing: CODE }, account: ROD } })} />)
    expect(await screen.findByText(/Signed in to Dropbox as/)).toBeTruthy()
    expect(api.parsePairingCode).toHaveBeenCalledWith(CODE)
    click('Join')
    await screen.findByText('You’re in')
    expect(api.joinSync).toHaveBeenCalledWith(PAYLOAD, 'here')
  })

  it('another account than the code’s: warns, and can go on anyway', async () => {
    render(<JoinFlow open onClose={() => {}} resume={ret({ type: 'join', pairing: CODE }, { ok: true, result: { kind: 'dropbox', intent: { type: 'join', pairing: CODE }, account: SAM } })} />)
    expect(await screen.findByText('This code is for rod@example.com, but you signed in as sam@example.org.')).toBeTruthy()
    expect(api.previewJoin).not.toHaveBeenCalled()
    click('Sign in with another account')
    expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'join', pairing: CODE }, { loginHint: 'rod@example.com', chooseAccount: true })
    click('Continue anyway')
    await screen.findByText(/Signed in to Dropbox as/)
  })

  it('the library isn’t in the signed-in account (§7.3): says so, offers another account or code', async () => {
    const msg = 'This library isn’t in the Dropbox account you signed in with (sam@example.org). The code was made for rod@example.com. Sign in with that account, or get a new code if the library was deleted.'
    vi.mocked(api.previewJoin).mockRejectedValue(new api.LibSyncFailure('wrongAccount', msg, 'rod@example.com'))
    // An older code without the account id: only the storage check can tell (§7.3 layer 2).
    vi.mocked(api.parsePairingCode).mockResolvedValue({ ...PAYLOAD, b: { kind: 'dropbox', root: '', account: ROD.email } })
    render(<JoinFlow open onClose={() => {}} resume={ret({ type: 'join', pairing: CODE }, { ok: true, result: { kind: 'dropbox', intent: { type: 'join', pairing: CODE }, account: { id: 'x', email: 'sam@example.org' } } })} />)
    expect(await screen.findByText(msg)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with another account' })).toBeTruthy()
    click('Scan another code')
    expect(screen.getByLabelText('Or paste the code')).toBeTruthy()
  })

  it('a cancelled sign-in comes back to the sign-in step', async () => {
    const error = new api.LibSyncFailure('unknown', 'Sign-in was cancelled.', 'denied')
    render(<JoinFlow open onClose={() => {}} resume={ret({ type: 'join', pairing: CODE }, { ok: false, error })} />)
    expect(await screen.findByText('Sign-in was cancelled.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with Dropbox' })).toBeTruthy()
  })

  it('rejoining leaves but keeps the sign-in the join needs', async () => {
    api.useLibSync.setState({ ...api.offStatus(), configured: true, phase: 'error', backendKind: 'dropbox' }, true)
    render(<JoinFlow open rejoin onClose={() => {}} resume={ret({ type: 'join', pairing: CODE }, { ok: true, result: { kind: 'dropbox', intent: { type: 'join', pairing: CODE }, account: ROD } })} />)
    await screen.findByText(/Signed in to Dropbox as/)
    click('Join and merge')
    await screen.findByText('You’re in')
    expect(api.leaveSync).toHaveBeenCalledWith({ keepSignIn: true })
  })
})

describe('Settings with a drive', () => {
  beforeEach(() => vi.mocked(api.parsePairingCode).mockResolvedValue(PAYLOAD))
  const on = (p: Partial<ReturnType<typeof api.offStatus>> = {}) =>
    api.useLibSync.setState({ ...api.offStatus(), configured: true, phase: 'idle', backendKind: 'dropbox', backendLabel: 'Dropbox · rod@example.com', ...p }, true)

  it('shows the account and folder, and signs in again instead of storage keys', async () => {
    on()
    render(<LibrarySyncSettings />)
    expect(screen.getByText('Dropbox · rod@example.com')).toBeTruthy()
    expect(await screen.findByRole('link', { name: /Open folder/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Update storage keys' })).toBeNull()
    click('Sign in again')
    await waitFor(() => expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'reauth', accountId: ROD.id }, { loginHint: ROD.email }))
  })

  it('reauth banner with its action; no Sync now while signed out', async () => {
    on({ phase: 'error', error: { code: 'reauth', message: 'reauth', at: 0 } })
    render(<LibrarySyncSettings />)
    expect(screen.getByText('Sign in to Dropbox again to keep syncing. Your changes are kept on this device until then.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in again' })[0])
    await waitFor(() => expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'reauth', accountId: ROD.id }, { loginHint: ROD.email }))
  })

  it('wrong account: whose Dropbox it is, and another account', async () => {
    on({ phase: 'error', error: { code: 'wrongAccount', message: 'wrongAccount', at: 0 } })
    render(<LibrarySyncSettings />)
    expect(await screen.findByText('This library is in rod@example.com’s Dropbox, not in the account you signed in with.')).toBeTruthy()
    click('Sign in with another account')
    await waitFor(() => expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'reauth', accountId: ROD.id }, { loginHint: ROD.email, chooseAccount: true }))
  })

  it('Stop syncing links to the account’s connected apps; Reset has no key rotation', async () => {
    on({ backendKind: 'gdrive', backendLabel: 'Google Drive · rod@example.com' })
    vi.mocked(api.parsePairingCode).mockResolvedValue({ ...PAYLOAD, b: { kind: 'gdrive', folder: '1AbCdEfGhIjK', account: ROD.email, accountId: 'p1' } })
    render(<LibrarySyncSettings />)
    click('Reset sync…')
    expect(await screen.findByText('A lost device stays signed in to Google Drive.')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Also switch to new storage keys' })).toBeNull()
    expect((screen.getByRole('link', { name: /Google account connections/ }) as HTMLAnchorElement).href).toBe('https://myaccount.google.com/connections')
  })
})

describe('indicator popover with a drive', () => {
  const on = (code: 'reauth' | 'wrongAccount') =>
    api.useLibSync.setState({ ...api.offStatus(), configured: true, phase: 'error', backendKind: 'dropbox', error: { code, message: code, at: 0 } }, true)
  beforeEach(() => vi.mocked(api.parsePairingCode).mockResolvedValue(PAYLOAD))

  it('reauth: Sign in again, as the same account; Open settings stays', async () => {
    on('reauth')
    render(<SyncIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /Library sync/ }))
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
    click('Sign in again')
    await waitFor(() => expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'reauth', accountId: ROD.id }, { loginHint: ROD.email }))
  })

  it('wrong account: Sign in with another account', async () => {
    on('wrongAccount')
    render(<SyncIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /Library sync/ }))
    click('Sign in with another account')
    await waitFor(() => expect(api.startSignIn).toHaveBeenCalledWith('dropbox', { type: 'reauth', accountId: ROD.id }, { loginHint: ROD.email, chooseAccount: true }))
  })
})
