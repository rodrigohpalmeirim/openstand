import { AlertTriangle, ChevronDown, Keyboard, Plus, Trash2, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSettings, type KeyBinding } from '../state/settings'
import { Button, cx, Dialog, IconButton, Kbd, Menu, Segmented, toast, useMenu } from '../ui/primitives'
import { ACTIONS, type ActionId } from '../viewer/actions'
import { keyId, keyLabel } from '../viewer/input'
import { applyPreset, conflictingIndexes, delayedTapKeys, findConflicts, isModifierOnly, PEDAL_PRESETS } from './keymap'
import { ActionMenu, ActionSelect, Row } from './kit'

/**
 * Capture one key press. Bare modifiers (a pedal that sends Shift) are recorded on release unless
 * another key follows, in which case the combo is recorded.
 */
function useKeyCapture(active: boolean, onKey: (id: string) => void) {
  const cb = useRef(onKey)
  cb.current = onKey
  useEffect(() => {
    if (!active) return
    let pendingMod: string | null = null
    const down = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.repeat) return
      if (isModifierOnly(e)) {
        pendingMod = e.key
        return
      }
      pendingMod = null
      cb.current(keyId(e))
    }
    const up = (e: KeyboardEvent) => {
      if (pendingMod && e.key === pendingMod) {
        e.preventDefault()
        cb.current(pendingMod)
      }
      pendingMod = null
    }
    // Escape reaches this too: the dialog doesn't close on Escape while listening (see LearnDialog).
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [active])
}

