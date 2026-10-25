import { ArrowDownLeft, ArrowUpRight, Ear, Plus, Radio, Trash2, Usb } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTerms } from '../library/browse/terms'
import { ActionSelect, Group, Row } from '../settings/kit'
import { useSettings, type MidiBinding } from '../state/settings'
import { Button, Dialog, Field, IconButton, Input, Select, Toggle, cx } from '../ui/primitives'
import type { ActionId } from '../viewer/actions'
import { describeEvent, describeKey, eventKey, isTriggerEvent, parseKey, type MidiEvent } from './codec'
import { clearMonitor, portEnabled, useMidi, type PortInfo } from './midi'
import { MidiAvailability, useMidiReady } from './MidiStatus'
import { startCapture } from './service'

function PortList({ ports, selected, onChange, kind }: { ports: PortInfo[]; selected: string[]; onChange: (v: string[]) => void; kind: 'input' | 'output' }) {
  if (!ports.length)
    return <div className="px-4 py-3 text-sm text-faint">No {kind}s found</div>
  return (
    <>
      {ports.map((p) => {
        const on = portEnabled(p, selected)
        return (
          <Row
            key={p.id}
            label={
              <span className="flex items-center gap-2">
                <span className={cx('size-2 rounded-full', p.connected ? 'bg-ok' : 'bg-faint')} title={p.connected ? 'Connected' : 'Disconnected'} />
                {p.name}
              </span>
            }
            hint={[p.manufacturer, p.connected ? null : 'disconnected'].filter(Boolean).join(' · ') || undefined}
          >
            <Toggle
              checked={on}
              label={`Use ${p.name}`}
              onChange={(v) => {
                // Empty selection means "all": materialise it before removing one.
                const all = ports.map((x) => x.name)
                const cur = selected.length ? selected : all
                const next = v ? [...new Set([...cur, p.name])] : cur.filter((n) => n !== p.name && n !== p.id)
                onChange(all.every((n) => next.includes(n)) ? [] : next)
              }}
            />
          </Row>
        )
      })}
    </>
  )
}

/** Learn dialog: wait for one trigger message, then pick the action. */
function LearnDialog({ open, initial, onClose, onSave }: { open: boolean; initial?: MidiBinding; onClose: () => void; onSave: (b: MidiBinding) => void }) {
  const [key, setKey] = useState('')
  const [action, setAction] = useState<ActionId>('nextPage')
  const [last, setLast] = useState<{ e: MidiEvent; port: string } | null>(null)
  const [anyChannel, setAnyChannel] = useState(false)
  const ready = useMidiReady()
  useEffect(() => {
    if (!open) return
    setKey(initial?.message ?? '')
    setAction((initial?.action as ActionId) ?? 'nextPage')
    setLast(null)
    // Start from the edited control's own setting, not whatever the previous dialog left.
    setAnyChannel(!!initial && !/^ch\d+:/.test(initial.message))
    return startCapture((e, port) => {
      if (!isTriggerEvent(e)) return
      const k = eventKey(e)
      if (!k) return
      setLast({ e, port })
      setKey(k)
    })
  }, [open, initial])
  const finalKey = anyChannel ? key.replace(/^ch\d+:/, '') : key
  const valid = !!parseKey(finalKey)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? 'Edit MIDI control' : 'Add MIDI control'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSave({ message: finalKey, action, device: last?.port ?? initial?.device })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 px-5 py-4">
        <MidiAvailability compact />
        <div className={cx('flex items-center gap-3 rounded-xl border px-4 py-4', last ? 'border-accent bg-accent-soft' : 'border-dashed border-line')}>
          <Radio className={cx('size-5 shrink-0', ready && !last ? 'animate-pulse text-accent' : 'text-muted')} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{last ? describeEvent(last.e) : key ? describeKey(key) : 'Press a pedal, key or button…'}</div>
            <div className="text-xs text-muted">{last ? `from ${last.port}` : 'The next message received is captured. Press again to replace it.'}</div>
          </div>
        </div>
        <Field label="Message" hint={key && !valid ? <span className="text-danger">Not a valid message key</span> : 'Captured automatically. Format: [ch1:]cc:64[:127], note:60, pc:5, start…'}>
          <Input className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="ch1:cc:64:127" />
        </Field>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Any channel
            <span className="block text-xs text-faint">Respond regardless of the MIDI channel</span>
          </span>
          <Toggle checked={anyChannel} onChange={setAnyChannel} />
        </label>
        <Field label="Action">
          <ActionSelect value={action} onChange={setAction} className="w-full" />
        </Field>
      </div>
    </Dialog>
  )
}

function Bindings() {
  const bindings = useSettings((s) => s.s.midi.bindings)
  const setIn = useSettings((s) => s.setIn)
  const [edit, setEdit] = useState<number | 'new' | null>(null)
  const save = (b: MidiBinding) => {
    const next = [...bindings]
    if (edit === 'new') next.push(b)
    else if (edit !== null) next[edit] = b
    setIn('midi', { bindings: next })
    setEdit(null)
  }
  return (
    <Group title="MIDI controls" description="Turn pages and run actions from pedals, pads and keyboards.">
      {bindings.length === 0 && <div className="px-4 py-4 text-sm text-faint">No controls yet. Add one and press the pedal or key you want to use.</div>}
      {bindings.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <button className="min-w-0 flex-1 rounded-lg py-1 text-left" onClick={() => setEdit(i)}>
            <div className="truncate text-sm font-medium">{describeKey(b.message)}</div>
            <div className="truncate font-mono text-xs text-faint">
              {b.message}
              {b.device ? ` · ${b.device}` : ''}
            </div>
          </button>
          <ActionSelect
            value={b.action}
            label="Action"
            onChange={(action) => setIn('midi', { bindings: bindings.map((x, j) => (j === i ? { ...x, action } : x)) })}
          />
          <IconButton label="Learn again" onClick={() => setEdit(i)}>
            <Ear className="size-4" />
          </IconButton>
          <IconButton label="Remove" onClick={() => setIn('midi', { bindings: bindings.filter((_, j) => j !== i) })}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      ))}
      <div className="px-4 py-3">
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>
          Add control
        </Button>
      </div>
      <LearnDialog open={edit !== null} initial={typeof edit === 'number' ? bindings[edit] : undefined} onClose={() => setEdit(null)} onSave={save} />
    </Group>
  )
}

