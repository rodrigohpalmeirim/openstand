/**
 * Pure MIDI encode/decode helpers: bytes <-> events, song commands -> send plan, binding keys,
 * recall matching and human-readable descriptions. No Web MIDI access here (unit-tested).
 */
import type { MidiCommand, MidiMessageType } from '../db/schema'

export type MidiEvent =
  | { kind: 'noteOn'; channel: number; note: number; velocity: number }
  | { kind: 'noteOff'; channel: number; note: number; velocity: number }
  | { kind: 'cc'; channel: number; controller: number; value: number }
  | { kind: 'pc'; channel: number; program: number }
  | { kind: 'pitchBend'; channel: number; value: number }
  | { kind: 'sysex'; bytes: Uint8Array }
  | { kind: 'songSelect'; song: number }
  | { kind: 'start' | 'stop' | 'continue' | 'clock' | 'activeSensing' | 'reset' }
  | { kind: 'other'; bytes: Uint8Array }

const clamp7 = (n: number | undefined) => Math.max(0, Math.min(127, Math.round(n ?? 0)))
const chNibble = (ch: number | undefined) => Math.max(0, Math.min(15, Math.round(ch || 1) - 1))

/* ------------------------------------------------------------------ decode */

export function decodeMessage(data: Uint8Array | number[]): MidiEvent | null {
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data)
  if (!d.length) return null
  const status = d[0]
  if (status === 0xf0) return { kind: 'sysex', bytes: d }
  if (status >= 0xf8) {
    const rt: Record<number, MidiEvent['kind']> = { 0xf8: 'clock', 0xfa: 'start', 0xfb: 'continue', 0xfc: 'stop', 0xfe: 'activeSensing', 0xff: 'reset' }
    const k = rt[status]
    return k ? ({ kind: k } as MidiEvent) : { kind: 'other', bytes: d }
  }
  if (status === 0xf3) return { kind: 'songSelect', song: d[1] ?? 0 }
  if (status < 0x80) return { kind: 'other', bytes: d }
  const channel = (status & 0x0f) + 1
  switch (status & 0xf0) {
    case 0x80:
      return { kind: 'noteOff', channel, note: d[1] ?? 0, velocity: d[2] ?? 0 }
    case 0x90:
      // Note On with velocity 0 is a Note Off by convention.
      return (d[2] ?? 0) === 0
        ? { kind: 'noteOff', channel, note: d[1] ?? 0, velocity: 0 }
        : { kind: 'noteOn', channel, note: d[1] ?? 0, velocity: d[2] }
    case 0xb0:
      return { kind: 'cc', channel, controller: d[1] ?? 0, value: d[2] ?? 0 }
    case 0xc0:
      return { kind: 'pc', channel, program: d[1] ?? 0 }
    case 0xe0:
      return { kind: 'pitchBend', channel, value: ((d[2] ?? 0) << 7) | (d[1] ?? 0) }
    default:
      return { kind: 'other', bytes: d }
  }
}

/* ------------------------------------------------------------------- sysex */

