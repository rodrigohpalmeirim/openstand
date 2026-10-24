// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  blobKey,
  blobsPrefix,
  checkKey,
  deviceKey,
  devicesPrefix,
  headKey,
  headsPrefix,
  latestHeads,
  libraryPrefix,
  logKey,
  logPrefix,
  metaKey,
  pad10,
  parse10,
  parseKey,
  snapKey,
  snapPrefix,
} from './paths'

const LIB = 'abcdefghijklmnopqrstuvwxyz'
const DEV = '0123456789abcdef'
const BLOB = 'a'.repeat(52)

describe('paths', () => {
  it('builds the §3 layout', () => {
    expect(libraryPrefix(LIB)).toBe(`os1/${LIB}/`)
    expect(metaKey(LIB)).toBe(`os1/${LIB}/meta`)
    expect(devicesPrefix(LIB)).toBe(`os1/${LIB}/devices/`)
    expect(deviceKey(LIB, DEV)).toBe(`os1/${LIB}/devices/${DEV}`)
    expect(headsPrefix(LIB)).toBe(`os1/${LIB}/heads/`)
    expect(headsPrefix(LIB, DEV)).toBe(`os1/${LIB}/heads/${DEV}/`)
    expect(headKey(LIB, DEV, 1)).toBe(`os1/${LIB}/heads/${DEV}/0000000001`)
    expect(logPrefix(LIB, DEV)).toBe(`os1/${LIB}/log/${DEV}/`)
    expect(logKey(LIB, DEV, 42)).toBe(`os1/${LIB}/log/${DEV}/0000000042`)
    expect(snapPrefix(LIB)).toBe(`os1/${LIB}/snap/`)
    expect(snapKey(LIB, DEV, 3)).toBe(`os1/${LIB}/snap/${DEV}/0000000003`)
    expect(blobsPrefix(LIB)).toBe(`os1/${LIB}/blobs/`)
    expect(blobKey(LIB, BLOB)).toBe(`os1/${LIB}/blobs/${BLOB}`)
    expect(checkKey('x1')).toBe('os1/.check-x1')
  })

  it('pads so that string order is numeric order', () => {
    const seqs = [1, 2, 9, 10, 99, 100, 12345, 9_999_999_999]
    const keys = seqs.map(pad10)
    expect([...keys].sort()).toEqual(keys)
    for (const n of seqs) expect(parse10(pad10(n))).toBe(n)
    expect(() => pad10(0)).toThrow()
    expect(() => pad10(1.5)).toThrow()
    expect(() => pad10(10_000_000_000)).toThrow()
    expect(parse10('0000000000')).toBeNull()
    expect(parse10('123')).toBeNull()
    expect(parse10('00000000a1')).toBeNull()
  })

  it('builders reject invalid parts', () => {
    expect(() => metaKey('ABC')).toThrow()
    expect(() => metaKey(LIB + 'a')).toThrow()
    expect(() => deviceKey(LIB, 'XYZ')).toThrow()
    expect(() => deviceKey(LIB, '../../etc/passwd')).toThrow()
    expect(() => logKey(LIB, DEV, -1)).toThrow()
    expect(() => blobKey(LIB, 'short')).toThrow()
    expect(() => checkKey('a/b')).toThrow()
  })

  it('parses every key it builds and nothing else', () => {
    expect(parseKey(metaKey(LIB))).toEqual({ type: 'meta', libraryId: LIB })
    expect(parseKey(deviceKey(LIB, DEV))).toEqual({ type: 'device', libraryId: LIB, deviceId: DEV })
    expect(parseKey(headKey(LIB, DEV, 7))).toEqual({ type: 'head', libraryId: LIB, deviceId: DEV, seq: 7 })
    expect(parseKey(logKey(LIB, DEV, 8))).toEqual({ type: 'log', libraryId: LIB, deviceId: DEV, seq: 8 })
    expect(parseKey(snapKey(LIB, DEV, 9))).toEqual({ type: 'snap', libraryId: LIB, deviceId: DEV, seq: 9 })
    expect(parseKey(blobKey(LIB, BLOB))).toEqual({ type: 'blob', libraryId: LIB, name: BLOB })
    for (const bad of [
      '',
      'os1',
      `os1/${LIB}`,
      `os2/${LIB}/meta`,
      `os1/${LIB}/meta/x`,
      `os1/${LIB}/log/${DEV}/1`,
      `os1/${LIB}/log/${DEV}/0000000000`,
      `os1/${LIB}/log/${DEV}`,
      `os1/${LIB}/what/${DEV}/0000000001`,
      `os1/${LIB}/toString/${DEV}/0000000001`,
      `os1/${LIB}/blobs/${BLOB}x`,
      'os1/.check-abc',
    ])
      expect(parseKey(bad)).toBeNull()
  })

  it('latestHeads takes the max per device and ignores other keys', () => {
    const D2 = 'ffffffffffffffff'
    const keys = [headKey(LIB, DEV, 3), headKey(LIB, DEV, 10), headKey(LIB, D2, 1), logKey(LIB, DEV, 99), 'junk', headKey('b'.repeat(26), DEV, 50)]
    expect(latestHeads(LIB, keys)).toEqual({ [DEV]: 10, [D2]: 1 })
  })
})
