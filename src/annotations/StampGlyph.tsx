import { getStamp, STAMP_FONTS } from './stamps'

/** Small preview of a stamp in `currentColor`. */
export function StampGlyph({ id, className }: { id: string; className?: string }) {
  const s = getStamp(id)
  if (s.kind === 'path') {
    const pad = 6
    return (
      <svg viewBox={`${-pad} ${-pad} ${s.w + 2 * pad} ${s.h + 2 * pad}`} className={className} aria-hidden>
        {s.fill?.map((d, i) => <path key={'f' + i} d={d} fill="currentColor" />)}
        {s.stroke?.map((st, i) => (
          <path key={'s' + i} d={st.d} fill="none" stroke="currentColor" strokeWidth={st.w} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
    )
  }
  const f = STAMP_FONTS[s.font]
  return (
    <span
      className={className}
      style={{ fontFamily: f.family, fontWeight: f.bold ? 700 : 400, fontStyle: f.italic ? 'italic' : 'normal', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap' }}
      aria-hidden
    >
      {s.text}
    </span>
  )
}
