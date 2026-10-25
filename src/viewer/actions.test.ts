import { afterEach, describe, expect, it } from 'vitest'
import { useSettings } from '../state/settings'
import { ACTIONS } from './actions'

describe('action labels', () => {
  afterEach(() => useSettings.getState().set({ terminology: 'song' }))

  it('follow the song/piece terminology setting', () => {
    expect(ACTIONS.nextSong.label).toBe('Next song')
    expect(ACTIONS.toggleNotes.label).toBe('Song notes')
    useSettings.getState().set({ terminology: 'piece' })
    expect(ACTIONS.nextSong.label).toBe('Next piece')
    expect(ACTIONS.prevSong.label).toBe('Previous piece')
    expect(ACTIONS.sendMidi.label).toBe('Send piece MIDI')
    expect(ACTIONS.toggleNotes.label).toBe('Piece notes')
    expect(ACTIONS.nextPage.label).toBe('Next page')
  })
})
