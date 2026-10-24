import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Config } from '../backends/types'
import type { PairingPayload } from '../model'

const BACKEND: S3Config = {
  kind: 's3',
  provider: 'r2',
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'my-music',
  prefix: 'openstand/',
  accessKeyId: 'old-key',
  secretAccessKey: 'old-secret',
  pathStyle: true,
}
const PAYLOAD: PairingPayload = { v: 1, s: 'secret', n: 'My Library', b: BACKEND, r: '/relay' }

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  pairingCode: vi.fn(async () => 'OSJ1.x'),
  parsePairingCode: vi.fn(async () => PAYLOAD),
  checkBackend: vi.fn(),
  updateBackend: vi.fn(),
  deleteRemoteData: vi.fn(),
  enableSync: vi.fn(),
}))
vi.mock('../../library/browse/libraries', async () => {
  const { create } = await import('zustand')
  return { useLibraries: create(() => ({ list: [{ id: 'default', name: 'My Library' }], active: 'default' })) }
})

const api = await import('../api')
const { LibrarySyncSettings } = await import('./LibrarySyncSettings')

const calls: string[] = []
beforeEach(() => {
  calls.length = 0
  vi.mocked(api.checkBackend).mockReset().mockImplementation(async () => (calls.push('check'), { ok: true, steps: [] }))
  vi.mocked(api.updateBackend).mockReset().mockImplementation(async () => void calls.push('update'))
  vi.mocked(api.deleteRemoteData).mockReset().mockImplementation(async () => void calls.push('delete'))
  vi.mocked(api.enableSync).mockReset().mockImplementation(async () => void calls.push('enable'))
  api.useLibSync.setState({ ...api.offStatus(), configured: true, phase: 'idle', backendLabel: 'Cloudflare R2 · my-music/openstand' }, true)
})
afterEach(() => {
  cleanup()
  api.useLibSync.setState(api.offStatus(), true)
})

async function openReset() {
  render(<LibrarySyncSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Reset sync…' }))
  // Wait for the storage config to load (the key-rotation switch needs it).
  return screen.findByRole('switch', { name: 'Also switch to new storage keys' })
}
const typeName = () => fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'my library' } })

describe('Reset sync', () => {
  it('says what it does and does not protect against', async () => {
    await openReset()
    expect(screen.getByText(/Reset makes a new encryption key and a new synced library/)).toBeTruthy()
    expect(screen.getByText('Reset doesn’t change your storage keys.')).toBeTruthy()
    expect(screen.getByText(/until you revoke them at Cloudflare R2/)).toBeTruthy()
  })

  it('without key rotation: keeps the storage keys, needs the library name', async () => {
    await openReset()
    const reset = screen.getByRole('button', { name: 'Reset sync' }) as HTMLButtonElement
    expect(reset.disabled).toBe(true)
    typeName()
    fireEvent.click(reset)
    await waitFor(() => expect(api.enableSync).toHaveBeenCalled())
    expect(calls).toEqual(['delete', 'enable'])
    expect(api.enableSync).toHaveBeenCalledWith({ backend: BACKEND, relay: '/relay' })
  })

  it('with key rotation: tests and saves the new keys first, then reminds to revoke the old one', async () => {
    const sw = await openReset()
    fireEvent.click(sw)
    expect(screen.getByText(/Create a new access key at Cloudflare R2/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Access key ID'), { target: { value: 'new-key' } })
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'new-secret' } })
    typeName()
    fireEvent.click(screen.getByRole('button', { name: 'Test keys and reset' }))
    expect(await screen.findByText('Last step: revoke the old storage key')).toBeTruthy()
    expect(calls).toEqual(['check', 'update', 'delete', 'enable'])
    const fresh = { ...BACKEND, accessKeyId: 'new-key', secretAccessKey: 'new-secret' }
    expect(api.updateBackend).toHaveBeenCalledWith(fresh)
    expect(api.enableSync).toHaveBeenCalledWith({ backend: fresh, relay: '/relay' })
  })

  it('refuses the key that is already in use, and stops when the new keys fail the test', async () => {
    const sw = await openReset()
    fireEvent.click(sw)
    fireEvent.change(screen.getByLabelText('Access key ID'), { target: { value: 'old-key' } })
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'x' } })
    typeName()
    fireEvent.click(screen.getByRole('button', { name: 'Test keys and reset' }))
    expect(await screen.findByText(/That’s the access key in use now/)).toBeTruthy()
    expect(calls).toEqual([])

    vi.mocked(api.checkBackend).mockResolvedValue({ ok: false, steps: [{ id: 'auth', ok: false }] })
    fireEvent.change(screen.getByLabelText('Access key ID'), { target: { value: 'new-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test keys and reset' }))
    await waitFor(() => expect(api.checkBackend).toHaveBeenCalled())
    expect(api.deleteRemoteData).not.toHaveBeenCalled()
  })
})
