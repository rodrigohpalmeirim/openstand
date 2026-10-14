import { Minus, Pause, PencilLine, Play, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { playAbc, splitPageHint, tuneTitles, type AbcPlayer } from '../abc/engine'
import { chordContext, songDiagrams } from '../chordpro/render'
import { metaFirst } from '../chordpro/parse'
import { updateSong } from '../db/db'
import type { TextDisplayOverrides } from '../db/schema'
import { ChordDiagram } from '../music/ChordDiagram'
import { formatKey, makeTransposer, NAMINGS, type NoteNaming } from '../music/chords'
import { loadInstrument, type Instrument } from '../music/diagrams'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { openTextEditor } from '../textedit/TextEditor'
import { Segmented, Slider, toast, Toggle } from '../ui/primitives'
import type { PanelProps } from '../viewer/panels'

const seg = '!bg-white/5 !border-white/10 [&>button[aria-checked=false]]:!text-white/65'

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm text-white/85">{label}</div>
        {hint && <div className="text-xs text-white/45">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Stepper({ value, onDec, onInc, label, disabledDec, disabledInc }: { value: ReactNode; onDec: () => void; onInc: () => void; label: string; disabledDec?: boolean; disabledInc?: boolean }) {
  const btn = 'flex size-11 items-center justify-center rounded-lg border border-white/10 text-white/85 hover:bg-white/10 disabled:opacity-30'
  return (
    <div className="flex items-center gap-1">
      <button type="button" className={btn} aria-label={`${label} down`} onClick={onDec} disabled={disabledDec}>
        <Minus className="size-4" />
      </button>
      <div className="min-w-20 text-center text-sm font-semibold tabular-nums text-white">{value}</div>
      <button type="button" className={btn} aria-label={`${label} up`} onClick={onInc} disabled={disabledInc}>
        <Plus className="size-4" />
      </button>
    </div>
  )
}

const H = ({ children }: { children: ReactNode }) => <h3 className="mb-1 mt-1 text-xs font-semibold uppercase tracking-wider text-white/50">{children}</h3>

/** Text panel shown in the performance view: transpose, capo, chords, diagrams, editing. */
export function TextPanel({ song, pages, currentPage }: PanelProps) {
  const s = useSettings((st) => st.s)
  const setIn = useSettings((st) => st.setIn)
  const sessionMap = useViewer((v) => v.transpose)
  const textZoom = useViewer((v) => v.textZoom)
  const setV = useViewer((v) => v.set)
  const session = sessionMap[song.id] ?? 0
  const saved = song.text?.transpose ?? 0

  const textFile = song.files.find((f) => f.kind === 'chordpro' || f.kind === 'text')
  const abcFile = song.files.find((f) => f.kind === 'abc')
  const dp = pages[currentPage]?.type === 'text' ? pages[currentPage] : pages.find((p) => p.type === 'text')
  const textPage = dp?.type === 'text' ? dp : undefined
  const abcPage = pages.find((p) => p.type === 'abc')
  const abcSource = abcPage?.type === 'abc' ? splitPageHint(abcPage.source).body : undefined

  const chords = useMemo(() => (textPage ? chordContext(textPage.cp, textPage.opts) : undefined), [textPage])
  const setText = (patch: Partial<TextDisplayOverrides>) => {
    const next: TextDisplayOverrides = { ...song.text, ...patch }
    for (const k of Object.keys(next) as (keyof TextDisplayOverrides)[]) if (next[k] === undefined) delete next[k]
    return updateSong(song.id, { text: next })
  }
  const setSession = (n: number) => setV({ transpose: { ...useViewer.getState().transpose, [song.id]: n } })
  const total = session + saved

  // Key display: text songs use the parsed song; ABC uses its K: field.
  const abcKey = abcSource ? /^K:\s*([A-G][#b]?(?:m(?!ix|aj)|min)?)/m.exec(abcSource)?.[1] : undefined
  const keyLine = (() => {
    if (chords) {
      if (!chords.originalKey) return total ? `${total > 0 ? '+' : ''}${total}` : 'Original'
      return chords.soundKey ?? chords.originalKey
    }
    if (abcKey) {
      const k = makeTransposer({ key: abcKey, semitones: total }).key
      return k ? formatKey(k) : abcKey
    }
    return total ? `${total > 0 ? '+' : ''}${total}` : 'Original'
  })()
  const origKey = chords?.originalKey ?? abcKey

  const capo = song.text?.capo ?? 0
  const fileCapo = textPage ? Number(metaFirst(textPage.cp, 'capo')) || 0 : 0
  const diagramsMode = s.text.diagrams

  return (
    <div className="space-y-5 p-4 text-white">
      <section>
        <H>Key</H>
        <Row label="Transpose" hint={origKey ? `Original key ${origKey}${total ? ` · ${total > 0 ? '+' : ''}${total}` : ''}` : undefined}>
          <Stepper label="Transpose" value={keyLine} onDec={() => setSession(session - 1)} onInc={() => setSession(session + 1)} />
        </Row>
        {(session !== 0 || saved !== 0) && (
          <div className="flex flex-wrap justify-end gap-2 pb-1">
            {session !== 0 && (
              <button
                type="button"
                className="h-9 rounded-lg bg-[var(--os-accent)] px-3 text-xs font-semibold text-[var(--os-accent-fg)]"
                onClick={async () => {
                  await setText({ transpose: ((((total % 12) + 18) % 12) - 6) || undefined })
                  setSession(0)
                  toast('Transposition saved to the song', 'ok')
                }}
              >
                Save to song
              </button>
            )}
            <button
              type="button"
              className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs text-white/80 hover:bg-white/10"
              onClick={async () => {
                setSession(0)
                if (saved) await setText({ transpose: undefined })
              }}
            >
              <RotateCcw className="size-3.5" /> Original key
            </button>
          </div>
        )}
        {textPage && (
          <Row
            label="Capo"
            hint={capo ? `Chords shown as ${chords?.shapeKey ? `${chords.shapeKey} ` : ''}shapes` : fileCapo ? `File suggests capo ${fileCapo}` : 'Show chord shapes for a capo'}
          >
            <Stepper
              label="Capo"
              value={capo ? `Capo ${capo}` : 'Off'}
              disabledDec={!capo}
              disabledInc={capo >= 11}
              onDec={() => setText({ capo: capo - 1 || undefined })}
              onInc={() => setText({ capo: capo + 1 })}
            />
          </Row>
        )}
        {textPage && !capo && fileCapo > 0 && (
          <div className="flex justify-end">
            <button type="button" className="h-9 rounded-lg border border-white/10 px-3 text-xs text-white/80 hover:bg-white/10" onClick={() => setText({ capo: fileCapo })}>
              Use capo {fileCapo}
            </button>
          </div>
        )}
      </section>

      {abcSource && <AbcPlayback source={abcSource} transpose={total} />}

      <section className="divide-y divide-white/10">
        <H>Text</H>
        <Row label="Text size" hint={`${Math.round(textZoom * 100)}%`}>
          <div className="flex items-center gap-2">
            <Slider className="w-32" label="Text size" min={0.5} max={2.5} step={0.05} value={textZoom} onChange={(v) => setV({ textZoom: v })} />
            <button type="button" className="flex size-9 items-center justify-center rounded-lg text-white/60 hover:bg-white/10" aria-label="Reset text size" onClick={() => setV({ textZoom: 1 })}>
              <RotateCcw className="size-3.5" />
            </button>
          </div>
        </Row>
        {textPage && (
          <>
            <Row label="Show chords">
              <Toggle checked={song.text?.showChords ?? s.text.showChords} onChange={(v) => setText({ showChords: v })} label="Show chords" />
            </Row>
            <Row label="Lyrics only" hint="Hide chords, tabs and grids">
              <Toggle checked={s.text.lyricsOnly} onChange={(v) => setIn('text', { lyricsOnly: v })} label="Lyrics only" />
            </Row>
            <Row label="Columns">
              <Segmented
                size="sm"
                className={seg}
                value={song.text?.columns ?? 0}
                onChange={(v) => setText({ columns: v || undefined })}
                options={[
                  { value: 0, label: 'Auto' },
                  { value: 1, label: '1' },
                  { value: 2, label: '2' },
                  { value: 3, label: '3' },
                ]}
              />
            </Row>
          </>
        )}
      </section>

      {textPage && (
        <section className="divide-y divide-white/10">
          <H>Chord names</H>
          <Row label="Notation">
            <select
              aria-label="Chord notation"
              className="h-10 rounded-lg border border-white/10 bg-white/5 px-2 text-sm text-white"
              value={s.text.naming}
              onChange={(e) => setIn('text', { naming: e.target.value as NoteNaming })}
            >
              {NAMINGS.map((n) => (
                <option key={n.value} value={n.value} className="bg-neutral-900">
                  {n.label} ({n.hint})
                </option>
              ))}
            </select>
          </Row>
          <Row label="Accidentals">
            <Segmented
              size="sm"
              className={seg}
              value={song.text?.accidental ?? 'auto'}
              onChange={(v) => setText({ accidental: v === 'auto' ? undefined : v })}
              options={[
                { value: 'auto', label: 'Auto', title: 'Follow the key' },
                { value: 'sharp', label: '♯' },
                { value: 'flat', label: '♭' },
              ]}
            />
          </Row>
        </section>
      )}

      {textPage && (
        <section className="divide-y divide-white/10">
          <H>Chord diagrams</H>
          <Row label="Show">
            <Segmented
              size="sm"
              className={seg}
              value={diagramsMode}
              onChange={(v) => setIn('text', { diagrams: v })}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'panel', label: 'Here' },
                { value: 'bottom', label: 'In song' },
              ]}
            />
          </Row>
          <Row label="Instrument">
            <Segmented
              size="sm"
              className={seg}
              value={s.text.instrument}
              onChange={(v: Instrument) => setIn('text', { instrument: v })}
              options={[
                { value: 'guitar', label: 'Guitar' },
                { value: 'ukulele', label: 'Ukulele' },
                { value: 'piano', label: 'Piano' },
              ]}
            />
          </Row>
          <Row label="Tap a chord for its diagram">
            <Toggle checked={s.text.diagramTap} onChange={(v) => setIn('text', { diagramTap: v })} label="Tap a chord for its diagram" />
          </Row>
          {diagramsMode === 'panel' && chords && <DiagramList textPage={textPage} chords={chords} />}
        </section>
      )}

      {(textFile || abcFile) && (
        <button
          type="button"
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/15 text-sm font-medium text-white/90 hover:bg-white/10"
          onClick={() => {
            setV({ panel: null })
            openTextEditor(song.id, (textFile ?? abcFile)!.id)
          }}
        >
          <PencilLine className="size-4" /> Edit file
        </button>
      )}
    </div>
  )
}

function DiagramList({ textPage, chords }: { textPage: Extract<PanelProps['pages'][number], { type: 'text' }>; chords: ReturnType<typeof chordContext> }) {
  const [, force] = useState(0)
  useEffect(() => {
    loadInstrument(chords.instrument).then(() => force((n) => n + 1))
  }, [chords.instrument])
  const items = songDiagrams(textPage.cp, chords)
  if (!items.length) return <div className="py-3 text-sm text-white/50">No chords in this song.</div>
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-3 py-3 text-white" style={{ fontSize: 15 }}>
      {items.map((it) =>
        it.diagram ? (
          <ChordDiagram key={it.label} diagram={it.diagram} label={it.label} bg="#17181a" size={1.1} />
        ) : (
          <div key={it.label} className="flex flex-col items-center text-xs text-white/40">
            <b className="text-sm text-white/80">{it.label}</b>
            no diagram
          </div>
        ),
      )}
    </div>
  )
}

