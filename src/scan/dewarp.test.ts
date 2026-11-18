import { describe, expect, it } from 'vitest'
import { estimateBend, fitBend, type BendDebug, type Track } from './dewarp'
import {
  makeScene,
  musicPage,
  photograph,
  photoQuad,
  rng,
  rotatePhotoCW,
  straightness,
  textPage,
  type FlatPage,
  type SceneOptions,
} from './dewarp.test-helper'
import { bendAt, bendPoint, isStraight, NO_BEND, rotateBend, rotateQuad, type Bend, type Pt, type Quad } from './geometry'

// Synthetic photos: a page laid on a curved surface (not the correction model) seen through a tilted pinhole
// camera, with shading, a spine shadow, blur and noise. Smaller than real proxies to keep the suite quick.
const SIZE = { imgW: 1200, imgH: 1600 }

interface Shot {
  page: FlatPage
  scene: ReturnType<typeof makeScene>
  grey: Uint8Array
  width: number
  height: number
  quad: Quad
  rotation: number
  mapPhoto: (p: Pt) => Pt
}

function shoot(page: FlatPage, o: SceneOptions, opts: { rotate?: boolean; jitter?: number } = {}): Shot {
  const so = { ...SIZE, ...o }
  const scene = makeScene(so)
  let ph = photograph(page, scene, so)
  let mapPhoto = (p: Pt) => p
  if (opts.rotate) {
    const h0 = ph.height
    ph = rotatePhotoCW(ph)
    mapPhoto = (p) => ({ x: h0 - p.y, y: p.x })
  }
  let { quad, rotation } = opts.rotate ? photoQuad(ph.quad) : { quad: ph.quad, rotation: 0 }
  if (opts.jitter) {
    const r = rng(o.seed ?? 1)
    const size = Math.hypot(ph.width, ph.height) / 1.4
    quad = quad.map((p) => ({ x: p.x + (r() * 2 - 1) * opts.jitter! * size, y: p.y + (r() * 2 - 1) * opts.jitter! * size })) as Quad
  }
  return { page, scene, grey: ph.grey, width: ph.width, height: ph.height, quad, rotation, mapPhoto }
}

/** Ground-truth worst staff-line deviation from straight (staff spaces) after warping with `bend`. */
function worst(s: Shot, bend: Bend): number {
  const up = rotateQuad(s.quad, s.rotation)
  const b = rotateBend(bend, s.rotation)
  return straightness(s.page, s.scene, up, (u, v) => bendPoint(b, u, v), 3300, s.mapPhoto).worstSp
}

const music = (seed: number, extra = {}) => musicPage({ seed, lyrics: true, lastPartial: 0.55, ...extra })

describe('fitBend', () => {
  it('recovers a known bend from exact staff traces', () => {
    const truth: Bend = [[0.012, 0.02], [], [0.006, 0.003], []]
    const tracks: Track[] = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((v) => {
      const u = Array.from({ length: 36 }, (_, k) => 0.08 + (0.84 * k) / 35)
      const Y = u.map((uu) => v - (1 - v) * bendAt(truth[0], uu) + v * bendAt(truth[2], 1 - uu))
      return { u, y: Y, Y, w: u.map(() => 1), v: 0, ok: true, inl: [] }
    })
    const f = fitBend(tracks, 0.006)!
    for (let k = 0; k < 2; k++) {
      expect(f.top[k]).toBeCloseTo(truth[0][k], 4)
      expect(f.bottom[k]).toBeCloseTo(truth[2][k], 4)
    }
  })
})

describe('estimateBend on synthetic photos', () => {
  const curved: [string, SceneOptions, { rotate?: boolean; jitter?: number }?][] = [
    ['mild, spine right', { theta0: 15, lambda: 30, pitch: 8, seed: 3 }],
    ['moderate, spine left, tilted camera', { theta0: 28, lambda: 35, spine: 'left', pitch: -12, yaw: 5, seed: 4 }],
    ['strong, low camera', { theta0: 45, lambda: 45, pitch: 12, height: 320, seed: 5 }],
    ['uniform bow', { kappa: 0.1, pitch: 10, seed: 6 }],
    ['moderate, heavy shading and blur', { theta0: 28, lambda: 35, pitch: 10, lighting: 0.9, blur: 1.6, noise: 7, seed: 7 }],
    ['moderate, phone held sideways', { theta0: 28, lambda: 35, pitch: 10, seed: 8 }, { rotate: true }],
    ['moderate, corners 0.4% off', { theta0: 28, lambda: 35, pitch: 10, seed: 9 }, { jitter: 0.004 }],
  ]
  for (const [name, o, opts] of curved)
    it(`straightens staff lines: ${name}`, () => {
      const s = shoot(music(o.seed!), o, opts)
      const dbg = {} as BendDebug
      const est = estimateBend(s.grey, s.width, s.height, s.quad, s.rotation, NO_BEND, dbg)
      expect(est, dbg.reason).not.toBeNull()
      expect(est!.flat).toBe(false)
      const before = worst(s, NO_BEND)
      const after = worst(s, est!.bend)
      expect(before).toBeGreaterThan(0.3)
      expect(after).toBeLessThan(before * 0.45)
      expect(after).toBeLessThan(0.45)
      // Only the sides along the staff lines are bent.
      const along = [(4 - s.rotation) % 4, (6 - s.rotation) % 4]
      est!.bend.forEach((side, i) => {
        if (!along.includes(i)) expect(side.every((v) => v === 0)).toBe(true)
      })
    }, 30_000)

  it('leaves flat pages straight', () => {
    for (const o of [
      { pitch: 12, yaw: 5, seed: 11 },
      { pitch: 25, yaw: -10, roll: 4, seed: 12 },
      { pitch: -15, height: 300, blur: 1.5, noise: 6, seed: 13 },
    ]) {
      const s = shoot(music(o.seed), o)
      const est = estimateBend(s.grey, s.width, s.height, s.quad)
      if (est) {
        expect(est.flat).toBe(true)
        expect(isStraight(est.bend)).toBe(true)
      }
    }
  }, 60_000)

  it('does not turn misplaced corners into a bend on a flat page', () => {
    for (const seed of [21, 22]) {
      const s = shoot(music(seed), { pitch: 12, seed }, { jitter: 0.015 })
      const est = estimateBend(s.grey, s.width, s.height, s.quad)
      if (est) expect(isStraight(est.bend)).toBe(true)
    }
  }, 60_000)

  it('returns null for pages without staves', () => {
    for (const [i, page] of [textPage(31), textPage(32, { short: true }), textPage(33, { ruled: true })].entries()) {
      const s = shoot(page, { theta0: 25, lambda: 35, pitch: 10, seed: 31 + i })
      expect(estimateBend(s.grey, s.width, s.height, s.quad)).toBeNull()
    }
  }, 60_000)

  it('returns null when the staves run the other way (wrong rotation)', () => {
    const s = shoot(music(41), { theta0: 25, lambda: 35, pitch: 10, seed: 41 })
    expect(estimateBend(s.grey, s.width, s.height, s.quad, 1)).toBeNull()
  }, 30_000)
})
