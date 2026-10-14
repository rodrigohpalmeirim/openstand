import { Camera, CameraOff, Loader2, Plus, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ActionSelect } from '../settings/kit'
import { useSettings, type FaceGestureBinding } from '../state/settings'
import { Button, cx, IconButton, Menu, Slider, useMenu } from '../ui/primitives'
import { ACTIONS } from '../viewer/actions'
import { faceErrorMessage, gestureAction, setFaceTestActive, startFaceTracker, type FaceFrame, type FaceTracker } from './faceGestures'
import { FACE_GESTURES, GESTURE_INFO, type Gesture, type GestureLevel } from './gestures'

/* -------------------------------------------------- Live test (shared state) */

interface Live {
  state: 'off' | 'loading' | 'on' | 'error'
  error: string
  frame: FaceFrame | null
  stream: MediaStream | null
  last: { g: Gesture; at: number } | null
}

let live: Live = { state: 'off', error: '', frame: null, stream: null, last: null }
const liveSubs = new Set<() => void>()
const setLive = (p: Partial<Live>) => {
  live = { ...live, ...p }
  liveSubs.forEach((l) => l())
}
const subscribeLive = (l: () => void) => {
  liveSubs.add(l)
  return () => liveSubs.delete(l)
}
const useLive = () => useSyncExternalStore(subscribeLive, () => live)

let tracker: FaceTracker | null = null
let gen = 0

function stopTest() {
  gen++
  tracker?.stop()
  tracker = null
  setFaceTestActive(false)
  setLive({ state: 'off', frame: null, stream: null, last: null })
}

async function startTest() {
  const my = ++gen
  setLive({ state: 'loading', error: '', last: null })
  setFaceTestActive(true)
  try {
    const t = await startFaceTracker((fr) => setLive(fr.gesture ? { frame: fr, last: { g: fr.gesture, at: performance.now() } } : { frame: fr }))
    if (my !== gen) return t.stop()
    tracker = t
    setLive({ state: 'on', stream: t.stream })
  } catch (e) {
    if (my !== gen) return
    setFaceTestActive(false)
    setLive({ state: 'error', error: faceErrorMessage(e) })
  }
}

/** A gesture that fired this recently is highlighted. */
const FLASH_MS = 900
const recent = (last: Live['last'], g?: Gesture) => !!last && (!g || last.g === g) && performance.now() - last.at < FLASH_MS

/**
 * Camera test: live (mirrored) preview and the last recognised gesture. While it runs, each
 * gesture row below shows its signal against its threshold. Doesn't trigger actions.
 */
