import { describe, expect, it } from 'vitest'
import { fitColumns } from './useDisplayPages'

describe('text columns', () => {
  it('caps columns to what fits the page', () => {
    expect(fitColumns(3, 390, 20)).toBe(1)
    expect(fitColumns(3, 1024, 20)).toBe(3)
    expect(fitColumns(2, 1280, 20)).toBe(2)
    expect(fitColumns(3, 1024, 40)).toBe(1)
  })
})
