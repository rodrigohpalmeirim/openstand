import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  pairingCode: vi.fn(async () => 'OSJ1.code'),
}))
vi.mock('./qr', () => ({ drawQr: vi.fn() }))

const { PairingQr } = await import('./PairingQr')
const { drawQr } = await import('./qr')

afterEach(cleanup)

const qr = () => screen.queryByRole('img', { name: 'Pairing QR code' })

describe('PairingQr', () => {
  it('covers the code on blur and when the page is hidden, and needs a tap to show it again', async () => {
    render(<PairingQr />)
    fireEvent.click(screen.getByRole('button', { name: 'Show pairing code' }))
    expect(await screen.findByRole('img', { name: 'Pairing QR code' })).toBeTruthy()
    // Let React finish the commit that mounted the canvas (findBy can resolve mid-commit).
    await waitFor(() => expect(drawQr).toHaveBeenCalledWith(qr(), 'OSJ1.code'))

    const canvas = qr() as HTMLCanvasElement
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(canvas.style.visibility).toBe('hidden')
    expect(qr()).toBeNull()
    // Focus coming back alone doesn't reveal it.
    act(() => void window.dispatchEvent(new Event('focus')))
    expect(qr()).toBeNull()
    vi.mocked(drawQr).mockClear()
    fireEvent.click(screen.getByRole('button', { name: /Tap to show the code/ }))
    expect(qr()).toBeTruthy()
    expect(drawQr).toHaveBeenCalledWith(qr(), 'OSJ1.code')

    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    vis.mockRestore()
    expect(qr()).toBeNull()
    expect(screen.getByRole('button', { name: /Tap to show the code/ })).toBeTruthy()
  })
})