export function toHex(bytes: Uint8Array | number[]): string {
  return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

/**
 * Parse user-typed SysEx hex ("F0 43 10 …F7", "f0,43,…", "0xF0 0x43"). F0/F7 framing is added when
 * missing so people can paste just the payload.
 */
export function parseSysex(text: string): { bytes: Uint8Array } | { error: string } {
  const tokens = text
    .trim()
    .replace(/0x/gi, ' ')
    .split(/[\s,;:]+/)
    .filter(Boolean)
  if (!tokens.length) return { error: 'Enter hex bytes, e.g. F0 7E 7F 06 01 F7' }
  // Allow a compact run of hex digits ("F07E7F0601F7").
  const parts = tokens.length === 1 && tokens[0].length > 2 ? tokens[0].match(/.{1,2}/g) ?? [] : tokens
  const out: number[] = []
  for (const p of parts) {
    if (!/^[0-9a-f]{1,2}$/i.test(p)) return { error: `"${p}" is not a hex byte` }
    out.push(parseInt(p, 16))
  }
  if (out[0] !== 0xf0) out.unshift(0xf0)
  if (out[out.length - 1] !== 0xf7) out.push(0xf7)
  for (let i = 1; i < out.length - 1; i++)
    if (out[i] > 0x7f) return { error: `Byte ${i + 1} (${toHex([out[i]])}) must be below 80 inside a SysEx message` }
  if (out.length < 3) return { error: 'SysEx message is empty' }
  return { bytes: Uint8Array.from(out) }
}

/* ------------------------------------------------------------------ encode */

/** Raw messages for one (non-batch, non-pause, non-clock) command. */
export function encodeCommand(cmd: MidiCommand, defaultChannel = 1): Uint8Array[] {
  const ch = chNibble(cmd.channel || defaultChannel)
  const msg = (...b: number[]) => Uint8Array.from(b)
  switch (cmd.type) {
    case 'programChange':
      return [msg(0xc0 | ch, clamp7(cmd.data1))]
    case 'controlChange':
      return [msg(0xb0 | ch, clamp7(cmd.data1), clamp7(cmd.data2))]
    case 'noteOn':
      return [msg(0x90 | ch, clamp7(cmd.data1), cmd.data2 === undefined ? 100 : Math.max(1, clamp7(cmd.data2)))]
    case 'noteOff':
      return [msg(0x80 | ch, clamp7(cmd.data1), clamp7(cmd.data2))]
    case 'bankSelect':
    case 'patchSelect': {
      const out: Uint8Array[] = []
      const lsb = cmd.lsb ?? (cmd.type === 'bankSelect' ? cmd.data2 : undefined)
      if (cmd.msb !== undefined) out.push(msg(0xb0 | ch, 0, clamp7(cmd.msb)))
      if (lsb !== undefined) out.push(msg(0xb0 | ch, 32, clamp7(lsb)))
      if (cmd.data1 !== undefined) out.push(msg(0xc0 | ch, clamp7(cmd.data1)))
      return out
    }
    case 'sysex': {
      const r = parseSysex(cmd.sysex ?? '')
      return 'bytes' in r ? [r.bytes] : []
    }
    case 'songSelect':
      return [msg(0xf3, clamp7(cmd.data1))]
    case 'start':
      return [msg(0xfa)]
    case 'continue':
      return [msg(0xfb)]
    case 'stop':
      return [msg(0xfc)]
    default:
      return []
  }
}

export type SendStep =
  | { kind: 'send'; bytes: Uint8Array; output?: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'clockStart' }
  | { kind: 'clockStop' }

/**
 * Turn a command list into an ordered plan. Batches expand in place, pauses become waits, and an
 * optional `gapMs` is inserted between top-level commands.
 */
export function planCommands(cmds: MidiCommand[], opts: { defaultChannel?: number; gapMs?: number; onLoadOnly?: boolean } = {}): SendStep[] {
  const steps: SendStep[] = []
  const add = (c: MidiCommand, depth: number) => {
    switch (c.type) {
      case 'pause':
        if ((c.delayMs ?? 0) > 0) steps.push({ kind: 'wait', ms: c.delayMs! })
        return
      case 'batch':
        if (depth === 0) for (const ch of c.children ?? []) add(ch, depth + 1)
        return
      case 'clockStart':
        steps.push({ kind: 'clockStart' })
        return
      case 'clockStop':
        steps.push({ kind: 'clockStop' })
        return
      default:
        for (const bytes of encodeCommand(c, opts.defaultChannel)) steps.push({ kind: 'send', bytes, output: c.output || undefined })
    }
  }
  const top = opts.onLoadOnly ? cmds.filter((c) => c.sendOnLoad !== false) : cmds
  top.forEach((c, i) => {
    if (i > 0 && opts.gapMs) steps.push({ kind: 'wait', ms: opts.gapMs })
    add(c, 0)
  })
  return steps
}

/** MIDI clock interval for a tempo (24 pulses per quarter note). */
export const clockIntervalMs = (bpm: number) => 60000 / (Math.max(1, bpm) * 24)

/* ---------------------------------------------------------- binding keys */

/**
 * Binding keys are short strings stored in settings: `[chN:]type[:a[:b]]`, e.g. "ch1:cc:64:127",
 * "cc:64" (any non-zero value), "note:60", "pc:5", "songselect:3", "start", "sysex:F0 …F7".
 */
export interface KeyPattern {
  channel?: number
  type: 'cc' | 'note' | 'noteoff' | 'pc' | 'songselect' | 'start' | 'stop' | 'continue' | 'sysex'
  a?: number
  b?: number
  sysex?: string
}

export function parseKey(key: string): KeyPattern | null {
  let rest = key.trim().toLowerCase()
  let channel: number | undefined
  const m = /^ch(\d{1,2}):/.exec(rest)
  if (m) {
    channel = Number(m[1])
    if (channel < 1 || channel > 16) return null
    rest = rest.slice(m[0].length)
  }
  const [type, ...args] = rest.split(':')
  if (type === 'sysex') {
    const r = parseSysex(args.join(':'))
    return 'bytes' in r ? { type, sysex: toHex(r.bytes) } : null
  }
  const nums = args.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 127)) return null
  switch (type) {
    case 'cc':
      if (nums.length < 1 || nums.length > 2) return null
      return { channel, type, a: nums[0], b: nums[1] }
    case 'note':
    case 'noteoff':
    case 'pc':
    case 'songselect':
      if (nums.length !== 1) return null
      return { channel, type, a: nums[0] }
    case 'start':
    case 'stop':
    case 'continue':
      return nums.length ? null : { type }
    default:
      return null
  }
}

