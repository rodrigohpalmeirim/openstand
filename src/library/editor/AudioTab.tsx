import { Link2, Music2, Pause, Play, Plus, Repeat, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { getBlob, putBlob, uid } from '../../db/db'
import type { AudioTrack, Song } from '../../db/schema'
import { stripExt } from '../../files/kinds'
import { Button, cx, Empty, IconButton, Input, promptDialog, Toggle, toast } from '../../ui/primitives'
import { safeExternalUrl } from '../../util/safeUrl'
import { useTerms } from '../browse/terms'
import type { SongPatch } from './FieldsTab'
import { Section } from './Sheet'

const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac,.webm,.mp4'

export function fmtTime(t: number | undefined) {
  if (t === undefined || !isFinite(t)) return '–:––'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function parseTime(s: string): number | undefined {
  const t = s.trim()
  if (!t) return undefined
  const parts = t.split(':').map(Number)
  if (parts.some((p) => isNaN(p) || p < 0)) return NaN
  return parts.reduce((a, p) => a * 60 + p, 0)
}

export function AudioTab({ song, update }: { song: Song; update: (p: SongPatch) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const setTrack = (id: string, patch: Partial<AudioTrack>) =>
    update((s) => ({ ...s, audio: s.audio.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))

  // Takes a copy: clearing the input's value empties its live FileList (Chromium) mid-loop.
  const add = async (list: File[]) => {
    if (!list.length) return
    setBusy(true)
    const tracks: AudioTrack[] = []
    for (const f of list) {
      if (!f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|mp4)$/i.test(f.name)) {
        toast(`${f.name} is not an audio file`, 'error')
        continue
      }
      const { id } = await putBlob(await f.arrayBuffer(), f.type || 'audio/mpeg')
      tracks.push({ id: uid(), name: stripExt(f.name), blobId: id })
    }
    setBusy(false)
    if (tracks.length) update((s) => ({ ...s, audio: [...s.audio, ...tracks] }))
  }

  const addUrl = async () => {
    const url = await promptDialog({ title: 'Add audio from a link', label: 'Audio URL (mp3, m4a, ogg…)', initial: 'https://' })
    if (!url || !/^https?:\/\/\S+$/i.test(url.trim())) return
    const name = decodeURIComponent(url.trim().split('/').pop()?.split('?')[0] ?? '') || 'Audio link'
    update((s) => ({ ...s, audio: [...s.audio, { id: uid(), name: stripExt(name), url: url.trim() }] }))
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <Section
        title={`Audio tracks (${song.audio.length})`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<Link2 className="size-4" />} onClick={addUrl}>
              Link
            </Button>
            <Button size="sm" icon={<Plus className="size-4" />} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Adding…' : 'Add audio'}
            </Button>
          </div>
        }
      >
        <input ref={input} type="file" accept={AUDIO_ACCEPT} multiple hidden onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ''))} />
        {song.audio.length === 0 ? (
          <Empty icon={<Music2 className="size-6" />} title="No audio">
            Attach a backing track or reference recording. Set A–B loop points to practise a passage.
          </Empty>
        ) : (
          song.audio.map((t) => (
            <TrackCard key={t.id} track={t} onChange={(p) => setTrack(t.id, p)} onRemove={() => update((s) => ({ ...s, audio: s.audio.filter((a) => a.id !== t.id) }))} />
          ))
        )}
      </Section>
    </div>
  )
}

