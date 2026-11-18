import { describe, expect, it } from 'vitest'
import {
  applyH,
  BEND_POINTS,
  bendAt,
  bendPoint,
  homography,
  invert3,
  isConvexQuad,
  isStraight,
  NO_BEND,
  orderQuad,
  outputSize,
  pageSizeFor,
  paperAspect,
  PAPER,
  rotateBend,
  rotateQuad,
  snapAspect,
  type Bend,
  type Pt,
  type Quad,
} from './geometry'

const close = (a: Pt, b: Pt, eps = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, -Math.log10(eps))
  expect(a.y).toBeCloseTo(b.y, -Math.log10(eps))
}

/** Photograph a W×H rectangle tilted in 3D with a pinhole camera; returns the image quad. */
function photograph(W: number, H: number, rx: number, ry: number, rz: number, z: number, f: number, imgW: number, imgH: number): Quad {
  const corners = [
    [-W / 2, -H / 2],
    [W / 2, -H / 2],
    [W / 2, H / 2],
    [-W / 2, H / 2],
  ]
  return corners.map(([x, y]) => {
    let p = [x, y, 0]
    const rot = (a: number, i: number, j: number) => {
      const c = Math.cos(a)
      const s = Math.sin(a)
      const q = [...p]
      q[i] = p[i] * c - p[j] * s
      q[j] = p[i] * s + p[j] * c
      p = q
    }
    rot(rz, 0, 1)
    rot(rx, 1, 2)
    rot(ry, 0, 2)
    const Z = p[2] + z
    return { x: (f * p[0]) / Z + imgW / 2 + 37, y: (f * p[1]) / Z + imgH / 2 - 21 }
  }) as Quad
}

describe('homography', () => {
  it('maps the four source points onto the destination points', () => {
    const src: Pt[] = [
      { x: 10, y: 20 },
      { x: 300, y: 35 },
      { x: 280, y: 400 },
      { x: 25, y: 380 },
    ]
    const dst: Pt[] = [
      { x: 0, y: 0 },
      { x: 210, y: 0 },
      { x: 210, y: 297 },
      { x: 0, y: 297 },
    ]
    const h = homography(src, dst)!
    src.forEach((p, i) => close(applyH(h, p), dst[i]))
  })

  it('reduces to scale + translation for an axis-aligned square', () => {
    const sq: Pt[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    const h = homography(
      sq,
      sq.map((p) => ({ x: p.x * 4 + 2, y: p.y * 3 - 1 })),
    )!
    close(applyH(h, { x: 0.5, y: 0.25 }), { x: 4, y: -0.25 })
    expect(h[6]).toBeCloseTo(0)
    expect(h[7]).toBeCloseTo(0)
  })

  it('keeps straight lines straight and maps the diagonal crossing to the centre', () => {
    const q: Quad = [
      { x: 100, y: 80 },
      { x: 900, y: 140 },
      { x: 820, y: 1000 },
      { x: 60, y: 900 },
    ]
    const h = homography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], q)!
    // Intersection of the quad's diagonals = image of the square's centre.
    const c = applyH(h, { x: 0.5, y: 0.5 })
    const cr = (a: Pt, b: Pt, p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    expect(Math.abs(cr(q[0], q[2], c))).toBeLessThan(1e-6)
    expect(Math.abs(cr(q[1], q[3], c))).toBeLessThan(1e-6)
  })

  it('returns null for degenerate input', () => {
    const line = [0, 1, 2, 3].map((i) => ({ x: i, y: i }))
    expect(homography(line, line)).toBeNull()
  })

  it('inverts', () => {
    const h = homography(
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      [{ x: 3, y: 1 }, { x: 9, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 7 }],
    )!
    const inv = invert3(h)!
    const p = { x: 0.3, y: 0.8 }
    close(applyH(inv, applyH(h, p)), p)
  })
})

