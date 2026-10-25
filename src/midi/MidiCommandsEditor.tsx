import { Ear, GripVertical, Pencil, Play, Plus, Radio, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MidiCommand, MidiMessageType } from '../db/schema'
import { useTerms } from '../library/browse/terms'
import { useSettings } from '../state/settings'
import { Button, Dialog, Field, IconButton, Input, Menu, Segmented, Select, Textarea, Toggle, cx, toast, useMenu } from '../ui/primitives'
import {
  COMMAND_TYPES,
  RECALLABLE,
  commandFromEvent,
  describeCommand,
  describeEvent,
  newCommand,
  noteName,
  parseSysex,
  typeLabel,
  type MidiEvent,
} from './codec'
import { sendCommands, useMidi } from './midi'
import { MidiAvailability, useMidiReady } from './MidiStatus'
import { startCapture } from './service'

/* ------------------------------------------------------------ small fields */

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 127,
  optional,
  hint,
  step = 1,
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  min?: number
  max?: number
  optional?: boolean
  hint?: React.ReactNode
  step?: number
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])
  return (
    <Field label={label} hint={hint}>
      <Input
        inputMode="decimal"
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        placeholder={optional ? 'Not sent' : undefined}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value === '') return optional ? onChange(undefined) : undefined
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
        }}
        onBlur={() => setText(value === undefined ? '' : String(value))}
      />
    </Field>
  )
}

function ChannelSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Field label="Channel">
      <Select value={value || 1} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: 16 }, (_, i) => (
          <option key={i} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/* ---------------------------------------------------------- command dialog */

const usesChannel = (t: MidiMessageType) => ['programChange', 'patchSelect', 'bankSelect', 'controlChange', 'noteOn', 'noteOff'].includes(t)

export function CommandDialog({
  open,
  initial,
  onSave,
  onClose,
  nested,
  trigger,
}: {
  open: boolean
  initial: MidiCommand | null
  onSave: (c: MidiCommand) => void
  onClose: () => void
  /** Inside a group: no groups, no per-command flags */
  nested?: boolean
  /** Used as an incoming trigger (recall): only recallable types, no send flags or timing */
  trigger?: boolean
}) {
  const [c, setC] = useState<MidiCommand | null>(initial)
  const [editChild, setEditChild] = useState<number | null>(null)
  const [childDraft, setChildDraft] = useState<MidiCommand | null>(null)
  const outputs = useMidi((m) => m.outputs)
  const terms = useTerms()
  useEffect(() => setC(initial), [initial, open])
  if (!c) return null
  const set = (patch: Partial<MidiCommand>) => setC({ ...c, ...patch })
  const sysex = c.type === 'sysex' ? parseSysex(c.sysex ?? '') : null
  const types = COMMAND_TYPES.filter((t) => (trigger ? RECALLABLE.includes(t.type) && t.type !== 'batch' : !(nested && t.type === 'batch')))
  const valid = !sysex || 'bytes' in sysex

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={trigger ? `Message that opens the ${terms.song}` : nested ? 'Command in group' : 'MIDI command'}
      size="md"
      footer={
        <>
          {!trigger && (
            <Button variant="ghost" icon={<Play className="size-4" />} onClick={() => void sendCommands([c])} disabled={!valid} className="mr-auto">
              Test
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSave(c)}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Type">
            <Select
              value={c.type}
              onChange={(e) => {
                const type = e.target.value as MidiMessageType
                setC({ ...c, type, ...(type === 'batch' && !c.children ? { children: [] } : {}), ...(type === 'pause' && !c.delayMs ? { delayMs: 500 } : {}) })
              }}
            >
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
              {c.type === 'bankSelect' && <option value="bankSelect">Bank select</option>}
            </Select>
          </Field>
          {usesChannel(c.type) && <ChannelSelect value={c.channel} onChange={(channel) => set({ channel })} />}
        </div>

        {(c.type === 'programChange' || c.type === 'songSelect') && (
          <NumberField label={c.type === 'songSelect' ? 'Song number' : 'Program'} value={c.data1 ?? 0} onChange={(v) => set({ data1: v ?? 0 })} hint="0–127. Some devices show programs as 1–128." />
        )}
        {(c.type === 'patchSelect' || c.type === 'bankSelect') && (
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Bank MSB" optional value={c.msb} onChange={(msb) => set({ msb })} />
            <NumberField
              label="Bank LSB"
              optional
              value={c.lsb ?? (c.type === 'bankSelect' ? c.data2 : undefined)}
              onChange={(lsb) => set({ lsb, data2: c.type === 'bankSelect' ? undefined : c.data2 })}
            />
            <NumberField label="Program" optional value={c.data1} onChange={(data1) => set({ data1 })} />
            <p className="col-span-3 -mt-1 text-xs text-faint">Leave a field empty to skip that part.</p>
          </div>
        )}
        {c.type === 'controlChange' && (
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Controller" value={c.data1 ?? 0} onChange={(v) => set({ data1: v ?? 0 })} hint="e.g. 7 volume, 64 sustain" />
            <NumberField label="Value" value={c.data2 ?? 0} onChange={(v) => set({ data2: v ?? 0 })} />
          </div>
        )}
        {(c.type === 'noteOn' || c.type === 'noteOff') && (
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Note" value={c.data1 ?? 60} onChange={(v) => set({ data1: v ?? 60 })} hint={noteName(c.data1 ?? 60)} />
            {c.type === 'noteOn' && !trigger && <NumberField label="Velocity" min={1} value={c.data2 ?? 100} onChange={(v) => set({ data2: v ?? 100 })} />}
          </div>
        )}
        {c.type === 'sysex' && (
          <Field
            label="SysEx bytes (hex)"
            hint={sysex && 'error' in sysex ? <span className="text-danger">{sysex.error}</span> : `${'bytes' in sysex! ? sysex.bytes.length : 0} bytes · F0/F7 are added if missing`}
          >
            <Textarea className="font-mono" rows={3} value={c.sysex ?? ''} onChange={(e) => set({ sysex: e.target.value })} placeholder="F0 43 10 7F 01 F7" />
          </Field>
        )}
        {c.type === 'pause' && (
          <NumberField
            label="Pause (seconds)"
            min={0}
            max={60}
            step={0.1}
            value={(c.delayMs ?? 0) / 1000}
            onChange={(v) => set({ delayMs: Math.round((v ?? 0) * 1000) })}
          />
        )}
        {(c.type === 'clockStart' || c.type === 'clockStop') && (
          <p className="text-sm text-muted">
            {c.type === 'clockStart'
              ? `Sends MIDI timing clock (24 pulses per beat) at the ${terms.song}’s metronome tempo until a Stop clock command or the ${terms.song} closes. Add “MIDI start” too if your device needs it.`
              : 'Stops the timing clock.'}
          </p>
        )}
        {c.type === 'batch' && (
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Commands in this group</div>
            <CommandRows
              value={c.children ?? []}
              onChange={(children) => set({ children })}
              onEdit={(i) => setEditChild(i)}
              onAdd={(d) => {
                setChildDraft(d)
                setEditChild((c.children ?? []).length)
              }}
              nested
            />
            <CommandDialog
              open={editChild !== null}
              initial={editChild !== null ? ((c.children ?? [])[editChild] ?? childDraft) : null}
              nested
              onClose={() => setEditChild(null)}
              onSave={(child) => {
                const children = [...(c.children ?? [])]
                children[editChild!] = child
                set({ children })
                setEditChild(null)
              }}
            />
          </div>
        )}

        <Field label="Label (optional)">
          <Input value={c.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })} placeholder="e.g. Piano patch" />
        </Field>

        {!nested && !trigger && (
          <div className="grid gap-3 rounded-xl border border-line p-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Send when the {terms.song} opens
                <span className="block text-xs text-faint">Off: only sent from the MIDI panel or “Send {terms.song} MIDI”</span>
              </span>
              <Toggle checked={c.sendOnLoad !== false} onChange={(v) => set({ sendOnLoad: v })} />
            </label>
            {RECALLABLE.includes(c.type) && (
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Open this {terms.song} when received
                  <span className="block text-xs text-faint">Needs “Open {terms.songs} from MIDI” in MIDI settings</span>
                </span>
                <Toggle checked={!!c.loadOnReceive} onChange={(v) => set({ loadOnReceive: v || undefined })} />
              </label>
            )}
            {outputs.length > 1 && !['pause', 'batch', 'clockStart', 'clockStop'].includes(c.type) && (
              <Field label="Send to">
                <Select value={c.output ?? ''} onChange={(e) => set({ output: e.target.value || undefined })}>
                  <option value="">All enabled outputs</option>
                  {outputs.map((o) => (
                    <option key={o.id} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ list rows */

function AddMenu({ onAdd, nested, label = 'Add' }: { onAdd: (t: MidiMessageType) => void; nested?: boolean; label?: string }) {
  const m = useMenu()
  return (
    <>
      <Button ref={m.ref} size="sm" icon={<Plus className="size-4" />} onClick={m.toggle}>
        {label}
      </Button>
      <Menu
        anchor={m.anchor}
        open={m.open}
        onClose={m.close}
        align="start"
        items={COMMAND_TYPES.filter((t) => !(nested && t.type === 'batch')).map((t) => ({ label: t.label, hint: t.hint, onSelect: () => onAdd(t.type) }))}
      />
    </>
  )
}

function CommandRows({
  value,
  onChange,
  onEdit,
  onAdd,
  nested,
}: {
  value: MidiCommand[]
  onChange: (v: MidiCommand[]) => void
  onEdit: (i: number) => void
  /** A new command to edit; it joins the list only when its dialog is saved. */
  onAdd: (c: MidiCommand) => void
  nested?: boolean
}) {
  const channel = useSettings((s) => s.s.midi.defaultChannel)
  const terms = useTerms()
  const move = (i: number, j: number) => {
    if (j < 0 || j >= value.length || i === j) return
    const next = [...value]
    const [it] = next.splice(i, 1)
    next.splice(j, 0, it)
    onChange(next)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  // Pointer drag on the grip: the row under the pointer becomes the drop position.
  const onGripDown = (i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    let cur = i
    setDrag(i)
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-cmd-row]') ?? [])]
      let to = rows.findIndex((r) => {
        const b = r.getBoundingClientRect()
        return ev.clientY < b.top + b.height / 2
      })
      if (to < 0) to = rows.length - 1
      if (to !== cur) {
        moveRef.current(cur, to)
        cur = to
        setDrag(to)
      }
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      setDrag(null)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }
  const moveRef = useRef(move)
  useEffect(() => {
    moveRef.current = move
  })
  return (
    <div className="grid gap-1.5" ref={listRef}>
      {value.length === 0 && <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-sm text-faint">No commands yet</div>}
      {value.map((c, i) => (
        <div key={i} data-cmd-row className={cx('group flex items-center gap-1 rounded-xl border bg-surface py-1 pl-0.5 pr-2', drag === i ? 'border-accent shadow-md' : 'border-line')}>
          <button
            type="button"
            aria-label={`Reorder ${c.label || describeCommand(c)} (drag, or Alt+Up/Down)`}
            title="Drag to reorder"
            className="flex h-11 w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-faint hover:bg-surface-2 hover:text-fg active:cursor-grabbing"
            onPointerDown={onGripDown(i)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
              e.preventDefault()
              move(i, i + (e.key === 'ArrowUp' ? -1 : 1))
            }}
          >
            <GripVertical className="size-4" />
          </button>
          <button className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => onEdit(i)}>
            <div className="truncate text-sm font-medium">{c.label || describeCommand(c)}</div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {c.label ? <span className="truncate">{describeCommand(c)}</span> : <span>{typeLabel(c.type)}</span>}
              {!nested && c.sendOnLoad === false && <span className="rounded bg-surface-2 px-1.5 text-faint">manual</span>}
              {!nested && c.loadOnReceive && <span className="rounded bg-accent-soft px-1.5 text-accent">opens {terms.song}</span>}
              {c.output && <span className="rounded bg-surface-2 px-1.5">→ {c.output}</span>}
            </div>
          </button>
          {c.type !== 'pause' && (
            <IconButton label="Send now" onClick={() => void sendCommands([c])}>
              <Play className="size-4" />
            </IconButton>
          )}
          <IconButton label="Delete" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <AddMenu
          nested={nested}
          onAdd={(t) => onAdd(newCommand(t, channel))}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- listen */

interface Captured {
  id: number
  event: MidiEvent
  port: string
  cmd: MidiCommand
}

/** Live list of incoming messages; selected rows become commands. */
export function ListenDialog({
  open,
  onClose,
  onAdd,
  single,
  title = 'Listen for MIDI',
}: {
  open: boolean
  onClose: () => void
  onAdd: (cmds: MidiCommand[], use: 'load' | 'recall') => void
  /** Pick exactly one message (recall trigger) */
  single?: boolean
  title?: string
}) {
  const [rows, setRows] = useState<Captured[]>([])
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [use, setUse] = useState<'load' | 'recall'>('recall')
  const ready = useMidiReady()
  const terms = useTerms()
  useEffect(() => {
    if (!open) return
    setRows([])
    setSel(new Set())
    let n = 0
    return startCapture((event, port) => {
      const cmd = commandFromEvent(event)
      if (!cmd) return
      const id = ++n
      setRows((r) => [...r.slice(-99), { id, event, port, cmd }])
      if (single) setSel(new Set([id]))
    })
  }, [open, single])

  const chosen = rows.filter((r) => sel.has(r.id)).map((r) => r.cmd)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          {!single && (
            <Segmented
              size="sm"
              className="mr-auto"
              value={use}
              onChange={setUse}
              options={[
                { value: 'recall', label: `Opens ${terms.song}`, title: `Receiving this message opens the ${terms.song}` },
                { value: 'load', label: 'Sent on open', title: `Send this message when the ${terms.song} opens` },
              ]}
            />
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!chosen.length} onClick={() => onAdd(chosen, use)}>
            {single ? 'Use message' : `Add ${chosen.length || ''}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 px-5 py-4">
        <MidiAvailability compact />
        {ready && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Radio className="size-4 animate-pulse text-accent" />
            {single ? 'Send the message from your device; the last one received is selected.' : 'Play or press something on your device, then pick the messages to add.'}
          </p>
        )}
        <div className="max-h-72 min-h-32 overflow-y-auto rounded-xl border border-line">
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-faint">Nothing received yet</div>
          ) : (
            rows
              .slice()
              .reverse()
              .map((r) => (
                <label key={r.id} className={cx('flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0', sel.has(r.id) && 'bg-accent-soft')}>
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    className="size-4 accent-[var(--os-accent)]"
                    checked={sel.has(r.id)}
                    onChange={(e) => {
                      const next = single ? new Set<number>() : new Set(sel)
                      if (e.target.checked) next.add(r.id)
                      else next.delete(r.id)
                      setSel(next)
                    }}
                  />
                  <span className="flex-1">{describeEvent(r.event)}</span>
                  <span className="max-w-32 truncate text-xs text-faint">{r.port}</span>
                </label>
              ))
          )}
        </div>
        {rows.length > 0 && (
          <Button size="sm" variant="ghost" className="justify-self-start" icon={<X className="size-4" />} onClick={() => (setRows([]), setSel(new Set()))}>
            Clear
          </Button>
        )}
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------- editor */

/** Editor for a song's MIDI commands (used in the song editor's MIDI tab). */
export function MidiCommandsEditor({
  value,
  onChange,
  recall,
  onRecallChange,
}: {
  value: MidiCommand[]
  onChange: (v: MidiCommand[]) => void
  recall?: MidiCommand
  onRecallChange?: (v: MidiCommand | undefined) => void
}) {
  const [edit, setEdit] = useState<number | null>(null)
  /** A command being added: it only joins the list when its dialog is saved. */
  const [draft, setDraft] = useState<MidiCommand | null>(null)
  const [editRecall, setEditRecall] = useState(false)
  const [listen, setListen] = useState<null | 'commands' | 'recall'>(null)
  const midi = useSettings((s) => s.s.midi)
  const channel = midi.defaultChannel
  const terms = useTerms()
  const editing = useMemo(() => (edit !== null ? (value[edit] ?? draft) : null), [edit, value, draft])
  // "Set" edits a suggested trigger; nothing is stored until Save.
  const recallInitial = useMemo<MidiCommand>(() => recall ?? { type: 'programChange', channel, data1: 0 }, [recall, channel])

  return (
    <div className="grid gap-6 p-1">
      <MidiAvailability compact />

      <section className="grid gap-2">
        <div className="flex items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Commands</h3>
            <p className="text-xs text-muted">Sent in order when the {terms.song} opens{midi.sendOnLoad ? '' : ' (sending on open is turned off in MIDI settings)'}.</p>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" icon={<Ear className="size-4" />} onClick={() => setListen('commands')}>
              Listen
            </Button>
            <Button size="sm" variant="ghost" icon={<Play className="size-4" />} disabled={!value.length} onClick={() => void sendCommands(value)}>
              Test all
            </Button>
          </div>
        </div>
        <CommandRows
          value={value}
          onChange={onChange}
          onEdit={setEdit}
          onAdd={(d) => {
            setDraft(d)
            setEdit(value.length)
          }}
        />
      </section>

      {onRecallChange && (
        <section className="grid gap-2">
          <div>
            <h3 className="text-sm font-semibold">Open this {terms.song} from MIDI</h3>
            <p className="text-xs text-muted">
              When this message arrives, OpenStand opens the {terms.song}
              {midi.recallSongs ? '.' : ` — turn on “Open ${terms.songs} from MIDI” in MIDI settings for this to work.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
            <span className={cx('flex-1 text-sm', !recall && 'text-faint')}>{recall ? describeCommand(recall) : 'Not set'}</span>
            <Button size="sm" variant="ghost" icon={<Ear className="size-4" />} onClick={() => setListen('recall')}>
              Listen
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={recall ? <Pencil className="size-4" /> : <Plus className="size-4" />}
              onClick={() => setEditRecall(true)}
            >
              {recall ? 'Edit' : 'Set'}
            </Button>
            {recall && (
              <IconButton label="Clear" size="sm" onClick={() => onRecallChange(undefined)}>
                <X className="size-4" />
              </IconButton>
            )}
          </div>
        </section>
      )}

      <CommandDialog
        open={edit !== null}
        initial={editing}
        onClose={() => setEdit(null)}
        onSave={(c) => {
          const next = [...value]
          next[edit!] = c
          onChange(next)
          setEdit(null)
        }}
      />
      <CommandDialog
        open={editRecall}
        trigger
        initial={editRecall ? recallInitial : null}
        onClose={() => setEditRecall(false)}
        onSave={(c) => {
          onRecallChange?.(c)
          setEditRecall(false)
        }}
      />
      <ListenDialog
        open={listen !== null}
        single={listen === 'recall'}
        title={listen === 'recall' ? `Listen for the message that opens this ${terms.song}` : 'Listen for MIDI'}
        onClose={() => setListen(null)}
        onAdd={(cmds, use) => {
          if (listen === 'recall') onRecallChange?.(cmds[0])
          else {
            const flagged = cmds.map((c) => (use === 'recall' ? { ...c, sendOnLoad: false, loadOnReceive: true } : { ...c }))
            onChange([...value, ...flagged])
            toast(`Added ${cmds.length} command${cmds.length === 1 ? '' : 's'}`, 'ok')
          }
          setListen(null)
        }}
      />
    </div>
  )
}
