import { describe, expect, it } from 'vitest'
import { emptySong, type SongFile } from '../../db/schema'
import type { PageEdit } from '../../scan/correct'
import { FULL_QUAD, NO_BEND, type Bend, type Quad } from '../../scan/geometry'
import { DEFAULT_PARAMS, type FilterParams } from '../../scan/image'
import { applyCorrection, correctedName, correctedSetting, geometryChanged, needsRender, pageList, planCorrection, startTurns } from './correctPlan'

const file = (id: string, pageCount: number, kind: SongFile['kind'] = 'pdf'): SongFile => ({ id, name: `${id}.${kind === 'image' ? 'jpg' : 'pdf'}`, kind, blobId: 'b' + id, pageCount, size: 1 })
const moved: Quad = [
  { x: 0.05, y: 0.02 },
  { x: 0.97, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 0.98 },
]
const bent: Bend = [[0.01, 0.02], [], [], []]
const edit = (p: Partial<PageEdit> = {}): PageEdit => ({ quad: FULL_QUAD, bend: NO_BEND, rotation: 0, ready: true, ...p })
const colour: FilterParams = { ...DEFAULT_PARAMS, filter: 'color', brightness: 0, contrast: 0 }
const bw: FilterParams = { ...DEFAULT_PARAMS, filter: 'bw' }
const crop = { top: 0.1, right: 0.05, bottom: 0, left: 0 }

