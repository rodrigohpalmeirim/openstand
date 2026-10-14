import { describe, expect, it } from 'vitest'
import {
  FACE_GESTURES,
  FaceReader,
  GestureDetector,
  NEUTRAL_SAMPLE,
  Polarity,
  geometryFromLandmarks,
  poseFromMatrix,
  threshold,
  type DetectorConfig,
  type FaceSample,
  type Gesture,
  type GestureTuning,
} from './gestures'

const cfg = (enabled: Gesture[], over: Partial<GestureTuning> = {}, cooldownMs = 1000): DetectorConfig => ({
  cooldownMs,
  gestures: Object.fromEntries(enabled.map((g) => [g, { enabled: true, sensitivity: 0.5, holdMs: 100, ...over }])),
})
const ALL = [...FACE_GESTURES]

/** Feed samples at 30 fps; returns [time, gesture] for every recognised gesture. */
function run(det: GestureDetector, frames: (FaceSample | null)[], start = 0) {
  const out: [number, Gesture][] = []
  frames.forEach((f, i) => {
    const t = start + i * 33
    const g = det.update(f, t)
    if (g) out.push([t, g])
  })
  return out
}
const names = (ev: [number, Gesture][]) => ev.map((e) => e[1])

const hold = (s: FaceSample | null, ms: number) => Array.from({ length: Math.ceil(ms / 33) }, () => s)
const face = (over: Partial<FaceSample>): FaceSample => ({ ...NEUTRAL_SAMPLE, ...over })
const neutral = NEUTRAL_SAMPLE
const right = face({ yaw: 30 })
const left = face({ yaw: -30 })
const up = face({ pitch: 25 })
const down = face({ pitch: -25 })
const winkL = face({ eyeL: 0.9, eyeR: 0.1 })
const winkR = face({ eyeL: 0.08, eyeR: 0.85 })
const blink = face({ eyeL: 0.9, eyeR: 0.88 })
const open = face({ jaw: 0.7 })
const smile = face({ smile: 0.9 })
const brows = face({ brows: 0.85 })
const lipsL = face({ lipsL: 0.7 })
const lipsR = face({ lipsR: 0.7 })
const settle = hold(neutral, 300)

