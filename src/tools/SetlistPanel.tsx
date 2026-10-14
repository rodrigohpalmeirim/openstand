import { useLiveQuery } from 'dexie-react-hooks'
import { GripVertical, ListPlus, MoreVertical, Plus, Search, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { db } from '../db/db'
import type { Song } from '../db/schema'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { cx, Input, Menu, toast, useMenu } from '../ui/primitives'
import type { PanelProps } from '../viewer/panels'
import { queueRows, removeFromQueue, reorderQueue } from './navigation'
import { PanelBody } from './ui'

const ROW_H = 56

/** The performance queue: jump, reorder for this session, add requests, see what's next. */
export function SetlistPanel(_props: PanelProps) {
  const queue = useViewer((v) => v.queue)
  const index = useViewer((v) => v.index)
  const setlistId = useViewer((v) => v.setlistId)
  const locked = useSettings((st) => st.s.display.performanceLock)
  const setlist = useLiveQuery(() => (setlistId ? db.setlists.get(setlistId) : undefined), [setlistId])
  const songs = useLiveQuery(async () => {
    const list = await db.songs.bulkGet(queue)
    return new Map(list.filter((s): s is Song => !!s).map((s) => [s.id, s]))
  }, [queue])
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null)
  const [adding, setAdding] = useState(false)

  const rows = queueRows(queue, setlist?.entries)
  const next = songs?.get(queue[index + 1] ?? '')
  const guard = () => {
    if (locked) toast('Performance lock is on')
    return !locked
  }
  const apply = (r: { queue: string[]; index: number }) => useViewer.setState({ queue: r.queue, index: r.index })

  const startDrag = (e: React.PointerEvent, qi: number) => {
    if (!guard()) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0
      setDrag({ from: qi, to: Math.max(0, Math.min(queue.length - 1, qi + Math.round(dy / ROW_H))), dy })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      const to = Math.max(0, Math.min(queue.length - 1, qi + Math.round((ev.clientY - y0) / ROW_H)))
      setDrag(null)
      if (to !== qi) apply(reorderQueue(useViewer.getState().queue, useViewer.getState().index, qi, to))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <PanelBody className="space-y-3 !px-2">
      <div className="mx-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{setlist ? setlist.name : 'Playing'}</div>
        <div className="truncate text-base font-semibold">{songs?.get(queue[index])?.title ?? '…'}</div>
        <div className="mt-1 truncate text-sm text-white/60">
          {next ? (
            <>
              Next up: <span className="text-white/90">{next.title}</span>
              {next.keys[0] && <span className="text-white/45"> · {next.keys[0]}</span>}
            </>
          ) : (
            'Last song'
          )}
        </div>
      </div>

      <ol className="select-none">
        {rows.map((r) => {
          if (r.kind === 'break')
            return (
              <li key={r.key} className="mx-2 my-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                <span className="h-px flex-1 bg-white/10" />
                {r.label}
                <span className="h-px flex-1 bg-white/10" />
              </li>
            )
          const s = songs?.get(r.songId)
          const dragging = drag?.from === r.qi
          const target = drag && !dragging && drag.to === r.qi
          return (
            <QueueRow
              key={`${r.qi}:${r.songId}`}
              qi={r.qi}
              song={s}
              note={r.note}
              current={r.qi === index}
              played={r.qi < index}
              style={dragging ? { transform: `translateY(${drag.dy}px)`, zIndex: 10, position: 'relative' } : undefined}
              highlight={!!target}
              onGo={() => r.qi !== index && useViewer.getState().goSong(r.qi)}
              onGrip={(e) => startDrag(e, r.qi)}
              onPlayNext={() => guard() && apply(reorderQueue(queue, index, r.qi, r.qi < index ? index : index + 1))}
              onRemove={() => {
                if (!guard()) return
                if (r.qi === index) return toast("Can't remove the song that's playing")
                apply(removeFromQueue(queue, index, r.qi))
              }}
            />
          )
        })}
      </ol>

      {adding ? (
        <AddSong
          onClose={() => setAdding(false)}
          onAdd={(id, where) => {
            if (!guard()) return
            const v = useViewer.getState()
            const at = where === 'next' ? v.index + 1 : v.queue.length
            useViewer.setState({ queue: [...v.queue.slice(0, at), id, ...v.queue.slice(at)] })
            toast(where === 'next' ? 'Plays next' : 'Added to the end', 'ok')
          }}
        />
      ) : (
        <button className="mx-2 flex min-h-11 w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 text-sm text-white/70 hover:bg-white/5" onClick={() => guard() && setAdding(true)}>
          <Plus className="size-4" /> Add a song for this performance
        </button>
      )}
      <p className="mx-2 text-xs text-white/40">Changes here only affect this performance{setlist ? ', not the saved setlist' : ''}.</p>
    </PanelBody>
  )
}

