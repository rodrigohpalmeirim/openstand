import { describe, expect, it } from 'vitest'
import { layoutWidthFor, WRAP_BELOW, wrapFor } from './engine'

describe('ABC narrow layout', () => {
  it('lays phones out near natural size instead of a 640px staff scaled down', () => {
    const w = layoutWidthFor(351)
    expect(w).toBeLessThan(WRAP_BELOW)
    expect(351 / w).toBeGreaterThan(0.8)
    expect(wrapFor(w)?.preferredMeasuresPerLine).toBe(2)
  })
  it('keeps the file line breaks on wide pages', () => {
    expect(layoutWidthFor(1152)).toBe(1152)
    expect(wrapFor(1152)).toBeUndefined()
  })
  it('text zoom enlarges notation (narrower layout width)', () => {
    expect(layoutWidthFor(700, 1.5)).toBeLessThan(layoutWidthFor(700))
  })
})