describe('quad helpers', () => {
  it('orders arbitrary corner lists as TL, TR, BR, BL', () => {
    const q = orderQuad([
      { x: 90, y: 95 },
      { x: 5, y: 10 },
      { x: 10, y: 100 },
      { x: 100, y: 0 },
    ])
    expect(q).toEqual([
      { x: 5, y: 10 },
      { x: 100, y: 0 },
      { x: 90, y: 95 },
      { x: 10, y: 100 },
    ])
    expect(isConvexQuad(q)).toBe(true)
    expect(isConvexQuad([q[0], q[2], q[1], q[3]])).toBe(false)
  })

  it('rotates the output clockwise by moving the bottom-left corner to the top-left', () => {
    const q: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    expect(rotateQuad(q, 1)[0]).toEqual({ x: 0, y: 1 })
    expect(rotateQuad(q, 1)[1]).toEqual({ x: 0, y: 0 })
    expect(rotateQuad(q, 4)).toEqual(q)
    expect(rotateQuad(q, -1)).toEqual(rotateQuad(q, 3))
  })
})

describe('paper aspect', () => {
  const A4 = 210 / 297
  it('recovers the true aspect of a tilted A4 sheet', () => {
    const q = photograph(0.21, 0.297, 0.5, 0.15, 0.05, 0.55, 3000, 4000, 3000)
    // Strong foreshortening: edge lengths alone are far off.
    const naive = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / (Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y))
    expect(Math.abs(naive / A4 - 1)).toBeGreaterThan(0.05)
    expect(paperAspect(q, 4000, 3000)).toBeCloseTo(A4, 1)
    expect(Math.abs(paperAspect(q, 4000, 3000) / A4 - 1)).toBeLessThan(0.03)
  })

  it('handles a frontal photo (no perspective)', () => {
    const q = photograph(0.216, 0.279, 0, 0, 0, 0.5, 3000, 4000, 3000)
    expect(paperAspect(q, 4000, 3000)).toBeCloseTo(216 / 279, 3)
  })

  it('snaps to A4 / Letter and picks page sizes', () => {
    expect(snapAspect(0.72).paper).toBe('a4')
    expect(snapAspect(0.77).paper).toBe('letter')
    expect(snapAspect(1 / 0.71).landscape).toBe(true)
    expect(snapAspect(0.5).paper).toBeNull()
    expect(pageSizeFor(PAPER.a4.w / PAPER.a4.h)).toEqual(PAPER.a4)
    expect(pageSizeFor(PAPER.letter.h / PAPER.letter.w)).toEqual({ w: 792, h: 612 })
    const odd = pageSizeFor(0.5)
    expect(odd.h).toBeCloseTo(PAPER.a4.h)
    expect(odd.w).toBeCloseTo(PAPER.a4.h / 2)
  })

  it('sizes the output from the measured resolution, capped', () => {
    const q = photograph(0.21, 0.297, 0.2, 0, 0, 0.5, 3000, 4000, 3000)
    const s = outputSize(q, 4000, 3000, 5000)
    expect(s.w / s.h).toBeCloseTo(A4, 2)
    expect(s.h).toBeGreaterThan(1500)
    const capped = outputSize(q, 4000, 3000, 1000)
    expect(capped.h).toBe(1000)
    expect(capped.w).toBe(Math.round(1000 * A4))
  })
})

