import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowDown, ArrowUp, Link2, MapPin, MoreVertical, MousePointerClick, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { db, uid, updateSong } from '../db/db'
import type { LinkPoint, SmartButton, SmartButtonKind, Song } from '../db/schema'
import { useTerms, type Terms } from '../library/browse/terms'
import { MidiCommandsEditor } from '../midi/MidiCommandsEditor'
import { useSettings } from '../state/settings'
import { confirmDialog, cx, Field, Input, Menu, promptDialog, Segmented, Select, Toggle, useMenu } from '../ui/primitives'
import { ACTION_IDS, ACTIONS, type ActionId } from '../viewer/actions'
import type { PanelProps } from '../viewer/panels'
import { describeButton, followLink, runSmartButton } from './commands'
import { describeLink, linkColor, moveItem } from './navigation'
import { beginPick, useTools } from './store'
import { PanelBody, PanelButton, Row, Section, Stepper } from './ui'
import { parseClock } from './util'
import { fmtTime } from './audio/player'

/** Link points (repeats, D.S./D.C., codas) and smart buttons for the current song. */
export function LinksPanel(props: PanelProps) {
  const tab = useTools((t) => t.linksTab)
  return (
    <div>
      <div className="px-4 pt-4">
        <Segmented
          className="w-full !border-white/10 !bg-white/5"
          value={tab}
          onChange={(v) => useTools.setState({ linksTab: v })}
          options={[
            { value: 'links', label: `Links${props.song.links.length ? ` (${props.song.links.length})` : ''}` },
            { value: 'buttons', label: `Buttons${props.song.smartButtons?.length ? ` (${props.song.smartButtons.length})` : ''}` },
          ]}
        />
      </div>
      {tab === 'links' ? <LinksTab {...props} /> : <ButtonsTab {...props} />}
    </div>
  )
}

/* ------------------------------------------------------------------ links */

function LinksTab({ song, goToPage }: PanelProps) {
  const pointer = useTools((t) => t.linkPointer)
  const lp = useSettings((st) => st.s.linkPoints)
  const setIn = useSettings((st) => st.setIn)
  const save = (links: LinkPoint[]) => updateSong(song.id, { links })

  return (
    <PanelBody>
      <PanelButton primary className="min-h-12 w-full" onClick={() => beginPick({ kind: 'linkFrom' })}>
        <Plus className="size-4" /> Add link point
      </PanelButton>

      {song.links.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-white/50">
          <Link2 className="size-8 text-white/25" />
          <p>Link points jump from one spot to another — repeats, D.S. al Coda, codas. Tap a marker on the page to jump; "Return from link" takes you back.</p>
        </div>
      ) : (
        <Section
          title="In order"
          action={
            <button className="flex items-center gap-1 text-xs text-[var(--os-accent)]" onClick={() => useTools.setState({ linkPointer: 0 })}>
              <RotateCcw className="size-3" /> Reset
            </button>
          }
        >
          <p className="mb-2 text-xs text-white/45">
            The "Next link point or next page" pedal action follows these in order; the outlined one is next.
          </p>
          <ul className="-mx-1">
            {song.links.map((l, i) => (
              <LinkRow
                key={l.id}
                l={l}
                i={i}
                count={song.links.length}
                next={i === pointer}
                onGo={() => goToPage(l.from.pageIndex)}
                onFollow={() => followLink(song, i)}
                onChange={(patch) => save(song.links.map((x) => (x.id === l.id ? { ...x, ...patch } : x)))}
                onMove={(d) => save(moveItem(song.links, i, i + d))}
                onMakeNext={() => useTools.setState({ linkPointer: i })}
                onDelete={async () => {
                  if (await confirmDialog({ title: `Delete link ${i + 1}?`, danger: true, confirmLabel: 'Delete' })) await save(song.links.filter((x) => x.id !== l.id))
                }}
              />
            ))}
          </ul>
        </Section>
      )}

      <Section title="Markers">
        <div className="divide-y divide-white/10">
          <Row label="Size">
            <Stepper label="marker size" min={18} max={64} step={2} value={lp.markerSize} onChange={(v) => setIn('linkPoints', { markerSize: v })} format={(v) => `${v}px`} />
          </Row>
          <Row label="Show destinations">
            <Toggle checked={lp.showDestinations} onChange={(v) => setIn('linkPoints', { showDestinations: v })} />
          </Row>
        </div>
      </Section>
    </PanelBody>
  )
}

