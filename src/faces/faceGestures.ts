/**
 * Hands-free control with the front camera (MediaPipe Face Landmarker, on-device).
 *
 * Nothing here is loaded until the feature is used: `@mediapipe/tasks-vision` is a dynamic import
 * (its own chunk), and the WebAssembly runtime (~13 MB) and the face model (~3.7 MB) are fetched
 * at runtime from the official CDNs below, then cached by the browser. Camera frames never leave
 * the device.
 */
import type { FaceLandmarker } from '@mediapipe/tasks-vision'
import { registerService } from '../services'
import { settings, useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions, runAction, type ActionId } from '../viewer/actions'
import { FACE_GESTURES, FaceReader, GestureDetector, type DetectorConfig, type FaceSample, type Gesture, type GestureLevel } from './gestures'

/** Must match the installed @mediapipe/tasks-vision version (JS glue and wasm are versioned together). */
const MEDIAPIPE_VERSION = '1.1.0'
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

let landmarker: Promise<FaceLandmarker> | null = null
/** Learned left/right conventions survive camera restarts (see `Polarity`). */
const reader = new FaceReader()

function loadLandmarker(): Promise<FaceLandmarker> {
  landmarker ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
    const create = (delegate: 'GPU' | 'CPU') =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })
    try {
      return await create('GPU')
    } catch {
      return await create('CPU')
    }
  })()
  landmarker.catch(() => (landmarker = null))
  return landmarker
}

export function gestureConfig(): DetectorConfig {
  const f = settings().faceGestures
  const gestures: DetectorConfig['gestures'] = {}
  for (const g of FACE_GESTURES) {
    const b = f.gestures[g]
    gestures[g] = { enabled: b.action !== 'none', sensitivity: b.sensitivity, holdMs: b.holdMs }
  }
  return { cooldownMs: f.cooldownMs, gestures }
}

export function gestureAction(g: Gesture): ActionId {
  return settings().faceGestures.gestures[g].action
}

/** True when at least one gesture has an action (otherwise there is no reason to use the camera). */
export function anyGestureAssigned(): boolean {
  const f = settings().faceGestures
  return FACE_GESTURES.some((g) => f.gestures[g].action !== 'none')
}

/** Human-readable reason why the camera/model could not start. */
export function faceErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Allow camera access for this site and try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No front camera was found.'
  if (name === 'NotReadableError') return 'The camera is in use by another app.'
  const msg = String((e as Error)?.message ?? e)
  return /fetch|network|load/i.test(msg) ? 'The face model could not be downloaded. Check your connection and try again.' : msg
}

export interface FaceFrame {
  sample: FaceSample | null
  gesture: Gesture | null
  /** Signal vs threshold for every gesture (empty when no face is found). */
  levels: Partial<Record<Gesture, GestureLevel>>
}

export interface FaceTracker {
  stream: MediaStream
  stop: () => void
}

/**
 * Open the camera and run the landmarker at a capped frame rate, reporting every processed frame.
 * Throws if the camera or model is unavailable.
 */
export async function startFaceTracker(onFrame: (f: FaceFrame) => void, fps = 12): Promise<FaceTracker> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access')
  // Camera first: without one there is no point downloading the model (~17 MB).
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
  })
  let lm: FaceLandmarker
  try {
    lm = await loadLandmarker()
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    throw e
  }
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play().catch(() => {})

  const detector = new GestureDetector(gestureConfig())
  let stopped = false
  let raf = 0
  let last = 0
  let lastVideoTime = -1
  const tick = (now: number) => {
    if (stopped) return
    raf = requestAnimationFrame(tick)
    if (now - last < 1000 / fps || video.readyState < 2 || video.currentTime === lastVideoTime) return
    last = now
    lastVideoTime = video.currentTime
    try {
      const res = lm.detectForVideo(video, now)
      const sample = reader.read(res)
      detector.config = gestureConfig()
      const gesture = detector.update(sample, now)
      onFrame({ sample, gesture, levels: detector.levels })
    } catch (e) {
      console.warn('face landmarker failed', e)
    }
  }
  raf = requestAnimationFrame(tick)
  return {
    stream,
    stop: () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    },
  }
}

/** Tiny status dot while the camera is on in performance mode (privacy + "is it seeing me?"). */
function statusDot() {
  const el = document.createElement('div')
  el.setAttribute('aria-hidden', 'true')
  el.title = 'Face gestures active'
  Object.assign(el.style, {
    position: 'fixed',
    left: '8px',
    bottom: '8px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#6f6c66',
    opacity: '0.7',
    zIndex: '80',
    pointerEvents: 'none',
    transition: 'background 120ms, transform 120ms',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(el)
  let flash = 0
  let flashing = false
  return {
    update(f: FaceFrame) {
      if (f.gesture) {
        flashing = true
        el.style.background = '#fb923c'
        el.style.transform = 'scale(2)'
        clearTimeout(flash)
        flash = window.setTimeout(() => {
          flashing = false
          el.style.transform = 'scale(1)'
        }, 250)
      } else if (!flashing) {
        el.style.background = f.sample ? '#30a46c' : '#6f6c66'
      }
    },
    remove: () => {
      clearTimeout(flash)
      el.remove()
    },
  }
}

/** Set by the settings test view so the background service doesn't fight it for the camera. */
let testing = false
const testListeners = new Set<() => void>()
export function setFaceTestActive(on: boolean) {
  testing = on
  testListeners.forEach((l) => l())
}

registerService(() => {
  let tracker: FaceTracker | null = null
  let dot: ReturnType<typeof statusDot> | null = null
  let gen = 0
  let running = false
  // After a failure don't retry until the song or the setting changes, to avoid permission loops.
  let failedKey = ''

  const stop = () => {
    gen++
    running = false
    tracker?.stop()
    tracker = null
    dot?.remove()
    dot = null
  }

  const sync = () => {
    const v = useViewer.getState()
    const want = settings().faceGestures.enabled && anyGestureAssigned() && v.queue.length > 0 && !testing
    const key = `${v.queue.join()}|${settings().faceGestures.enabled}`
    if (!want) {
      if (running) stop()
      if (!settings().faceGestures.enabled || !v.queue.length) failedKey = ''
      return
    }
    if (running || failedKey === key) return
    running = true
    const my = ++gen
    startFaceTracker((f) => {
      dot?.update(f)
      if (f.gesture) runAction(gestureAction(f.gesture), 'face')
    })
      .then((t) => {
        if (my !== gen) return t.stop()
        tracker = t
        dot = statusDot()
      })
      .catch((e: unknown) => {
        if (my !== gen) return
        running = false
        failedKey = key
        toast(`Face gestures unavailable. ${faceErrorMessage(e)}`, 'error')
      })
  }

  const unsubs = [
    useSettings.subscribe((s, prev) => s.s.faceGestures !== prev.s.faceGestures && sync()),
    useViewer.subscribe((v, prev) => (v.queue !== prev.queue ? sync() : undefined)),
    registerActions({
      toggleFaceGestures: () => {
        const on = !settings().faceGestures.enabled
        useSettings.getState().setIn('faceGestures', { enabled: on })
        toast(on ? (anyGestureAssigned() ? 'Face gestures on' : 'Face gestures on, but no gesture has an action yet') : 'Face gestures off')
      },
    }),
  ]
  testListeners.add(sync)
  sync()
  return () => {
    unsubs.forEach((u) => u())
    testListeners.delete(sync)
    stop()
  }
})
