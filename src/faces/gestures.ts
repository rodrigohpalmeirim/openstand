/**
 * Pure face-gesture decision logic, independent of the camera/ML pipeline so it can be unit tested.
 *
 * Pipeline: MediaPipe result → `FaceReader.read()` (blendshapes + head pose, resolved to the
 * user's own left/right) → `GestureDetector.update()` (thresholds, hold time, re-arming, cooldown)
 * → at most one gesture per frame.
 */

export const FACE_GESTURES = [
  'turnLeft',
  'turnRight',
  'tiltUp',
  'tiltDown',
  'winkLeft',
  'winkRight',
  'raiseBrows',
  'smile',
  'mouthOpen',
  'lipsLeft',
  'lipsRight',
] as const

export type Gesture = (typeof FACE_GESTURES)[number]

export interface GestureInfo {
  label: string
  /** How to perform it (shown in settings). */
  hint: string
  /** Default minimum hold time. */
  holdMs: number
  /** Action offered when the user adds this gesture. */
  suggested: 'nextPage' | 'prevPage'
}

export const GESTURE_INFO: Record<Gesture, GestureInfo> = {
  turnLeft: { label: 'Turn head left', hint: 'Turn to your left, then back to the centre.', holdMs: 120, suggested: 'prevPage' },
  turnRight: { label: 'Turn head right', hint: 'Turn to your right, then back to the centre.', holdMs: 120, suggested: 'nextPage' },
  tiltUp: { label: 'Tilt head up', hint: 'Lift your chin, then back to the centre.', holdMs: 150, suggested: 'prevPage' },
  tiltDown: { label: 'Tilt head down', hint: 'Nod down, then back to the centre.', holdMs: 150, suggested: 'nextPage' },
  winkLeft: { label: 'Wink left eye', hint: 'Close your left eye, keep the right one open.', holdMs: 250, suggested: 'prevPage' },
  winkRight: { label: 'Wink right eye', hint: 'Close your right eye, keep the left one open.', holdMs: 250, suggested: 'nextPage' },
  raiseBrows: { label: 'Raise eyebrows', hint: 'Raise both eyebrows, then relax.', holdMs: 250, suggested: 'nextPage' },
  smile: { label: 'Smile', hint: 'Smile, then back to a resting face.', holdMs: 350, suggested: 'nextPage' },
  mouthOpen: { label: 'Open mouth', hint: 'Open your mouth, then close it. Not for singers.', holdMs: 200, suggested: 'nextPage' },
  lipsLeft: { label: 'Move lips left', hint: 'Push your closed lips to your left.', holdMs: 250, suggested: 'prevPage' },
  lipsRight: { label: 'Move lips right', hint: 'Push your closed lips to your right.', holdMs: 250, suggested: 'nextPage' },
}

/**
 * One frame, in the user's own frame of reference ("left" = the user's left, whatever the camera
 * or model conventions). Expression values are MediaPipe blendshape scores (0..1).
 */
export interface FaceSample {
  /** Head yaw in degrees, positive = turned to the user's right. */
  yaw: number
  /** Head pitch in degrees, positive = chin up. */
  pitch: number
  /** Eye closure (eyeBlink) of the user's left / right eye. */
  eyeL: number
  eyeR: number
  smile: number
  brows: number
  /** jawOpen */
  jaw: number
  /** Lips pushed to the user's left / right (mouthLeft/mouthRight). */
  lipsL: number
  lipsR: number
}

export const NEUTRAL_SAMPLE: FaceSample = { yaw: 0, pitch: 0, eyeL: 0.05, eyeR: 0.05, smile: 0, brows: 0.05, jaw: 0, lipsL: 0, lipsR: 0 }

/* --------------------------------------------------------------- Detection */

export interface GestureTuning {
  enabled: boolean
  /** 0 (needs big movements) .. 1 (reacts to small movements). */
  sensitivity: number
  /** The gesture must be held this long before it counts. */
  holdMs: number
}

export interface DetectorConfig {
  /** Minimum time between recognised gestures; gestures made during it are ignored. */
  cooldownMs: number
  gestures: Partial<Record<Gesture, GestureTuning>>
}

