import { describe, expect, it } from 'vitest'
import type { Annotation, StrokeAnnotation } from '../db/schema'
import { commandKind, diffItems, makeCommand, UndoStack } from './history'

const mk = (id: string): StrokeAnnotation => ({ id, type: 'pen', layer: 'default', color: '#000', opacity: 1, createdAt: 0, width: 0.003, points: [{ x: 0, y: 0 }] })

describe('diff & commands', () => {
  it('classifies created, deleted and updated items by identity', () => {
    const a = mk('a')
    const b = mk('b')
    const b2 = { ...b, color: 'red' }
    const c = mk('c')
    const d = diffItems([a, b], [b2, c])
    expect(d).toEqual({ created: ['c'], deleted: ['a'], updated: ['b'] })
  })

  it('labels command kinds', () => {
    const a = mk('a')
    expect(commandKind([{ key: 'k', before: [], after: [a] }])).toBe('create')
    expect(commandKind([{ key: 'k', before: [a], after: [] }])).toBe('delete')
    expect(commandKind([{ key: 'k', before: [a], after: [{ ...a, opacity: 0.5 }] }])).toBe('update')
    expect(commandKind([{ key: 'k', before: [a], after: [mk('b')] }])).toBe('mixed')
  })

  it('drops no-op changes', () => {
    const items: Annotation[] = [mk('a')]
    expect(makeCommand('x', [{ key: 'k', before: items, after: items }])).toBeNull()
    const cmd = makeCommand('x', [
      { key: 'k', before: items, after: items },
      { key: 'j', before: [], after: items },
    ])
    expect(cmd?.changes.map((c) => c.key)).toEqual(['j'])
  })
})

describe('UndoStack', () => {
  const cmd = (label: string) => makeCommand(label, [{ key: 'k', before: [], after: [mk(label)] }])!

  it('undoes and redoes in order', () => {
    const s = new UndoStack()
    expect(s.canUndo).toBe(false)
    s.push(cmd('1'))
    s.push(cmd('2'))
    expect(s.undo()?.label).toBe('2')
    expect(s.canRedo).toBe(true)
    expect(s.undo()?.label).toBe('1')
    expect(s.undo()).toBeUndefined()
    expect(s.redo()?.label).toBe('1')
    expect(s.redo()?.label).toBe('2')
    expect(s.redo()).toBeUndefined()
  })

  it('a new command clears the redo branch', () => {
    const s = new UndoStack()
    s.push(cmd('1'))
    s.push(cmd('2'))
    s.undo()
    s.push(cmd('3'))
    expect(s.canRedo).toBe(false)
    expect(s.undo()?.label).toBe('3')
    expect(s.undo()?.label).toBe('1')
  })

  it('caps its length', () => {
    const s = new UndoStack(3)
    for (let i = 0; i < 5; i++) s.push(cmd(String(i)))
    expect(s.size).toBe(3)
    expect(s.undo()?.label).toBe('4')
  })
})
