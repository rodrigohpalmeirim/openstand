import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../state/settings'
import { settingsFromJSON, settingsToJSON } from './io'

describe('settings export/import', () => {
  it('round-trips and keeps device-only fields of the importing device', () => {
    const mine = { ...DEFAULT_SETTINGS, theme: 'dark' as const, onboarded: true, recentSearches: ['bach'] }
    const json = settingsToJSON(mine)
    expect(JSON.parse(json).settings.recentSearches).toBeUndefined()
    const other = { ...DEFAULT_SETTINGS, onboarded: false, recentSearches: ['x'] }
    const out = settingsFromJSON(json, other)
    expect(out.theme).toBe('dark')
    expect(out.onboarded).toBe(false)
    expect(out.recentSearches).toEqual(['x'])
  })

  it('accepts a bare settings object', () => {
    expect(settingsFromJSON('{"accent":"stage"}', DEFAULT_SETTINGS).accent).toBe('stage')
  })

  it('migrates older exports', () => {
    const json = JSON.stringify({ app: 'openstand', kind: 'settings', version: 1, settings: { pageTurn: { keys: [{ key: ' ', action: 'nextPage' }] } } })
    expect(settingsFromJSON(json, DEFAULT_SETTINGS).pageTurn.keys).toEqual([{ key: 'Space', action: 'nextPage' }])
  })

  it('rejects other files with a readable error', () => {
    expect(() => settingsFromJSON('not json', DEFAULT_SETTINGS)).toThrow(/not valid JSON/)
    expect(() => settingsFromJSON('[1]', DEFAULT_SETTINGS)).toThrow(/does not contain settings/)
    expect(() => settingsFromJSON('{"app":"other"}', DEFAULT_SETTINGS)).toThrow(/another app/)
    expect(() => settingsFromJSON('{"app":"openstand","kind":"backup"}', DEFAULT_SETTINGS)).toThrow(/backup file/)
    expect(() => settingsFromJSON('{"app":"openstand","kind":"settings","version":99,"settings":{}}', DEFAULT_SETTINGS)).toThrow(/newer version/)
  })
})
