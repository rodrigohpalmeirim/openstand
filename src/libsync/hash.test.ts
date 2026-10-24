// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { canonicalJson, hash64, jsonEqual, toJson, valueHash } from './hash'

describe('canonicalJson', () => {
  it('sorts keys at every level and ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}')
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }))
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
  })

  it('follows JSON.stringify for undefined, non-finite numbers and -0', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
    expect(canonicalJson([undefined, NaN, Infinity, -0])).toBe('[null,null,null,0]')
    expect(canonicalJson(undefined)).toBe('null')
    expect(canonicalJson('é"\n')).toBe(JSON.stringify('é"\n'))
    const nullProto = Object.assign(Object.create(null), { b: 2, a: 1 })
    expect(canonicalJson(nullProto)).toBe('{"a":1,"b":2}')
  })
})

describe('hashes', () => {
  it('hash64 is 16 hex chars, stable, and spreads', () => {
    expect(hash64('')).toMatch(/^[0-9a-f]{16}$/)
    expect(hash64('openstand')).toBe(hash64('openstand'))
    // Golden value: shadows persist hashes, so the function must never change silently.
    expect(hash64('openstand')).toBe('e3dde17a07c80de0')
    const seen = new Set(Array.from({ length: 10000 }, (_, i) => hash64(`v${i}`)))
    expect(seen.size).toBe(10000)
    expect(hash64('a', 1)).not.toBe(hash64('a'))
  })

  it("valueHash: '' only for undefined; equal for equal values in any key order", () => {
    expect(valueHash(undefined)).toBe('')
    expect(valueHash(null)).not.toBe('')
    expect(valueHash(null)).not.toBe(valueHash('null'))
    expect(valueHash({ a: 1, b: [true] })).toBe(valueHash({ b: [true], a: 1 }))
    expect(valueHash(1)).not.toBe(valueHash('1'))
  })

  it('toJson deep-copies into plain JSON', () => {
    const src = { a: 1, b: undefined, c: [undefined, NaN, { d: -0 }], e: () => 1 }
    const j = toJson(src)
    expect(j).toEqual({ a: 1, c: [null, null, { d: 0 }] })
    expect(Object.is((j as { c: [null, null, { d: number }] }).c[2].d, 0)).toBe(true)
    expect(toJson(undefined)).toBeUndefined()
    const arr = [1]
    expect(toJson({ arr })).not.toBe(arr)
  })
})
