import type { PanelProps } from '../viewer/panels'
import { MiniPlayer } from './audio/MiniPlayer'
import { AutoScroller } from './autoScroll/AutoScroller'
import { MetronomeOverlay } from './metronome/MetronomeOverlay'
import { CornerOverlays, NotesPopup, PickBanner } from './overlays'
import { useToolActions } from './useToolActions'

/**
 * Always-mounted performance helpers drawn over the stage: metronome beat display, auto-scroll engine
 * and progress, audio mini player, notes popup, placement banner, clock/capo badges, and the action
 * handlers for pedals/keys/MIDI. Long-lived engines (metronome, audio) are singletons driven by
 * src/tools/service.ts so they survive song changes.
 */
export function ViewerAddons(props: PanelProps) {
  useToolActions(props)
  const { song, stops, pos, paged, pages } = props
  const isText = pages.some((p) => p.type === 'text')
  return (
    <>
      <MetronomeOverlay />
      <AutoScroller song={song} stops={stops} pos={pos} paged={paged} />
      <CornerOverlays song={song} isText={isText} />
      <NotesPopup song={song} />
      <MiniPlayer song={song} />
      <PickBanner />
    </>
  )
}