describe('bends', () => {
  const B = (t: number[], r: number[], b: number[], l: number[]): Bend => [t, r, b, l]

  it('bendAt is zero at the ends and passes through the control values', () => {
    expect(BEND_POINTS === 2 || BEND_POINTS === 3).toBe(true)
    const vals = Array.from({ length: BEND_POINTS }, (_, k) => 0.03 * (k + 1) * (k % 2 ? -1 : 1))
    expect(bendAt(vals, 0)).toBeCloseTo(0, 12)
    expect(bendAt(vals, 1)).toBeCloseTo(0, 12)
    vals.forEach((v, k) => expect(bendAt(vals, (k + 1) / (BEND_POINTS + 1))).toBeCloseTo(v, 12))
    expect(bendAt([], 0.4)).toBe(0)
  })

  it('bendAt is linear in the values (fit by least squares)', () => {
    const a = Array.from({ length: BEND_POINTS }, (_, k) => 0.02 + 0.01 * k)
    const b = Array.from({ length: BEND_POINTS }, (_, k) => -0.05 + 0.03 * k)
    for (const t of [0.1, 0.27, 0.5, 0.81]) {
      expect(bendAt(a.map((x, i) => x + b[i]), t)).toBeCloseTo(bendAt(a, t) + bendAt(b, t), 12)
      expect(bendAt(a.map((x) => 3 * x), t)).toBeCloseTo(3 * bendAt(a, t), 12)
    }
    // A constant bow stays between the ends without wild overshoot.
    const flat = new Array<number>(BEND_POINTS).fill(0.05)
    for (let t = 0; t <= 1; t += 0.05) expect(Math.abs(bendAt(flat, t))).toBeLessThan(0.08)
  })

  it('bendPoint is the identity without a bend', () => {
    const zeros = new Array<number>(BEND_POINTS).fill(0)
    for (const [u, v] of [[0, 0], [0.3, 0.7], [1, 1], [0.5, 0.01]]) {
      expect(bendPoint(NO_BEND, u, v)).toEqual({ x: u, y: v })
      expect(bendPoint(B(zeros, zeros, zeros, zeros), u, v)).toEqual({ x: u, y: v })
    }
    expect(isStraight(undefined)).toBe(true)
    expect(isStraight(NO_BEND)).toBe(true)
    expect(isStraight(B(zeros, [], [], []))).toBe(true)
    expect(isStraight(B([0.01, 0], [], [], []))).toBe(false)
  })

  it('bendPoint moves the sides outwards and keeps the corners', () => {
    const v = new Array<number>(BEND_POINTS).fill(0.05)
    const bend = B(v, v, v, v)
    for (const [u, w] of [[0, 0], [1, 0], [1, 1], [0, 1]]) close(bendPoint(bend, u, w), { x: u, y: w }, 1e-12)
    expect(bendPoint(bend, 0.5, 0).y).toBeLessThan(0) // top bows up
    expect(bendPoint(bend, 1, 0.5).x).toBeGreaterThan(1) // right bows right
    expect(bendPoint(bend, 0.5, 1).y).toBeGreaterThan(1) // bottom bows down
    expect(bendPoint(bend, 0, 0.5).x).toBeLessThan(0) // left bows left
    // Control t runs from corner i towards corner i+1: the bottom runs right to left.
    const bottom = B([], [], [0.1, ...new Array<number>(BEND_POINTS - 1).fill(0)], [])
    close(bendPoint(bottom, 1 - 1 / (BEND_POINTS + 1), 1), { x: 1 - 1 / (BEND_POINTS + 1), y: 1.1 }, 1e-12)
  })

  it('rotateBend follows rotateQuad through quarter turns', () => {
    const q: Quad = [
      { x: 0.1, y: 0.15 },
      { x: 0.85, y: 0.1 },
      { x: 0.9, y: 0.88 },
      { x: 0.12, y: 0.95 },
    ]
    const mk = (s: number) => Array.from({ length: BEND_POINTS }, (_, k) => s * (k + 1) * 0.02)
    const bend = B(mk(1), mk(-0.5), mk(2), mk(0.7))
    const square: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    const photo = (qq: Quad, b: Bend, u: number, v: number) => applyH(homography(square, qq)!, bendPoint(b, u, v))
    // Output point (u,v) after one clockwise quarter turn shows the unrotated page point (v, 1 − u).
    const back = (k: number, u: number, v: number): [number, number] => (k ? back(k - 1, v, 1 - u) : [u, v])
    for (let k = 0; k < 4; k++)
      for (const [u, v] of [[0.2, 0], [0.5, 0.5], [1, 0.3], [0.7, 1], [0, 0.6], [0.33, 0.9]]) {
        close(photo(rotateQuad(q, k), rotateBend(bend, k), u, v), photo(q, bend, ...back(k, u, v)), 1e-9)
      }
    expect(rotateBend(bend, 4)).toEqual(bend)
    expect(rotateBend(bend, -1)).toEqual(rotateBend(bend, 3))
  })
})
