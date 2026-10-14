/**
 * Piano (grand) staff geometry: a treble and a bass staff joined by a brace and a system barline,
 * divided into measures, with a final double barline. Everything is laid out inside the dragged
 * rectangle so the drawn system, its bounding box and the selection box agree.
 *
 * All values are in pixel space of the page being drawn (any uniform unit works).
 */

export interface StaffBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface StaffLayout {
  /** Staff space (distance between two staff lines). */
  s: number
  /** y of the 5 treble lines, then the 5 bass lines (top to bottom). */
  treble: number[]
  bass: number[]
  /** Brace box (left of the system line). */
  brace: StaffBox
  /** x of the system (start) barline; staff lines run from here to `x1`. */
  xs: number
  x1: number
  /** Inner barlines between measures. */
  bars: number[]
  /** Final barline: thin line at `thin`, thick bar from `thick0` to `x1`. */
  thin: number
  thick0: number
  /** Left edge of the clefs, or null when the system is too short to fit them. */
  clefX: number | null
  measures: number
}

/** Vertical proportions in staff spaces: room for the treble clef above, two staves and a gap, a little below. */
const TOP = 1.6
const GAP = 4
const BOTTOM = 0.6
export const STAFF_SPACES = TOP + 4 + GAP + 4 + BOTTOM
const BRACE_W = 1.3
const BRACE_GAP = 0.35
const CLEF_ZONE = 3.8
const THICK = 0.5
const THIN_GAP = 0.55

export const clampMeasures = (n: number | undefined) => Math.max(1, Math.min(12, Math.round(n ?? 4)))

export function staffLayout(box: StaffBox, measures: number | undefined): StaffLayout {
  const x0 = Math.min(box.x0, box.x1)
  const x1 = Math.max(box.x0, box.x1)
  const y0 = Math.min(box.y0, box.y1)
  const y1 = Math.max(box.y0, box.y1)
  const n = clampMeasures(measures)
  // Staff space from the height, but never so large that the brace and final barline overrun a narrow box.
  const s = Math.max(1e-6, Math.min((y1 - y0) / STAFF_SPACES, (x1 - x0) / (BRACE_W + BRACE_GAP + THICK + THIN_GAP + 2)))
  const top = y0 + TOP * s
  const treble = [0, 1, 2, 3, 4].map((i) => top + i * s)
  const bass = treble.map((y) => y + (4 + GAP) * s)
  const xs = x0 + (BRACE_W + BRACE_GAP) * s
  const thick0 = x1 - THICK * s
  const thin = thick0 - THIN_GAP * s
  // Clefs only when every measure still gets at least two staff spaces.
  const clefs = x1 - xs >= CLEF_ZONE * s + n * 2 * s
  const start = xs + (clefs ? CLEF_ZONE * s : 0)
  const m = (x1 - start) / n
  const bars: number[] = []
  for (let k = 1; k < n; k++) bars.push(start + k * m)
  return { s, treble, bass, brace: { x0, y0: treble[0], x1: x0 + BRACE_W * s, y1: bass[4] }, xs, x1, bars, thin, thick0, clefX: clefs ? xs + 0.35 * s : null, measures: n }
}

const r = (v: number) => Math.round(v * 100) / 100

/** Stroked treble clef, in staff spaces with the origin at the clef's left edge on the G line. */
const TREBLE_STROKE: number[][] = [
  [0.66, 1.8],
  [0.62, 2.42, 1.58, 2.5, 1.52, 1.78],
  [1.46, 0.55, 1.12, -1.75, 1.28, -3.1],
  [1.38, -3.95, 1.82, -4.5, 1.98, -4.3],
  [2.18, -4.02, 1.84, -3.2, 1.12, -2.42],
  [0.42, -1.66, 0.12, -0.82, 0.28, 0.06],
  [0.46, 1.02, 1.72, 1.16, 2.22, 0.44],
  [2.56, -0.1, 2.2, -0.98, 1.5, -0.97],
  [0.92, -0.96, 0.66, -0.26, 1.06, 0.18],
]
/** Filled bass clef body, origin at its left edge on the F line. */
const BASS_FILL: number[][] = [
  [0.08, 0.02],
  [0.04, -0.86, 0.82, -1.16, 1.36, -1.12],
  [2.18, -1.08, 2.66, -0.44, 2.64, 0.32],
  [2.62, 1.44, 1.56, 2.36, 0.12, 2.98],
  [0.06, 2.82],
  [1.22, 2.14, 1.98, 1.32, 1.98, 0.3],
  [1.98, -0.46, 1.7, -0.92, 1.28, -0.92],
  [0.86, -0.92, 0.58, -0.7, 0.52, -0.36],
]