/** Head turns beyond this (degrees) pause eye/lip/brow gestures: foreshortening and gaze shifts fake them. */
export const HEAD_GATE = 20
/** A wink needs the other eye at most this closed. */
export const OPEN_EYE_MAX = 0.4

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t))

interface Ctx {
  s: FaceSample
  /** Yaw / pitch relative to the user's neutral pose. */
  yaw: number
  pitch: number
}

interface Def {
  /** Gestures in a group disarm together (e.g. after a right turn, a left turn also waits for the centre). */
  group: string
  /** Threshold for a sensitivity (same units as `signal`). */
  th: (sens: number) => number
  signal: (c: Ctx) => number
  /** Why the gesture can't fire right now (another gesture or the head pose would fake it). */
  blocked?: (c: Ctx) => boolean
  /** Back at rest: the gesture can fire again. Default: signal below half the threshold. */
  rest?: (c: Ctx, th: number) => boolean
}

const headTurned = (c: Ctx) => Math.abs(c.yaw) > HEAD_GATE || Math.abs(c.pitch) > HEAD_GATE
const yawTh = (s: number) => lerp(35, 10, s)
const pitchTh = (s: number) => lerp(28, 8, s)
const yawCentred = (c: Ctx, th: number) => Math.abs(c.yaw) < th * 0.5
const pitchCentred = (c: Ctx, th: number) => Math.abs(c.pitch) < th * 0.5
const winkTh = (s: number) => lerp(0.7, 0.25, s)
const lipsTh = (s: number) => lerp(0.7, 0.15, s)
const lipsBlocked = (c: Ctx) => headTurned(c) || c.s.smile > 0.4 || c.s.jaw > 0.4

export const DEFS: Record<Gesture, Def> = {
  // A diagonal movement counts only along its dominant axis.
  turnLeft: { group: 'yaw', th: yawTh, signal: (c) => -c.yaw, blocked: (c) => Math.abs(c.pitch) > Math.abs(c.yaw), rest: yawCentred },
  turnRight: { group: 'yaw', th: yawTh, signal: (c) => c.yaw, blocked: (c) => Math.abs(c.pitch) > Math.abs(c.yaw), rest: yawCentred },
  tiltUp: { group: 'pitch', th: pitchTh, signal: (c) => c.pitch, blocked: (c) => Math.abs(c.yaw) > Math.abs(c.pitch), rest: pitchCentred },
  tiltDown: { group: 'pitch', th: pitchTh, signal: (c) => -c.pitch, blocked: (c) => Math.abs(c.yaw) > Math.abs(c.pitch), rest: pitchCentred },
  // Asymmetry between the eyes, so a blink (both closed) never counts.
  winkLeft: { group: 'eyes', th: winkTh, signal: (c) => c.s.eyeL - c.s.eyeR, blocked: (c) => headTurned(c) || c.s.eyeR > OPEN_EYE_MAX },
  winkRight: { group: 'eyes', th: winkTh, signal: (c) => c.s.eyeR - c.s.eyeL, blocked: (c) => headTurned(c) || c.s.eyeL > OPEN_EYE_MAX },
  raiseBrows: { group: 'brows', th: (s) => lerp(0.8, 0.3, s), signal: (c) => c.s.brows, blocked: headTurned },
  smile: { group: 'smile', th: (s) => lerp(0.85, 0.35, s), signal: (c) => c.s.smile },
  mouthOpen: { group: 'mouth', th: (s) => lerp(0.7, 0.15, s), signal: (c) => c.s.jaw },
  lipsLeft: { group: 'lips', th: lipsTh, signal: (c) => c.s.lipsL - c.s.lipsR, blocked: lipsBlocked },
  lipsRight: { group: 'lips', th: lipsTh, signal: (c) => c.s.lipsR - c.s.lipsL, blocked: lipsBlocked },
}

/** Trigger threshold of a gesture at a sensitivity (exposed for tests and the settings meters). */
export const threshold = (g: Gesture, sensitivity: number) => DEFS[g].th(sensitivity)

export interface GestureLevel {
  /** Signal relative to the threshold: 1 = at the threshold. */
  value: number
  /** Suppressed this frame (see `Def.blocked`). */
  blocked: boolean
  /** False until the user returns to rest after this gesture fired. */
  armed: boolean
}

