import { AudioLines, FilePlus2, MoreVertical, Pause, Play, Repeat, RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import { useRef } from 'react'
import { putBlob, uid, updateSong } from '../db/db'
import type { AudioTrack } from '../db/schema'
import { useTerms } from '../library/browse/terms'
import { useSettings } from '../state/settings'
import { confirmDialog, cx, Menu, promptDialog, Slider, toast, Toggle, useMenu } from '../ui/primitives'
import type { PanelProps } from '../viewer/panels'
import { SeekBar } from './audio/MiniPlayer'
import { fmtTime, player, useAudio } from './audio/player'
import { useTools } from './store'
import { PanelBody, PanelButton, Row, Section } from './ui'

const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm'

export function AudioPanel({ song }: PanelProps) {
  const a = useAudio()
  const visible = useTools((t) => t.playerVisible)
  const prefs = useSettings((st) => st.s.audio)
  const setIn = useSettings((st) => st.setIn)
  const fileRef = useRef<HTMLInputElement>(null)
  const terms = useTerms()
  const current = song.audio.find((t) => t.id === a.trackId)
  const saveTracks = (audio: AudioTrack[]) => updateSong(song.id, { audio })

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const added: AudioTrack[] = []
    for (const f of Array.from(files)) {
      const { id } = await putBlob(await f.arrayBuffer(), f.type || 'audio/mpeg')
      added.push({ id: uid(), name: f.name.replace(/\.[^.]+$/, ''), blobId: id })
    }
    await saveTracks([...song.audio, ...added])
    toast(`${added.length} track${added.length > 1 ? 's' : ''} added`, 'ok')
  }

  return (
    <PanelBody>
      {/* Transport */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
        <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate font-medium">{current?.name ?? (a.trackId ? a.trackName || `Track from previous ${terms.song}` : song.audio.length ? 'Choose a track' : 'No tracks')}</span>
          <span className="shrink-0 text-xs tabular-nums text-white/55">
            {fmtTime(a.time)} / {fmtTime(a.duration)}
          </span>
        </div>
        <SeekBar />
        <div className="mt-2 flex items-center justify-center gap-2">
          <button className="flex size-11 items-center justify-center rounded-xl hover:bg-white/10 disabled:opacity-30" aria-label={`Back ${prefs.skipSeconds} seconds`} disabled={!a.trackId} onClick={() => player.skip(-prefs.skipSeconds)}>
            <RotateCcw className="size-5" />
          </button>
          <button
            className="flex size-14 items-center justify-center rounded-full bg-[var(--os-accent)] text-[var(--os-accent-fg)] hover:brightness-110 disabled:opacity-30"
            aria-label={a.playing ? 'Pause' : 'Play'}
            disabled={!song.audio.length && !a.trackId}
            onClick={() => void player.toggle(song)}
          >
            {a.playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 translate-x-px fill-current" />}
          </button>
          <button className="flex size-11 items-center justify-center rounded-xl hover:bg-white/10 disabled:opacity-30" aria-label={`Forward ${prefs.skipSeconds} seconds`} disabled={!a.trackId} onClick={() => player.skip(prefs.skipSeconds)}>
            <RotateCw className="size-5" />
          </button>
        </div>
        {a.trackId && (
          <div className="mt-3 divide-y divide-white/10">
            <Row label="A-B loop" hint={a.loopEnd !== undefined ? `${fmtTime(a.loopStart!)} – ${fmtTime(a.loopEnd)}` : a.settingLoop ? `A at ${fmtTime(a.loopStart!)} · now set B` : 'Repeat a passage'}>
              <PanelButton active={a.settingLoop || a.loopEnd !== undefined} onClick={() => player.abLoop()}>
                <Repeat className="size-4" />
                {a.loopEnd !== undefined ? 'Clear' : a.settingLoop ? 'Set B' : 'Set A'}
              </PanelButton>
            </Row>
            <Row label="Speed" hint="Pitch is kept">
              <Slider className="w-28" label="Speed" min={0.5} max={1.5} step={0.05} value={a.speed} onChange={(v) => player.setSpeed(v)} />
              <button className="w-12 text-right text-sm tabular-nums text-white/80" onClick={() => player.setSpeed(1)} title="Reset to 100%">
                {Math.round(a.speed * 100)}%
              </button>
            </Row>
            <Row label="Volume">
              <Slider className="w-28" label="Volume" min={0} max={1} step={0.05} value={a.volume} onChange={(v) => player.setVolume(v)} />
              <span className="w-12 text-right text-sm tabular-nums text-white/80">{Math.round(a.volume * 100)}%</span>
            </Row>
          </div>
        )}
      </section>

      <Section
        title="Tracks"
        action={
          <button className="flex items-center gap-1 text-xs text-[var(--os-accent)]" onClick={() => fileRef.current?.click()}>
            <FilePlus2 className="size-3.5" /> Add audio
          </button>
        }
      >
        <input ref={fileRef} type="file" accept={AUDIO_ACCEPT} multiple hidden onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))} />
        {song.audio.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-white/50">
            <AudioLines className="size-8 text-white/25" />
            Add a backing track or reference recording to play along with this {terms.song}.
          </div>
        ) : (
          <ul className="-mx-1">
            {song.audio.map((t) => (
              <TrackRow
                key={t.id}
                t={t}
                active={t.id === a.trackId}
                playing={t.id === a.trackId && a.playing}
                onPlay={() => (t.id === a.trackId ? void player.toggle(song) : void player.load(song, t, { play: true }))}
                onChange={(patch) => saveTracks(song.audio.map((x) => (x.id === t.id ? { ...x, ...patch } : x)))}
                onDelete={async () => {
                  if (!(await confirmDialog({ title: `Remove "${t.name}"?`, danger: true, confirmLabel: 'Remove' }))) return
                  if (t.id === a.trackId) player.stop()
                  await saveTracks(song.audio.filter((x) => x.id !== t.id))
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Player">
        <div className="divide-y divide-white/10">
          <Row label="Mini player on screen">
            <Toggle checked={visible} onChange={(v) => useTools.setState({ playerVisible: v })} />
          </Row>
          <Row label={`Show player when a ${terms.song} with audio opens`}>
            <Toggle checked={prefs.showPlayerOnLoad} onChange={(v) => setIn('audio', { showPlayerOnLoad: v })} />
          </Row>
          <Row label={`Keep playing on next ${terms.song}`}>
            <Toggle checked={prefs.keepPlayingAcrossSongs} onChange={(v) => setIn('audio', { keepPlayingAcrossSongs: v })} />
          </Row>
        </div>
      </Section>
    </PanelBody>
  )
}

function TrackRow({ t, active, playing, onPlay, onChange, onDelete }: { t: AudioTrack; active: boolean; playing: boolean; onPlay: () => void; onChange: (p: Partial<AudioTrack>) => void; onDelete: () => void }) {
  const menu = useMenu()
  const terms = useTerms()
  return (
    <li className={cx('flex items-center gap-1 rounded-xl', active && 'bg-[var(--os-accent)]/15')}>
      <button className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left hover:bg-white/5" onClick={onPlay} aria-label={`${playing ? 'Pause' : 'Play'} ${t.name}`}>
        <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full', active ? 'bg-[var(--os-accent)] text-[var(--os-accent-fg)]' : 'bg-white/10')}>
          {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-px fill-current" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{t.name}</span>
          <span className="block text-xs text-white/45">
            {[t.autoPlay && 'Auto-play', t.loopEnd !== undefined && `Loop ${fmtTime(t.loopStart ?? 0)}–${fmtTime(t.loopEnd)}`, t.speed && t.speed !== 1 && `${Math.round(t.speed * 100)}%`].filter(Boolean).join(' · ') || (t.url ? 'Link' : 'File')}
          </span>
        </span>
      </button>
      <button ref={menu.ref} onClick={menu.toggle} aria-label={`Options for ${t.name}`} className="flex size-11 items-center justify-center rounded-xl text-white/60 hover:bg-white/10">
        <MoreVertical className="size-4" />
      </button>
      <Menu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        items={[
          { label: `Play when ${terms.song} opens`, checked: !!t.autoPlay, onSelect: () => onChange({ autoPlay: !t.autoPlay }) },
          {
            label: 'Rename',
            onSelect: async () => {
              const name = await promptDialog({ title: 'Rename track', initial: t.name })
              if (name?.trim()) onChange({ name: name.trim() })
            },
          },
          { divider: true, label: '' },
          { label: 'Remove', danger: true, icon: <Trash2 className="size-4" />, onSelect: onDelete },
        ]}
      />
    </li>
  )
}

