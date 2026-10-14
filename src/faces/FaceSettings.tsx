import { Camera, CameraOff, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../state/settings'
import { Button, cx } from '../ui/primitives'
import { ACTIONS } from '../viewer/actions'
import { faceErrorMessage, setFaceTestActive, startFaceTracker, gestureAction, type FaceFrame, type FaceTracker } from './faceGestures'
import { thresholds, type Gesture } from './gestures'

const GESTURE_LABEL: Record<Gesture, string> = { turnLeft: 'Head turned left', turnRight: 'Head turned right', mouthOpen: 'Mouth opened' }

/** Horizontal meter with a centre line and trigger markers. */
function Meter({ label, value, threshold, centred }: { label: string; value: number; threshold: number; centred?: boolean }) {
  // centred: value in -1..1 drawn from the middle; otherwise 0..1 from the left.
  const pos = centred ? 50 + Math.max(-1, Math.min(1, value)) * 50 : Math.max(0, Math.min(1, value)) * 100
  const hit = Math.abs(value) > threshold
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="font-mono tabular-nums">{value.toFixed(2)}</span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full bg-surface-3">
        {centred && <div className="absolute inset-y-0 left-1/2 w-px bg-line" />}
        {(centred ? [50 - threshold * 50, 50 + threshold * 50] : [threshold * 100]).map((m) => (
          <div key={m} className="absolute inset-y-0 w-0.5 bg-fg/40" style={{ left: `${m}%` }} />
        ))}
        <div
          className={cx('absolute inset-y-0 rounded-full transition-[left,width] duration-75', hit ? 'bg-accent' : 'bg-muted')}
          style={centred ? { left: `${Math.min(50, pos)}%`, width: `${Math.abs(pos - 50)}%` } : { left: 0, width: `${pos}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Camera test: live (mirrored) preview, the measured head turn and mouth opening against the
 * current thresholds, and the last recognised gesture. Doesn't trigger actions.
 */
export function FaceGestureTest() {
  const f = useSettings((st) => st.s.faceGestures)
  const [state, setState] = useState<'off' | 'loading' | 'on' | 'error'>('off')
  const [error, setError] = useState('')
  const [frame, setFrame] = useState<FaceFrame | null>(null)
  const [last, setLast] = useState<{ g: Gesture; at: number } | null>(null)
  const tracker = useRef<FaceTracker | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const gen = useRef(0)

  const stop = () => {
    gen.current++
    tracker.current?.stop()
    tracker.current = null
    setFaceTestActive(false)
    setState('off')
    setFrame(null)
  }
  useEffect(() => () => stop(), [])

  const start = async () => {
    const my = ++gen.current
    setState('loading')
    setError('')
    setFaceTestActive(true)
    try {
      const t = await startFaceTracker((fr) => {
        setFrame(fr)
        if (fr.gesture) setLast({ g: fr.gesture, at: performance.now() })
      })
      if (my !== gen.current) return t.stop()
      tracker.current = t
      if (video.current) {
        video.current.srcObject = t.stream
        void video.current.play().catch(() => {})
      }
      setState('on')
    } catch (e) {
      if (my !== gen.current) return
      setFaceTestActive(false)
      setState('error')
      setError(faceErrorMessage(e))
    }
  }

  const th = thresholds(f.sensitivity)
  const yaw = frame?.sample ? frame.sample.yaw - frame.neutralYaw : 0
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Test gestures</div>
          <div className="text-xs text-muted">See what the camera recognises. Nothing is triggered while testing.</div>
        </div>
        {state === 'on' || state === 'loading' ? (
          <Button onClick={stop} icon={<CameraOff className="size-4" />}>
            Stop camera
          </Button>
        ) : (
          <Button variant="primary" onClick={start} icon={<Camera className="size-4" />}>
            Start camera
          </Button>
        )}
      </div>
      {state === 'error' && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className={cx('grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]', state === 'off' || state === 'error' ? 'hidden' : '')}>
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-black">
          <video ref={video} muted playsInline className="size-full -scale-x-100 object-cover" />
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
        </div>
        <div className="flex flex-col justify-center gap-3">
          <Meter label="Head turn (left … right)" value={yaw} threshold={th.yaw} centred />
          <Meter label="Mouth opening" value={frame?.sample?.mouth ?? 0} threshold={th.mouth} />
          <div
            key={last?.at}
            className={cx('rounded-lg px-3 py-2 text-sm', last ? 'animate-pop-in bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}
            aria-live="polite"
          >
            {last ? (
              <>
                <b>{GESTURE_LABEL[last.g]}</b> → {ACTIONS[gestureAction(last.g)].label}
              </>
            ) : (
              'Turn your head to one side and back, or open your mouth.'
            )}
          </div>
        </div>
      </div>
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