/**
 * Stateful detector. A gesture fires once when its signal stays above its threshold for its hold
 * time; it (and its group) must then return to rest before it can fire again. Gestures made during
 * the cooldown are ignored rather than queued. The neutral head pose adapts slowly so a camera
 * placed off to one side still works.
 */
export class GestureDetector {
  private neutral: { yaw: number; pitch: number } | null = null
  private disarmed = new Set<Gesture>()
  private since = new Map<Gesture, number>()
  private lastFire = Number.NEGATIVE_INFINITY

  config: DetectorConfig
  /** Per-gesture levels of the last frame (every gesture, enabled or not, for the settings meters). */
  levels: Partial<Record<Gesture, GestureLevel>> = {}

  constructor(config: DetectorConfig) {
    this.config = config
  }

  reset() {
    this.neutral = null
    this.disarmed.clear()
    this.since.clear()
    this.lastFire = Number.NEGATIVE_INFINITY
    this.levels = {}
  }

  /** Current neutral head pose (degrees). */
  get neutralPose() {
    return this.neutral ?? { yaw: 0, pitch: 0 }
  }

  private tuning(g: Gesture): GestureTuning {
    return this.config.gestures[g] ?? { enabled: false, sensitivity: 0.5, holdMs: GESTURE_INFO[g].holdMs }
  }

  /** Feed one frame. `t` is a timestamp in ms. Returns the gesture recognised on this frame. */
  update(sample: FaceSample | null, t: number): Gesture | null {
    if (!sample) {
      this.since.clear()
      this.levels = {}
      return null
    }
    this.neutral ??= { yaw: clamp(sample.yaw, 25), pitch: clamp(sample.pitch, 20) }
    const n = this.neutral
    const c: Ctx = { s: sample, yaw: sample.yaw - n.yaw, pitch: sample.pitch - n.pitch }
    // Track slow drift of the resting pose, only while close to it.
    if (Math.abs(c.yaw) < 6 && Math.abs(c.pitch) < 6) {
      n.yaw += c.yaw * 0.04
      n.pitch += c.pitch * 0.04
    }

    const cooling = t - this.lastFire < this.config.cooldownMs
    const over: Gesture[] = []
    let best: { g: Gesture; ratio: number } | null = null
    const levels: Partial<Record<Gesture, GestureLevel>> = {}
    for (const g of FACE_GESTURES) {
      const def = DEFS[g]
      const tune = this.tuning(g)
      const th = def.th(tune.sensitivity)
      const sig = def.signal(c)
      if (this.disarmed.has(g) && (def.rest ? def.rest(c, th) : sig < th * 0.5)) this.disarmed.delete(g)
      const blocked = !!def.blocked?.(c)
      const armed = !this.disarmed.has(g)
      levels[g] = { value: Math.max(0, sig / th), blocked, armed }
      if (!tune.enabled || blocked || sig < th) {
        this.since.delete(g)
        continue
      }
      over.push(g)
      if (!armed) continue
      if (cooling) {
        // Ignored, not queued: the user has to relax and do it again.
        this.disarm(g)
        continue
      }
      if (!this.since.has(g)) this.since.set(g, t)
      if (t - this.since.get(g)! < tune.holdMs) continue
      const ratio = sig / th
      if (!best || ratio > best.ratio) best = { g, ratio }
    }
    this.levels = levels
    if (!best) return null
    this.lastFire = t
    // Anything happening at the same time is part of the same movement: don't fire it afterwards.
    over.forEach((g) => this.disarm(g))
    this.disarm(best.g)
    return best.g
  }

  private disarm(g: Gesture) {
    const group = DEFS[g].group
    for (const o of FACE_GESTURES) {
      if (DEFS[o].group === group) {
        this.disarmed.add(o)
        this.since.delete(o)
      }
    }
  }
}

const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v))

/* --------------------------------------------------- Reading model output */

interface Point {
  x: number
  y: number
}