function pathOf(cmds: number[][], ox: number, oy: number, s: number, close: boolean): string {
  let d = ''
  for (const c of cmds) {
    const p = c.map((v, i) => r(i % 2 ? oy + v * s : ox + v * s))
    d += p.length === 2 ? `${d ? 'L' : 'M'}${p[0]} ${p[1]}` : `C${p.join(' ')}`
  }
  return close ? d + 'Z' : d
}

const circle = (cx: number, cy: number, rad: number) =>
  `M${r(cx - rad)} ${r(cy)}a${r(rad)} ${r(rad)} 0 1 0 ${r(2 * rad)} 0a${r(rad)} ${r(rad)} 0 1 0 ${r(-2 * rad)} 0Z`

/** Filled curly brace spanning `b` (thick in the middle of each half, pointed at the ends and centre). */
export function bracePath(b: StaffBox): string {
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const P = (u: number, v: number) => `${r(b.x0 + u * w)} ${r(b.y0 + v * h)}`
  return (
    `M${P(1, 0)}C${P(0.22, 0.05)} ${P(0.58, 0.4)} ${P(0, 0.5)}` +
    `C${P(0.58, 0.6)} ${P(0.22, 0.95)} ${P(1, 1)}` +
    `C${P(0.48, 0.93)} ${P(0.95, 0.58)} ${P(0.06, 0.5)}` +
    `C${P(0.95, 0.42)} ${P(0.48, 0.07)} ${P(1, 0)}Z`
  )
}

export interface StaffPaths {
  /** Staff lines and thin barlines (stroked with `lineW` / `barW`). */
  lines: string
  bars: string
  barW: number
  /** Filled: brace, final thick barline, bass clef and dots. */
  fill: string
  /** Stroked treble clef (`clefW`), empty when clefs don't fit. */
  clef: string
  clefW: number
}

export function staffPaths(box: StaffBox, measures: number | undefined, lineW: number): StaffPaths {
  const L = staffLayout(box, measures)
  const { s } = L
  const lines = [...L.treble, ...L.bass].map((y) => `M${r(L.xs)} ${r(y)}H${r(L.x1)}`).join('')
  const yt = L.treble[0]
  const yb = L.bass[4]
  const barW = Math.max(lineW * 1.4, s * 0.1)
  const bars = [L.xs, ...L.bars, L.thin].map((x) => `M${r(x)} ${r(yt)}V${r(yb)}`).join('')
  let fill = bracePath(L.brace) + `M${r(L.thick0)} ${r(yt)}H${r(L.x1)}V${r(yb)}H${r(L.thick0)}Z`
  let clef = ''
  if (L.clefX !== null) {
    const gLine = L.treble[3]
    const fLine = L.bass[1]
    clef = pathOf(TREBLE_STROKE, L.clefX + 0.15 * s, gLine, s, false)
    fill += circle(L.clefX + 0.15 * s + 0.86 * s, gLine + 1.86 * s, 0.32 * s)
    const bx = L.clefX + 0.1 * s
    fill += pathOf(BASS_FILL, bx, fLine, s, true)
    fill += circle(bx + 0.52 * s, fLine + 0.02 * s, 0.46 * s)
    fill += circle(bx + 3.0 * s, fLine - 0.5 * s, 0.17 * s) + circle(bx + 3.0 * s, fLine + 0.5 * s, 0.17 * s)
  }
  return { lines, bars, barW, fill, clef, clefW: s * 0.2 }
}

/** Default system height (page-width units) for a staff placed by a tap or a flat drag. */
export const DEFAULT_STAFF_SPACE = 0.0085
