import { useEffect, useRef } from 'react'
import { useSettings } from '../../state/settings'
import { useViewer } from '../../state/viewer'
import { useMetronome } from './engine'

/** Beat flash drawn over the stage: a pulsing frame or beat dots, plus big count-in numbers. */
export function MetronomeOverlay() {
  const m = useMetronome()
  const style = useSettings((st) => st.s.metronome.visualStyle)
  const bigBeat = useSettings((st) => st.s.metronome.bigBeat)
  const toolbar = useViewer((v) => v.toolbar || v.annotating)
  const frame = useRef<HTMLDivElement>(null)
  const big = useRef<HTMLDivElement>(null)
  const beatMs = 60000 / Math.max(20, m.bpm)

  useEffect(() => {
    if (!m.running || m.seq === 0) return
    const fade = Math.min(260, beatMs * 0.6)
    frame.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: 'ease-out' })
    big.current?.animate([{ transform: 'scale(1.08)', opacity: 1 }, { transform: 'scale(1)', opacity: 0.85 }], { duration: fade, easing: 'ease-out' })
  }, [m.seq, m.running, beatMs])

  if (!m.running) return null
  const accent = m.level === 'accent'
  const showBig = m.countingIn || bigBeat
  return (
    <div className="pointer-events-none absolute inset-0 z-[15]" aria-hidden>
      {m.visual && style === 'border' && (
        <div
          ref={frame}
          className="absolute inset-0"
          style={{ opacity: 0, boxShadow: `inset 0 0 0 ${accent ? 10 : 5}px ${accent ? 'var(--os-accent)' : 'color-mix(in srgb, var(--os-accent) 70%, transparent)'}` }}
        />
      )}
      {m.visual && style === 'dot' && (
        <div className="absolute left-1/2 flex -translate-x-1/2 gap-2 rounded-full bg-black/50 px-3 py-2 backdrop-blur" style={{ top: toolbar ? 64 : 10 }}>
          {Array.from({ length: m.beatsPerBar }, (_, i) => (
            <span
              key={i}
              className="size-3.5 rounded-full transition-colors duration-75"
              style={{ background: i === m.beat ? (i === 0 ? 'var(--os-accent)' : '#fff') : 'rgb(255 255 255 / 0.18)' }}
            />
          ))}
        </div>
      )}
      {showBig && m.beat >= 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div
            ref={big}
            className="flex size-[28vmin] flex-col items-center justify-center rounded-full bg-black/60 text-white shadow-2xl backdrop-blur"
            style={{ border: `4px solid ${accent ? 'var(--os-accent)' : 'rgb(255 255 255 / 0.3)'}` }}
          >
            <span className="text-[14vmin] font-bold leading-none tabular-nums">{m.beat + 1}</span>
            {m.countingIn && <span className="mt-1 text-[2.4vmin] font-semibold uppercase tracking-widest text-white/70">Count-in</span>}
          </div>
        </div>
      )}
    </div>
  )
}