/** The parts of a MediaPipe FaceLandmarkerResult we use (structurally typed for tests). */
export interface FaceResultLike {
  faceLandmarks?: readonly (readonly Point[])[]
  faceBlendshapes?: readonly { categories: readonly { categoryName: string; score: number }[] }[]
  facialTransformationMatrixes?: readonly { rows?: number; columns?: number; data: readonly number[] }[]
}

/**
 * Learns whether a model signal follows a convention (sign +1) or its mirror image (sign -1) by
 * correlating its movements with a geometric reference measured directly in the camera image.
 * MediaPipe's left/right naming for blendshapes and the axes of its transformation matrix depend
 * on whether frames are mirrored, so rather than trust a guess we check it against the landmarks.
 */
export class Polarity {
  private m = 0
  private g = 0
  private started = false
  private evidence: number
  private mScale: number
  private gScale: number

  /** `mScale` / `gScale`: size of a clear movement of the model signal / geometric reference. */
  constructor(prior: 1 | -1, mScale: number, gScale: number) {
    this.evidence = prior * 3
    this.mScale = mScale
    this.gScale = gScale
  }

  get sign(): 1 | -1 {
    return this.evidence >= 0 ? 1 : -1
  }

  observe(model: number, geo: number) {
    if (!Number.isFinite(model) || !Number.isFinite(geo)) return
    if (!this.started) {
      this.m = model
      this.g = geo
      this.started = true
      return
    }
    const dm = model - this.m
    const dg = geo - this.g
    this.m += dm * 0.05
    this.g += dg * 0.05
    const wm = Math.min(1, Math.abs(dm) / this.mScale)
    const wg = Math.min(1, Math.abs(dg) / this.gScale)
    // Only clear, simultaneous movements count as evidence; jitter doesn't.
    if (wm > 0.5 && wg > 0.5) this.evidence = Math.max(-20, Math.min(20, this.evidence + Math.sign(dm * dg) * wm * wg))
  }
}

// MediaPipe Face Mesh landmark indices (478-point topology). Sides are taken from image positions
// below, never from the index names, so a mislabelled side can't swap left and right.
const NOSE_TIP = 1
const CHEEK_A = 234
const CHEEK_B = 454
const MOUTH_A = 61
const MOUTH_B = 291
const EYE_A = { top: 159, bottom: 145, inner: 133, outer: 33 }
const EYE_B = { top: 386, bottom: 374, inner: 362, outer: 263 }

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Measurements taken straight from the (unmirrored) camera image. */
export interface Geometry {
  /** Head yaw: positive = turned to the user's right (nose moves to the image's left). */
  yaw: number
  /** Grows when the chin goes up (nose tip moves towards the eyes in the image). */
  pitch: number
  /** Openness of the eye on the image's left minus the one on the image's right. */
  eyeDiff: number
  /** Mouth centre offset towards the image's right (= the user's left), in face widths. */
  mouthShift: number
}

export function geometryFromLandmarks(lm: readonly Point[] | undefined): Geometry | null {
  if (!lm || lm.length <= CHEEK_B) return null
  const [cl, cr] = lm[CHEEK_A].x < lm[CHEEK_B].x ? [lm[CHEEK_A], lm[CHEEK_B]] : [lm[CHEEK_B], lm[CHEEK_A]]
  const width = cr.x - cl.x
  if (width < 1e-4) return null
  const nose = lm[NOSE_TIP]
  // Where the nose sits between the cheek contours: 0.5 when facing the camera.
  const yaw = Math.max(-1, Math.min(1, (0.5 - (nose.x - cl.x) / width) * 2))
  const eyesY = (lm[EYE_A.outer].y + lm[EYE_B.outer].y) / 2
  const mouthY = (lm[MOUTH_A].y + lm[MOUTH_B].y) / 2
  const span = mouthY - eyesY
  const pitch = Math.abs(span) > 1e-4 ? -(nose.y - eyesY) / span : 0
  const open = (e: typeof EYE_A) => {
    const w = dist(lm[e.inner], lm[e.outer])
    return w > 1e-4 ? dist(lm[e.top], lm[e.bottom]) / w : 0
  }
  const ax = (lm[EYE_A.inner].x + lm[EYE_A.outer].x) / 2
  const bx = (lm[EYE_B.inner].x + lm[EYE_B.outer].x) / 2
  const eyeDiff = ax < bx ? open(EYE_A) - open(EYE_B) : open(EYE_B) - open(EYE_A)
  const mouthShift = ((lm[MOUTH_A].x + lm[MOUTH_B].x) / 2 - nose.x) / width
  return { yaw, pitch, eyeDiff, mouthShift }
}

