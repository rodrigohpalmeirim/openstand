import { describe, expect, it } from 'vitest'
import { GestureDetector, sampleFromLandmarks, thresholds, type FaceSample, type GestureConfig } from './gestures'

const cfg = (over: Partial<GestureConfig> = {}): GestureConfig => ({ sensitivity: 0.5, cooldownMs: 1000, headTurn: true, mouth: true, holdMs: 100, ...over })

/** Feed samples at 30 fps; returns [time, gesture] for every recognised gesture. */
function run(det: GestureDetector, frames: (FaceSample | null)[], start = 0) {
  const out: [number, string][] = []
  frames.forEach((f, i) => {
    const t = start + i * 33
    const g = det.update(f, t)
    if (g) out.push([t, g])
  })
  return out
}

const hold = (s: FaceSample | null, ms: number) => Array.from({ length: Math.ceil(ms / 33) }, () => s)
const neutral: FaceSample = { yaw: 0, mouth: 0.02 }
const right: FaceSample = { yaw: 0.7, mouth: 0.02 }
const left: FaceSample = { yaw: -0.7, mouth: 0.02 }
const open: FaceSample = { yaw: 0, mouth: 0.7 }

describe('sampleFromLandmarks', () => {
  const face = (noseX: number, lipGap = 0) => {
    const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }))
    lm[234] = { x: 0.3, y: 0.5 }
    lm[454] = { x: 0.7, y: 0.5 }
    lm[1] = { x: noseX, y: 0.5 }
    lm[61] = { x: 0.4, y: 0.7 }
    lm[291] = { x: 0.6, y: 0.7 }
    lm[13] = { x: 0.5, y: 0.7 - lipGap / 2 }
    lm[14] = { x: 0.5, y: 0.7 + lipGap / 2 }
    return lm
  }

  it('is centred when the nose is between the cheeks', () => {
    const s = sampleFromLandmarks(face(0.5))!
    expect(s.yaw).toBeCloseTo(0)
    expect(s.mouth).toBeCloseTo(0)
  })

  it('reports a right turn when the nose moves to the image left', () => {
    expect(sampleFromLandmarks(face(0.36))!.yaw).toBeGreaterThan(0.5)
    expect(sampleFromLandmarks(face(0.64))!.yaw).toBeLessThan(-0.5)
  })

  it('measures mouth opening relative to mouth width', () => {
    expect(sampleFromLandmarks(face(0.5, 0.1))!.mouth).toBeCloseTo(0.5)
  })

  it('rejects missing or degenerate landmarks', () => {
    expect(sampleFromLandmarks(undefined)).toBeNull()
    expect(sampleFromLandmarks([{ x: 0, y: 0 }])).toBeNull()
  })
})

describe('thresholds', () => {
  it('needs smaller movements at higher sensitivity', () => {
    expect(thresholds(1).yaw).toBeLessThan(thresholds(0).yaw)
    expect(thresholds(1).mouth).toBeLessThan(thresholds(0).mouth)
  })
})

describe('GestureDetector', () => {
  it('fires once per head turn and needs a return to centre', () => {
    const det = new GestureDetector(cfg({ cooldownMs: 0 }))
    const ev = run(det, [...hold(neutral, 300), ...hold(right, 2000), ...hold(neutral, 300), ...hold(left, 500)])
    expect(ev.map((e) => e[1])).toEqual(['turnRight', 'turnLeft'])
  })

  it('requires the pose to be held (ignores single-frame jitter)', () => {
    const det = new GestureDetector(cfg())
    const frames = [...hold(neutral, 300), right, neutral, right, neutral, ...hold(neutral, 300)]
    expect(run(det, frames)).toEqual([])
  })

  it('ignores gestures made during the cooldown', () => {
    const det = new GestureDetector(cfg({ cooldownMs: 1500 }))
    const frames = [...hold(neutral, 300), ...hold(right, 300), ...hold(neutral, 200), ...hold(right, 300), ...hold(neutral, 1500), ...hold(right, 300)]
    const ev = run(det, frames)
    expect(ev).toHaveLength(2)
    expect(ev[1][0] - ev[0][0]).toBeGreaterThanOrEqual(1500)
  })

  it('does not re-fire a gesture held through the end of the cooldown', () => {
    const det = new GestureDetector(cfg({ cooldownMs: 500 }))
    expect(run(det, [...hold(neutral, 300), ...hold(right, 3000)])).toHaveLength(1)
  })

  it('detects mouth opening and respects the enable flags', () => {
    expect(run(new GestureDetector(cfg()), [...hold(neutral, 300), ...hold(open, 400)]).map((e) => e[1])).toEqual(['mouthOpen'])
    expect(run(new GestureDetector(cfg({ mouth: false })), [...hold(neutral, 300), ...hold(open, 400)])).toEqual([])
    expect(run(new GestureDetector(cfg({ headTurn: false })), [...hold(neutral, 300), ...hold(right, 400)])).toEqual([])
  })

  it('a lower sensitivity ignores a small turn that a higher one accepts', () => {
    const small: FaceSample = { yaw: 0.35, mouth: 0 }
    const frames = [...hold(neutral, 300), ...hold(small, 400)]
    expect(run(new GestureDetector(cfg({ sensitivity: 0.1 })), frames)).toEqual([])
    expect(run(new GestureDetector(cfg({ sensitivity: 0.9 })), frames)).toHaveLength(1)
  })

  it('uses the first pose as neutral so an off-centre camera does not trigger', () => {
    const offset: FaceSample = { yaw: 0.3, mouth: 0 }
    const det = new GestureDetector(cfg({ sensitivity: 0.9 }))
    expect(run(det, hold(offset, 2000))).toEqual([])
    expect(det.neutralYaw).toBeCloseTo(0.3)
    // A real turn relative to that neutral still works.
    expect(run(det, hold({ yaw: -0.3, mouth: 0 }, 400), 5000).map((e) => e[1])).toEqual(['turnLeft'])
  })

  it('losing the face cancels a pending gesture', () => {
    const det = new GestureDetector(cfg({ holdMs: 200 }))
    const frames = [...hold(neutral, 300), right, right, null, right, right, null, ...hold(neutral, 300)]
    expect(run(det, frames)).toEqual([])
  })
})