export function matchKey(p: KeyPattern, e: MidiEvent): boolean {
  if (p.channel && 'channel' in e && e.channel !== p.channel) return false
  switch (p.type) {
    case 'cc':
      return e.kind === 'cc' && e.controller === p.a && (p.b === undefined ? e.value > 0 : e.value === p.b)
    case 'note':
      return e.kind === 'noteOn' && e.note === p.a
    case 'noteoff':
      return e.kind === 'noteOff' && e.note === p.a
    case 'pc':
      return e.kind === 'pc' && e.program === p.a
    case 'songselect':
      return e.kind === 'songSelect' && e.song === p.a
    case 'sysex':
      return e.kind === 'sysex' && toHex(e.bytes) === p.sysex
    default:
      return e.kind === p.type
  }
}

/** Key for a captured event (learn mode), or null for events that can't trigger anything. */
export function eventKey(e: MidiEvent, withChannel = true): string | null {
  const ch = withChannel && 'channel' in e ? `ch${e.channel}:` : ''
  switch (e.kind) {
    case 'cc':
      return `${ch}cc:${e.controller}:${e.value}`
    case 'noteOn':
      return `${ch}note:${e.note}`
    case 'pc':
      return `${ch}pc:${e.program}`
    case 'songSelect':
      return `songselect:${e.song}`
    case 'start':
    case 'stop':
    case 'continue':
      return e.kind
    case 'sysex':
      return `sysex:${toHex(e.bytes)}`
    default:
      return null
  }
}

/** True for events worth reacting to (learn / bindings ignore clock, sensing, releases). */
export function isTriggerEvent(e: MidiEvent): boolean {
  if (e.kind === 'cc') return e.value > 0
  return ['noteOn', 'pc', 'songSelect', 'start', 'stop', 'continue', 'sysex'].includes(e.kind)
}

export function describeKey(key: string): string {
  const p = parseKey(key)
  if (!p) return key
  const ch = p.channel ? ` · ch ${p.channel}` : ''
  switch (p.type) {
    case 'cc':
      return `CC ${p.a}${p.b === undefined ? '' : ` = ${p.b}`}${ch}`
    case 'note':
      return `Note ${noteName(p.a!)}${ch}`
    case 'noteoff':
      return `Note off ${noteName(p.a!)}${ch}`
    case 'pc':
      return `Program ${p.a}${ch}`
    case 'songselect':
      return `Song select ${p.a}`
    case 'sysex':
      return `SysEx ${shorten(p.sysex!)}`
    default:
      return p.type[0].toUpperCase() + p.type.slice(1)
  }
}

/* ------------------------------------------------------------- recall/learn */

export interface BankState {
  msb?: number
  lsb?: number
}

/** Track Bank Select CCs per channel so Patch Select recall can require a bank. */
export function updateBanks(banks: Map<number, BankState>, e: MidiEvent) {
  if (e.kind !== 'cc' || (e.controller !== 0 && e.controller !== 32)) return
  const b = banks.get(e.channel) ?? {}
  if (e.controller === 0) b.msb = e.value
  else b.lsb = e.value
  banks.set(e.channel, b)
}