describe('GestureDetector', () => {
  it('recognises every gesture from its own movement only', () => {
    const cases: [FaceSample, Gesture][] = [
      [left, 'turnLeft'],
      [right, 'turnRight'],
      [up, 'tiltUp'],
      [down, 'tiltDown'],
      [winkL, 'winkLeft'],
      [winkR, 'winkRight'],
      [brows, 'raiseBrows'],
      [smile, 'smile'],
      [open, 'mouthOpen'],
      [lipsL, 'lipsLeft'],
      [lipsR, 'lipsRight'],
    ]
    for (const [pose, g] of cases) {
      const det = new GestureDetector(cfg(ALL))
      expect(names(run(det, [...settle, ...hold(pose, 600), ...settle])), g).toEqual([g])
    }
  })

  it('a normal blink is not a wink', () => {
    const det = new GestureDetector(cfg(['winkLeft', 'winkRight']))
    // Slightly asymmetric eye closing, as in real blinks, held well past the hold time.
    const frames = [...settle, face({ eyeL: 0.5, eyeR: 0.2 }), ...hold(blink, 600), face({ eyeL: 0.3, eyeR: 0.6 }), ...settle]
    expect(run(det, frames)).toEqual([])
  })

  it('a wink needs the other eye clearly open', () => {
    const det = new GestureDetector(cfg(['winkLeft'], { sensitivity: 1 }))
    expect(run(det, [...settle, ...hold(face({ eyeL: 0.95, eyeR: 0.5 }), 600)])).toEqual([])
  })

  it('requires the gesture to be held for its hold time', () => {
    const det = new GestureDetector(cfg(['winkRight'], { holdMs: 300 }))
    // A 200 ms wink is too short…
    expect(run(det, [...settle, ...hold(winkR, 200), ...settle])).toEqual([])
    // …a 400 ms one counts, once the hold time has passed.
    const ev = run(det, [...settle, ...hold(winkR, 400), ...settle], 10_000)
    expect(names(ev)).toEqual(['winkRight'])
    expect(ev[0][0] - (10_000 + settle.length * 33)).toBeGreaterThanOrEqual(300)
  })

  it('ignores single-frame jitter', () => {
    const det = new GestureDetector(cfg(['turnRight']))
    expect(run(det, [...settle, right, neutral, right, neutral, ...settle])).toEqual([])
  })

  it('fires once per head turn and re-arms only back at the centre', () => {
    const det = new GestureDetector(cfg(['turnLeft', 'turnRight'], {}, 0))
    // Held turn, then a partial return (still well off-centre), then out again: one event.
    const partial = face({ yaw: 12 })
    expect(names(run(det, [...settle, ...hold(right, 1500), ...hold(partial, 500), ...hold(right, 500)]))).toEqual(['turnRight'])
    // Back to the centre: the next turn counts.
    expect(names(run(det, [...hold(neutral, 300), ...hold(right, 400)], 5000))).toEqual(['turnRight'])
  })

  it('a turn to one side also waits for the centre before the other side', () => {
    const det = new GestureDetector(cfg(['turnLeft', 'turnRight'], {}, 0))
    // Swinging straight from right to left without stopping at the centre.
    expect(names(run(det, [...settle, ...hold(right, 400), ...hold(left, 400)]))).toEqual(['turnRight'])
  })

  it('tilts re-arm at the centre too', () => {
    const det = new GestureDetector(cfg(['tiltDown'], {}, 0))
    expect(names(run(det, [...settle, ...hold(down, 400), ...hold(face({ pitch: -10 }), 300), ...hold(down, 400)]))).toEqual(['tiltDown'])
    expect(names(run(det, [...hold(neutral, 300), ...hold(down, 400)], 5000))).toEqual(['tiltDown'])
  })

  it('ignores gestures made during the cooldown', () => {
    const det = new GestureDetector(cfg(['turnRight', 'winkLeft'], {}, 1500))
    const frames = [...settle, ...hold(right, 300), ...hold(neutral, 200), ...hold(winkL, 300), ...hold(neutral, 1500), ...hold(winkL, 300)]
    const ev = run(det, frames)
    expect(names(ev)).toEqual(['turnRight', 'winkLeft'])
    expect(ev[1][0] - ev[0][0]).toBeGreaterThanOrEqual(1500)
  })

  it('does not re-fire a gesture held through the end of the cooldown', () => {
    const det = new GestureDetector(cfg(['smile'], {}, 500))
    expect(run(det, [...settle, ...hold(smile, 3000)])).toHaveLength(1)
  })

  it('only fires enabled gestures but reports every level', () => {
    const det = new GestureDetector(cfg(['turnLeft']))
    expect(run(det, [...settle, ...hold(open, 400), ...hold(right, 400)])).toEqual([])
    expect(det.levels.turnRight?.value).toBeGreaterThan(1)
    expect(det.levels.mouthOpen?.value).toBeLessThan(0.5)
  })

  it('a lower sensitivity ignores a small movement that a higher one accepts', () => {
    const small = face({ yaw: 18 })
    const frames = [...settle, ...hold(small, 400)]
    expect(run(new GestureDetector(cfg(['turnRight'], { sensitivity: 0.1 })), frames)).toEqual([])
    expect(run(new GestureDetector(cfg(['turnRight'], { sensitivity: 0.9 })), frames)).toHaveLength(1)
    for (const g of FACE_GESTURES) expect(threshold(g, 1), g).toBeLessThan(threshold(g, 0))
  })

  it('uses the first pose as neutral so an off-centre camera does not trigger', () => {
    const offset = face({ yaw: 15, pitch: -10 })
    const det = new GestureDetector(cfg(['turnLeft', 'turnRight', 'tiltDown'], { sensitivity: 0.9 }))
    expect(run(det, hold(offset, 2000))).toEqual([])
    expect(det.neutralPose.yaw).toBeCloseTo(15)
    // A real turn relative to that neutral still works.
    expect(names(run(det, hold(face({ yaw: -5, pitch: -10 }), 400), 5000))).toEqual(['turnLeft'])
  })

  it('losing the face cancels a pending gesture', () => {
    const det = new GestureDetector(cfg(['turnRight'], { holdMs: 200 }))
    expect(run(det, [...settle, right, right, null, right, right, null, ...settle])).toEqual([])
  })

  describe('no cross-triggering', () => {
    it('a big (lopsided) smile is not a lip movement', () => {
      const det = new GestureDetector(cfg(['lipsLeft', 'lipsRight']))
      expect(run(det, [...settle, ...hold(face({ smile: 0.85, lipsL: 0.6 }), 800)])).toEqual([])
    })

    it('a head turn is not a wink, even though the far eye looks closed', () => {
      const det = new GestureDetector(cfg(['winkLeft', 'winkRight', 'turnRight']))
      const turnedSquint = face({ yaw: 32, eyeL: 0.1, eyeR: 0.75 })
      expect(names(run(det, [...settle, ...hold(turnedSquint, 800), ...settle]))).toEqual(['turnRight'])
    })

    it('eye, brow and lip gestures pause while the head is tilted', () => {
      const det = new GestureDetector(cfg(['winkLeft', 'raiseBrows', 'lipsRight']))
      expect(run(det, [...settle, ...hold(face({ pitch: 25, eyeL: 0.9, brows: 0.9, lipsR: 0.8 }), 800)])).toEqual([])
    })

    it('a diagonal head movement counts only along its dominant axis', () => {
      const det = new GestureDetector(cfg(['turnRight', 'tiltUp'], {}, 0))
      expect(names(run(det, [...settle, ...hold(face({ yaw: 30, pitch: 18 }), 800), ...settle]))).toEqual(['turnRight'])
    })

    it('simultaneous movements fire once (the strongest), not one after the other', () => {
      const det = new GestureDetector(cfg(['mouthOpen', 'raiseBrows'], {}, 300))
      const surprised = face({ jaw: 0.9, brows: 0.6 })
      expect(names(run(det, [...settle, ...hold(surprised, 2000)]))).toEqual(['mouthOpen'])
    })
  })
})