function TrackCard({ track, onChange, onRemove }: { track: AudioTrack; onChange: (p: Partial<AudioTrack>) => void; onRemove: () => void }) {
  const terms = useTerms()
  const audio = useRef<HTMLAudioElement>(null)
  const [src, setSrc] = useState<string | undefined>(() => safeExternalUrl(track.url) ?? undefined)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [dur, setDur] = useState<number>(NaN)
  const [loop, setLoop] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!track.blobId) return setSrc(safeExternalUrl(track.url) ?? undefined)
    let url: string | undefined
    let alive = true
    getBlob(track.blobId).then(
      (b) => {
        if (!alive) return
        url = URL.createObjectURL(b)
        setSrc(url)
      },
      () => setError(true),
    )
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [track.blobId, track.url])

  const a = track.loopStart
  const b = track.loopEnd
  const hasLoop = a !== undefined || b !== undefined
  const onTime = () => {
    const el = audio.current!
    if (loop && b !== undefined && el.currentTime >= b) el.currentTime = a ?? 0
    setTime(el.currentTime)
  }
  const toggle = () => {
    const el = audio.current
    if (!el) return
    if (el.paused) {
      if (loop && hasLoop && (el.currentTime < (a ?? 0) || (b !== undefined && el.currentTime >= b))) el.currentTime = a ?? 0
      el.play().catch(() => setError(true))
    } else el.pause()
  }
  const max = isFinite(dur) ? dur : Math.max(b ?? 0, 1)

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={onTime}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (loop && hasLoop && audio.current) {
            audio.current.currentTime = a ?? 0
            audio.current.play().catch(() => {})
          }
        }}
        onError={() => setError(true)}
      />
      <div className="flex items-center gap-2">
        <Input value={track.name} aria-label="Track name" onChange={(e) => onChange({ name: e.target.value })} className="flex-1 font-medium" />
        <IconButton label="Remove track" onClick={onRemove} className="size-11 text-danger">
          <Trash2 className="size-4.5" />
        </IconButton>
      </div>
      {error && <p className="text-xs text-danger">This audio can't be played in this browser{track.url ? ' (check the link)' : ''}.</p>}
      <div className="flex items-center gap-2">
        <IconButton label={playing ? 'Pause' : 'Play'} onClick={toggle} disabled={!src} className="size-11 shrink-0 rounded-full bg-accent text-accent-fg hover:bg-accent hover:brightness-110">
          {playing ? <Pause className="size-5" /> : <Play className="size-5 translate-x-px" />}
        </IconButton>
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-3">
            {hasLoop && (
              <div
                className="absolute inset-y-0 rounded-full bg-accent/35"
                style={{ left: `${((a ?? 0) / max) * 100}%`, right: `${100 - ((b ?? max) / max) * 100}%` }}
              />
            )}
          </div>
          <input
            type="range"
            aria-label="Position"
            min={0}
            max={max}
            step={0.1}
            value={Math.min(time, max)}
            onChange={(e) => {
              if (audio.current) audio.current.currentTime = Number(e.target.value)
              setTime(Number(e.target.value))
            }}
            className="relative h-11 w-full appearance-none bg-transparent accent-[var(--os-accent)]"
          />
        </div>
        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted">
          {fmtTime(time)} / {fmtTime(dur)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LoopPoint label="A" value={a} onSet={() => onChange({ loopStart: audio.current?.currentTime ?? 0 })} onChange={(v) => onChange({ loopStart: v })} />
        <LoopPoint label="B" value={b} onSet={() => onChange({ loopEnd: audio.current?.currentTime })} onChange={(v) => onChange({ loopEnd: v })} />
        <IconButton label="Loop A–B while previewing" active={loop} onClick={() => setLoop(!loop)} className="size-11">
          <Repeat className="size-4.5" />
        </IconButton>
        {hasLoop && (
          <Button variant="ghost" size="sm" icon={<X className="size-4" />} onClick={() => onChange({ loopStart: undefined, loopEnd: undefined })}>
            Clear loop
          </Button>
        )}
        {a !== undefined && b !== undefined && b <= a && <span className="text-xs text-danger">B must be after A</span>}
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <Toggle checked={!!track.autoPlay} onChange={(v) => onChange({ autoPlay: v })} label={`Play automatically when the ${terms.song} opens`} />
        Play automatically when the {terms.song} opens
      </label>
    </div>
  )
}

function LoopPoint({ label, value, onSet, onChange }: { label: string; value?: number; onSet: () => void; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState<string | null>(null)
  const parsed = text === null ? value : parseTime(text)
  const bad = parsed !== undefined && isNaN(parsed)
  return (
    <div className={cx('flex h-11 items-center overflow-hidden rounded-lg border bg-surface', bad ? 'border-danger' : 'border-line')}>
      <button type="button" onClick={onSet} className="flex h-full items-center gap-1 bg-surface-2 px-3 text-sm font-semibold hover:bg-surface-3" title={`Set ${label} to the current position`}>
        Set {label}
      </button>
      <input
        aria-label={`Loop ${label} (m:ss)`}
        inputMode="decimal"
        placeholder="–:––"
        value={text ?? (value === undefined ? '' : fmtTime(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null && !bad) onChange(parsed)
          setText(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="h-full w-20 bg-transparent px-2 text-sm tabular-nums outline-none"
      />
    </div>
  )
}
