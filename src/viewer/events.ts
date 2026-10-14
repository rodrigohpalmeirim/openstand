import type { Song } from '../db/schema'

/**
 * Viewer lifecycle events so independent modules (MIDI, audio, sync) can react without the
 * viewer importing them.
 */
export interface ViewerEvents {
  songOpened: { song: Song; setlistId?: string }
  pageChanged: { songId: string; page: number; position: number }
  songClosed: { songId: string }
}

type Listener<K extends keyof ViewerEvents> = (e: ViewerEvents[K]) => void
const listeners = new Map<keyof ViewerEvents, Set<(e: never) => void>>()

export function on<K extends keyof ViewerEvents>(k: K, l: Listener<K>): () => void {
  let set = listeners.get(k)
  if (!set) listeners.set(k, (set = new Set()))
  set.add(l as (e: never) => void)
  return () => set.delete(l as (e: never) => void)
}

export function emit<K extends keyof ViewerEvents>(k: K, e: ViewerEvents[K]) {
  ;(listeners.get(k) as Set<Listener<K>> | undefined)?.forEach((l) => {
    try {
      l(e)
    } catch (err) {
      console.error(err)
    }
  })
}
