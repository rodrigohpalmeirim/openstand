/** Performance-mode layer actions (pedal/MIDI/touch can step through annotation layers). */
import { registerService } from '../services'
import { currentSongId, useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions } from '../viewer/actions'
import { cycleLayer } from './layers'
import { usePen } from './pen'

const step = (dir: 1 | -1) => {
  const songId = currentSongId()
  if (!songId) return
  // Marking up (the annotation mode, or a pen in use while reading) steps the layer drawn on.
  void cycleLayer(songId, dir, useViewer.getState().annotating || usePen.getState().awake).then((msg) => toast(msg))
}

registerService(() => registerActions({ nextLayer: () => step(1), prevLayer: () => step(-1) }))
