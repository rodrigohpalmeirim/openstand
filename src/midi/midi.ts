/**
 * Web MIDI runtime: access/permission, port lists with hot-plug, sending (with pauses and timing
 * clock), receiving with fan-out to listeners, and a small monitor log for the UI.
 */
import { create } from 'zustand'
import type { MidiCommand } from '../db/schema'
import { settings, useSettings } from '../state/settings'
import { toast } from '../ui/primitives'
import { clockIntervalMs, decodeMessage, describeEvent, planCommands, toHex, type MidiEvent, type SendStep } from './codec'

export interface PortInfo {
  id: string
  name: string
  manufacturer: string
  connected: boolean
}

export interface MonitorEntry {
  id: number
  t: number
  dir: 'in' | 'out'
  port: string
  hex: string
  text: string
}

export type MidiStatus = 'off' | 'unsupported' | 'insecure' | 'requesting' | 'ready' | 'denied' | 'error'

interface MidiStore {
  status: MidiStatus
  /** SysEx permission granted */
  sysex: boolean
  error?: string
  inputs: PortInfo[]
  outputs: PortInfo[]
  log: MonitorEntry[]
  clockRunning: boolean
}

export const useMidi = create<MidiStore>(() => ({
  status: 'off',
  sysex: false,
  inputs: [],
  outputs: [],
  log: [],
  clockRunning: false,
}))

export function midiSupport(): 'ok' | 'unsupported' | 'insecure' {
  if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) return 'unsupported'
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure'
  return 'ok'
}

let access: MIDIAccess | null = null
let requesting: Promise<void> | null = null
type Listener = (e: MidiEvent, port: string, raw: Uint8Array) => void
const listeners = new Set<Listener>()
let logSeq = 0

/** Port selection: empty list = every port; entries match port name (stable across reconnects) or id. */
export function portEnabled(p: { id: string; name: string | null }, selected: string[]) {
  return !selected.length || (!!p.name && selected.includes(p.name)) || selected.includes(p.id)
}

function pushLog(dir: 'in' | 'out', port: string, bytes: Uint8Array, e?: MidiEvent | null) {
  const entry: MonitorEntry = {
    id: ++logSeq,
    t: Date.now(),
    dir,
    port,
    hex: toHex(bytes.length > 48 ? bytes.slice(0, 48) : bytes),
    text: e ? describeEvent(e) : toHex(bytes),
  }
  useMidi.setState((s) => ({ log: [...s.log.slice(-79), entry] }))
}

export function clearMonitor() {
  useMidi.setState({ log: [] })
}

function info(p: MIDIPort): PortInfo {
  return { id: p.id, name: p.name ?? p.id, manufacturer: p.manufacturer ?? '', connected: p.state === 'connected' }
}

function onMessage(this: MIDIInput, ev: MIDIMessageEvent) {
  if (!ev.data) return
  const raw = ev.data
  const e = decodeMessage(raw)
  if (!e) return
  // Clock and active sensing would flood the monitor and listeners.
  if (e.kind === 'clock' || e.kind === 'activeSensing') return
  if (!portEnabled(this, settings().midi.inputs)) return
  pushLog('in', this.name ?? '', raw, e)
  listeners.forEach((l) => {
    try {
      l(e, this.name ?? '', raw)
    } catch (err) {
      console.error(err)
    }
  })
}

function refreshPorts() {
  if (!access) return
  const inputs: PortInfo[] = []
  const outputs: PortInfo[] = []
  access.inputs.forEach((p) => {
    inputs.push(info(p))
    p.onmidimessage = onMessage
  })
  access.outputs.forEach((p) => outputs.push(info(p)))
  useMidi.setState({ inputs, outputs })
}

export function enableMidi(): Promise<void> {
  if (access) return Promise.resolve()
  if (requesting) return requesting
  const support = midiSupport()
  if (support !== 'ok') {
    useMidi.setState({ status: support })
    return Promise.resolve()
  }
  useMidi.setState({ status: 'requesting', error: undefined })
  requesting = (async () => {
    let sysex = true
    let a: MIDIAccess
    try {
      a = await navigator.requestMIDIAccess({ sysex: true })
    } catch {
      // SysEx permission is separate; fall back to plain MIDI rather than nothing.
      sysex = false
      try {
        a = await navigator.requestMIDIAccess({ sysex: false })
      } catch (err) {
        const denied = err instanceof DOMException && (err.name === 'SecurityError' || err.name === 'NotAllowedError')
        useMidi.setState({ status: denied ? 'denied' : 'error', error: String((err as Error)?.message ?? err) })
        return
      }
    }
    access = a
    a.onstatechange = (ev) => {
      const port = (ev as MIDIConnectionEvent).port
      const before = [...useMidi.getState().inputs, ...useMidi.getState().outputs].find((p) => p.id === port?.id)
      refreshPorts()
      if (port && port.type === 'input') {
        const was = before?.connected ?? false
        const now = port.state === 'connected'
        if (was !== now) toast(`MIDI device ${port.name} ${now ? 'connected' : 'disconnected'}`)
      }
    }
    useMidi.setState({ status: 'ready', sysex })
    refreshPorts()
  })().finally(() => {
    requesting = null
  })
  return requesting
}