/* ------------------------------------------------------------ Model output */

/** A synthetic face in an unmirrored camera image (the user's left is the image's right). */
function landmarks(o: { noseX?: number; noseY?: number; leftEyeOpen?: number; rightEyeOpen?: number; mouthShift?: number } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }))
  lm[234] = { x: 0.3, y: 0.5 } // user's right cheek (image left)
  lm[454] = { x: 0.7, y: 0.5 }
  lm[1] = { x: o.noseX ?? 0.5, y: o.noseY ?? 0.55 }
  const eye = (outer: number, inner: number, top: number, bottom: number, x0: number, x1: number, open: number) => {
    lm[outer] = { x: x0, y: 0.45 }
    lm[inner] = { x: x1, y: 0.45 }
    const cx = (x0 + x1) / 2
    lm[top] = { x: cx, y: 0.45 - (open * Math.abs(x1 - x0)) / 2 }
    lm[bottom] = { x: cx, y: 0.45 + (open * Math.abs(x1 - x0)) / 2 }
  }
  eye(33, 133, 159, 145, 0.35, 0.45, o.rightEyeOpen ?? 0.3) // user's right eye, image left
  eye(263, 362, 386, 374, 0.65, 0.55, o.leftEyeOpen ?? 0.3)
  const ms = (o.mouthShift ?? 0) * 0.4
  lm[61] = { x: 0.42 + ms, y: 0.65 }
  lm[291] = { x: 0.58 + ms, y: 0.65 }
  return lm
}

const blend = (scores: Record<string, number>) => [{ categories: Object.entries(scores).map(([categoryName, score]) => ({ categoryName, score })) }]

/** Column-major 4×4 for a head rotated by yaw (about y) then pitch (about x), 50 cm from the camera. */
function matrix(yawDeg: number, pitchDeg: number, rowMajor = false) {
  const y = (yawDeg * Math.PI) / 180
  const p = (pitchDeg * Math.PI) / 180
  // R = Ry(y) · Rx(-p): positive p lifts the forward axis (+z) towards +y.
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p)
  const R = [
    [cy, -sy * sp, sy * cp],
    [0, cp, sp],
    [-sy, -cy * sp, cy * cp],
  ]
  const M = [
    [...R[0], 0],
    [...R[1], 0],
    [...R[2], -50],
    [0, 0, 0, 1],
  ]
  const out: number[] = []
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out.push(rowMajor ? M[i][j] : M[j][i])
  return out
}

describe('geometryFromLandmarks', () => {
  it('measures yaw, eye asymmetry and lip shift in the user’s frame', () => {
    const g = geometryFromLandmarks(landmarks())!
    expect(g.yaw).toBeCloseTo(0)
    expect(g.eyeDiff).toBeCloseTo(0)
    // Turning right moves the nose to the image left.
    expect(geometryFromLandmarks(landmarks({ noseX: 0.36 }))!.yaw).toBeGreaterThan(0.5)
    // Closing the left eye (image right) makes the image-left eye relatively more open.
    expect(geometryFromLandmarks(landmarks({ leftEyeOpen: 0.05 }))!.eyeDiff).toBeGreaterThan(0.2)
    expect(geometryFromLandmarks(landmarks({ mouthShift: 0.1 }))!.mouthShift).toBeGreaterThan(0)
    // Chin up: nose tip moves up towards the eyes.
    expect(geometryFromLandmarks(landmarks({ noseY: 0.5 }))!.pitch).toBeGreaterThan(g.pitch)
  })

  it('rejects missing or degenerate landmarks', () => {
    expect(geometryFromLandmarks(undefined)).toBeNull()
    expect(geometryFromLandmarks([{ x: 0, y: 0 }])).toBeNull()
  })
})