describe('correctPlan', () => {
  it('only corners off the page edges or bent edges count as moved content', () => {
    expect(geometryChanged(edit())).toBe(false)
    expect(geometryChanged(edit({ rotation: 1 }))).toBe(false)
    expect(geometryChanged(edit({ bend: undefined }))).toBe(false)
    expect(geometryChanged(edit({ bend: [[0, 0], [], [], []] }))).toBe(false)
    expect(geometryChanged(edit({ quad: moved }))).toBe(true)
    expect(geometryChanged(edit({ bend: bent }))).toBe(true)
  })

  it('copies pages nothing happened to instead of redrawing them', () => {
    expect(needsRender(edit(), colour)).toBe(false)
    expect(needsRender(edit({ rotation: 3 }), colour)).toBe(false)
    expect(needsRender(edit(), { ...colour, brightness: 10 })).toBe(true)
    expect(needsRender(edit(), bw)).toBe(true)
    expect(needsRender(edit({ quad: moved }), colour)).toBe(true)
    expect(needsRender(edit({ quad: moved, ready: false }), bw)).toBe(false)
  })

  it('starts the editor with the saved rotation', () => {
    expect(startTurns(undefined)).toBe(0)
    expect(startTurns({ rotation: 270 })).toBe(3)
  })

  it('keeps crop and rotation of a page whose geometry did not change (filter only)', () => {
    const old = { rotation: 90 as const, crop }
    expect(correctedSetting(old, edit({ rotation: 1 }))).toEqual(old)
    expect(correctedSetting(undefined, edit())).toBeUndefined()
  })

  it('writes a changed rotation back as the setting, turning the crop with it', () => {
    // Saved 90°, ended at 180°: one more quarter turn.
    expect(correctedSetting({ rotation: 90, crop }, edit({ rotation: 2 }))).toEqual({ rotation: 180, crop: { top: 0, right: 0.1, bottom: 0.05, left: 0 } })
    // Turned back upright: the rotation setting goes away.
    expect(correctedSetting({ rotation: 270 }, edit({ rotation: 0 }))).toBeUndefined()
  })

  it('drops the crop when the content moves, keeping the rotation', () => {
    expect(correctedSetting({ rotation: 90, crop }, edit({ rotation: 1, quad: moved }))).toEqual({ rotation: 90 })
    expect(correctedSetting({ crop }, edit({ bend: bent }))).toBeUndefined()
  })

  it('leaves unreadable pages alone', () => {
    const old = { rotation: 90 as const, crop }
    expect(correctedSetting(old, edit({ ready: false, quad: moved, rotation: 0 }))).toBe(old)
  })

  it('plans redraws, annotation warnings and dropped crops', () => {
    const settings = { 'a:0': { crop }, 'a:1': { crop }, 'a:2': { rotation: 90 as const }, 'b:1': { crop } }
    const edits = [edit({ quad: moved }), edit({ rotation: 1 }), edit({ bend: bent, rotation: 1 }), edit({ quad: moved, ready: false })]
    const p = planCorrection('a', settings, edits, colour, new Set([1, 2, 3]))
    expect(p.render).toEqual([0, 2])
    // Page 1 only turned (annotations turn with it); page 3 is kept as it is.
    expect(p.warn).toEqual([2])
    expect(p.cropsDropped).toEqual([0])
    expect(planCorrection('a', settings, edits, bw, new Set()).render).toEqual([0, 1, 2])
  })

  it('replaces a PDF keeping file id, page order and settings of unchanged pages', () => {
    const s = emptySong({ id: 's', title: 't', files: [file('a', 3), file('b', 1)] })
    s.pageOrder = [
      { fileId: 'b', page: 0 },
      { fileId: 'a', page: 2 },
      { fileId: 'a', page: 0 },
    ]
    s.pageSettings = { 'a:0': { rotation: 90, crop }, 'a:1': { crop }, 'a:2': { rotation: 180 }, 'b:0': { crop } }
    const repl = { ...file('new', 3), blobId: 'corrected', name: 'a.pdf' }
    const r = applyCorrection(s, 'a', repl, [edit({ rotation: 1 }), edit({ quad: moved }), edit({ rotation: 1 })])
    expect(r.files.map((f) => [f.id, f.blobId])).toEqual([
      ['a', 'corrected'],
      ['b', 'bb'],
    ])
    expect(r.pageOrder).toEqual(s.pageOrder)
    expect(r.pageSettings).toEqual({ 'a:0': { rotation: 90, crop }, 'a:2': { rotation: 90 }, 'b:0': { crop } })
    // The draft passed in is not modified (cancelling the song editor discards the result).
    expect(s.files[0].blobId).toBe('ba')
    expect(s.pageSettings['a:1']).toEqual({ crop })
  })

  it('keeps the settings of an image that becomes a one-page PDF', () => {
    const s = emptySong({ id: 's', title: 't', files: [file('img', 1, 'image')] })
    s.pageSettings = { 'img:0': { rotation: 270, crop } }
    const repl = { ...file('x', 1), name: correctedName(s.files[0]) }
    const r = applyCorrection(s, 'img', repl, [edit({ rotation: 3 })])
    expect(r.files[0]).toMatchObject({ id: 'img', kind: 'pdf', name: 'img.pdf' })
    expect(r.pageSettings).toEqual({ 'img:0': { rotation: 270, crop } })
  })

  it('updates only settings when nothing had to be redrawn', () => {
    const s = emptySong({ id: 's', title: 't', files: [file('a', 2)] })
    s.pageSettings = { 'a:1': { rotation: 90 } }
    const r = applyCorrection(s, 'a', null, [edit({ rotation: 1 }), edit({ rotation: 1 })])
    expect(r.files).toBe(s.files)
    expect(r.pageSettings).toEqual({ 'a:0': { rotation: 90 }, 'a:1': { rotation: 90 } })
  })

  it('refuses a replacement with a different page count', () => {
    const s = emptySong({ id: 's', title: 't', files: [file('a', 2)] })
    expect(() => applyCorrection(s, 'a', file('n', 1), [edit(), edit()])).toThrow()
  })

  it('names files and page lists', () => {
    expect(correctedName(file('Waltz', 1, 'image'))).toBe('Waltz.pdf')
    expect(correctedName({ ...file('x', 1, 'image'), name: 'no-ext' })).toBe('no-ext.pdf')
    expect(correctedName(file('Book', 4))).toBe('Book.pdf')
    expect(pageList([1])).toBe('page 2')
    expect(pageList([0, 4])).toBe('pages 1 and 5')
    expect(pageList([0, 2, 3])).toBe('pages 1, 3 and 4')
  })
})
