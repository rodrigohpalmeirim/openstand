import { describe, expect, it } from 'vitest'
import type { KeyBinding } from '../state/settings'
import { applyPreset, cheatSheet, conflictingIndexes, delayedTapKeys, findConflicts, isModifierOnly, PEDAL_PRESETS } from './keymap'

const b = (key: string, action: KeyBinding['action'], long?: boolean): KeyBinding => (long ? { key, action, long } : { key, action })

describe('findConflicts', () => {
  it('reports keys bound twice with the same press type', () => {
    const keys = [b('ArrowRight', 'nextPage'), b('KeyN', 'nextSong'), b('ArrowRight', 'nextSong')]
    const c = findConflicts(keys)
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ key: 'ArrowRight', long: false, indexes: [0, 2], actions: ['nextPage', 'nextSong'] })
    expect([...conflictingIndexes(keys)]).toEqual([2])
  })

  it('allows the same key for tap and long press', () => {
    const keys = [b('PageDown', 'nextPage'), b('PageDown', 'nextSong', true)]
    expect(findConflicts(keys)).toEqual([])
    expect([...delayedTapKeys(keys)]).toEqual(['PageDown'])
  })

  it('treats an exact duplicate as a conflict too', () => {
    expect(findConflicts([b('Space', 'nextPage'), b('Space', 'nextPage')])[0].actions).toEqual(['nextPage'])
  })

  it('distinguishes modifier combos', () => {
    expect(findConflicts([b('KeyN', 'nextSong'), b('Shift+KeyN', 'prevSong')])).toEqual([])
  })
})

describe('applyPreset', () => {
  it('replaces bindings for the preset keys and keeps the rest', () => {
    const preset = PEDAL_PRESETS.find((p) => p.id === 'donner')!
    const out = applyPreset([b('PageDown', 'nextSong'), b('KeyM', 'toggleMetronome'), b('PageDown', 'lastPage', true)], preset)
    expect(out).toContainEqual(b('KeyM', 'toggleMetronome'))
    expect(out).toContainEqual(b('PageDown', 'lastPage', true))
    expect(out).toContainEqual(b('PageDown', 'nextPage'))
    expect(out).not.toContainEqual(b('PageDown', 'nextSong'))
    expect(findConflicts(out)).toEqual([])
  })

  it('every preset is conflict free', () => {
    for (const p of PEDAL_PRESETS) expect(findConflicts(p.bindings)).toEqual([])
  })
})

describe('cheatSheet', () => {
  it('groups keys per action in catalogue order and skips "none"', () => {
    const rows = cheatSheet([b('KeyM', 'toggleMetronome'), b('ArrowRight', 'nextPage'), b('Space', 'nextPage', true), b('KeyZ', 'none')])
    expect(rows.map((r) => r.action)).toEqual(['nextPage', 'toggleMetronome'])
    expect(rows[0].keys).toEqual([
      { key: 'ArrowRight', long: false },
      { key: 'Space', long: true },
    ])
  })
})

describe('isModifierOnly', () => {
  it('detects bare modifiers', () => {
    expect(isModifierOnly({ key: 'Shift', code: 'ShiftLeft' })).toBe(true)
    expect(isModifierOnly({ key: 'Control', code: 'ControlRight' })).toBe(true)
    expect(isModifierOnly({ key: 'a', code: 'KeyA' })).toBe(false)
  })
})
