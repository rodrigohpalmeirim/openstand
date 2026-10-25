import { parseKey } from '../music/chords'

/** ABC key field ("G", "F#m", "Bbmaj", "Ador", "E minor") in library form, or undefined if it is not a key. */
export function abcKey(field: string): string | undefined {
  const m = /^([A-G][#b]?)(?:\s*(maj|ion|min|aeo|mix|dor|phr|lyd|loc|m)[a-z]*)?(?=\s|$)/i.exec(field.trim())
  if (!m || !parseKey(m[1])) return undefined
  const mode = m[2]?.toLowerCase()
  if (!mode || mode === 'maj' || mode === 'ion') return m[1]
  if (mode === 'm' || mode === 'min' || mode === 'aeo') return m[1] + 'm'
  return m[1] + mode
}

/** Read the header fields of the first tune in an ABC notation file. */
export function parseAbcHeader(src: string): { title?: string; composer?: string; key?: string; meter?: string; tempo?: string } {
  const out: { title?: string; composer?: string; key?: string; meter?: string; tempo?: string } = {}
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Za-z]):\s*(.*)$/.exec(line)
    if (!m) continue
    const [, f, v] = m
    if (f === 'T' && !out.title) out.title = v.trim()
    else if (f === 'C' && !out.composer) out.composer = v.trim()
    else if (f === 'M' && !out.meter) out.meter = v.trim()
    else if (f === 'Q' && !out.tempo) out.tempo = v.trim()
    else if (f === 'K') {
      // K: is the last header field.
      out.key = abcKey(v)
      break
    }
  }
  return out
}