describe('poseFromMatrix', () => {
  it('reads yaw and pitch from column- and row-major data alike', () => {
    for (const rowMajor of [false, true]) {
      const p = poseFromMatrix(matrix(20, -10, rowMajor))!
      expect(p.yaw).toBeCloseTo(20, 0)
      expect(p.pitch).toBeCloseTo(-10, 0)
    }
    expect(poseFromMatrix(undefined)).toBeNull()
  })
})

describe('Polarity', () => {
  it('keeps its prior without evidence and flips on consistent contrary evidence', () => {
    const p = new Polarity(1, 0.3, 0.1)
    for (let i = 0; i < 50; i++) p.observe(0.01 * (i % 2), 0.002 * (i % 3)) // jitter only
    expect(p.sign).toBe(1)
    for (let i = 0; i < 6; i++) {
      p.observe(0, 0)
      p.observe(0.8, -0.3)
      p.observe(0, 0)
    }
    expect(p.sign).toBe(-1)
  })
})

describe('FaceReader', () => {
  /** A short session: neutral frames, then a movement, as the camera would deliver them. */
  function session(reader: FaceReader, move: { lm: Parameters<typeof landmarks>[0]; bs: Record<string, number>; yaw?: number; pitch?: number }, reps = 4) {
    let last: FaceSample | null = null
    for (let r = 0; r < reps; r++) {
      for (let i = 0; i < 5; i++) reader.read({ faceLandmarks: [landmarks()], faceBlendshapes: blend({}), facialTransformationMatrixes: [{ data: matrix(0, 0) }] })
      for (let i = 0; i < 5; i++)
        last = reader.read({ faceLandmarks: [landmarks(move.lm)], faceBlendshapes: blend(move.bs), facialTransformationMatrixes: [{ data: matrix(move.yaw ?? 0, move.pitch ?? 0) }] })
    }
    return last!
  }

  it('maps subject-relative blendshape names to the user’s left/right', () => {
    const s = session(new FaceReader(), { lm: { leftEyeOpen: 0.04 }, bs: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.05 } })
    expect(s.eyeL).toBeCloseTo(0.9)
    expect(s.eyeR).toBeCloseTo(0.05)
  })

  it('learns image-relative (swapped) blendshape names from the landmarks', () => {
    // The user closes their LEFT eye (image right), but the model calls it eyeBlinkRight.
    const reader = new FaceReader()
    const s = session(reader, { lm: { leftEyeOpen: 0.04 }, bs: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.9 } })
    expect(s.eyeL).toBeCloseTo(0.9)
    // Same for lips pushed to the user's left (image right) reported as mouthRight.
    const l = session(reader, { lm: { mouthShift: 0.1 }, bs: { mouthLeft: 0, mouthRight: 0.7 } })
    expect(l.lipsL).toBeCloseTo(0.7)
    expect(l.lipsR).toBeCloseTo(0)
  })

  it('reports head yaw positive to the user’s right, whatever the matrix axes', () => {
    // Turning right: nose to the image left. In camera axes that is a negative yaw…
    const s = session(new FaceReader(), { lm: { noseX: 0.4 }, bs: {}, yaw: -25 })
    expect(s.yaw).toBeCloseTo(25, 0)
    // …and if a model reported it the other way round, the reader learns that.
    const t = session(new FaceReader(), { lm: { noseX: 0.4 }, bs: {}, yaw: 25 })
    expect(t.yaw).toBeCloseTo(25, 0)
  })

  it('reports chin up as positive pitch', () => {
    const s = session(new FaceReader(), { lm: { noseY: 0.5 }, bs: {}, pitch: 20 })
    expect(s.pitch).toBeCloseTo(20, 0)
    const t = session(new FaceReader(), { lm: { noseY: 0.5 }, bs: {}, pitch: -20 })
    expect(t.pitch).toBeCloseTo(20, 0)
  })

  it('combines smile, brow and jaw blendshapes', () => {
    const s = new FaceReader().read({
      faceLandmarks: [landmarks()],
      faceBlendshapes: blend({ mouthSmileLeft: 0.8, mouthSmileRight: 0.6, browInnerUp: 0.8, browOuterUpLeft: 0.6, browOuterUpRight: 0.4, jawOpen: 0.5 }),
    })!
    expect(s.smile).toBeCloseTo(0.7)
    expect(s.brows).toBeCloseTo(0.65)
    expect(s.jaw).toBeCloseTo(0.5)
    expect(new FaceReader().read({})).toBeNull()
  })
})
