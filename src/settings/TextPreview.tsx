import { useMemo } from 'react'
import { parseChordPro } from '../chordpro/parse'
import { songBlocks, textContainerStyle } from '../chordpro/render'
import { useSettings } from '../state/settings'

const SAMPLE = `{title: Morning Has Broken}
{artist: Traditional}
{key: C}
{capo: 0}

{start_of_verse: Verse 1}
[C]Morning has [Dm]broken, [G]like the first [F]morning
[C]Blackbird has [Am]spoken, [D7]like the first [G]bird
{end_of_verse}

{start_of_chorus}
[C]Praise for the [F]singing, [C]praise for the [Am]morning
[D7]Praise for them [G7]springing [F]fresh from the [C]world
{end_of_chorus}

{comment: Repeat chorus twice}
`

/** Live ChordPro preview of the current text style (always on paper, like the viewer). */
export function TextPreview() {
  const style = useSettings((st) => st.s.text)
  const song = useMemo(() => parseChordPro(SAMPLE), [])
  const blocks = useMemo(() => songBlocks(song, { style, transpose: 0 }), [song, style])
  return (
    <div className="px-4 py-3.5">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Preview</div>
      <div
        className="max-h-80 overflow-auto rounded-lg border border-line bg-white px-5 py-4 shadow-sm"
        style={textContainerStyle(style, 0.8)}
        aria-label="Text style preview"
      >
        {blocks.map((b) => (
          <div key={b.key}>{b.node}</div>
        ))}
      </div>
    </div>
  )
}