function QueueRow({
  qi,
  song,
  note,
  current,
  played,
  style,
  highlight,
  onGo,
  onGrip,
  onPlayNext,
  onRemove,
}: {
  qi: number
  song: Song | undefined
  note?: string
  current: boolean
  played: boolean
  style?: React.CSSProperties
  highlight: boolean
  onGo: () => void
  onGrip: (e: React.PointerEvent) => void
  onPlayNext: () => void
  onRemove: () => void
}) {
  const menu = useMenu()
  return (
    <li
      style={{ height: ROW_H, ...style }}
      className={cx('flex items-center rounded-xl', current && 'bg-[var(--os-accent)]/15', highlight && 'ring-1 ring-[var(--os-accent)]', style && 'bg-neutral-800 shadow-xl')}
    >
      <button aria-label="Drag to reorder" className="flex h-full w-9 shrink-0 cursor-grab touch-none items-center justify-center text-white/30 hover:text-white/70" onPointerDown={onGrip}>
        <GripVertical className="size-4" />
      </button>
      <button className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-xl pr-2 text-left hover:bg-white/5" onClick={onGo} aria-current={current ? 'true' : undefined}>
        <span className={cx('w-6 shrink-0 text-right text-xs tabular-nums', current ? 'font-bold text-[var(--os-accent)]' : 'text-white/40')}>{qi + 1}</span>
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[15px]', played && !current && 'text-white/50')}>{song?.title ?? '…'}</span>
          <span className="block truncate text-xs text-white/45">{[song?.artists[0], song?.keys[0], note].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      <button ref={menu.ref} onClick={menu.toggle} aria-label="Song options" className="flex size-11 shrink-0 items-center justify-center rounded-xl text-white/50 hover:bg-white/10">
        <MoreVertical className="size-4" />
      </button>
      <Menu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        items={[
          { label: 'Play next', icon: <ListPlus className="size-4" />, onSelect: onPlayNext, disabled: current },
          { label: 'Remove from this performance', icon: <Trash2 className="size-4" />, danger: true, onSelect: onRemove, disabled: current },
        ]}
      />
    </li>
  )
}

function AddSong({ onAdd, onClose }: { onAdd: (id: string, where: 'next' | 'end') => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useLiveQuery(async () => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    return db.songs
      .filter((s) => s.title.toLowerCase().includes(t) || s.artists.some((a) => a.toLowerCase().includes(t)) || String(s.songNumber ?? '') === t)
      .limit(12)
      .toArray()
  }, [q])
  return (
    <div className="mx-2 rounded-2xl border border-white/10 bg-white/[0.03] p-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40" />
        <Input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a song…" className="!bg-white/5 pl-9 pr-10" aria-label="Find a song" />
        <button className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-white/50 hover:bg-white/10" aria-label="Close search" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <ul className="mt-1">
        {results?.map((s) => (
          <li key={s.id} className="flex items-center gap-1">
            <div className="min-w-0 flex-1 px-2 py-1.5">
              <div className="truncate text-sm">{s.title}</div>
              <div className="truncate text-xs text-white/45">{[s.artists[0], s.keys[0]].filter(Boolean).join(' · ')}</div>
            </div>
            <button className="min-h-10 rounded-lg px-2.5 text-xs font-medium text-[var(--os-accent)] hover:bg-white/10" onClick={() => onAdd(s.id, 'next')}>
              Play next
            </button>
            <button className="min-h-10 rounded-lg px-2.5 text-xs text-white/70 hover:bg-white/10" onClick={() => onAdd(s.id, 'end')}>
              At end
            </button>
          </li>
        ))}
        {q.trim() && results?.length === 0 && <li className="px-2 py-3 text-sm text-white/45">No songs found</li>}
      </ul>
    </div>
  )
}
