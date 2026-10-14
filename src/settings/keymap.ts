import { ACTIONS, type ActionId } from '../viewer/actions'
import type { KeyBinding } from '../state/settings'

/**
 * Presets for common Bluetooth page turners. Most pedals emulate a keyboard; many can switch
 * between several key modes, so each preset binds every mode the device ships with.
 */
export interface PedalPreset {
  id: string
  name: string
  hint: string
  bindings: KeyBinding[]
}

const pair = (prev: string, next: string): KeyBinding[] => [
  { key: prev, action: 'prevPage' },
  { key: next, action: 'nextPage' },
]

export const PEDAL_PRESETS: PedalPreset[] = [
  {
    id: 'airturn',
    name: 'AirTurn',
    hint: 'BT-105, PED, DUO, QUAD in keyboard modes: arrows or Page Up/Down',
    bindings: [...pair('ArrowUp', 'ArrowDown'), ...pair('ArrowLeft', 'ArrowRight'), ...pair('PageUp', 'PageDown')],
  },
  {
    id: 'pageflip',
    name: 'PageFlip',
    hint: 'Butterfly, Cicada, Firefly: Page Up/Down or arrows',
    bindings: [...pair('PageUp', 'PageDown'), ...pair('ArrowLeft', 'ArrowRight'), ...pair('ArrowUp', 'ArrowDown')],
  },
  {
    id: 'blueturn',
    name: 'iRig BlueTurn',
    hint: 'Up/Down or Left/Right arrows',
    bindings: [...pair('ArrowUp', 'ArrowDown'), ...pair('ArrowLeft', 'ArrowRight')],
  },
  {
    id: 'donner',
    name: 'Donner',
    hint: 'Page Up/Down or Left/Right arrows',
    bindings: [...pair('PageUp', 'PageDown'), ...pair('ArrowLeft', 'ArrowRight')],
  },
  {
    id: 'space-shift',
    name: 'Space / Shift',
    hint: 'Pedals that send Space (forward) and Shift (back)',
    bindings: pair('Shift', 'Space'),
  },
]

/** Add a preset's bindings, replacing existing bindings for the same keys and press type. */
export function applyPreset(keys: KeyBinding[], preset: PedalPreset): KeyBinding[] {
  const taken = new Set(preset.bindings.map(slot))
  return [...keys.filter((k) => !taken.has(slot(k))), ...preset.bindings]
}

const slot = (k: KeyBinding) => `${k.key}|${k.long ? 'long' : 'tap'}`

export interface Conflict {
  key: string
  long: boolean
  /** Indexes into the bindings array; only the first one fires. */
  indexes: number[]
  actions: ActionId[]
}

/** Bindings that share a key and press type. The viewer only runs the first one. */
export function findConflicts(keys: KeyBinding[]): Conflict[] {
  const bySlot = new Map<string, number[]>()
  keys.forEach((k, i) => {
    const s = slot(k)
    bySlot.set(s, [...(bySlot.get(s) ?? []), i])
  })
  const out: Conflict[] = []
  for (const idx of bySlot.values()) {
    if (idx.length < 2) continue
    const actions = [...new Set(idx.map((i) => keys[i].action))]
    out.push({ key: keys[idx[0]].key, long: !!keys[idx[0]].long, indexes: idx, actions })
  }
  return out
}

/** Index set for quick "is this row in conflict" lookups (all but the winning first binding). */
export function conflictingIndexes(keys: KeyBinding[]): Set<number> {
  const s = new Set<number>()
  for (const c of findConflicts(keys)) c.indexes.slice(1).forEach((i) => s.add(i))
  return s
}

/** Keys with both a tap and a long-press binding: the tap only fires on key-up. */
export function delayedTapKeys(keys: KeyBinding[]): Set<string> {
  const tap = new Set(keys.filter((k) => !k.long).map((k) => k.key))
  return new Set(keys.filter((k) => k.long && tap.has(k.key)).map((k) => k.key))
}

/** Cheat sheet rows: one per action, listing every key bound to it (in ACTIONS order). */
export function cheatSheet(keys: KeyBinding[]): { action: ActionId; label: string; group: string; keys: { key: string; long: boolean }[] }[] {
  const by = new Map<ActionId, { key: string; long: boolean }[]>()
  for (const k of keys) {
    if (k.action === 'none') continue
    by.set(k.action, [...(by.get(k.action) ?? []), { key: k.key, long: !!k.long }])
  }
  return (Object.keys(ACTIONS) as ActionId[])
    .filter((a) => by.has(a))
    .map((a) => ({ action: a, label: ACTIONS[a].label, group: ACTIONS[a].group, keys: by.get(a)! }))
}

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/

/** True for a keydown that is only a modifier (Shift, Ctrl…), which may still become a combo. */
export function isModifierOnly(e: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
  return MODIFIER_CODES.test(e.code) || /^(Shift|Control|Alt|Meta|OS)$/.test(e.key)
}
