import { describe, expect, it } from 'vitest'
import { applyH, homography, type Quad } from './geometry'
import { cleanBW, cleanGrey, despeckle, flatten, packBits, toGrey, warpPerspective, type Rgba } from './image'

function rgba(w: number, h: number, f: (x: number, y: number) => number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = f(x, y)
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  return { data, width: w, height: h }
}

/** Deterministic pseudo-random noise. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

describe('warpPerspective', () => {
  it('copies an axis-aligned region exactly (pixel-centre sampling)', () => {
    const src = rgba(100, 100, (x) => x * 2)
    const q: Quad = [
      { x: 20, y: 30 },
      { x: 80, y: 30 },
      { x: 80, y: 70 },
      { x: 20, y: 70 },
    ]
    const out = warpPerspective(src, q, 60, 40)
    expect(out.width).toBe(60)
    for (const x of [0, 7, 31, 59]) expect(out.data[(10 * 60 + x) * 4]).toBe(2 * (20 + x))
  })

  it('undoes a perspective projection', () => {
    // A 10px checkerboard "page", photographed into a 400×400 frame.
    const W = 200
    const H = 280
    const page = (x: number, y: number) => (((x / 10) | 0) + ((y / 10) | 0)) % 2 ? 0 : 255
    const quad: Quad = [
      { x: 60, y: 40 },
      { x: 330, y: 70 },
      { x: 370, y: 380 },
      { x: 20, y: 350 },
    ]
    const toPage = homography(quad, [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ])!
    const photo = rgba(400, 400, (x, y) => {
      const p = applyH(toPage, { x: x + 0.5, y: y + 0.5 })
      return p.x >= 0 && p.x < W && p.y >= 0 && p.y < H ? page(p.x, p.y) : 90
    })
    const out = warpPerspective(photo, quad, W, H)
    let wrong = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(out.data[(y * W + x) * 4] - page(x + 0.5, y + 0.5)) > 128) wrong++
    expect(wrong / (W * H)).toBeLessThan(0.03)
  })
})

/**
 * A synthetic photographed score: strong illumination gradient plus a shadow, five-line staves
 * drawn 1px thick at modest contrast, filled note heads and sensor noise.
 */
function syntheticScore(w = 600, h = 800) {
  const rand = rng(7)
  const light = (x: number, y: number) => {
    const grad = 235 - (x / w) * 110 // 235 → 125 across the page
    const shadow = 70 * Math.exp(-(((x - w * 0.8) / 90) ** 2 + ((y - h * 0.2) / 120) ** 2))
    return grad - shadow
  }
  const staffRows = new Set<number>()
  for (let s = 0; s < 6; s++) for (let l = 0; l < 5; l++) staffRows.add(80 + s * 120 + l * 9)
  const isHead = (x: number, y: number) => {
    for (let s = 0; s < 6; s++)
      for (let n = 0; n < 8; n++) {
        const cx = 60 + n * 65
        const cy = 80 + s * 120 + (n % 5) * 9
        if (((x - cx) / 6) ** 2 + ((y - cy) / 4.5) ** 2 <= 1) return true
      }
    return false
  }
  const ink = new Uint8Array(w * h) // 1 = staff line, 2 = note head
  const g = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let v = light(x, y)
      if (x > 30 && x < w - 30 && staffRows.has(y)) {
        ink[i] = 1
        v *= 0.6
      }
      if (isHead(x, y)) {
        ink[i] = 2
        v *= 0.15
      }
      g[i] = Math.max(0, Math.min(255, Math.round(v + (rand() - 0.5) * 12)))
    }
  return { g, ink, w, h }
}

describe('Clean B&W', () => {
  it('keeps thin staff lines and note heads while whitening gradients and shadows', () => {
    const { g, ink, w, h } = syntheticScore()
    const bw = cleanBW(g, w, h, 50)
    let line = 0
    let lineBlack = 0
    let head = 0
    let headBlack = 0
    let paper = 0
    let paperBlack = 0
    for (let i = 0; i < bw.length; i++) {
      if (ink[i] === 1) {
        line++
        if (!bw[i]) lineBlack++
      } else if (ink[i] === 2) {
        head++
        if (!bw[i]) headBlack++
      } else {
        // Ignore the pixels right next to ink (anti-aliasing / blur in a real photo).
        const y = (i / w) | 0
        if (ink[i - 1] || ink[i + 1] || (y > 0 && ink[i - w]) || (y < h - 1 && ink[i + w])) continue
        paper++
        if (!bw[i]) paperBlack++
      }
    }
    expect(lineBlack / line).toBeGreaterThan(0.95)
    expect(headBlack / head).toBeGreaterThan(0.98)
    expect(paperBlack / paper).toBeLessThan(0.002)

    // A single global threshold can't do this: the shadowed paper is darker than lit staff lines.
    let globalPaperBlack = 0
    for (let i = 0; i < g.length; i++) if (!ink[i] && g[i] < 140) globalPaperBlack++
    expect(globalPaperBlack / paper).toBeGreaterThan(0.1)
  })

  it('threshold slider trades faint lines for cleanliness', () => {
    const { g, w, h } = syntheticScore()
    const count = (b: Uint8Array) => b.reduce((n, v) => n + (v ? 0 : 1), 0)
    expect(count(cleanBW(g, w, h, 90))).toBeGreaterThan(count(cleanBW(g, w, h, 10)))
  })

  it('flattens paper to ~1 and keeps ink relative', () => {
    const { g, ink, w, h } = syntheticScore()
    const n = flatten(g, w, h)
    let sum = 0
    let cnt = 0
    for (let i = 0; i < n.length; i += 7)
      if (!ink[i]) {
        sum += n[i]
        cnt++
      }
    expect(sum / cnt).toBeGreaterThan(0.93)
    const grey = cleanGrey(g, w, h, 0, 0)
    // Paper turns (nearly) white everywhere, including inside the shadow.
    let shade = 0
    for (let y = 150; y < 159; y++) for (let x = 470; x < 479; x++) shade += grey[y * w + x]
    expect(shade / 81).toBeGreaterThan(240)
  })
})

describe('bit helpers', () => {
  it('despeckle removes isolated dots but keeps lines', () => {
    const w = 10
    const h = 5
    const b = new Uint8Array(w * h).fill(255)
    b[1 * w + 2] = 0 // lonely dot
    for (let x = 4; x < 9; x++) b[3 * w + x] = 0 // 1px line
    despeckle(b, w, h)
    expect(b[1 * w + 2]).toBe(255)
    expect(b[3 * w + 6]).toBe(0)
  })

  it('packs 1 bit per pixel, MSB first, padded rows', () => {
    const bin = new Uint8Array([255, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255])
    const p = packBits(bin, 9, 2)
    expect([...p]).toEqual([0b10100000, 0b10000000, 0b01111111, 0b10000000])
  })

  it('computes luma', () => {
    const img: Rgba = { data: new Uint8ClampedArray([255, 0, 0, 255, 255, 255, 255, 255]), width: 2, height: 1 }
    const g = toGrey(img)
    expect(g[0]).toBe(76)
    expect(g[1]).toBe(255)
  })
})