/** Does an incoming event match a command used as a "load on receive" trigger? */
export function commandMatches(cmd: MidiCommand, e: MidiEvent, bank?: BankState): boolean {
  const chOk = (ch: number) => !cmd.channel || cmd.channel === ch
  switch (cmd.type) {
    case 'programChange':
      return e.kind === 'pc' && chOk(e.channel) && e.program === (cmd.data1 ?? 0)
    case 'bankSelect':
    case 'patchSelect': {
      if (e.kind !== 'pc' || !chOk(e.channel) || cmd.data1 === undefined || e.program !== cmd.data1) return false
      const lsb = cmd.lsb ?? (cmd.type === 'bankSelect' ? cmd.data2 : undefined)
      if (cmd.msb !== undefined && bank?.msb !== cmd.msb) return false
      if (lsb !== undefined && bank?.lsb !== lsb) return false
      return true
    }
    case 'controlChange':
      return e.kind === 'cc' && chOk(e.channel) && e.controller === (cmd.data1 ?? 0) && (cmd.data2 === undefined || e.value === cmd.data2)
    case 'noteOn':
      return e.kind === 'noteOn' && chOk(e.channel) && e.note === (cmd.data1 ?? 0)
    case 'noteOff':
      return e.kind === 'noteOff' && chOk(e.channel) && e.note === (cmd.data1 ?? 0)
    case 'songSelect':
      return e.kind === 'songSelect' && e.song === (cmd.data1 ?? 0)
    case 'sysex': {
      if (e.kind !== 'sysex') return false
      const r = parseSysex(cmd.sysex ?? '')
      return 'bytes' in r && toHex(r.bytes) === toHex(e.bytes)
    }
    case 'start':
    case 'stop':
    case 'continue':
      return e.kind === cmd.type
    case 'batch':
      return (cmd.children ?? []).some((c) => c.type !== 'batch' && commandMatches(c, e, bank))
    default:
      return false
  }
}

/** Command captured from an incoming event (Listen button). */
export function commandFromEvent(e: MidiEvent): MidiCommand | null {
  switch (e.kind) {
    case 'pc':
      return { type: 'programChange', channel: e.channel, data1: e.program }
    case 'cc':
      return { type: 'controlChange', channel: e.channel, data1: e.controller, data2: e.value }
    case 'noteOn':
      return { type: 'noteOn', channel: e.channel, data1: e.note, data2: e.velocity }
    case 'noteOff':
      return { type: 'noteOff', channel: e.channel, data1: e.note }
    case 'songSelect':
      return { type: 'songSelect', channel: 1, data1: e.song }
    case 'sysex':
      return e.bytes.length > 2 ? { type: 'sysex', channel: 1, sysex: toHex(e.bytes) } : null
    case 'start':
    case 'stop':
    case 'continue':
      return { type: e.kind, channel: 1 }
    default:
      return null
  }
}

