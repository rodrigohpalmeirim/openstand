/**
 * Pure face-gesture decision logic, independent of the camera/ML pipeline so it can be unit tested.
 * Input: per-frame measurements derived from MediaPipe face landmarks. Output: discrete gestures.
 */

export type Gesture = 'turnLeft' | 'turnRight' | 'mouthOpen'

export interface FaceSample {
  /** Head yaw estimate, about -1..1. Positive = the person turned to THEIR right. 0 = facing camera. */
  yaw: number
  /** Inner-lip gap divided by mouth width: ~0 closed, 0.3+ clearly open. */
  mouth: number
}

export interface GestureConfig {
  /** 0 (needs big movements) .. 1 (reacts to small movements). */
  sensitivity: number
  /** Minimum time between recognised gestures. */
  cooldownMs: number
  headTurn: boolean
  mouth: boolean
  /** A pose must be held this long before it counts (filters out tracking jitter). */
  holdMs?: number
}

interface Point {
  x: number
  y: number
}

// MediaPipe Face Mesh landmark indices (478-point topology).
const NOSE_TIP = 1
const FACE_RIGHT = 234 // subject's right cheek contour (left side of an unmirrored image)
const FACE_LEFT = 454
const LIP_UPPER = 13
const LIP_LOWER = 14
const MOUTH_RIGHT = 61
const MOUTH_LEFT = 291

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Turn raw landmarks (normalised image coordinates, unmirrored camera frame) into a sample. */
export function sampleFromLandmarks(lm: readonly Point[] | undefined): FaceSample | null {
  if (!lm || lm.length <= FACE_LEFT) return null
  const r = lm[FACE_RIGHT]
  const l = lm[FACE_LEFT]
  const width = l.x - r.x
  if (Math.abs(width) < 1e-4) return null
  // Where the nose sits between the two cheek contours: 0.5 when facing the camera. Turning to
  // your right moves the nose towards the image's left edge.
  const ratio = (lm[NOSE_TIP].x - r.x) / width
  const yaw = Math.max(-1, Math.min(1, (0.5 - ratio) * 2))
  const mw = dist(lm[MOUTH_RIGHT], lm[MOUTH_LEFT])
  const mouth = mw > 1e-4 ? dist(lm[LIP_UPPER], lm[LIP_LOWER]) / mw : 0
  return { yaw, mouth }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t))

/** Trigger thresholds for a sensitivity value. Higher sensitivity → smaller movement needed. */
export function thresholds(sensitivity: number) {
  return { yaw: lerp(0.6, 0.2, sensitivity), mouth: lerp(0.6, 0.2, sensitivity) }
}

/**
 * Stateful detector. A gesture fires once when a pose crosses its threshold (held for `holdMs`),
 * then that channel must return to a neutral pose before it can fire again. Gestures made during
 * the cooldown are ignored rather than queued. The neutral yaw adapts slowly so a camera placed
 * off to one side still works.
 */
export class GestureDetector {
  private baseline: number | null = null
  private yawArmed = true
  private mouthArmed = true
  private lastFire = Number.NEGATIVE_INFINITY
  private pending: { g: Gesture; since: number } | null = null

  config: GestureConfig

  constructor(config: GestureConfig) {
    this.config = config
  }

  reset() {
    this.baseline = null
    this.yawArmed = this.mouthArmed = true
    this.lastFire = Number.NEGATIVE_INFINITY
    this.pending = null
  }

  /** Current neutral yaw (for the settings test view). */
  get neutralYaw() {
    return this.baseline ?? 0
  }

  /** Feed one frame. `t` is a timestamp in ms. Returns the gesture recognised on this frame. */
  update(sample: FaceSample | null, t: number): Gesture | null {
    if (!sample) {
      this.pending = null
      return null
    }
    const cfg = this.config
    const th = thresholds(cfg.sensitivity)
    if (this.baseline === null) this.baseline = Math.max(-0.5, Math.min(0.5, sample.yaw))
    const rel = sample.yaw - this.baseline

    if (Math.abs(rel) < th.yaw * 0.5) {
      this.yawArmed = true
      if (Math.abs(rel) < th.yaw * 0.35) this.baseline += rel * 0.05
    }
    if (sample.mouth < th.mouth * 0.6) this.mouthArmed = true

    let candidate: Gesture | null = null
    if (cfg.headTurn && this.yawArmed && Math.abs(rel) > th.yaw) candidate = rel > 0 ? 'turnRight' : 'turnLeft'
    else if (cfg.mouth && this.mouthArmed && sample.mouth > th.mouth) candidate = 'mouthOpen'

    if (!candidate) {
      this.pending = null
      return null
    }
    if (t - this.lastFire < cfg.cooldownMs) {
      this.disarm(candidate)
      this.pending = null
      return null
    }
    if (!this.pending || this.pending.g !== candidate) this.pending = { g: candidate, since: t }
    if (t - this.pending.since < (cfg.holdMs ?? 120)) return null

    this.pending = null
    this.lastFire = t
    this.disarm(candidate)
    return candidate
  }

  private disarm(g: Gesture) {
    if (g === 'mouthOpen') this.mouthArmed = false
    else this.yawArmed = false
  }
}