export function FaceGestureTest() {
  const { state, error, frame, stream, last } = useLive()
  const [noCamera, setNoCamera] = useState(false)
  const noApi = !navigator.mediaDevices?.getUserMedia

  useEffect(() => () => stopTest(), [])
  useEffect(() => {
    // Before permission is granted this still lists devices (without names), so we can say early
    // that there is no camera instead of downloading the model for nothing.
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((d) => setNoCamera(!d.some((x) => x.kind === 'videoinput')))
      .catch(() => {})
  }, [])
  const attach = (el: HTMLVideoElement | null) => {
    if (!el || el.srcObject === stream) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => {})
  }
  const camHint = noApi
    ? window.isSecureContext
      ? 'This browser has no camera access.'
      : 'Camera access needs a secure (https) connection.'
    : noCamera
      ? 'No camera was found on this device.'
      : ''

  const running = state === 'on' || state === 'loading'
  const fired = recent(last) ? last : null
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-48 flex-1">
          <div className="text-sm font-medium">Test and tune</div>
          <div className="mt-0.5 text-xs leading-snug text-muted">
            Each gesture’s bar fills as you move and flashes when it fires. Nothing is triggered while testing.
          </div>
        </div>
        {running ? (
          <Button onClick={stopTest} icon={<CameraOff className="size-4" />}>
            Stop camera
          </Button>
        ) : (
          <Button variant="primary" onClick={startTest} disabled={noApi} icon={<Camera className="size-4" />}>
            Start camera
          </Button>
        )}
      </div>
      {state === 'error' ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : (
        camHint && !running && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">{camHint}</p>
      )}
      {running && (
        <div className="relative mx-auto aspect-[4/3] w-full max-w-72 overflow-hidden rounded-lg bg-black">
          <video ref={attach} muted playsInline className="size-full -scale-x-100 object-cover" />
          {state === 'loading' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/80">
              <Loader2 className="size-6 animate-spin" />
              Loading face model…
            </div>
          )}
          {state === 'on' && (
            <span
              className={cx(
                'absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                frame?.sample ? 'bg-ok text-white' : 'bg-black/60 text-white/80',
              )}
            >
              {frame?.sample ? 'Face found' : 'No face'}
            </span>
          )}
          <div aria-live="polite" className="absolute inset-x-2 bottom-2 flex justify-center">
            {fired && (
              <span key={fired.at} className="animate-pop-in rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg shadow">
                {GESTURE_INFO[fired.g].label} → {ACTIONS[gestureAction(fired.g)].label}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- Gesture list */

/** Signal vs threshold: the marker sits at the threshold, the bar fills up to twice the threshold. */
function Meter({ level, flash, label }: { level: GestureLevel | undefined; flash: boolean; label: string }) {
  const v = level?.value ?? 0
  const pct = Math.min(1, v / 2) * 100
  const status = !level ? 'No face' : level.blocked ? 'Paused' : !level.armed ? 'Relax' : flash ? 'Fired' : null
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label={`${label} signal`}
        aria-valuemin={0}
        aria-valuemax={200}
        aria-valuenow={Math.round(Math.min(2, v) * 100)}
        aria-valuetext={`${Math.round(v * 100)}% of threshold`}
        className={cx('relative h-2.5 flex-1 overflow-hidden rounded-full bg-surface-3 transition', flash && 'ring-2 ring-accent ring-offset-1 ring-offset-surface')}
      >
        <div
          className={cx(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-75',
            flash || v >= 1 ? 'bg-accent' : 'bg-muted',
            (level?.blocked || level?.armed === false) && 'opacity-40',
          )}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-fg/50" />
      </div>
      <span className={cx('w-12 shrink-0 text-right text-[11px] font-medium', flash ? 'text-accent' : 'text-muted')}>{status ?? `${Math.round(v * 100)}%`}</span>
    </div>
  )
}

const holdLabel = (ms: number) => `${(ms / 1000).toFixed(2)} s`

function GestureRow({ g, b, onChange, onRemove }: { g: Gesture; b: FaceGestureBinding; onChange: (p: Partial<FaceGestureBinding>) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const { state, frame, last } = useLive()
  const info = GESTURE_INFO[g]
  const flash = recent(last, g)
  return (
    <li className={cx('flex flex-col gap-2.5 px-4 py-3 transition-colors', flash && 'bg-accent-soft')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-40 flex-[1_1_12rem]">
          <div className="text-sm font-medium">{info.label}</div>
          <div className="mt-0.5 text-xs leading-snug text-muted">{info.hint}</div>
        </div>
        <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-1 sm:flex-none">
          <ActionSelect value={b.action} onChange={(action) => onChange({ action })} label={`${info.label} action`} className="min-w-0 flex-1 sm:min-w-44" />
          <IconButton label={`Adjust ${info.label.toLowerCase()}`} active={open} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <SlidersHorizontal className="size-4.5" />
          </IconButton>
          <IconButton label={`Remove ${info.label.toLowerCase()}`} onClick={onRemove}>
            <X className="size-4.5" />
          </IconButton>
        </div>
      </div>
      {state === 'on' && <Meter level={frame?.levels[g]} flash={flash} label={info.label} />}
      {open && (
        <div className="grid gap-x-6 gap-y-3 rounded-lg bg-surface-2 px-3 py-2.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-xs text-muted">
              <span>Sensitivity</span>
              <span className="font-mono tabular-nums">{Math.round(b.sensitivity * 100)}%</span>
            </span>
            <Slider value={b.sensitivity} min={0} max={1} step={0.05} onChange={(sensitivity) => onChange({ sensitivity })} label={`${info.label} sensitivity`} />
            <span className="text-[11px] text-faint">Higher reacts to smaller movements.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-xs text-muted">
              <span>Hold for</span>
              <span className="font-mono tabular-nums">{holdLabel(b.holdMs)}</span>
            </span>
            <Slider value={b.holdMs} min={0} max={900} step={50} onChange={(holdMs) => onChange({ holdMs })} label={`${info.label} hold time`} />
            <span className="text-[11px] text-faint">Longer ignores brief, accidental movements.</span>
          </label>
        </div>
      )}
    </li>
  )
}

/** Gestures with an action, plus "Add gesture" for the others. */
export function FaceGestureList() {
  const gestures = useSettings((st) => st.s.faceGestures.gestures)
  const setIn = useSettings((st) => st.setIn)
  const { ref: menuRef, anchor, open, toggle, close } = useMenu()
  const update = (g: Gesture, p: Partial<FaceGestureBinding>) => {
    const cur = useSettings.getState().s.faceGestures.gestures
    setIn('faceGestures', { gestures: { ...cur, [g]: { ...cur[g], ...p } } })
  }
  const used = FACE_GESTURES.filter((g) => gestures[g].action !== 'none')
  const free = FACE_GESTURES.filter((g) => gestures[g].action === 'none')
  return (
    <div className="flex flex-col">
      {used.length ? (
        <ul className="divide-y divide-line">
          {used.map((g) => (
            <GestureRow key={g} g={g} b={gestures[g]} onChange={(p) => update(g, p)} onRemove={() => update(g, { action: 'none' })} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3.5 text-sm text-muted">No gestures yet. Add one and choose what it does.</p>
      )}
      {free.length > 0 && (
        <div className={cx('px-4 py-3', used.length > 0 && 'border-t border-line')}>
          <Button ref={menuRef} onClick={toggle} icon={<Plus className="size-4" />} aria-haspopup="menu" aria-expanded={open}>
            Add gesture
          </Button>
          <Menu
            anchor={anchor}
            open={open}
            onClose={close}
            align="start"
            items={free.map((g) => ({ label: GESTURE_INFO[g].label, onSelect: () => update(g, { action: GESTURE_INFO[g].suggested }) }))}
          />
        </div>
      )}
    </div>
  )
}

export function FacePrivacyNote() {
  return (
    <div className="px-4 py-3 text-xs leading-relaxed text-muted">
      The camera is used only while a song is open, and video is processed on this device. It is never recorded or uploaded. The first time,
      the face model (about 4 MB) and its runtime (about 13 MB) are downloaded from Google’s and jsDelivr’s servers and then cached. A small dot
      in the bottom-left corner shows when the camera is on: grey means no face found, green means tracking.
    </div>
  )
}