export function MidiMonitor({ dark, limit = 30 }: { dark?: boolean; limit?: number }) {
  const log = useMidi((m) => m.log)
  const rows = log.slice(-limit).reverse()
  if (!rows.length) return <div className={cx('px-4 py-4 text-sm', dark ? 'text-white/40' : 'text-faint')}>No messages yet</div>
  return (
    <div className="max-h-64 overflow-y-auto font-mono text-xs">
      {rows.map((r) => (
        <div key={r.id} className={cx('flex items-center gap-2 px-4 py-1.5', dark ? 'border-b border-white/5' : 'border-b border-line last:border-0')}>
          {r.dir === 'in' ? <ArrowDownLeft className="size-3.5 shrink-0 text-ok" /> : <ArrowUpRight className="size-3.5 shrink-0 text-accent" />}
          <span className={cx('flex-1 truncate font-sans', dark ? 'text-white/85' : 'text-fg')}>{r.text}</span>
          <span className={cx('hidden truncate sm:inline', dark ? 'text-white/40' : 'text-faint')}>{r.hex}</span>
        </div>
      ))}
    </div>
  )
}

const channelOptions = Array.from({ length: 16 }, (_, i) => i + 1)

/** MIDI section of the settings screen. */
export function MidiSettings() {
  const m = useSettings((s) => s.s.midi)
  const setIn = useSettings((s) => s.setIn)
  const { inputs, outputs, status, sysex } = useMidi()
  const t = useTerms()
  const ready = status === 'ready'

  return (
    <div className="flex flex-col gap-6">
      <MidiAvailability />

      <Group>
        <Row label="Use MIDI" hint="Connect USB or Bluetooth MIDI devices (pair Bluetooth MIDI in your system settings first).">
          <Toggle checked={m.enabled} onChange={(enabled) => setIn('midi', { enabled })} label="Use MIDI" />
        </Row>
        <Row label={`Send ${t.song} MIDI on open`} hint={`Each ${t.song}’s commands (patch changes etc.) go out when it opens.`}>
          <Toggle checked={m.sendOnLoad} onChange={(sendOnLoad) => setIn('midi', { sendOnLoad })} label={`Send ${t.song} MIDI on open`} />
        </Row>
        <Row label={`Open ${t.songs} from MIDI`} hint={`A ${t.song} opens when its recall message arrives (set it in the ${t.song} editor’s MIDI tab).`}>
          <Toggle checked={m.recallSongs} onChange={(recallSongs) => setIn('midi', { recallSongs })} label={`Open ${t.songs} from MIDI`} />
        </Row>
        <Row label="Channel for new commands">
          <Select className="w-auto min-w-24" value={m.defaultChannel} onChange={(e) => setIn('midi', { defaultChannel: Number(e.target.value) })}>
            {channelOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Listen on channel" hint="Ignore incoming channel messages on other channels.">
          <Select className="w-auto min-w-24" value={m.receiveChannel} onChange={(e) => setIn('midi', { receiveChannel: Number(e.target.value) })}>
            <option value={0}>Any</option>
            {channelOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Delay between commands" hint="Some instruments miss messages sent back to back.">
          <Select className="w-auto min-w-24" value={m.commandGapMs} onChange={(e) => setIn('midi', { commandGapMs: Number(e.target.value) })}>
            {[0, 10, 25, 50, 100, 250, 500].map((v) => (
              <option key={v} value={v}>
                {v ? `${v} ms` : 'None'}
              </option>
            ))}
          </Select>
        </Row>
      </Group>

      {m.enabled && ready && (
        <>
          <Group title="Inputs" description="Devices OpenStand listens to.">
            <PortList kind="input" ports={inputs} selected={m.inputs} onChange={(v) => setIn('midi', { inputs: v })} />
          </Group>
          <Group title="Outputs" description={`Devices that receive ${t.song} commands.${sysex ? '' : ' SysEx was not permitted, so SysEx commands are skipped.'}`}>
            <PortList kind="output" ports={outputs} selected={m.outputs} onChange={(v) => setIn('midi', { outputs: v })} />
          </Group>
          {!inputs.length && !outputs.length && (
            <p className="-mt-3 flex items-center gap-2 px-1 text-sm text-muted">
              <Usb className="size-4" /> Plug in a device — it appears here automatically.
            </p>
          )}
        </>
      )}

      <Bindings />

      {m.enabled && ready && (
        <Group title="Monitor" description="Recent messages in and out — handy for checking a connection.">
          <MidiMonitor />
          <div className="px-4 py-2">
            <Button size="sm" variant="ghost" onClick={clearMonitor}>
              Clear
            </Button>
          </div>
        </Group>
      )}
    </div>
  )
}

