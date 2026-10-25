import { describe, expect, it } from 'vitest'
import { createLibrary, libraryName, renameLibrary } from './libraries'

describe('library names', () => {
  it('numbers duplicate names, case-insensitively', () => {
    const a = createLibrary('Brass Band')
    const b = createLibrary('brass band')
    expect(libraryName(a)).toBe('Brass Band')
    expect(libraryName(b)).toBe('brass band (1)')
    expect(renameLibrary(b, 'BRASS BAND')).toBe('BRASS BAND (1)')
    expect(renameLibrary(a, 'brass band')).toBe('brass band')
    expect(renameLibrary('default', 'Brass Band')).toBe('Brass Band (2)')
  })
})
