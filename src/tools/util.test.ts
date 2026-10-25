import { describe, expect, it } from 'vitest'
import { parseClock, parseSongLength } from './util'

describe('parseClock', () => {
  it('reads m:ss and plain seconds', () => {
    expect(parseClock('3:05')).toBe(185)
    expect(parseClock('90')).toBe(90)
    expect(parseClock('')).toBeUndefined()
    expect(parseClock('x')).toBeUndefined()
  })
})

describe('parseSongLength', () => {
  it('clears on empty input and reads a bare small number as minutes', () => {
    expect(parseSongLength('  ')).toBe(0)
    expect(parseSongLength('4')).toBe(240)
    expect(parseSongLength('3.5')).toBe(210)
    expect(parseSongLength('200')).toBe(200)
    expect(parseSongLength('3:30')).toBe(210)
    expect(parseSongLength('0:45')).toBe(45)
    expect(parseSongLength('abc')).toBeUndefined()
  })
})
