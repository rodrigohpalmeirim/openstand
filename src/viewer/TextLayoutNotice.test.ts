import { describe, expect, it } from 'vitest'
import { layoutChanges, type TextLayoutSig } from './TextLayoutNotice'

const base: TextLayoutSig = { zoom: 1, columns: 1, width: 390, height: 844, transpose: 0 }

describe('layoutChanges', () => {
  it('reports nothing for the same layout (small height jitter included)', () => {
    expect(layoutChanges(base, { ...base, height: 800 })).toEqual([])
  })
  it('reports text size, columns and key changes', () => {
    expect(layoutChanges(base, { ...base, zoom: 1.2, columns: 2, transpose: 2 })).toEqual(['size', 'columns', 'key'])
  })
  it('reports rotation as a screen change', () => {
    expect(layoutChanges(base, { ...base, width: 844, height: 390 })).toEqual(['screen'])
  })
})
