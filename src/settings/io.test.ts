import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../state/settings'
import { resetAllSettings, settingsFromJSON, settingsToJSON } from './io'

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

  it('leaves out this device’s sync identity and MIDI ports, and keeps the importing device’s', () => {
    const D = DEFAULT_SETTINGS
    const mine = {
      ...D,
      sync: { ...D.sync, deviceName: 'Leader iPad', role: 'leader' as const, relayUrl: 'wss://relay.example', room: 'gig', autoConnect: true, followSongs: false },
      midi: { ...D.midi, inputs: ['in-1'], outputs: ['out-1'], defaultChannel: 5 },
    }
    const exported = JSON.parse(settingsToJSON(mine)).settings
    expect(exported.sync).toEqual({ followPages: true, followSongs: false })
    expect(exported.midi.inputs).toBeUndefined()
    expect(exported.midi.outputs).toBeUndefined()
    expect(exported.midi.defaultChannel).toBe(5)
    expect(mine.sync.deviceName).toBe('Leader iPad') // the live settings are untouched

    const other = { ...D, sync: { ...D.sync, deviceName: 'Drums', role: 'follower' as const, room: 'band' }, midi: { ...D.midi, inputs: ['x'] } }
    // Even a hand-made file that contains them doesn't override this device's values.
    const out = settingsFromJSON(JSON.stringify({ app: 'openstand', kind: 'settings', version: 2, settings: { ...exported, sync: mine.sync, midi: mine.midi } }), other)
    expect(out.sync).toMatchObject({ deviceName: 'Drums', role: 'follower', room: 'band', relayUrl: '', autoConnect: false, followSongs: false })
    expect(out.midi.inputs).toEqual(['x'])
    expect(out.midi.outputs).toEqual([])
    expect(out.midi.defaultChannel).toBe(5)
  })

  it('reset all keeps what the user made', () => {
    const D = DEFAULT_SETTINGS
    const preset = { id: 'p1', tool: 'pen', config: {} } as unknown as (typeof D.annotations.presets)[number]
    const mine = {
      ...D,
      theme: 'dark' as const,
      onboarded: true,
      pageTurn: { ...D.pageTurn, keys: [] },
      midi: { ...D.midi, bindings: [{ message: 'cc:64:127', action: 'nextPage' as const }], inputs: ['pedal'] },
      annotations: { ...D.annotations, smoothing: 0, presets: [preset], recentColors: ['#ff0000'] },
      importPrefs: { ...D.importPrefs, filePattern: '%artist% - %title%', autoCrop: true },
      sync: { ...D.sync, deviceName: 'Keys', room: 'gig', relayUrl: '/relay', role: 'leader' as const, autoConnect: true, followPages: false },
    }
    const out = resetAllSettings(mine)
    expect(out.theme).toBe(D.theme)
    expect(out.pageTurn.keys).toEqual(D.pageTurn.keys)
    expect(out.midi.bindings).toEqual([])
    expect(out.midi.inputs).toEqual(['pedal'])
    expect(out.annotations.smoothing).toBe(D.annotations.smoothing)
    expect(out.annotations.presets).toEqual([preset])
    expect(out.annotations.recentColors).toEqual(['#ff0000'])
    expect(out.importPrefs).toEqual({ ...D.importPrefs, filePattern: '%artist% - %title%' })
    // This device stays in its band's room; only shared preferences reset.
    expect(out.sync).toEqual({ ...D.sync, deviceName: 'Keys', room: 'gig', relayUrl: '/relay', role: 'leader', autoConnect: true })
    expect(out.onboarded).toBe(true)
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
