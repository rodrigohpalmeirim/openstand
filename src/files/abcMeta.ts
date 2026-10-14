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
      out.key = v.trim().split(/\s+/)[0]
      break
    }
  }
  return out
}