function LearnDialog({
  open,
  onClose,
  initial,
  onSave,
}: {
  open: boolean
  onClose: () => void
  /** Editing an existing binding: only the key is re-learned. */
  initial?: KeyBinding
  onSave: (b: KeyBinding) => void
}) {
  const keys = useSettings((st) => st.s.pageTurn.keys)
  const [key, setKey] = useState<string | null>(null)
  const [action, setAction] = useState<ActionId>(initial?.action ?? 'nextPage')
  const [long, setLong] = useState(!!initial?.long)
  const [listening, setListening] = useState(true)
  useKeyCapture(open && listening, (id) => {
    setKey(id)
    setListening(false)
  })
  const clash = key ? keys.filter((k) => k !== initial && k.key === key && !!k.long === long) : []

  return (
    <Dialog
      open={open}
      onClose={onClose}
      escapeCloses={!listening}
      size="sm"
      title={initial ? 'Change key' : 'Add key or pedal'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!key} onClick={() => key && onSave(long ? { key, action, long } : { key, action })}>
            {clash.length ? 'Replace' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <button
          onClick={() => setListening(true)}
          className={cx(
            'flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 text-center transition',
            listening ? 'animate-pulse border-accent bg-accent-soft text-accent' : 'border-line',
          )}
        >
          {listening ? (
            <>
              <Keyboard className="size-6" />
              <span className="text-sm font-semibold">Press a key or pedal…</span>
            </>
          ) : (
            <>
              <span className="text-2xl font-semibold">{key && keyLabel(key)}</span>
              <span className="text-xs text-muted">Click to press a different key</span>
            </>
          )}
        </button>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">When</span>
          <Segmented
            label="When"
            value={long ? 'hold' : 'tap'}
            onChange={(v) => setLong(v === 'hold')}
            options={[
              { value: 'tap', label: 'Pressed' },
              { value: 'hold', label: 'Held ½ s' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Do</span>
          <ActionSelect value={action} onChange={setAction} className="w-full" label="Action" />
        </div>
        {clash.length > 0 && (
          <p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            <AlertTriangle className="size-4 shrink-0 text-warn" />
            {keyLabel(key!)} is already set to “{ACTIONS[clash[0].action].label}”. Saving replaces it.
          </p>
        )}
      </div>
    </Dialog>
  )
}

/**
 * Action of a binding: a button opening the action list, not a <select>. A focused select would take
 * the arrow keys of a pedal being tested and silently change the binding. Its minimum width makes it
 * wrap to a line of its own on phones rather than shrink to a letter.
 */
function ActionPicker({ value, onChange, label }: { value: ActionId; onChange: (a: ActionId) => void; label: string }) {
  const { ref: setAnchor, anchor, open, toggle, close } = useMenu()
  return (
    <>
      <button
        ref={setAnchor}
        onClick={toggle}
        aria-label={`${label}: ${ACTIONS[value].label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 min-w-40 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-sm text-fg transition hover:border-accent"
      >
        <span className="min-w-0 flex-1 truncate">{ACTIONS[value].label}</span>
        <ChevronDown className="size-4 shrink-0 text-muted" />
      </button>
      <ActionMenu anchor={anchor} open={open} onClose={close} value={value} onChange={onChange} title={label} />
    </>
  )
}

/** Live "press something" readout so users can check what their pedal sends. */
function PedalTester({ paused }: { paused: boolean }) {
  const keys = useSettings((st) => st.s.pageTurn.keys)
  const [last, setLast] = useState<string | null>(null)
  useEffect(() => {
    if (paused) return
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (isModifierOnly(e) && e.key !== 'Shift') return
      setLast(isModifierOnly(e) ? e.key : keyId(e))
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [paused])
  const hits = last ? keys.filter((k) => k.key === last) : []
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
      <Zap className="size-4 text-muted" />
      {last ? (
        <>
          <Kbd>{keyLabel(last)}</Kbd>
          <span className="text-muted">→</span>
          {hits.length ? (
            hits.map((h, i) => (
              <span key={i} className="font-medium">
                {ACTIONS[h.action].label}
                {h.long && <span className="text-muted"> (held)</span>}
              </span>
            ))
          ) : (
            <span className="text-muted">not assigned</span>
          )}
        </>
      ) : (
        <span className="text-muted">Press a key or pedal to test it.</span>
      )}
    </div>
  )
}

export function KeyBindingsEditor() {
  const keys = useSettings((st) => st.s.pageTurn.keys)
  const setIn = useSettings((st) => st.setIn)
  const save = (next: KeyBinding[]) => setIn('pageTurn', { keys: next })
  const [learn, setLearn] = useState<{ index: number | null } | null>(null)
  const presets = useMenu()
  const bad = conflictingIndexes(keys)
  const conflicts = findConflicts(keys)
  const delayed = delayedTapKeys(keys)

  const upsert = (b: KeyBinding, index: number | null) => {
    // Replace any binding already on the same key + press type, then put this one in place.
    const others = keys.filter((k, i) => i !== index && !(k.key === b.key && !!k.long === !!b.long))
    if (index === null) save([...others, b])
    else {
      const at = keys.slice(0, index).filter((k) => others.includes(k)).length
      save([...others.slice(0, at), b, ...others.slice(at)])
    }
    setLearn(null)
  }
  const update = (i: number, patch: Partial<KeyBinding>) => {
    const next = keys.map((k, j) => (j === i ? { ...k, ...patch } : k))
    if (patch.long === false) delete next[i].long
    save(next)
  }

  return (
    <Row
      stacked
      label="Keys and pedals"
      hint="Bluetooth page turners act like a keyboard. Add a key by pressing it, or start from a preset."
    >
      <PedalTester paused={!!learn} />
      {conflicts.length > 0 && (
        <div role="alert" className="flex gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <div>
            {conflicts.map((c) => (
              <div key={c.key + c.long}>
                <b>{keyLabel(c.key)}</b>
                {c.long ? ' (held)' : ''} is assigned {c.indexes.length} times; only “{ACTIONS[keys[c.indexes[0]].action].label}” will run.
              </div>
            ))}
          </div>
        </div>
      )}
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {keys.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">No keys assigned.</li>}
        {keys.map((k, i) => (
          <li key={i} className={cx('flex flex-wrap items-center gap-2 px-2 py-2', bad.has(i) && 'bg-warn/10')}>
            <button
              onClick={() => setLearn({ index: i })}
              title="Change key"
              className="min-w-24 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-left font-mono text-xs font-semibold hover:border-accent"
            >
              {keyLabel(k.key)}
            </button>
            <Segmented
              size="sm"
              label={`When ${keyLabel(k.key)} runs`}
              value={k.long ? 'hold' : 'tap'}
              onChange={(v) => update(i, { long: v === 'hold' })}
              options={[
                { value: 'tap', label: 'Press', title: 'Runs when pressed' },
                { value: 'hold', label: 'Hold', title: 'Runs after holding for half a second' },
              ]}
            />
            <ActionPicker value={k.action} onChange={(a) => update(i, { action: a })} label={`Action for ${keyLabel(k.key)}`} />
            {bad.has(i) && <AlertTriangle className="size-4 text-warn" aria-label="Conflicts with an earlier binding" />}
            <IconButton size="sm" label={`Remove ${keyLabel(k.key)}`} onClick={() => save(keys.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>
      {delayed.size > 0 && (
        <p className="text-xs text-muted">
          {[...delayed].map(keyLabel).join(', ')} {delayed.size === 1 ? 'has' : 'have'} both a press and a hold action, so the press action
          runs when the key is released.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setLearn({ index: null })}>
          Add key or pedal
        </Button>
        <Button ref={presets.ref} onClick={presets.toggle}>
          Pedal presets…
        </Button>
      </div>
      <Menu
        anchor={presets.anchor}
        open={presets.open}
        onClose={presets.close}
        align="start"
        items={PEDAL_PRESETS.map((p) => ({
          label: (
            <span className="flex flex-col py-0.5">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted">{p.hint}</span>
            </span>
          ),
          onSelect: () => {
            save(applyPreset(keys, p))
            toast(`${p.name} keys added`, 'ok')
          },
        }))}
      />
      {learn && (
        <LearnDialog
          open
          onClose={() => setLearn(null)}
          initial={learn.index != null ? keys[learn.index] : undefined}
          onSave={(b) => upsert(b, learn.index)}
        />
      )}
    </Row>
  )
}
