import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLibSync, type BlobState } from '../api'
import { BlobPending, PendingThumb } from './BlobPending'
import { useMockBlobs } from './client'

const setBlob = (s: BlobState | undefined) => act(() => useMockBlobs.setState({ state: () => s }))

afterEach(() => {
  cleanup()
  useMockBlobs.setState({ state: undefined })
})

describe('BlobPending', () => {
  it('shows download progress, then calls onReady once when the file arrives', () => {
    setBlob({ state: 'downloading', progress: 0.45 })
    const onReady = vi.fn()
    render(<BlobPending blobId="b1" onReady={onReady} />)
    expect(screen.getByRole('status').textContent).toContain('Downloading this file… 45%')
    setBlob({ state: 'local' })
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('offline and waiting wording', () => {
    setBlob({ state: 'offline' })
    const { rerender } = render(<BlobPending blobId="b1" />)
    expect(screen.getByRole('status').textContent).toBe('Not downloaded yet. Connect to the internet to get it.')
    setBlob({ state: 'waiting' })
    rerender(<BlobPending blobId="b1" />)
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for the device that added this file/)
  })

  it('does not loop when sync knows nothing about the file', () => {
    setBlob({ state: 'local' })
    const onReady = vi.fn()
    render(<BlobPending blobId="b1" onReady={onReady} />)
    expect(onReady).not.toHaveBeenCalled()
    // Without library sync (a backup that lacked the file) there's nothing to wait for.
    expect(screen.getByRole('status').textContent).toBe('This file is missing. Re-add it in the song editor.')
    act(() => useLibSync.setState({ configured: true }))
    expect(screen.getByRole('status').textContent).toMatch(/isn’t on this device yet/)
    act(() => useLibSync.setState({ configured: false }))
  })
})

describe('PendingThumb', () => {
  it('labels the placeholder with the row caption', () => {
    render(<PendingThumb state={{ state: 'waiting' }} />)
    expect(screen.getByRole('img', { name: 'Waiting for upload' })).toBeTruthy()
    cleanup()
    render(<PendingThumb state={{ state: 'downloading', progress: 0.1 }} />)
    expect(screen.getByRole('img', { name: 'Downloading' })).toBeTruthy()
  })
})
