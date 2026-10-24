import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibSyncErrorCode, LibSyncStatus } from '../api'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  syncNow: vi.fn(async () => {}),
  setPaused: vi.fn(async () => {}),
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
    expect(screen.getByRole('dialog', { name: undefined })).toBeTruthy()
    expect(screen.getByText('Join a synced library')).toBeTruthy()
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
    ['libraryGone', 'The synced library was deleted from storage.', 'Stop syncing'],
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
})
