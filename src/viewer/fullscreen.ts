/**
 * Fullscreen API helpers with the WebKit prefix (iPad Safari before 16.4 only has webkit*), plus the
 * "fullscreen while performing" behaviour: enter when a piece opens, leave on close only if we entered.
 */

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const doc = () => document as WebkitDocument

export const fullscreenElement = (): Element | null => document.fullscreenElement ?? doc().webkitFullscreenElement ?? null
export const isFullscreen = () => !!fullscreenElement()

/** Must be called synchronously from a user gesture; otherwise the browser rejects it. */
export function requestFullscreen(el: HTMLElement = document.documentElement): Promise<void> {
  try {
    const req = el.requestFullscreen ?? (el as WebkitElement).webkitRequestFullscreen
    if (!req) return Promise.reject(new Error('Fullscreen not supported'))
    // Old WebKit returns undefined instead of a promise.
    return Promise.resolve(req.call(el))
  } catch (e) {
    return Promise.reject(e)
  }
}

export function exitFullscreen(): Promise<void> {
  try {
    const exit = document.exitFullscreen ?? doc().webkitExitFullscreen
    if (!exit || !isFullscreen()) return Promise.resolve()
    return Promise.resolve(exit.call(document))
  } catch (e) {
    return Promise.reject(e)
  }
}

export function onFullscreenChange(cb: () => void): () => void {
  document.addEventListener('fullscreenchange', cb)
  document.addEventListener('webkitfullscreenchange', cb)
  return () => {
    document.removeEventListener('fullscreenchange', cb)
    document.removeEventListener('webkitfullscreenchange', cb)
  }
}

/* --------------------------------------------------------- Auto fullscreen while performing */

/** Whether the current fullscreen session was started by `enterPerformanceFullscreen`. */
let entered = false
/** Between enter and leave; a request that resolves after the viewer closed is undone. */
let performing = false
let listening = false

/** Launched as a fullscreen PWA, or the browser window itself is fullscreen (F11): bars are already hidden. */
const alreadyImmersive = () => typeof matchMedia === 'function' && matchMedia('(display-mode: fullscreen)').matches

/** Enter fullscreen for a performance unless the page is already fullscreen. Call from the gesture's handler. */
export function enterPerformanceFullscreen() {
  performing = true
  if (isFullscreen() || alreadyImmersive()) return
  if (!listening) {
    listening = true
    // The user left fullscreen themselves (Esc, back gesture, the toggle): it's no longer ours to exit.
    onFullscreenChange(() => {
      if (!isFullscreen()) entered = false
    })
  }
  requestFullscreen()
    .then(() => {
      if (!performing) exitFullscreen().catch(() => {})
      else if (isFullscreen()) entered = true
    })
    // No user activation (MIDI, sync), unsupported, or denied.
    .catch(() => {})
}

/** Leave fullscreen if `enterPerformanceFullscreen` entered it and the user hasn't left it since. */
export function leavePerformanceFullscreen() {
  performing = false
  if (!entered) return
  entered = false
  exitFullscreen().catch(() => {})
}
