import { describe, expect, it } from 'vitest'
import { emptySong } from '../../db/schema'
import { addFiles, removeFile, replaceFile, rotateSetting, scopeKeys } from './songEdit'

const f = (id: string, pageCount: number, kind: 'pdf' | 'text' = 'pdf') => ({ id, name: id, kind, blobId: 'b' + id, pageCount, size: 1 })

describe('songEdit', () => {
  it('rotates pages with their crop', () => {
    const s = rotateSetting({ crop: { top: 0.1, right: 0, bottom: 0, left: 0 } }, 90)
    expect(s).toEqual({ rotation: 90, crop: { top: 0, right: 0.1, bottom: 0, left: 0 } })
    expect(rotateSetting({ rotation: 90 }, -90)).toEqual({})
    expect(rotateSetting(undefined, -90).rotation).toBe(270)
  })
  it('adds, removes and replaces files keeping the order consistent', () => {
    let s = emptySong({ id: 's', title: 't', files: [f('a', 3)] })
    s.pageOrder = [{ fileId: 'a', page: 2 }]
    s.pageSettings = { 'a:2': { rotation: 90 }, 'a:0': { rotation: 180 } }
    s = addFiles(s, [f('b', 2)])
    expect(s.pageOrder!.map((r) => r.fileId + r.page)).toEqual(['a2', 'b0', 'b1'])
    const r = replaceFile(s, 'a', f('new', 2))
    expect(r.files[0].id).toBe('a')
    // Page 3 of the replaced file no longer exists; the rest of the custom order survives.
    expect(r.pageOrder!.map((x) => x.fileId + x.page)).toEqual(['b0', 'b1'])
    expect(r.pageSettings).toEqual({ 'a:0': { rotation: 180 } })
    const d = removeFile(s, 'a')
    expect(d.pageOrder).toBeUndefined()
    expect(d.pageSettings).toEqual({})
  })
  it('lists crop scope keys', () => {
    const s = emptySong({ id: 's', title: 't', files: [f('a', 2), f('t', 1, 'text'), f('b', 1)] })
    expect(scopeKeys(s, { fileId: 'a', page: 1 }, 'page')).toEqual(['a:1'])
    expect(scopeKeys(s, { fileId: 'a', page: 1 }, 'file')).toEqual(['a:0', 'a:1'])
    expect(scopeKeys(s, { fileId: 'a', page: 1 }, 'song')).toEqual(['a:0', 'a:1', 'b:0'])
  })
})