/** Head yaw/pitch (degrees) from a 4×4 facial transformation matrix, in the matrix's own axes. */
export function poseFromMatrix(data: readonly number[] | undefined): { yaw: number; pitch: number } | null {
  if (!data || data.length < 16) return null
  // The translation's z (face distance, tens of cm) is by far the largest entry: it tells us
  // whether the array is column-major (index 14) or row-major (index 11).
  const colMajor = Math.abs(data[14]) >= Math.abs(data[11])
  const at = (r: number, c: number) => (colMajor ? data[c * 4 + r] : data[r * 4 + c])
  // The face's forward axis (third column of the rotation) expressed in camera space.
  const fx = at(0, 2)
  const fy = at(1, 2)
  const fz = at(2, 2)
  const deg = 180 / Math.PI
  return { yaw: Math.atan2(fx, fz) * deg, pitch: Math.asin(Math.max(-1, Math.min(1, fy))) * deg }
}

/**
 * Turns MediaPipe results into `FaceSample`s in the user's frame of reference. Keeps the learned
 * polarities between frames, so use one reader per camera session (or longer).
 */
export class FaceReader {
  // Priors: blendshape names follow the subject's own left/right (ARKit convention); the matrix
  // uses camera axes (x right, y up, face looking along +z), where a turn to the user's right
  // points the face towards the image's left.
  readonly eyes = new Polarity(1, 0.3, 0.08)
  readonly lips = new Polarity(1, 0.2, 0.02)
  readonly yaw = new Polarity(-1, 6, 0.1)
  readonly pitch = new Polarity(1, 5, 0.04)

  read(res: FaceResultLike): FaceSample | null {
    const geo = geometryFromLandmarks(res.faceLandmarks?.[0])
    if (!geo) return null
    const bs: Record<string, number> = {}
    for (const c of res.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score
    const b = (k: string) => bs[k] ?? 0

    const pose = poseFromMatrix(res.facialTransformationMatrixes?.[0]?.data)
    let yaw: number
    let pitch: number
    if (pose) {
      this.yaw.observe(pose.yaw, geo.yaw)
      this.pitch.observe(pose.pitch, geo.pitch)
      yaw = pose.yaw * this.yaw.sign
      pitch = pose.pitch * this.pitch.sign
    } else {
      // Rough fallback; the detector works relative to the neutral pose anyway.
      yaw = Math.asin(geo.yaw) * (180 / Math.PI)
      pitch = geo.pitch * 60
    }

    // Eye and lip evidence is only trustworthy while roughly facing the camera.
    const facing = Math.abs(geo.yaw) < 0.25
    const eyeModel = b('eyeBlinkLeft') - b('eyeBlinkRight')
    // eyeBlinkLeft rising while the image-right eye (= user's left) closes means subject-relative names.
    if (facing) this.eyes.observe(eyeModel, geo.eyeDiff)
    const lipModel = b('mouthLeft') - b('mouthRight')
    if (facing) this.lips.observe(lipModel, geo.mouthShift)

    const [eyeL, eyeR] = this.eyes.sign > 0 ? [b('eyeBlinkLeft'), b('eyeBlinkRight')] : [b('eyeBlinkRight'), b('eyeBlinkLeft')]
    const [lipsL, lipsR] = this.lips.sign > 0 ? [b('mouthLeft'), b('mouthRight')] : [b('mouthRight'), b('mouthLeft')]
    return {
      yaw,
      pitch,
      eyeL,
      eyeR,
      smile: (b('mouthSmileLeft') + b('mouthSmileRight')) / 2,
      brows: (b('browInnerUp') + (b('browOuterUpLeft') + b('browOuterUpRight')) / 2) / 2,
      jaw: b('jawOpen'),
      lipsL,
      lipsR,
    }
  }
}
