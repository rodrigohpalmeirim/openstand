// Labels that name a song follow the terminology setting. settings.ts plugs the reader in, since
// importing the settings store here would be a circular import (it validates action ids on load).
let songWord = () => 'song'
export function setActionSongWord(get: () => string) {
  songWord = get
}
const cap = (w: string) => w[0].toUpperCase() + w.slice(1)

/**
 * Every performable action. Touch zones, gestures, keyboard/pedal keys, MIDI messages and face
 * gestures all map to these ids; the viewer registers a handler for each.
 */
export const ACTIONS = {
  none: { label: 'Do nothing', group: 'General' },
  nextPage: { label: 'Next page', group: 'Navigation' },
  prevPage: { label: 'Previous page', group: 'Navigation' },
  nextOnePage: { label: 'Turn one page forward', group: 'Navigation' },
  prevOnePage: { label: 'Turn one page back', group: 'Navigation' },
  nextTwoPages: { label: 'Turn two pages forward', group: 'Navigation' },
  prevTwoPages: { label: 'Turn two pages back', group: 'Navigation' },
  nextPageLoop: { label: 'Next page or loop to start', group: 'Navigation' },
  prevPageLoop: { label: 'Previous page or loop to end', group: 'Navigation' },
  nextHalfPage: { label: 'Half page forward', group: 'Navigation' },
  prevHalfPage: { label: 'Half page back', group: 'Navigation' },
  firstPage: { label: 'First page', group: 'Navigation' },
  lastPage: { label: 'Last page', group: 'Navigation' },
  scrollDown: { label: 'Scroll down', group: 'Navigation' },
  scrollUp: { label: 'Scroll up', group: 'Navigation' },
  nextSong: { get label() { return `Next ${songWord()}` }, group: 'Navigation' },
  prevSong: { get label() { return `Previous ${songWord()}` }, group: 'Navigation' },
  followLink: { label: 'Follow link point', group: 'Navigation' },
  goBack: { label: 'Return from link', group: 'Navigation' },
  showBookmarks: { label: 'Bookmarks', group: 'Navigation' },
  showSetlist: { label: 'Setlist panel', group: 'Navigation' },
  goToPage: { label: 'Go to page…', group: 'Navigation' },
  closeSong: { label: 'Back to library', group: 'Navigation' },

  toggleToolbar: { label: 'Show/hide toolbar', group: 'View' },
  toggleFullscreen: { label: 'Fullscreen', group: 'View' },
  toggleNightMode: { label: 'Night mode', group: 'View' },
  cycleDisplayMode: { label: 'Cycle display mode', group: 'View' },
  zoomIn: { label: 'Zoom in', group: 'View' },
  zoomOut: { label: 'Zoom out', group: 'View' },
  resetZoom: { label: 'Reset zoom', group: 'View' },
  toggleAnnotations: { label: 'Show/hide annotations', group: 'View' },
  nextLayer: { label: 'Next annotation layer', group: 'View' },
  prevLayer: { label: 'Previous annotation layer', group: 'View' },

  toggleMetronome: { label: 'Start/stop metronome', group: 'Tools' },
  tapTempo: { label: 'Tap tempo', group: 'Tools' },
  toggleAutoScroll: { label: 'Start/stop auto-scroll', group: 'Tools' },
  autoScrollFaster: { label: 'Auto-scroll faster', group: 'Tools' },
  autoScrollSlower: { label: 'Auto-scroll slower', group: 'Tools' },
  toggleAudio: { label: 'Play/pause audio', group: 'Tools' },
  audioRewind: { label: 'Rewind audio 5s', group: 'Tools' },
  toggleAnnotate: { label: 'Annotate', group: 'Tools' },
  undoAnnotation: { label: 'Undo annotation', group: 'Tools' },
  redoAnnotation: { label: 'Redo annotation', group: 'Tools' },
  transposeUp: { label: 'Transpose up', group: 'Tools' },
  transposeDown: { label: 'Transpose down', group: 'Tools' },
  textBigger: { label: 'Larger text', group: 'Tools' },
  textSmaller: { label: 'Smaller text', group: 'Tools' },
  sendMidi: { get label() { return `Send ${songWord()} MIDI` }, group: 'Tools' },
  startAutoScroll: { label: 'Start auto-scroll', group: 'Tools' },
  stopAutoScroll: { label: 'Stop auto-scroll', group: 'Tools' },
  startMetronome: { label: 'Start metronome', group: 'Tools' },
  stopMetronome: { label: 'Stop metronome', group: 'Tools' },
  toggleNotes: { get label() { return `${cap(songWord())} notes` }, group: 'Tools' },
  toggleFaceGestures: { label: 'Face gestures on/off', group: 'Tools' },
  // Performance tools (src/tools)
  prevBookmark: { label: 'Previous bookmark', group: 'Navigation' },
  nextBookmark: { label: 'Next bookmark', group: 'Navigation' },
  activateLinkOrTurn: { label: 'Next link point or next page', group: 'Navigation' },
  resetLinks: { label: 'Reset link points', group: 'Navigation' },
  nextTempo: { label: 'Next metronome tempo', group: 'Tools' },
  toggleAudioPlayer: { label: 'Show/hide audio player', group: 'Tools' },
  audioForward: { label: 'Forward audio 5s', group: 'Tools' },
  audioVolumeUp: { label: 'Audio volume up', group: 'Tools' },
  audioVolumeDown: { label: 'Audio volume down', group: 'Tools' },
  prevAudioTrack: { label: 'Previous audio track', group: 'Tools' },
  nextAudioTrack: { label: 'Next audio track', group: 'Tools' },
  nextSmartButton: { label: 'Activate next smart button', group: 'Tools' },
  prevSmartButton: { label: 'Activate previous smart button', group: 'Tools' },
  showNotesPopup: { label: 'Show notes popup', group: 'Tools' },
} as const

export type ActionId = keyof typeof ACTIONS

export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[]

type Handler = (source?: string) => void

const handlers = new Map<ActionId, Handler>()
const listeners = new Set<(a: ActionId, source?: string) => void>()

/** Register handlers for the current screen. Returns an unregister function. */
export function registerActions(map: Partial<Record<ActionId, Handler>>): () => void {
  const entries = Object.entries(map) as [ActionId, Handler][]
  for (const [id, h] of entries) handlers.set(id, h)
  return () => {
    for (const [id, h] of entries) if (handlers.get(id) === h) handlers.delete(id)
  }
}

/** Run an action. `source` identifies the input ("key", "touch", "midi", "face", "remote"). */
export function runAction(id: ActionId, source?: string): boolean {
  if (id === 'none') return false
  const h = handlers.get(id)
  listeners.forEach((l) => l(id, source))
  if (!h) return false
  h(source)
  return true
}

/** Observe dispatched actions (used by sync to mirror page turns to other devices). */
export function onAction(l: (a: ActionId, source?: string) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
