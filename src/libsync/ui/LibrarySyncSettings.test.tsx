import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibSyncErrorCode, LibSyncStatus } from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  syncNow: vi.fn(async () => {}),
  setPaused: vi.fn(async () => {}),
  leaveSync: vi.fn(async () => {
    const m = await import('../api')
    m.useLibSync.setState(m.offStatus(), true)
  }),
  renameDevice: vi.fn(async () => {}),
  pairingCode: vi.fn(async () => {
    throw new Error('no code')
  }),
}))

// Isolated from the library module (and whatever it pulls in): only the active library's name is read.
vi.mock('../../library/browse/libraries', async () => {
  const { create } = await import('zustand')
  return { useLibraries: create(() => ({ list: [{ id: 'default', name: 'My Library' }], active: 'default' })) }
})

const api = await import('../api')
const { LibrarySyncSettings } = await import('./LibrarySyncSettings')
const { SyncIndicator } = await import('./SyncIndicator')

const NOW = Date.now()
const on = (p: Partial<LibSyncStatus> = {}): LibSyncStatus => ({
  ...api.offStatus(),
  configured: true,
  phase: 'idle',
  lastSyncAt: NOW - 2 * 60_000,
  backendLabel: 'Cloudflare R2 · my-music/openstand',
  offlineReady: { have: 1238, total: 1240 },
  devices: [
    { v: 1, id: 'a', name: 'Laptop', platform: 'Linux', appVersion: '1', createdAt: 0, lastSeenAt: NOW, self: true },
    { v: 1, id: 'b', name: 'iPad', platform: 'iPadOS', appVersion: '1', createdAt: 0, lastSeenAt: NOW - 3 * 3600_000, self: false },
    { v: 1, id: 'c', name: 'Old phone', platform: 'Android', appVersion: '1', createdAt: 0, lastSeenAt: 0, self: false, retired: true },
  ],
  ...p,
})
const set = (s: LibSyncStatus) => api.useLibSync.setState(s, true)

afterEach(() => {
  cleanup()
  set(api.offStatus())
})

