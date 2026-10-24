import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendError, type BackendCheck } from '../backends/types'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  checkBackend: vi.fn(),
  enableSync: vi.fn(),
  pairingCode: vi.fn(),
}))

const api = await import('../api')
const { SetupWizard } = await import('./SetupWizard')

const cors: BackendCheck = { ok: false, steps: [{ id: 'reach', ok: true }, { id: 'cors', ok: false }], error: new BackendError('cors') }
const ok: BackendCheck = { ok: true, steps: ['list', 'write', 'read', 'range', 'etag', 'delete'].map((id) => ({ id, ok: true })) as BackendCheck['steps'] }

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

describe('SetupWizard', () => {
  beforeEach(() => vi.mocked(api.checkBackend).mockReset())
  afterEach(cleanup)

  it('validates the form before testing', async () => {
    render(<SetupWizard open onClose={() => {}} />)
    click('Next')
    click('Test connection')
    expect(await screen.findByText('Enter your Cloudflare account ID.')).toBeTruthy()
    expect(screen.getByText('Enter the bucket name.')).toBeTruthy()
    expect(api.checkBackend).not.toHaveBeenCalled()
  })

  it('switching provider changes the fields', () => {
    render(<SetupWizard open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: /B2/ }))
    click('Next')
    expect(screen.getByLabelText('Region')).toBeTruthy()
    expect(screen.queryByLabelText('Account ID')).toBeNull()
  })

  it('tests the connection, shows the CORS rule, then starts syncing', async () => {
    vi.mocked(api.checkBackend).mockResolvedValueOnce(cors).mockResolvedValueOnce(ok)
    vi.mocked(api.enableSync).mockResolvedValue()
    render(<SetupWizard open onClose={() => {}} />)
    click('Next')
    type('Account ID', '0123456789abcdef0123456789abcdef')
    type('Bucket', 'my-music')
    type('Access key ID', 'key')
    type('Secret access key', 'secret')
    click('Test connection')

    expect(await screen.findByText(/Add the CORS rule below/)).toBeTruthy()
    const rule = screen.getByLabelText('CORS rule').textContent ?? ''
    expect(JSON.parse(rule)[0].AllowedOrigins).toEqual([location.origin])
    expect(screen.getByText(/R2 → your bucket → Settings → CORS policy/)).toBeTruthy()
    expect(api.checkBackend).toHaveBeenCalledWith(expect.objectContaining({ kind: 's3', provider: 'r2', bucket: 'my-music', region: 'auto', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com' }))

    click('Test again')
    expect(await screen.findByText(/Everything works/)).toBeTruthy()
    click('Start syncing')
    expect(await screen.findByRole('button', { name: 'Show pairing code' })).toBeTruthy()
    expect(api.enableSync).toHaveBeenCalledWith({ backend: expect.objectContaining({ accessKeyId: 'key', secretAccessKey: 'secret', prefix: 'openstand/' }) })
  })

  it('shows a thrown start failure and lets the user retry', async () => {
    vi.mocked(api.checkBackend).mockResolvedValue(ok)
    vi.mocked(api.enableSync).mockRejectedValueOnce(new Error('meta already exists'))
    render(<SetupWizard open onClose={() => {}} />)
    click('Next')
    type('Account ID', '0123456789abcdef0123456789abcdef')
    type('Bucket', 'my-music')
    type('Access key ID', 'key')
    type('Secret access key', 'secret')
    click('Test connection')
    await screen.findByText(/Everything works/)
    click('Start syncing')
    expect(await screen.findByText('meta already exists')).toBeTruthy()
    vi.mocked(api.enableSync).mockResolvedValueOnce()
    click('Try again')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeTruthy())
  })
})
