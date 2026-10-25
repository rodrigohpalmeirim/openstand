// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { blobKey, checkKey, deviceKey, headKey, headsPrefix, logKey, logPrefix, metaKey, snapKey } from '../paths'
import { deep3, dirProps, fromDeep3, prefixScope, segments } from './keymap'
import { BackendError } from './types'

const LIB = 'abcdefghijklmnopqrstuvwxyz'
const DEV = '0123456789abcdef'
const BLOB = 'a'.repeat(52)

const badKey = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof BackendError && e.code === 'unknown' && e.providerCode === 'BadKey'
  }
  return false
}

describe('keymap', () => {
  const keys = [
    metaKey(LIB),
    deviceKey(LIB, DEV),
    headKey(LIB, DEV, 7),
    logKey(LIB, DEV, 12),
    snapKey(LIB, DEV, 3),
    blobKey(LIB, BLOB),
    checkKey('abc123'),
    'contract-x1y2/ls/a/x',
    'single',
  ]

  it('segments: accepts every key the app writes', () => {
    for (const k of keys) expect(segments(k).join('/')).toBe(k)
  })

  it('segments: rejects empty segments, a leading slash, ~, upper case, non-ASCII and trailing dots', () => {
    for (const k of ['', '/a', 'a/', 'a//b', 'a~b', 'A', 'os1/Meta', 'é', 'a b', 'a/./b', 'a/../b', 'a.', 'a/b\\c', 'a?b'])
      expect(badKey(() => segments(k)), k).toBe(true)
  })

  it('deep3: the first min(n−1, 3) segments are folders, the rest joins with ~; fromDeep3 inverts it', () => {
    expect(deep3(headKey(LIB, DEV, 7))).toEqual({ folder: ['os1', LIB, 'heads'], leaf: `${DEV}~0000000007` })
    expect(deep3(metaKey(LIB))).toEqual({ folder: ['os1', LIB], leaf: 'meta' })
    expect(deep3(blobKey(LIB, BLOB))).toEqual({ folder: ['os1', LIB, 'blobs'], leaf: BLOB })
    expect(deep3(deviceKey(LIB, DEV))).toEqual({ folder: ['os1', LIB, 'devices'], leaf: DEV })
    expect(deep3('single')).toEqual({ folder: [], leaf: 'single' })
    expect(deep3('a/b/c/d/e/f')).toEqual({ folder: ['a', 'b', 'c'], leaf: 'd~e~f' })
    for (const k of [...keys, 'a/b/c/d/e/f']) {
      const { folder, leaf } = deep3(k)
      expect(fromDeep3(folder, leaf)).toBe(k)
    }
  })

  it('fromDeep3 refuses names deep3 never produces', () => {
    expect(badKey(() => fromDeep3(['os1'], 'a~b'))).toBe(true)
    expect(badKey(() => fromDeep3(['a', 'b', 'c', 'd'], 'e'))).toBe(true)
    expect(badKey(() => fromDeep3(['a', 'b', 'c'], 'x~'))).toBe(true)
    expect(badKey(() => fromDeep3([], 'Desktop.ini'))).toBe(true)
  })

  it('dirProps: only proper folder prefixes, at most 3', () => {
    expect(dirProps(headKey(LIB, DEV, 7))).toEqual({ d1: 'os1', d2: `os1/${LIB}`, d3: `os1/${LIB}/heads` })
    expect(dirProps(metaKey(LIB))).toEqual({ d1: 'os1', d2: `os1/${LIB}` })
    expect(dirProps(checkKey('abc'))).toEqual({ d1: 'os1' })
    expect(dirProps('single')).toEqual({})
    expect(badKey(() => dirProps('A/b'))).toBe(true)
  })

  it('prefixScope: the deepest complete folder, capped at 3', () => {
    const table: [string, string[]][] = [
      ['', []],
      ['os1', []],
      ['os1/', ['os1']],
      ['os1/.check-', ['os1']],
      [`os1/${LIB}/`, ['os1', LIB]],
      [`os1/${LIB}/he`, ['os1', LIB]],
      [headsPrefix(LIB), ['os1', LIB, 'heads']],
      [headsPrefix(LIB, DEV), ['os1', LIB, 'heads']],
      [logPrefix(LIB, DEV), ['os1', LIB, 'log']],
      ['a/b/c/d/e/', ['a', 'b', 'c']],
    ]
    for (const [p, folder] of table) expect(prefixScope(p), p).toEqual({ folder, depth: folder.length })
    for (const p of ['/a', 'a//', 'A/', 'a/B', 'a~/', 'a./']) expect(badKey(() => prefixScope(p)), p).toBe(true)
  })
})