function LinkRow({
  l,
  i,
  count,
  next,
  onGo,
  onFollow,
  onChange,
  onMove,
  onMakeNext,
  onDelete,
}: {
  l: LinkPoint
  i: number
  count: number
  next: boolean
  onGo: () => void
  onFollow: () => void
  onChange: (p: Partial<LinkPoint>) => void
  onMove: (d: 1 | -1) => void
  onMakeNext: () => void
  onDelete: () => void
}) {
  const menu = useMenu()
  return (
    <li className="flex items-center rounded-xl">
      <button className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left hover:bg-white/5" onClick={onGo} title="Show the start of this link">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white"
          style={{ background: linkColor(i), outline: next ? `2px solid ${linkColor(i)}` : undefined, outlineOffset: 2 }}
        >
          {i + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{l.label || describeLink(l)}</span>
          {l.label && <span className="block text-xs text-white/45">{describeLink(l)}</span>}
        </span>
      </button>
      <button ref={menu.ref} onClick={menu.toggle} aria-label={`Options for link ${i + 1}`} className="flex size-11 items-center justify-center rounded-xl text-white/60 hover:bg-white/10">
        <MoreVertical className="size-4" />
      </button>
      <Menu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        items={[
          { label: 'Jump now', icon: <Play className="size-4" />, onSelect: onFollow },
          { label: 'Make this the next link', onSelect: onMakeNext },
          {
            label: 'Label…',
            icon: <Pencil className="size-4" />,
            onSelect: async () => {
              const v = await promptDialog({ title: 'Link label', label: 'Shown next to the marker (e.g. D.S., To Coda)', initial: l.label ?? '' })
              if (v !== null) onChange({ label: v.trim() || undefined })
            },
          },
          { label: 'Move start…', icon: <MapPin className="size-4" />, onSelect: () => beginPick({ kind: 'linkMove', linkId: l.id, end: 'from' }) },
          { label: 'Move destination…', icon: <MapPin className="size-4" />, onSelect: () => beginPick({ kind: 'linkMove', linkId: l.id, end: 'to' }) },
          { label: 'Earlier in order', icon: <ArrowUp className="size-4" />, disabled: i === 0, onSelect: () => onMove(-1) },
          { label: 'Later in order', icon: <ArrowDown className="size-4" />, disabled: i === count - 1, onSelect: () => onMove(1) },
          { divider: true, label: '' },
          { label: 'Delete', danger: true, icon: <Trash2 className="size-4" />, onSelect: onDelete },
        ]}
      />
    </li>
  )
}

/* ---------------------------------------------------------------- buttons */

const kinds = (t: Terms): { value: SmartButtonKind; label: string }[] => [
  { value: 'action', label: 'Run an action' },
  { value: 'page', label: 'Go to page' },
  { value: 'song', label: `Open ${t.song}` },
  { value: 'audio', label: 'Play audio track' },
  { value: 'midi', label: 'Send MIDI' },
  { value: 'url', label: 'Open web link' },
]

/** Actions that make sense on a button (not "do nothing"). Grouped like the key-binding editor. */
const BUTTON_ACTIONS = ACTION_IDS.filter((a) => a !== 'none')
const GROUPS = [...new Set(BUTTON_ACTIONS.map((a) => ACTIONS[a].group))]

function ButtonsTab({ song, currentPage, goToPage }: PanelProps) {
  const [draft, setDraft] = useState<SmartButton | null>(null)
  const terms = useTerms()
  const list = song.smartButtons ?? []
  const save = (smartButtons: SmartButton[]) => updateSong(song.id, { smartButtons })

  if (draft) return <ButtonEditor song={song} draft={draft} onClose={() => setDraft(null)} isNew={!list.some((b) => b.id === draft.id)} />

  return (
    <PanelBody>
      <PanelButton
        primary
        className="min-h-12 w-full"
        onClick={() => setDraft({ id: uid(), label: '', pageIndex: currentPage, x: 0.5, y: 0.5, kind: 'action', action: 'toggleMetronome', size: 'md' })}
      >
        <Plus className="size-4" /> Add smart button
      </PanelButton>
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-white/50">
          <MousePointerClick className="size-8 text-white/25" />
          <p>Place buttons on the score that start a backing track, send MIDI to your rig, jump to a page or {terms.song}, or run any action.</p>
        </div>
      ) : (
        <ul className="-mx-1">
          {list.map((b, i) => (
            <ButtonRow
              key={b.id}
              b={b}
              song={song}
              onGo={() => goToPage(b.pageIndex)}
              onEdit={() => setDraft(b)}
              onMove={(d) => save(moveItem(list, i, i + d))}
              first={i === 0}
              last={i === list.length - 1}
              onDelete={async () => {
                if (await confirmDialog({ title: `Delete "${b.label || 'button'}"?`, danger: true, confirmLabel: 'Delete' })) await save(list.filter((x) => x.id !== b.id))
              }}
            />
          ))}
        </ul>
      )}
      {list.length > 1 && <p className="text-xs text-white/45">Pedal actions "Activate next/previous smart button" step through them in this order.</p>}
    </PanelBody>
  )
}

