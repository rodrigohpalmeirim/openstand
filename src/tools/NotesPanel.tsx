import { useEffect, useRef, useState } from 'react'
import { updateSong } from '../db/db'
import { useSettings } from '../state/settings'
import { Segmented, Slider, Textarea, Toggle } from '../ui/primitives'
import type { PanelProps } from '../viewer/panels'
import { useTools } from './store'
import { PanelBody, PanelButton, Row, Section } from './ui'

/** Edit the song's notes (saved as you type) and choose when they pop up over the score. */
export function NotesPanel({ song }: PanelProps) {
  const n = useSettings((st) => st.s.notes)
  const setIn = useSettings((st) => st.setIn)
  const [text, setText] = useState(song.notes)
  const [saved, setSaved] = useState(true)
  const pending = useRef<{ id: string; text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flush = () => {
    clearTimeout(timer.current)
    const p = pending.current
    pending.current = null
    if (p) void updateSong(p.id, { notes: p.text }).then(() => setSaved(true))
  }

  // Switching songs: save what was typed for the previous song, then load the new notes.
  useEffect(() => {
    setText(song.notes)
    setSaved(true)
    return flush
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id])

  const onChange = (v: string) => {
    setText(v)
    setSaved(false)
    pending.current = { id: song.id, text: v }
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 600)
  }

  return (
    <PanelBody>
      <div>
        <Textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={flush}
          placeholder="Reminders, cues, lyrics, setlist chat…"
          className="min-h-56 !bg-white/5 leading-snug"
          style={{ fontSize: n.fontSize }}
          aria-label="Song notes"
        />
        <div className="mt-1 flex items-center justify-between text-xs text-white/45">
          <span>{saved ? 'Saved' : 'Saving…'}</span>
          <PanelButton className="!min-h-8 text-xs" disabled={!text.trim()} onClick={() => useTools.setState({ notesPopup: true })}>
            Show over score
          </PanelButton>
        </div>
      </div>
      <Section title="Popup">
        <div className="divide-y divide-white/10">
          <Row label="Show when a song opens" hint="Only songs that have notes">
            <Toggle checked={n.showOnLoad} onChange={(v) => setIn('notes', { showOnLoad: v })} />
          </Row>
          <Row label="Hide after">
            <Segmented
              size="sm"
              className="!border-white/10 !bg-white/5"
              value={n.autoHideSeconds}
              onChange={(v) => setIn('notes', { autoHideSeconds: v })}
              options={[
                { value: 0, label: 'Tap' },
                { value: 5, label: '5s' },
                { value: 10, label: '10s' },
              ]}
            />
          </Row>
          <Row label="Text size">
            <Slider className="w-32" label="Text size" min={14} max={40} value={n.fontSize} onChange={(v) => setIn('notes', { fontSize: v })} />
          </Row>
        </div>
      </Section>
    </PanelBody>
  )
}
