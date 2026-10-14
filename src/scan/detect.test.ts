import { describe, expect, it } from 'vitest'
import { convexHull, detectQuad, otsu, simplifyTo } from './detect'
import type { Pt, Quad } from './geometry'

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

function inside(q: readonly Pt[], x: number, y: number) {
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false
  }
  return true
}

/**
 * A downscaled "photo": dark textured table, a bright page (pixel quad `q`) lit unevenly, with
 * dark music-like marks on it. 2×2 supersampling gives soft, realistic edges.
 */
function scene(q: Quad, w = 320, h = 240, opts: { shadow?: boolean; seed?: number } = {}) {
  const rand = rng(opts.seed ?? 3)
  const g = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (const [sx, sy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const px = x + sx
        const py = y + sy
        if (inside(q, px, py)) {
          let v = 225 - (px / w) * 40
          if (opts.shadow) v -= 70 * Math.max(0, 1 - Math.hypot(px - w * 0.7, py - h * 0.3) / 90)
          // Staff-ish lines and blobs.
          if (Math.round(py) % 12 === 0 && px % 50 > 8) v *= 0.55
          if (((px - w / 2) / 9) ** 2 + ((py - h / 2) / 6) ** 2 < 1) v *= 0.2
          acc += v
        } else acc += 55 + 25 * Math.sin(px / 7) * Math.sin(py / 11)
      }
      g[y * w + x] = Math.max(0, Math.min(255, Math.round(acc / 4 + (rand() - 0.5) * 16)))
    }
  return g
}

function expectCorners(found: Quad | null, truth: Quad, w: number, h: number, tolPx = 3) {
  expect(found).not.toBeNull()
  found!.forEach((p, i) => {
    expect(Math.abs(p.x * w - truth[i].x)).toBeLessThan(tolPx)
    expect(Math.abs(p.y * h - truth[i].y)).toBeLessThan(tolPx)
  })
}

describe('quad detection', () => {
  it('finds a skewed page on a dark table', () => {
    const q: Quad = [
      { x: 70, y: 22 },
      { x: 250, y: 35 },
      { x: 268, y: 222 },
      { x: 48, y: 208 },
    ]
    expectCorners(detectQuad(scene(q), 320, 240), q, 320, 240)
  })

  it('copes with a rotated page and a shadow across it', () => {
    const q: Quad = [
      { x: 120, y: 12 },
      { x: 292, y: 80 },
      { x: 220, y: 230 },
      { x: 40, y: 150 },
    ]
    expectCorners(detectQuad(scene(q, 320, 240, { shadow: true, seed: 11 }), 320, 240), q, 320, 240, 4)
  })

  it('returns null when there is no page', () => {
    const rand = rng(5)
    const flat = new Uint8Array(320 * 240).map(() => 128 + Math.round((rand() - 0.5) * 10))
    expect(detectQuad(flat, 320, 240)).toBeNull()
  })

  it('otsu splits a bimodal histogram between the modes', () => {
    const g = new Uint8Array(1000).map((_, i) => (i < 600 ? 40 + (i % 10) : 200 + (i % 10)))
    const t = otsu(g)
    expect(t).toBeGreaterThanOrEqual(49)
    expect(t).toBeLessThan(200)
  })

  it('hull + simplification keep the extreme corners', () => {
    const pts: Pt[] = []
    for (let i = 0; i <= 20; i++) pts.push({ x: i, y: 0 }, { x: i, y: 10 }, { x: 0, y: i / 2 }, { x: 20, y: i / 2 }, { x: 10, y: 5 })
    const hull = convexHull(pts)
    expect(hull.length).toBe(4)
    const poly = [{ x: 0, y: 0 }, { x: 10, y: -0.2 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }]
    expect(simplifyTo(poly, 4)).not.toContainEqual({ x: 10, y: -0.2 })
  })
})
