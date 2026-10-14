import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../state/settings'
import { FACE_GESTURES } from './gestures'

const assigned = (s: ReturnType<typeof mergeSettings>) =>
  Object.fromEntries(FACE_GESTURES.filter((g) => s.faceGestures.gestures[g].action !== 'none').map((g) => [g, s.faceGestures.gestures[g].action]))

describe('face gesture settings', () => {
  it('defaults: head turns turn pages, nothing else assigned', () => {
    expect(assigned(mergeSettings(undefined))).toEqual({ turnLeft: 'prevPage', turnRight: 'nextPage' })
    expect(DEFAULT_SETTINGS.faceGestures.enabled).toBe(false)
  })

  it('migrates the old head-turn/mouth settings', () => {
    const s = mergeSettings({
      faceGestures: {
        enabled: true,
        headTurn: true,
        mouth: true,
        sensitivity: 0.8,
        cooldownMs: 900,
        turnLeftAction: 'prevSong',
        turnRightAction: 'nextSong',
        mouthAction: 'toggleMetronome',
      },
    })
    expect(s.faceGestures.enabled).toBe(true)
    expect(s.faceGestures.cooldownMs).toBe(900)
    expect(assigned(s)).toEqual({ turnLeft: 'prevSong', turnRight: 'nextSong', mouthOpen: 'toggleMetronome' })
    expect(s.faceGestures.gestures.turnLeft.sensitivity).toBe(0.8)
    expect(s.faceGestures.gestures.mouthOpen.sensitivity).toBe(0.8)
    // Old keys are gone.
    expect(Object.keys(s.faceGestures).sort()).toEqual(['cooldownMs', 'enabled', 'gestures'])
  })

  it('old settings with head turns off and mouth on', () => {
    const s = mergeSettings({ faceGestures: { enabled: true, headTurn: false, mouth: true, mouthAction: 'nextPage' } })
    expect(assigned(s)).toEqual({ mouthOpen: 'nextPage' })
  })

  it('old settings with only some fields use the old defaults for the rest', () => {
    expect(assigned(mergeSettings({ faceGestures: { enabled: true } }))).toEqual({ turnLeft: 'prevPage', turnRight: 'nextPage' })
    expect(assigned(mergeSettings({ faceGestures: { mouth: false, turnRightAction: 'bogus' } }))).toEqual({ turnLeft: 'prevPage' })
  })

  it('keeps new-shape data and repairs bad values', () => {
    const s = mergeSettings({
      faceGestures: {
        enabled: true,
        gestures: {
          winkRight: { action: 'nextPage', sensitivity: 0.3, holdMs: 400 },
          smile: { action: 'explode', sensitivity: -2, holdMs: 99999 },
          turnLeft: { action: 'none' },
          sneeze: { action: 'nextPage', sensitivity: 0.5, holdMs: 100 },
        },
      },
    })
    const g = s.faceGestures.gestures
    expect(g.winkRight).toEqual({ action: 'nextPage', sensitivity: 0.3, holdMs: 400 })
    expect(g.smile).toEqual({ action: 'none', sensitivity: 0, holdMs: 900 })
    expect(assigned(s)).toEqual({ turnRight: 'nextPage', winkRight: 'nextPage' })
    expect(Object.keys(g).sort()).toEqual([...FACE_GESTURES].sort())
  })

  it('round-trips current settings unchanged', () => {
    expect(mergeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS))).faceGestures).toEqual(DEFAULT_SETTINGS.faceGestures)
  })
})