function AbcPlayback({ source, transpose }: { source: string; transpose: number }) {
  const titles = useMemo(() => tuneTitles(source), [source])
  const [tune, setTune] = useState(0)
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const player = useRef<AbcPlayer | null>(null)
  useEffect(() => () => player.current?.stop(), [])
  const toggle = async () => {
    if (player.current) {
      player.current.stop()
      player.current = null
      setState('idle')
      return
    }
    setState('loading')
    try {
      player.current = await playAbc(source, {
        tune,
        transpose,
        onEnd: () => {
          player.current = null
          setState('idle')
        },
      })
      setState('playing')
    } catch (e) {
      player.current = null
      setState('idle')
      toast(`Playback failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }
  return (
    <section>
      <H>Playback</H>
      {titles.length > 1 && (
        <select
          aria-label="Tune"
          className="mb-2 h-10 w-full rounded-lg border border-white/10 bg-white/5 px-2 text-sm text-white"
          value={tune}
          onChange={(e) => setTune(Number(e.target.value))}
        >
          {titles.map((t, i) => (
            <option key={i} value={i} className="bg-neutral-900">
              {t}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={state === 'loading'}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--os-accent)] text-sm font-semibold text-[var(--os-accent-fg)] disabled:opacity-60"
      >
        {state === 'playing' ? <Pause className="size-4" /> : <Play className="size-4" />}
        {state === 'playing' ? 'Stop' : state === 'loading' ? 'Loading sounds…' : 'Play'}
      </button>
      <p className="mt-1.5 text-xs text-white/40">Instrument sounds are downloaded on first use.</p>
    </section>
  )
}
