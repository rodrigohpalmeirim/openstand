import { describe, expect, it } from 'vitest'
import { matchPattern, parseDuration } from './import'

describe('import patterns', () => {
  it('matches filename patterns', () => {
    expect(matchPattern('%artist% - %title%', 'Miles Davis - So What')).toEqual({ artist: 'Miles Davis', title: 'So What' })
    expect(matchPattern('%title% (%key%)', 'Autumn Leaves (Gm)')).toEqual({ title: 'Autumn Leaves', key: 'Gm' })
    expect(matchPattern('%artist% - %title%', 'NoSeparator')).toBeNull()
  })
  it('parses durations', () => {
    expect(parseDuration('3:25')).toBe(205)
    expect(parseDuration('1:02:03')).toBe(3723)
    expect(parseDuration('90')).toBe(90)
  })
})
