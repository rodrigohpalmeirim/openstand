/**
 * ABC playback lives outside the Text panel so closing the panel doesn't stop the music; it stops on
 * request, at the end of the tune, or when the song changes / the viewer closes.
 */
import { create } from 'zustand'
import { on } from '../viewer/events'
import { playAbc, type AbcPlayer } from './engine'

interface AbcPlayback {
  state: 'idle' | 'loading' | 'playing'
  songId?: string
  tune: number
  title?: string
}

export const useAbcPlayback = create<AbcPlayback>(() => ({ state: 'idle', tune: 0 }))

let player: AbcPlayer | null = null
/** Bumped on every start/stop so a slow `playAbc` that resolves after a stop is discarded. */
let session = 0

export function stopAbc() {
  session++
  const p = player
  player = null
  p?.stop()
  useAbcPlayback.setState({ state: 'idle', songId: undefined, title: undefined })
}

export async function startAbc(source: string, opts: { songId: string; tune: number; transpose: number; title?: string }) {
  stopAbc()
  const my = session
  useAbcPlayback.setState({ state: 'loading', songId: opts.songId, tune: opts.tune, title: opts.title })
  try {
    const p = await playAbc(source, {
      tune: opts.tune,
      transpose: opts.transpose,
      onEnd: () => {
        if (my !== session) return
        player = null
        useAbcPlayback.setState({ state: 'idle', songId: undefined, title: undefined })
      },
    })
    if (my !== session) return p.stop()
    player = p
    useAbcPlayback.setState({ state: 'playing' })
  } catch (e) {
    if (my === session) useAbcPlayback.setState({ state: 'idle', songId: undefined, title: undefined })
    throw e
  }
}

on('songClosed', ({ songId }) => {
  if (useAbcPlayback.getState().songId === songId) stopAbc()
})
