import type { AutoScrollSettings, Song } from '../../db/schema'
import { settings } from '../../state/settings'

/** Effective auto-scroll settings for a song: per-song values over the defaults. */
export function songAutoScroll(song: Song | undefined): AutoScrollSettings & { pauseOnTouch: boolean } {
  const d = settings().autoScroll
  return {
    mode: d.mode,
    delay: d.delay,
    speed: d.speed,
    pageDelay: d.pageDelay,
    startOnLoad: d.startOnLoad ?? false,
    pauseOnTouch: d.pauseOnTouch,
    ...(song?.autoScroll ?? {}),
  }
}
