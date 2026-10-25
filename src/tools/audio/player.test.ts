import { describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import { emptySong } from '../../db/schema'
import { player, useAudio } from './player'

describe('player track settings', () => {
  it('saves every change made within the debounce window, not just the last one', async () => {
    await db.songs.put(emptySong({ id: 'au1', title: 'A', audio: [{ id: 't1', name: 'Track' }] }))
    useAudio.setState({ songId: 'au1', trackId: 't1' })
    player.setVolume(0.5)
    player.setSpeed(1.2)
    await player.flush()
    expect((await db.songs.get('au1'))?.audio[0]).toMatchObject({ volume: 0.5, speed: 1.2 })
  })
})