/* --------------------------------------------------------------- describe */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** MIDI note number -> name, middle C (60) = C4. */
export function noteName(n: number) {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`
}

function shorten(hex: string, max = 24) {
  return hex.length > max ? `${hex.slice(0, max)}…` : hex
}

export const COMMAND_TYPES: { type: MidiMessageType; label: string; hint: string }[] = [
  { type: 'programChange', label: 'Program change', hint: 'Select a patch / preset' },
  { type: 'patchSelect', label: 'Patch select (bank + program)', hint: 'Bank MSB/LSB then program' },
  { type: 'controlChange', label: 'Control change', hint: 'CC number and value' },
  { type: 'noteOn', label: 'Note on', hint: 'Trigger a note or pad' },
  { type: 'noteOff', label: 'Note off', hint: '' },
  { type: 'sysex', label: 'System exclusive', hint: 'Raw hex bytes' },
  { type: 'songSelect', label: 'Song select', hint: 'Sequencer song number' },
  { type: 'start', label: 'MIDI start', hint: '' },
  { type: 'continue', label: 'MIDI continue', hint: '' },
  { type: 'stop', label: 'MIDI stop', hint: '' },
  { type: 'clockStart', label: 'Start clock', hint: 'Sends timing clock at the song tempo' },
  { type: 'clockStop', label: 'Stop clock', hint: '' },
  { type: 'pause', label: 'Pause', hint: 'Wait before the next command' },
  { type: 'batch', label: 'Group', hint: 'Several commands as one' },
]

export const typeLabel = (t: MidiMessageType) =>
  t === 'bankSelect' ? 'Bank select' : COMMAND_TYPES.find((c) => c.type === t)?.label ?? t

/** Types that can act as a "load song on receive" trigger. */
export const RECALLABLE: MidiMessageType[] = ['programChange', 'patchSelect', 'bankSelect', 'controlChange', 'noteOn', 'noteOff', 'sysex', 'songSelect', 'start', 'stop', 'continue', 'batch']

export function describeCommand(c: MidiCommand): string {
  const ch = ` · ch ${c.channel || 1}`
  switch (c.type) {
    case 'programChange':
      return `Program ${c.data1 ?? 0}${ch}`
    case 'bankSelect':
    case 'patchSelect': {
      const parts: string[] = []
      const lsb = c.lsb ?? (c.type === 'bankSelect' ? c.data2 : undefined)
      if (c.msb !== undefined || lsb !== undefined) parts.push(`Bank ${c.msb ?? '–'}/${lsb ?? '–'}`)
      if (c.data1 !== undefined) parts.push(`Program ${c.data1}`)
      return (parts.join(', ') || 'Patch select') + ch
    }
    case 'controlChange':
      return `CC ${c.data1 ?? 0} = ${c.data2 ?? 0}${ch}`
    case 'noteOn':
      return `Note on ${noteName(c.data1 ?? 60)}${c.data2 !== undefined ? ` vel ${c.data2}` : ''}${ch}`
    case 'noteOff':
      return `Note off ${noteName(c.data1 ?? 60)}${ch}`
    case 'sysex':
      return `SysEx ${shorten(c.sysex ?? '')}`
    case 'songSelect':
      return `Song select ${c.data1 ?? 0}`
    case 'pause':
      return `Pause ${((c.delayMs ?? 0) / 1000).toFixed(c.delayMs && c.delayMs % 1000 ? 2 : 0)} s`
    case 'batch':
      return `Group of ${c.children?.length ?? 0}`
    case 'clockStart':
      return 'Start clock'
    case 'clockStop':
      return 'Stop clock'
    default:
      return typeLabel(c.type)
  }
}

export function describeEvent(e: MidiEvent): string {
  switch (e.kind) {
    case 'noteOn':
      return `Note on ${noteName(e.note)} (${e.note}) vel ${e.velocity} · ch ${e.channel}`
    case 'noteOff':
      return `Note off ${noteName(e.note)} (${e.note}) · ch ${e.channel}`
    case 'cc':
      return `CC ${e.controller} = ${e.value} · ch ${e.channel}`
    case 'pc':
      return `Program ${e.program} · ch ${e.channel}`
    case 'pitchBend':
      return `Pitch bend ${e.value} · ch ${e.channel}`
    case 'sysex':
      return `SysEx ${shorten(toHex(e.bytes), 36)}`
    case 'songSelect':
      return `Song select ${e.song}`
    case 'other':
      return toHex(e.bytes)
    default:
      return e.kind[0].toUpperCase() + e.kind.slice(1)
  }
}

/** A fresh command of the given type with sensible defaults. */
export function newCommand(type: MidiMessageType, channel = 1): MidiCommand {
  switch (type) {
    case 'programChange':
      return { type, channel, data1: 0 }
    case 'patchSelect':
      return { type, channel, msb: 0, lsb: 0, data1: 0 }
    case 'controlChange':
      return { type, channel, data1: 7, data2: 100 }
    case 'noteOn':
      return { type, channel, data1: 60, data2: 100 }
    case 'noteOff':
      return { type, channel, data1: 60 }
    case 'sysex':
      return { type, channel, sysex: 'F0 7E 7F 06 01 F7' }
    case 'songSelect':
      return { type, channel, data1: 0 }
    case 'pause':
      return { type, channel, delayMs: 500 }
    case 'batch':
      return { type, channel, children: [] }
    default:
      return { type, channel }
  }
}
