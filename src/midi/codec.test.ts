import { describe, expect, it } from 'vitest'
import {
  commandFromEvent,
  commandMatches,
  decodeMessage,
  describeCommand,
  describeKey,
  encodeCommand,
  eventKey,
  matchKey,
  noteName,
  parseKey,
  parseSysex,
  planCommands,
  toHex,
  updateBanks,
  type BankState,
} from './codec'

const hex = (a: Uint8Array[]) => a.map(toHex)

describe('decode', () => {
  it('decodes channel voice messages', () => {
    expect(decodeMessage([0x90, 60, 100])).toEqual({ kind: 'noteOn', channel: 1, note: 60, velocity: 100 })
    expect(decodeMessage([0x93, 60, 0])).toEqual({ kind: 'noteOff', channel: 4, note: 60, velocity: 0 })
    expect(decodeMessage([0x8f, 61, 10])).toEqual({ kind: 'noteOff', channel: 16, note: 61, velocity: 10 })
    expect(decodeMessage([0xb0, 64, 127])).toEqual({ kind: 'cc', channel: 1, controller: 64, value: 127 })
    expect(decodeMessage([0xc2, 5])).toEqual({ kind: 'pc', channel: 3, program: 5 })
    expect(decodeMessage([0xe0, 0, 64])).toEqual({ kind: 'pitchBend', channel: 1, value: 8192 })
  })
  it('decodes system messages', () => {
    expect(decodeMessage([0xf3, 7])).toEqual({ kind: 'songSelect', song: 7 })
    expect(decodeMessage([0xfa])).toEqual({ kind: 'start' })
    expect(decodeMessage([0xfc])).toEqual({ kind: 'stop' })
    expect(decodeMessage([0xfb])).toEqual({ kind: 'continue' })
    expect(decodeMessage([0xf8])).toEqual({ kind: 'clock' })
    const sx = decodeMessage([0xf0, 0x43, 0x10, 0xf7])
    expect(sx?.kind).toBe('sysex')
    expect(decodeMessage([])).toBeNull()
  })
})

describe('sysex parsing', () => {
  it('accepts several notations and adds framing', () => {
    expect(toHex((parseSysex('F0 7E 7F 06 01 F7') as { bytes: Uint8Array }).bytes)).toBe('F0 7E 7F 06 01 F7')
    expect(toHex((parseSysex('0x7e,0x7f,06,1') as { bytes: Uint8Array }).bytes)).toBe('F0 7E 7F 06 01 F7')
    expect(toHex((parseSysex('f07e7f0601f7') as { bytes: Uint8Array }).bytes)).toBe('F0 7E 7F 06 01 F7')
  })
  it('rejects invalid input', () => {
    expect(parseSysex('')).toHaveProperty('error')
    expect(parseSysex('F0 ZZ F7')).toHaveProperty('error')
    expect(parseSysex('F0 43 90 F7')).toHaveProperty('error')
  })
})

describe('encode', () => {
  it('encodes simple commands', () => {
    expect(hex(encodeCommand({ type: 'programChange', channel: 1, data1: 5 }))).toEqual(['C0 05'])
    expect(hex(encodeCommand({ type: 'controlChange', channel: 10, data1: 7, data2: 127 }))).toEqual(['B9 07 7F'])
    expect(hex(encodeCommand({ type: 'noteOn', channel: 2, data1: 60 }))).toEqual(['91 3C 64'])
    expect(hex(encodeCommand({ type: 'noteOff', channel: 2, data1: 60 }))).toEqual(['81 3C 00'])
    expect(hex(encodeCommand({ type: 'songSelect', channel: 1, data1: 3 }))).toEqual(['F3 03'])
    expect(hex(encodeCommand({ type: 'start', channel: 1 }))).toEqual(['FA'])
    expect(hex(encodeCommand({ type: 'stop', channel: 1 }))).toEqual(['FC'])
    expect(hex(encodeCommand({ type: 'continue', channel: 1 }))).toEqual(['FB'])
    expect(hex(encodeCommand({ type: 'sysex', channel: 1, sysex: '43 10 7F' }))).toEqual(['F0 43 10 7F F7'])
  })
  it('clamps values and uses the default channel', () => {
    expect(hex(encodeCommand({ type: 'programChange', channel: 0, data1: 300 }, 3))).toEqual(['C2 7F'])
  })
  it('encodes patch select with optional parts', () => {
    expect(hex(encodeCommand({ type: 'patchSelect', channel: 1, msb: 1, lsb: 2, data1: 3 }))).toEqual(['B0 00 01', 'B0 20 02', 'C0 03'])
    expect(hex(encodeCommand({ type: 'patchSelect', channel: 1, data1: 3 }))).toEqual(['C0 03'])
    expect(hex(encodeCommand({ type: 'bankSelect', channel: 1, msb: 4, data2: 5 }))).toEqual(['B0 00 04', 'B0 20 05'])
  })
  it('plans batches, pauses, gaps and clock', () => {
    const plan = planCommands(
      [
        { type: 'programChange', channel: 1, data1: 1 },
        { type: 'batch', channel: 1, children: [{ type: 'pause', channel: 1, delayMs: 500 }, { type: 'start', channel: 1 }] },
        { type: 'controlChange', channel: 1, data1: 1, data2: 1, sendOnLoad: false },
        { type: 'clockStart', channel: 1 },
      ],
      { gapMs: 10, onLoadOnly: true },
    )
    expect(plan.map((s) => (s.kind === 'send' ? toHex(s.bytes) : s.kind === 'wait' ? `wait${s.ms}` : s.kind))).toEqual([
      'C0 01',
      'wait10',
      'wait500',
      'FA',
      'wait10',
      'clockStart',
    ])
  })
})

