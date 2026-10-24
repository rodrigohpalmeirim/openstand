import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairingError, type PairingPayload } from '../model'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  parsePairingCode: vi.fn(),
  previewJoin: vi.fn(),
  joinSync: vi.fn(),
  leaveSync: vi.fn(),
}))

// Isolated from the library module (and whatever it pulls in): only the active library's name is read.
vi.mock('../../library/browse/libraries', async () => {
  const { create } = await import('zustand')
  return { useLibraries: create(() => ({ list: [{ id: 'default', name: 'My Library' }], active: 'default' })) }
})

const api = await import('../api')
const { JoinFlow } = await import('./JoinFlow')

const payload: PairingPayload = { v: 1, s: 'secret', n: 'Band book', b: { kind: 'memory', name: 'm' }, r: null }

const paste = (text: string) => {
  fireEvent.change(screen.getByLabelText('Or paste the code'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('JoinFlow', () => {
  beforeEach(() => {
    vi.mocked(api.parsePairingCode).mockReset()
    vi.mocked(api.previewJoin).mockReset()
    vi.mocked(api.joinSync).mockReset()
    vi.mocked(api.leaveSync).mockReset()
  })
  afterEach(cleanup)

  it('explains a code that is not a pairing code and stays on the scanner', async () => {
    vi.mocked(api.parsePairingCode).mockRejectedValue(new PairingError('format'))
    render(<JoinFlow open onClose={() => {}} />)
    paste('hello')
    expect(await screen.findByText(/isn’t an OpenStand pairing code/)).toBeTruthy()
    expect(screen.getByLabelText('Or paste the code')).toBeTruthy()
    expect(api.previewJoin).not.toHaveBeenCalled()
  })

  it('shows the §12.3 wording when the code does not match the storage', async () => {
    vi.mocked(api.parsePairingCode).mockResolvedValue(payload)
    vi.mocked(api.previewJoin).mockRejectedValue(new api.LibSyncFailure('wrongSecret'))
    render(<JoinFlow open onClose={() => {}} />)
    paste('OSJ1.abc')
    expect(await screen.findByText('This code doesn’t match the data in that storage.')).toBeTruthy()
  })

  it('previews, defaults to a new library, and joins with the chosen mode', async () => {
    vi.mocked(api.parsePairingCode).mockResolvedValue(payload)
    vi.mocked(api.previewJoin).mockResolvedValue({ remoteSongs: 1240, remoteBytes: 3.2e9, localSongs: 12, matches: 3, suggested: 'newLibrary' })
    vi.mocked(api.joinSync).mockResolvedValue()
    render(<JoinFlow open onClose={() => {}} />)
    paste('  Here is my code: OSJ1.abc  ')
    expect(api.parsePairingCode).toHaveBeenCalledWith('Here is my code: OSJ1.abc')

    expect(await screen.findByText('“Band book”: 1,240 songs, 3.2 GB')).toBeTruthy()
    expect(screen.getByText('This device: 12 songs')).toBeTruthy()
    const newLib = screen.getByRole('radio', { name: /As a new library/ }) as HTMLInputElement
    const merge = screen.getByRole('radio', { name: /Merge with/ }) as HTMLInputElement
    expect(newLib.checked).toBe(true)
    expect(screen.getByText('3 of your songs are already in the synced library and will be combined; 9 will be added.')).toBeTruthy()

    fireEvent.click(merge)
    fireEvent.click(screen.getByRole('button', { name: 'Join and merge' }))
    expect(await screen.findByText('You’re in')).toBeTruthy()
    expect(api.joinSync).toHaveBeenCalledWith(payload, 'merge')
    expect(api.leaveSync).not.toHaveBeenCalled()
  })

  it('an empty device joins here without a choice', async () => {
    vi.mocked(api.parsePairingCode).mockResolvedValue(payload)
    vi.mocked(api.previewJoin).mockResolvedValue({ remoteSongs: 5, remoteBytes: 0, localSongs: 0, matches: 0, suggested: 'here' })
    vi.mocked(api.joinSync).mockResolvedValue()
    render(<JoinFlow open onClose={() => {}} />)
    paste('OSJ1.abc')
    expect(await screen.findByText('The synced library will be loaded here.')).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await screen.findByText('You’re in')
    expect(api.joinSync).toHaveBeenCalledWith(payload, 'here')
  })

  it('a failed join goes back to the preview with the reason', async () => {
    vi.mocked(api.parsePairingCode).mockResolvedValue(payload)
    vi.mocked(api.previewJoin).mockResolvedValue({ remoteSongs: 5, remoteBytes: 0, localSongs: 2, matches: 0, suggested: 'newLibrary' })
    vi.mocked(api.joinSync).mockRejectedValue(new api.LibSyncFailure('localQuota', 'localQuota', String(2e9)))
    render(<JoinFlow open onClose={() => {}} />)
    paste('OSJ1.abc')
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }))
    expect(await screen.findByText('This device is out of space (needs 2.0 GB more).')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy()
  })
})