export function disableMidi() {
  stopClock()
  if (access) {
    access.inputs.forEach((p) => {
      p.onmidimessage = null
    })
    access.onstatechange = null
  }
  access = null
  useMidi.setState({ status: 'off', inputs: [], outputs: [] })
}

/** Observe incoming messages. Returns an unsubscribe function. */
export function onMidi(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function targets(output?: string): MIDIOutput[] {
  if (!access) return []
  const sel = settings().midi.outputs
  const out: MIDIOutput[] = []
  access.outputs.forEach((p) => {
    if (p.state !== 'connected') return
    if (output ? p.name === output || p.id === output : portEnabled(p, sel)) out.push(p)
  })
  return out
}

/** Timestamp of the last song-command send (used for MIDI loop protection). */
export let lastSongSendAt = 0

export function sendBytes(bytes: Uint8Array, output?: string, timestamp?: number): number {
  if (bytes[0] === 0xf0 && !useMidi.getState().sysex) {
    toast('SysEx was not permitted by the browser; message skipped', 'error')
    return 0
  }
  const outs = targets(output)
  for (const o of outs) {
    try {
      o.send(bytes, timestamp)
    } catch (err) {
      console.warn('MIDI send failed', err)
    }
  }
  pushLog('out', outs.length === 1 ? outs[0].name ?? '' : `${outs.length} outputs`, bytes, decodeMessage(bytes))
  return outs.length
}

/* -------------------------------------------------------------- clock */

let clockTimer: ReturnType<typeof setInterval> | null = null

/** Send F8 at 24 PPQN using timestamped sends scheduled ~100 ms ahead for steady timing. */
export function startClock(bpm: number) {
  stopClock()
  const interval = clockIntervalMs(bpm)
  let next = performance.now() + 5
  const pump = () => {
    const horizon = performance.now() + 100
    const outs = targets()
    while (next < horizon) {
      for (const o of outs) {
        try {
          o.send([0xf8], next)
        } catch {
          /* port went away */
        }
      }
      next += interval
    }
  }
  pump()
  clockTimer = setInterval(pump, 25)
  useMidi.setState({ clockRunning: true })
}

export function stopClock() {
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = null
  if (useMidi.getState().clockRunning) useMidi.setState({ clockRunning: false })
}

/* ---------------------------------------------------------- sending */

let runToken = 0

export async function runSteps(steps: SendStep[], bpm: number) {
  const token = ++runToken
  for (const s of steps) {
    if (token !== runToken) return
    if (s.kind === 'send') sendBytes(s.bytes, s.output)
    else if (s.kind === 'wait') await new Promise((r) => setTimeout(r, s.ms))
    else if (s.kind === 'clockStart') startClock(bpm)
    else stopClock()
  }
}

/** Send a list of commands now (all of them, or just the send-on-load ones). */
export async function sendCommands(cmds: MidiCommand[], opts: { bpm?: number; onLoadOnly?: boolean } = {}) {
  if (!access) await enableMidi()
  if (!access) {
    toast('MIDI is not available', 'error')
    return
  }
  const m = settings().midi
  const steps = planCommands(cmds, { defaultChannel: m.defaultChannel, gapMs: m.commandGapMs, onLoadOnly: opts.onLoadOnly })
  if (!targets().length && steps.some((s) => s.kind === 'send')) toast('No MIDI output connected', 'error')
  lastSongSendAt = Date.now()
  await runSteps(steps, opts.bpm ?? settings().metronome.bpm)
}

export const midiReady = () => !!access

/** Keep access in sync with the enabled setting (called by the service). */
export function watchMidiSetting(): () => void {
  const apply = (on: boolean) => (on ? void enableMidi() : disableMidi())
  apply(settings().midi.enabled)
  return useSettings.subscribe((st, prev) => {
    if (st.s.midi.enabled !== prev.s.midi.enabled) apply(st.s.midi.enabled)
  })
}