describe('binding keys', () => {
  it('parses and validates keys', () => {
    expect(parseKey('ch1:cc:64:127')).toEqual({ channel: 1, type: 'cc', a: 64, b: 127 })
    expect(parseKey('note:60')).toEqual({ channel: undefined, type: 'note', a: 60 })
    expect(parseKey('pc:5')).toMatchObject({ type: 'pc', a: 5 })
    expect(parseKey('start')).toEqual({ type: 'start' })
    expect(parseKey('ch17:pc:5')).toBeNull()
    expect(parseKey('cc:200')).toBeNull()
    expect(parseKey('wat:1')).toBeNull()
  })
  it('matches events', () => {
    const pedalDown = decodeMessage([0xb0, 64, 127])!
    const pedalUp = decodeMessage([0xb0, 64, 0])!
    expect(matchKey(parseKey('cc:64')!, pedalDown)).toBe(true)
    expect(matchKey(parseKey('cc:64')!, pedalUp)).toBe(false)
    expect(matchKey(parseKey('ch2:cc:64:127')!, pedalDown)).toBe(false)
    expect(matchKey(parseKey('ch1:cc:64:127')!, pedalDown)).toBe(true)
    expect(matchKey(parseKey('note:60')!, decodeMessage([0x95, 60, 1])!)).toBe(true)
    expect(matchKey(parseKey('note:60')!, decodeMessage([0x95, 60, 0])!)).toBe(false)
    expect(matchKey(parseKey('sysex:f0 01 02 f7')!, decodeMessage([0xf0, 1, 2, 0xf7])!)).toBe(true)
  })
  it('builds keys from events and describes them', () => {
    expect(eventKey(decodeMessage([0xb0, 64, 127])!)).toBe('ch1:cc:64:127')
    expect(eventKey(decodeMessage([0xc1, 9])!, false)).toBe('pc:9')
    expect(eventKey(decodeMessage([0xf8])!)).toBeNull()
    expect(describeKey('ch1:cc:64:127')).toBe('CC 64 = 127 · ch 1')
    expect(describeKey('note:60')).toBe('Note C4')
    expect(noteName(69)).toBe('A4')
  })
})

describe('recall', () => {
  it('matches program changes and patch select with banks', () => {
    const banks = new Map<number, BankState>()
    const pc = decodeMessage([0xc0, 5])!
    expect(commandMatches({ type: 'programChange', channel: 1, data1: 5 }, pc)).toBe(true)
    expect(commandMatches({ type: 'programChange', channel: 2, data1: 5 }, pc)).toBe(false)
    const patch = { type: 'patchSelect' as const, channel: 1, msb: 1, data1: 5 }
    expect(commandMatches(patch, pc, banks.get(1))).toBe(false)
    updateBanks(banks, decodeMessage([0xb0, 0, 1])!)
    expect(commandMatches(patch, pc, banks.get(1))).toBe(true)
  })
  it('matches sysex, batches and transport', () => {
    expect(commandMatches({ type: 'sysex', channel: 1, sysex: 'F0 43 01 F7' }, decodeMessage([0xf0, 0x43, 1, 0xf7])!)).toBe(true)
    expect(
      commandMatches({ type: 'batch', channel: 1, children: [{ type: 'songSelect', channel: 1, data1: 2 }] }, decodeMessage([0xf3, 2])!),
    ).toBe(true)
    expect(commandMatches({ type: 'start', channel: 1 }, decodeMessage([0xfa])!)).toBe(true)
  })
  it('captures commands from events', () => {
    expect(commandFromEvent(decodeMessage([0xc3, 7])!)).toEqual({ type: 'programChange', channel: 4, data1: 7 })
    expect(commandFromEvent(decodeMessage([0xf8])!)).toBeNull()
    expect(describeCommand({ type: 'patchSelect', channel: 1, msb: 0, lsb: 3, data1: 9 })).toBe('Bank 0/3, Program 9 · ch 1')
  })
})
