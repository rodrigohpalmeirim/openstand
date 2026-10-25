import { Minus, Play, Plus, Send, Square } from 'lucide-react'
import { useState } from 'react'
import { useTerms } from '../library/browse/terms'
import { useSettings } from '../state/settings'
import type { PanelProps } from '../viewer/panels'
import { describeCommand } from './codec'
import { clearMonitor, sendCommands, stopClock, useMidi } from './midi'
import { MidiMonitor } from './MidiSettings'
import { songBpm } from '../tools/metronome/tempo'
import { MidiAvailability } from './MidiStatus'

const sectionTitle = 'mb-2 text-xs font-semibold uppercase tracking-wider text-white/50'
const darkBtn = 'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:opacity-40'

/** Song MIDI panel in the performance view: resend, quick program change, monitor. */
export function MidiPanel({ song }: PanelProps) {
  const enabled = useSettings((s) => s.s.midi.enabled)
  const defaultChannel = useSettings((s) => s.s.midi.defaultChannel)
  const status = useMidi((m) => m.status)
  const outputs = useMidi((m) => m.outputs)
  const clock = useMidi((m) => m.clockRunning)
  const terms = useTerms()
  const [channel, setChannel] = useState(defaultChannel)
  const [program, setProgram] = useState(0)
  const ready = enabled && status === 'ready'
  const bpm = songBpm(song) ?? useSettings.getState().s.metronome.bpm
  const sendPc = (p: number) => {
    const v = Math.max(0, Math.min(127, p))
    setProgram(v)
    void sendCommands([{ type: 'programChange', channel, data1: v }])
  }

  return (
    <div className="space-y-6 p-4 text-white">
      {!ready && <MidiAvailability dark />}
      {ready && !outputs.some((o) => o.connected) && <p className="rounded-lg bg-white/5 px-3 py-2 text-sm text-white/70">No MIDI output connected.</p>}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className={sectionTitle + ' mb-0'}>This {terms.song}</h3>
          {clock && (
            <button className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs" onClick={stopClock}>
              <span className="size-1.5 animate-pulse rounded-full bg-[var(--os-accent)]" /> Clock {bpm} BPM <Square className="size-3" />
            </button>
          )}
        </div>
        {song.midiOnLoad.length === 0 ? (
          <p className="text-sm text-white/50">No MIDI commands. Add them in the {terms.song} editor’s MIDI tab.</p>
        ) : (
          <>
            <ul className="mb-3 divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
              {song.midiOnLoad.map((c, i) => (
                <li key={i} className="flex items-center gap-2 pl-3">
                  <span className="min-w-0 flex-1 py-2">
                    <span className="block truncate text-sm">{c.label || describeCommand(c)}</span>
                    {c.label && <span className="block truncate text-xs text-white/50">{describeCommand(c)}</span>}
                  </span>
                  {c.type !== 'pause' && (
                    <button aria-label="Send" title="Send" disabled={!ready} className={darkBtn + ' w-11 hover:bg-white/10'} onClick={() => void sendCommands([c], { bpm })}>
                      <Play className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              disabled={!ready}
              className={darkBtn + ' w-full bg-[var(--os-accent)] text-[var(--os-accent-fg)] hover:brightness-110'}
              onClick={() => void sendCommands(song.midiOnLoad, { bpm })}
            >
              <Send className="size-4" /> Send all again
            </button>
          </>
        )}
      </section>

      <section>
        <h3 className={sectionTitle}>Quick program change</h3>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="midi-qpc-ch">
            Channel
          </label>
          <select
            id="midi-qpc-ch"
            value={channel}
            onChange={(e) => setChannel(Number(e.target.value))}
            className="h-10 rounded-lg border border-white/10 bg-white/5 px-2 text-sm text-white"
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i + 1} className="bg-neutral-900">
                Ch {i + 1}
              </option>
            ))}
          </select>
          <button aria-label="Previous program" disabled={!ready} className={darkBtn + ' w-10 bg-white/5 hover:bg-white/10'} onClick={() => sendPc(program - 1)}>
            <Minus className="size-4" />
          </button>
          <input
            type="number"
            aria-label="Program"
            min={0}
            max={127}
            value={program}
            onChange={(e) => setProgram(Math.max(0, Math.min(127, Number(e.target.value) || 0)))}
            onKeyDown={(e) => e.key === 'Enter' && sendPc(program)}
            className="h-10 w-16 rounded-lg border border-white/10 bg-white/5 text-center text-sm tabular-nums text-white"
          />
          <button aria-label="Next program" disabled={!ready} className={darkBtn + ' w-10 bg-white/5 hover:bg-white/10'} onClick={() => sendPc(program + 1)}>
            <Plus className="size-4" />
          </button>
          <button disabled={!ready} className={darkBtn + ' flex-1 bg-white/10 hover:bg-white/15'} onClick={() => sendPc(program)}>
            Send
          </button>
        </div>
      </section>

      {ready && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className={sectionTitle + ' mb-0'}>Monitor</h3>
            <button className="text-xs text-white/50 hover:text-white" onClick={clearMonitor}>
              Clear
            </button>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/10">
            <MidiMonitor dark limit={20} />
          </div>
        </section>
      )}
    </div>
  )
}
