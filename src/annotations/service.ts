/** Performance-mode layer actions (pedal/MIDI/touch can step through annotation layers). */
import { registerService } from '../services'
import { currentSongId, useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions } from '../viewer/actions'
import { cycleLayer } from './layers'

const step = (dir: 1 | -1) => {
  const songId = currentSongId()
  if (!songId) return
  void cycleLayer(songId, dir, useViewer.getState().annotating).then((msg) => toast(msg))
}

registerService(() => registerActions({ nextLayer: () => step(1), prevLayer: () => step(-1) }))
