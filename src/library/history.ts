import { closeTextEditor, useTextEditor } from '../textedit/store'
/**
 * Browser history integration, so the browser Back button / Android back gesture closes the top-most
 * thing (viewer panel, viewer, editor, dialog, drawer) and then walks back through library sections
 * instead of leaving the app.
 *
 * Every history entry we create carries a snapshot of the app: the route plus the open "layers". After
 * any state change we reconcile the current entry with the app (push when something opened or the
 * route moved on, go back when the app returned to the previous entry, otherwise replace). On popstate
 * we make the app match the entry we landed on by closing layers and restoring its route.
 */
import { useEffect, useRef } from 'react'
import { sameRoute, useNav, type Route } from '../state/nav'
import { useViewer } from '../state/viewer'
import { useLibraryUI } from './browse/ui'

interface Layer {
  id: string
  isOpen: () => boolean
  close: () => void
}

/* Bottom → top. Closing order on Back is top first. */
const LAYERS: Layer[] = [
  { id: 'drawer', isOpen: () => useLibraryUI.getState().drawer, close: () => useLibraryUI.getState().set({ drawer: false }) },
  { id: 'libraries', isOpen: () => useLibraryUI.getState().libraries, close: () => useLibraryUI.getState().set({ libraries: false }) },
  { id: 'prefs', isOpen: () => useLibraryUI.getState().prefs, close: () => useLibraryUI.getState().set({ prefs: false }) },
  { id: 'batch', isOpen: () => !!useLibraryUI.getState().batch, close: () => useLibraryUI.getState().set({ batch: null }) },
  { id: 'addTo', isOpen: () => !!useLibraryUI.getState().addTo, close: () => useLibraryUI.getState().set({ addTo: null }) },
  { id: 'import', isOpen: () => !!useLibraryUI.getState().importing, close: () => useLibraryUI.getState().set({ importing: null }) },
  { id: 'editor', isOpen: () => !!useLibraryUI.getState().editor, close: () => useLibraryUI.getState().set({ editor: null }) },
  { id: 'viewer', isOpen: () => useViewer.getState().queue.length > 0, close: () => useViewer.getState().close() },
  { id: 'textEditor', isOpen: () => !!useTextEditor.getState().target, close: closeTextEditor },
  {
    id: 'panel',
    isOpen: () => useViewer.getState().queue.length > 0 && !!useViewer.getState().panel,
    close: () => useViewer.getState().set({ panel: null }),
  },
]

/**
 * Components can take over what Back does for their layer (e.g. the song editor asks to save first, or
 * closes a sub-editor). The most recently mounted handler wins. If the layer stays open, its history
 * entry is simply pushed again.
 */
const overrides: { layer: string; fn: () => void }[] = []

export function useBackHandler(layer: string, handler: () => void, enabled = true) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    if (!enabled) return
    const entry = { layer, fn: () => ref.current() }
    overrides.push(entry)
    return () => void overrides.splice(overrides.indexOf(entry), 1)
  }, [layer, enabled])
}

const closeLayer = (l: Layer) => ([...overrides].reverse().find((o) => o.layer === l.id)?.fn ?? l.close)()

/** Entries written by this page load; older entries (before a reload) are skipped over on Back. */
const SESSION = Math.random().toString(36).slice(2)

interface Snap {
  sid: string
  os: number
  route: Route
  layers: string[]
}

type View = Omit<Snap, 'os' | 'sid'>

const sameSnap = (a: View, b: View) => sameRoute(a.route, b.route) && a.layers.join() === b.layers.join()

function current(): View {
  return { route: useNav.getState().route, layers: LAYERS.filter((l) => l.isOpen()).map((l) => l.id) }
}

function entryState(): Snap | null {
  const s = (history.state as { __os?: Snap } | null)?.__os
  return s && typeof s.os === 'number' && s.route ? s : null
}

let snaps: Snap[] = []
let idx = 0
/** Pops we caused ourselves (history.back() to drop an entry) that the popstate handler must ignore. */
let ownPops = 0
let scheduled = false

function write(view: View & { os: number }, push: boolean) {
  const snap: Snap = { ...view, sid: SESSION }
  const state = { ...(history.state ?? {}), __os: snap }
  if (push) history.pushState(state, '')
  else history.replaceState(state, '')
  snaps[snap.os] = snap
  if (push) snaps.length = snap.os + 1
}

function reconcile() {
  scheduled = false
  if (ownPops > 0) return // wait for our own back() to land; the pop handler reconciles again
  const want = current()
  const here = snaps[idx]
  if (!here) return write({ os: idx, ...want }, false)
  if (sameSnap(here, want)) return
  const opened = want.layers.some((l) => !here.layers.includes(l))
  const closed = here.layers.some((l) => !want.layers.includes(l))
  const moved = !sameRoute(here.route, want.route)
  // Back where an earlier entry was (something closed via the UI, an in-app "back" button, a section
  // visited before): return to that entry so Back never lands on what was just left.
  for (let k = idx - 1; k >= 0; k--) {
    if (!snaps[k] || !sameSnap(snaps[k], want)) continue
    ownPops++
    history.go(k - idx)
    idx = k
    return
  }
  if ((opened || moved) && !closed) write({ os: ++idx, ...want }, true)
  else write({ os: idx, ...want }, false)
}

function schedule() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(reconcile)
}

function onPop() {
  const snap = entryState()
  if (ownPops > 0) {
    ownPops--
    if (snap) idx = snap.os
    schedule()
    return
  }
  if (!snap || snap.sid !== SESSION) {
    // An entry from before this page load (e.g. before a reload): keep going back, out of the app.
    history.back()
    return
  }
  const back = snap.os <= idx
  idx = snap.os
  snaps[idx] = snap
  if (back) {
    // Close layers the target entry doesn't have, top-most first (a viewer panel before the viewer).
    for (const l of [...LAYERS].reverse()) if (l.isOpen() && !snap.layers.includes(l.id)) closeLayer(l)
  }
  const route = useNav.getState().route
  if (!sameRoute(route, snap.route)) useNav.getState().go(snap.route)
  schedule()
}

/** Mount once (App). */
export function useHistorySync() {
  useEffect(() => {
    snaps = []
    idx = 0
    ownPops = 0
    // Start a fresh stack on the current entry (a reload keeps the old entries; they're not ours anymore).
    write({ os: 0, ...current() }, false)
    window.addEventListener('popstate', onPop)
    const unsubs = [useNav.subscribe(schedule), useViewer.subscribe(schedule), useLibraryUI.subscribe(schedule), useTextEditor.subscribe(schedule)]
    return () => {
      window.removeEventListener('popstate', onPop)
      unsubs.forEach((u) => u())
    }
  }, [])
}
