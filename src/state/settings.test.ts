import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, migrateSettings, SETTINGS_VERSION } from './settings'

describe('mergeSettings', () => {
  it('returns defaults for empty or garbage input', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
  })

  it('fills in fields added after the data was saved', () => {
    const s = mergeSettings({ theme: 'dark', display: { nightMode: true } })
    expect(s.theme).toBe('dark')
    expect(s.display.nightMode).toBe(true)
    expect(s.display.fit).toBe(DEFAULT_SETTINGS.display.fit)
    expect(s.faceGestures.cooldownMs).toBe(DEFAULT_SETTINGS.faceGestures.cooldownMs)
    expect(s.accent).toBe('ember')
  })

  it('drops values of the wrong type', () => {
    const s = mergeSettings({ display: { pageGap: 'wide', keepScreenOn: 'yes', brightness: Number.NaN }, visibleGroups: 'artists' })
    expect(s.display.pageGap).toBe(DEFAULT_SETTINGS.display.pageGap)
    expect(s.display.keepScreenOn).toBe(DEFAULT_SETTINGS.display.keepScreenOn)
    expect(s.display.brightness).toBe(DEFAULT_SETTINGS.display.brightness)
    expect(s.visibleGroups).toEqual(DEFAULT_SETTINGS.visibleGroups)
  })

  it('replaces arrays instead of merging them', () => {
    const s = mergeSettings({ listFields: ['albums'] })
    expect(s.listFields).toEqual(['albums'])
  })

  it('keeps user-defined record keys', () => {
    const s = mergeSettings({ fieldLabels: { custom: 'Arranger' } })
    expect(s.fieldLabels).toEqual({ custom: 'Arranger' })
  })

  it('repairs unknown actions and duplicate key bindings', () => {
    const s = mergeSettings({
      pageTurn: {
        zones: { tl: 'explode' },
        swipeLeft: 'teleport',
        keys: [
          { key: 'KeyX', action: 'nextPage' },
          { key: 'KeyX', action: 'nextPage' },
          { key: 'KeyY', action: 'bogus' },
          { key: '', action: 'nextPage' },
          null,
        ],
      },
      faceGestures: { sensitivity: 7, mouthAction: 'zzz' },
    })
    expect(s.pageTurn.zones.tl).toBe('none')
    expect(s.pageTurn.zones.tr).toBe('nextPage')
    expect(s.pageTurn.swipeLeft).toBe('none')
    expect(s.pageTurn.keys).toEqual([{ key: 'KeyX', action: 'nextPage' }])
    expect(s.faceGestures.gestures.turnRight.sensitivity).toBe(1)
    expect(s.faceGestures.gestures.mouthOpen.action).toBe('none')
  })
})

describe('migrateSettings', () => {
  it('upgrades v1 space-bar bindings stored by key', () => {
    const v1 = { pageTurn: { keys: [{ key: ' ', action: 'nextPage' }, { key: 'Spacebar', action: 'nextPage', long: true }] } }
    const s = migrateSettings(v1, 1)
    expect(s.pageTurn.keys).toEqual([
      { key: 'Space', action: 'nextPage' },
      { key: 'Space', action: 'nextPage', long: true },
    ])
  })

  it('is a no-op merge for current data', () => {
    const s = migrateSettings({ ...DEFAULT_SETTINGS, theme: 'light' }, SETTINGS_VERSION)
    expect(s).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
  })

  it('treats missing data as defaults', () => {
    expect(migrateSettings(undefined, 0)).toEqual(DEFAULT_SETTINGS)
  })
})