describe('LibrarySyncSettings', () => {
  it('off: explains and offers set up and join', () => {
    set(api.offStatus())
    render(<LibrarySyncSettings />)
    expect(screen.getByText('Your own storage')).toBeTruthy()
    expect(screen.getByText('Encrypted on the device')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set up sync' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Join from another device' }))
    expect(screen.getByRole('dialog', { name: 'Join a synced library' })).toBeTruthy()
  })

  it('on: status, offline readiness, devices', () => {
    set(on())
    render(<LibrarySyncSettings />)
    expect(screen.getByText('Up to date · 2 min ago')).toBeTruthy()
    expect(screen.getByText('Ready offline: 1,238 of 1,240 files')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.getByText(/Last seen 3 h ago/)).toBeTruthy()
    expect(screen.getByText(/Stopped syncing/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(api.syncNow).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Pause sync' }))
    expect(api.setPaused).toHaveBeenCalledWith(true)
  })

  it('shows transfer lines while syncing', () => {
    set(on({ phase: 'syncing', upload: { files: 3, doneFiles: 0, bytes: 12e6, doneBytes: 0 }, download: { files: 120, doneFiles: 0, bytes: 1e6, doneBytes: 0 } }))
    render(<LibrarySyncSettings />)
    expect(screen.getByText('Uploading 3 files (12 MB)')).toBeTruthy()
    expect(screen.getByText('Downloading 120 files. You can keep using OpenStand.')).toBeTruthy()
  })

  const banners: [LibSyncErrorCode, string, string | null][] = [
    ['auth', 'Your storage rejected the access key. It may have expired or been revoked.', 'Update storage keys'],
    ['cors', 'Your bucket doesn’t allow this site yet.', 'Show CORS rule'],
    ['clock', 'This device’s clock is wrong, so the storage refused the request.', 'Retry'],
    ['wrongSecret', 'This code doesn’t match the data in that storage.', 'Join again'],
    ['libraryGone', 'The synced library was reset or deleted from another device.', 'Join with a new code'],
    ['newerFormat', 'Another device uses a newer OpenStand. Update this one to keep syncing.', 'Reload app'],
    ['rejoin', 'This device needs to rejoin the synced library.', 'Rejoin'],
  ]
  it.each(banners)('error banner for %s', (code, message, action) => {
    set(on({ phase: 'error', error: { code, message: code, at: NOW } }))
    render(<LibrarySyncSettings />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(message)
    if (action) expect(within(alert).getByRole('button', { name: action })).toBeTruthy()
  })

  it('library gone: explains what happened and offers to join with a new code, keeping the songs', async () => {
    set(on({ phase: 'error', error: { code: 'libraryGone', message: 'libraryGone', at: NOW } }))
    render(<LibrarySyncSettings />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('get a new pairing code from a device that’s still syncing and join again')
    expect(within(alert).getByRole('button', { name: 'Stop syncing' })).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: 'Join with a new code' }))
    const dialog = await screen.findByRole('dialog', { name: 'Join with a new code' })
    expect(api.leaveSync).toHaveBeenCalledTimes(1)
    expect(dialog.textContent).toContain('Your songs are still here.')
  })

  it('library gone: Sync now, Add a device and storage keys are hidden (in the popover too)', () => {
    set(on({ phase: 'error', error: { code: 'libraryGone', message: 'libraryGone', at: NOW } }))
    render(<LibrarySyncSettings />)
    for (const name of ['Sync now', 'Add a device', 'Update storage keys', 'Re-check files', 'Delete synced data from storage…'])
      expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Pause sync' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename this device' })).toBeNull()
    expect(screen.getByText(/Not syncing/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset sync…' })).toBeTruthy()
    cleanup()
    render(<SyncIndicator />)
    fireEvent.click(screen.getByRole('button', { name: /^Library sync:/ }))
    const pop = screen.getByRole('dialog', { name: 'Library sync status' })
    expect(within(pop).queryByRole('button', { name: 'Sync now' })).toBeNull()
    expect(within(pop).getByRole('button', { name: 'Open settings' })).toBeTruthy()
  })

  it('rejoin: no pairing code; paused: Sync now disabled with a reason', () => {
    set(on({ phase: 'error', error: { code: 'rejoin', message: 'rejoin', at: NOW } }))
    render(<LibrarySyncSettings />)
    expect(screen.queryByRole('button', { name: 'Add a device' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
    cleanup()
    set(on({ phase: 'paused' }))
    render(<LibrarySyncSettings />)
    const sync = screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement
    expect(sync.disabled).toBe(true)
    expect(sync.title).toBe('Sync is paused.')
    expect(screen.getByRole('button', { name: 'Add a device' })).toBeTruthy()
  })

  it('renames this device from the devices list', async () => {
    set(on())
    render(<LibrarySyncSettings />)
    // Only this device has a rename button.
    expect(screen.getAllByRole('button', { name: 'Rename this device' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Rename this device' }))
    const dialog = screen.getByRole('dialog', { name: 'Rename this device' })
    const input = within(dialog).getByRole('textbox', { name: /Device name/ }) as HTMLInputElement
    expect(input.value).toBe('Laptop')
    fireEvent.change(input, { target: { value: '  Studio laptop ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith('Studio laptop'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename this device' })).toBeNull())
  })

  it('shows friendly wording for the first upload after a reset', () => {
    set(on({ phase: 'starting', initial: { kind: 'upload', step: 'publish', done: 0, total: 1 } }))
    render(<LibrarySyncSettings />)
    expect(screen.getByText('Uploading your library…')).toBeTruthy()
    expect(screen.getByText('Uploading songs and files…')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/publish|(^|[^\d,])0 of 1\b/)
  })

  it('no banner for network errors (shown as offline)', () => {
    set(on({ phase: 'offline', error: { code: 'network', message: 'x', at: NOW } }))
    render(<LibrarySyncSettings />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Offline. Changes will sync when you’re back online.')).toBeTruthy()
  })
})

describe('SyncIndicator', () => {
  it('is hidden when sync is not set up', () => {
    set(api.offStatus())
    const { container } = render(<SyncIndicator />)
    expect(container.innerHTML).toBe('')
  })

  it.each([
    [on(), 'Library sync: up to date'],
    [on({ phase: 'offline' }), 'Library sync: offline'],
    [on({ phase: 'paused' }), 'Library sync: paused'],
    [on({ phase: 'syncing', upload: { files: 3, doneFiles: 0, bytes: 12e6, doneBytes: 0 } }), 'Library sync: Uploading 3 files (12 MB)'],
    [on({ phase: 'error', error: { code: 'auth', message: 'auth', at: 0 } }), 'Library sync: Your storage rejected the access key. It may have expired or been revoked.'],
  ])('labels its state (%#)', (s, label) => {
    set(s)
    render(<SyncIndicator />)
    expect(screen.getByRole('button', { name: label })).toBeTruthy()
  })

  it('opens a summary with Sync now and Open settings', () => {
    set(on({ pendingChanges: 2 }))
    render(<SyncIndicator />)
    fireEvent.click(screen.getByRole('button', { name: 'Library sync: up to date' }))
    expect(screen.getByText('2 changes waiting to upload')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
  })
  it('a held-back device stream is a calm warning, not "Sync stopped"', () => {
    const w = { code: 'unknown' as const, message: 'Changes from “iPad” can’t be read right now. Other devices keep syncing.', at: NOW }
    set(on({ streams: { b: w }, warning: w, error: w }))
    render(<LibrarySyncSettings />)
    expect(screen.getByText(w.message)).toBeTruthy()
    expect(screen.getByText(/keeps retrying in the background/)).toBeTruthy()
    expect(screen.queryByText('Sync stopped')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