function ButtonRow({ b, song, onGo, onEdit, onMove, onDelete, first, last }: { b: SmartButton; song: Song; onGo: () => void; onEdit: () => void; onMove: (d: 1 | -1) => void; onDelete: () => void; first: boolean; last: boolean }) {
  const menu = useMenu()
  return (
    <li className="flex items-center rounded-xl">
      <button className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 text-left hover:bg-white/5" onClick={onGo}>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-white/50">p.{b.pageIndex + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{b.label || 'Button'}</span>
          <span className="block truncate text-xs text-white/45">{describeButton(b, song)}</span>
        </span>
      </button>
      <button ref={menu.ref} onClick={menu.toggle} aria-label={`Options for ${b.label || 'button'}`} className="flex size-11 items-center justify-center rounded-xl text-white/60 hover:bg-white/10">
        <MoreVertical className="size-4" />
      </button>
      <Menu
        anchor={menu.anchor}
        open={menu.open}
        onClose={menu.close}
        items={[
          { label: 'Test', icon: <Play className="size-4" />, onSelect: () => void runSmartButton(song, b) },
          { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: onEdit },
          { label: 'Move on page…', icon: <MapPin className="size-4" />, onSelect: () => beginPick({ kind: 'button', draft: b }) },
          { label: 'Earlier in order', icon: <ArrowUp className="size-4" />, disabled: first, onSelect: () => onMove(-1) },
          { label: 'Later in order', icon: <ArrowDown className="size-4" />, disabled: last, onSelect: () => onMove(1) },
          { divider: true, label: '' },
          { label: 'Delete', danger: true, icon: <Trash2 className="size-4" />, onSelect: onDelete },
        ]}
      />
    </li>
  )
}

function ButtonEditor({ song, draft: initial, isNew, onClose }: { song: Song; draft: SmartButton; isNew: boolean; onClose: () => void }) {
  const [b, setB] = useState<SmartButton>(initial)
  const set = (p: Partial<SmartButton>) => setB((x) => ({ ...x, ...p }))
  const [songQuery, setSongQuery] = useState('')
  const terms = useTerms()
  const target = useLiveQuery(() => (b.songId ? db.songs.get(b.songId) : undefined), [b.songId])
  const found = useLiveQuery(async () => {
    const t = songQuery.trim().toLowerCase()
    if (!t) return []
    return db.songs.filter((s) => s.title.toLowerCase().includes(t)).limit(8).toArray()
  }, [songQuery])
  const label = b.label.trim() || describeButton(b, song)
  const valid =
    (b.kind === 'action' && !!b.action) ||
    b.kind === 'page' ||
    (b.kind === 'song' && !!b.songId) ||
    (b.kind === 'audio' && song.audio.length > 0) ||
    (b.kind === 'midi' && !!b.midi?.length) ||
    (b.kind === 'url' && !!b.url?.trim())

  const saveExisting = async () => {
    const list = song.smartButtons ?? []
    await updateSong(song.id, { smartButtons: list.map((x) => (x.id === b.id ? { ...b, label } : x)) })
    onClose()
  }

  return (
    <PanelBody>
      <h3 className="text-sm font-semibold">{isNew ? 'New smart button' : 'Edit smart button'}</h3>
      <Field label="Label">
        <Input value={b.label} onChange={(e) => set({ label: e.target.value })} placeholder={describeButton(b, song)} maxLength={40} />
      </Field>
      <Field label="When tapped">
        <Select value={b.kind} onChange={(e) => set({ kind: e.target.value as SmartButtonKind })}>
          {kinds(terms).map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      {b.kind === 'action' && (
        <Field label="Action">
          <Select value={b.action ?? ''} onChange={(e) => set({ action: e.target.value as ActionId })}>
            {GROUPS.map((g) => (
              <optgroup key={g} label={g}>
                {BUTTON_ACTIONS.filter((a) => ACTIONS[a].group === g).map((a) => (
                  <option key={a} value={a}>
                    {ACTIONS[a].label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      )}
      {(b.kind === 'page' || b.kind === 'song') && (
        <Field label="Page">
          <Input type="number" min={1} value={(b.page ?? 0) + 1} onChange={(e) => set({ page: Math.max(0, (Number(e.target.value) || 1) - 1) })} />
        </Field>
      )}
      {b.kind === 'song' && (
        <Field label={terms.Song} hint={target ? `Selected: ${target.title}` : 'Search the library'}>
          <Input value={songQuery} onChange={(e) => setSongQuery(e.target.value)} placeholder={target?.title ?? `Find a ${terms.song}…`} />
          {!!found?.length && (
            <ul className="mt-1 rounded-lg border border-white/10">
              {found.map((s) => (
                <li key={s.id}>
                  <button className={cx('w-full truncate px-3 py-2 text-left text-sm hover:bg-white/5', s.id === b.songId && 'text-[var(--os-accent)]')} onClick={() => (set({ songId: s.id }), setSongQuery(''))}>
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
      )}
      {b.kind === 'audio' &&
        (song.audio.length ? (
          <>
            <Field label="Track">
              <Select value={b.trackId ?? song.audio[0].id} onChange={(e) => set({ trackId: e.target.value })}>
                {song.audio.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Start at (m:ss)">
              <Input defaultValue={b.start ? fmtTime(b.start) : ''} placeholder="0:00" onBlur={(e) => set({ start: parseClock(e.target.value) })} />
            </Field>
          </>
        ) : (
          <p className="text-sm text-white/55">Add audio tracks to this {terms.song} first (Audio panel).</p>
        ))}
      {b.kind === 'midi' && <MidiCommandsEditor value={b.midi ?? []} onChange={(midi) => set({ midi })} />}
      {b.kind === 'url' && (
        <Field label="Web address">
          <Input type="url" value={b.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" />
        </Field>
      )}

      <Field label="Size">
        <Segmented
          className="w-full !border-white/10 !bg-white/5"
          value={b.size ?? 'md'}
          onChange={(size) => set({ size })}
          options={[
            { value: 'sm', label: 'Small' },
            { value: 'md', label: 'Medium' },
            { value: 'lg', label: 'Large' },
          ]}
        />
      </Field>

      <div className="flex gap-2 pt-2">
        <PanelButton className="flex-1" onClick={onClose}>
          Cancel
        </PanelButton>
        {isNew ? (
          <PanelButton primary className="flex-[2]" disabled={!valid} onClick={() => beginPick({ kind: 'button', draft: { ...b, label, trackId: b.kind === 'audio' ? b.trackId ?? song.audio[0]?.id : b.trackId } })}>
            <MapPin className="size-4" /> Place on page
          </PanelButton>
        ) : (
          <PanelButton primary className="flex-[2]" disabled={!valid} onClick={saveExisting}>
            Save
          </PanelButton>
        )}
      </div>
    </PanelBody>
  )
}
