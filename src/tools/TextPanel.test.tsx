import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptySong } from '../db/schema'
import { useViewer } from '../state/viewer'
import { TextPanel } from './TextPanel'

const updateSong = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../db/db', async (orig) => ({ ...(await orig<typeof import('../db/db')>()), updateSong }))

afterEach(() => {
  cleanup()
  useViewer.setState({ textZoom: 1 })
})

describe('TextPanel text size', () => {
  it('previews while dragging and writes the song once, on release', () => {
    const song = emptySong({ id: 's1', title: 'x' })
    const props = { pages: [], currentPage: 0 } as unknown as Omit<Parameters<typeof TextPanel>[0], 'song'>
    const { rerender } = render(<TextPanel song={song} {...props} />)
    const slider = screen.getByRole('slider', { name: 'Text size' })
    for (const v of ['1.1', '1.25', '1.5']) fireEvent.input(slider, { target: { value: v } })
    expect(useViewer.getState().textZoom).toBe(1.5)
    expect(updateSong).not.toHaveBeenCalled()

    fireEvent.change(slider, { target: { value: '1.5' } })
    expect(updateSong).toHaveBeenCalledTimes(1)
    expect(updateSong).toHaveBeenCalledWith('s1', { text: { fontScale: 1.5 } })
    // The preview zoom stays until the saved size arrives, then folds into it.
    expect(useViewer.getState().textZoom).toBe(1.5)
    act(() => rerender(<TextPanel song={{ ...song, text: { fontScale: 1.5 } }} {...props} />))
    expect(useViewer.getState().textZoom).toBe(1)
  })
})
