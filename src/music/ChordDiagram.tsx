import type { Diagram, FretShape, KeysShape } from './diagrams'

/**
 * SVG chord diagram (fretboard grid or keyboard). Drawn in `currentColor` so it adapts to paper,
 * night mode and dark panels; `bg` is the colour used for finger numbers inside dots.
 */
export function ChordDiagram({
  diagram,
  label,
  size = 1,
  bg = 'white',
  accent,
  fingers = true,
}: {
  diagram: Diagram
  /** Text above the diagram (defaults to the diagram name). */
  label?: string
  /** Scale; 1 ≈ 4.2em wide for guitar. */
  size?: number
  bg?: string
  accent?: string
  fingers?: boolean
}) {
  const { shape } = diagram
  return (
    <figure className="m-0 inline-flex flex-col items-center" style={{ lineHeight: 1.1 }} aria-label={`Chord ${label ?? diagram.name}`}>
      <figcaption className="font-bold" style={{ fontSize: `${0.85 * size}em` }}>
        {label ?? diagram.name}
        {diagram.approx && <span style={{ opacity: 0.5 }} title="Closest chord in the dictionary">*</span>}
      </figcaption>
      {shape.kind === 'frets' ? (
        <FretSvg shape={shape} size={size} bg={bg} fingers={fingers} />
      ) : (
        <KeysSvg shape={shape} size={size} accent={accent} />
      )}
    </figure>
  )
}

const SG = 10 // string gap
const FG = 12 // fret gap

function FretSvg({ shape, size, bg, fingers }: { shape: FretShape; size: number; bg: string; fingers: boolean }) {
  const n = shape.frets.length
  const played = shape.frets.filter((f): f is number => f !== null && f > 0)
  const rows = Math.max(4, ...played)
  const left = 12
  const top = 11
  const w = left + (n - 1) * SG + 8
  const h = top + rows * FG + 4
  const x = (i: number) => left + i * SG
  const y = (fret: number) => top + (fret - 0.5) * FG
  const barres = (shape.barres ?? []).map((b) => {
    const idx = shape.frets.map((f, i) => (f === b ? i : -1)).filter((i) => i >= 0)
    return { fret: b, from: Math.min(...idx), to: Math.max(...idx) }
  }).filter((b) => b.to > b.from)
  const inBarre = (i: number, f: number) => barres.some((b) => b.fret === f && i >= b.from && i <= b.to)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={`${(w / 13) * size}em`} height={`${(h / 13) * size}em`} role="img" aria-hidden style={{ overflow: 'visible' }}>
      {/* nut or base fret */}
      {shape.baseFret <= 1 ? (
        <rect x={left - 0.6} y={top - 2.4} width={(n - 1) * SG + 1.2} height={2.6} fill="currentColor" />
      ) : (
        <text x={left - 4} y={y(1) + 2.5} fontSize={7} textAnchor="end" fill="currentColor">
          {shape.baseFret}
        </text>
      )}
      {Array.from({ length: rows + 1 }, (_, r) => (
        <line key={'f' + r} x1={left} x2={x(n - 1)} y1={top + r * FG} y2={top + r * FG} stroke="currentColor" strokeWidth={0.6} />
      ))}
      {Array.from({ length: n }, (_, i) => (
        <line key={'s' + i} x1={x(i)} x2={x(i)} y1={top} y2={top + rows * FG} stroke="currentColor" strokeWidth={0.6} />
      ))}
      {shape.frets.map((f, i) =>
        f === null ? (
          <text key={"m" + i} x={x(i)} y={top - 3.6} fontSize={8.5} fontWeight={700} textAnchor="middle" fill="currentColor">
            ×
          </text>
        ) : f === 0 ? (
          <circle key={'m' + i} cx={x(i)} cy={top - 6} r={2.3} fill="none" stroke="currentColor" strokeWidth={0.7} />
        ) : null,
      )}
      {barres.map((b) => (
        <rect key={'b' + b.fret} x={x(b.from) - 3.6} y={y(b.fret) - 3.6} width={x(b.to) - x(b.from) + 7.2} height={7.2} rx={3.6} fill="currentColor" />
      ))}
      {shape.frets.map((f, i) =>
        f && f > 0 ? (
          <g key={'d' + i}>
            {!inBarre(i, f) && <circle cx={x(i)} cy={y(f)} r={3.6} fill="currentColor" />}
            {fingers && shape.fingers?.[i] ? (
              <text x={x(i)} y={y(f) + 2.1} fontSize={5.6} textAnchor="middle" fill={bg} fontWeight={700}>
                {shape.fingers[i]}
              </text>
            ) : null}
          </g>
        ) : null,
      )}
    </svg>
  )
}

const WHITE = [0, 2, 4, 5, 7, 9, 11]

function KeysSvg({ shape, size, accent = '#c2410c' }: { shape: KeysShape; size: number; accent?: string }) {
  const lo = Math.min(...shape.keys)
  const hi = Math.max(...shape.keys)
  const startOct = Math.floor(lo / 12)
  const octaves = Math.max(2, Math.floor(hi / 12) - startOct + 1)
  const ww = 7
  const wh = 26
  const on = new Set(shape.keys.map((k) => k - startOct * 12))
  const whites: { x: number; semi: number }[] = []
  const blacks: { x: number; semi: number }[] = []
  for (let o = 0; o < octaves; o++) {
    WHITE.forEach((s, i) => {
      const xx = (o * 7 + i) * ww
      whites.push({ x: xx, semi: o * 12 + s })
      if (s !== 4 && s !== 11) blacks.push({ x: xx + ww - 2.2, semi: o * 12 + s + 1 })
    })
  }
  const w = octaves * 7 * ww
  return (
    <svg viewBox={`-0.5 -0.5 ${w + 1} ${wh + 1}`} width={`${(w / 16) * size}em`} height={`${(wh / 16) * size}em`} role="img" aria-hidden>
      {whites.map((k) => (
        <rect key={'w' + k.semi} x={k.x} y={0} width={ww} height={wh} fill={on.has(k.semi) ? accent : '#fff'} stroke="#444" strokeWidth={0.6} />
      ))}
      {blacks.map((k) => (
        <rect key={'b' + k.semi} x={k.x} y={0} width={4.4} height={wh * 0.62} fill={on.has(k.semi) ? accent : '#222'} stroke="#222" strokeWidth={0.5} />
      ))}
    </svg>
  )
}
