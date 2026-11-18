/**
 * Pen presence while reading. A pen always writes; fingers, pedals and keys always navigate. A pen
 * coming near the screen (hover) or touching it wakes the quick palette; it goes back to sleep a few
 * seconds after the pen was last seen, and the tool falls back to the pen.
 *
 * This file is the contract between the input side (viewer, annotation layer) and the palette UI.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { settings, useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { flush, useAnnotUI } from './store'

export interface PenState {
  /** The quick palette is showing: a pen is near, or was used moments ago. Always false in the full annotation mode. */
  awake: boolean
  /** A pen is in range (hovering or touching) and moved recently: finger input on the page is ignored. */
  present: boolean
}

export const usePen = create<PenState>(() => ({ awake: false, present: false }))

/* ------------------------------------------------------------ State machine */

export const PEN_TIMING = {
  /** A hovering pen wakes the palette once it has been in range this long (a pen passing by doesn't). */
  dwell: 150,
  /** The palette sleeps this long after the last pen event or poke. */
  idle: 4000,
  /** A pen in range counts as present for this long after its last event (a pen lying on the glass sends none). */
  recent: 2000,
  /** A pen that reports no hover counts as present for this long after its last contact event. */
  palm: 800,
} as const

export interface PenModel {
  awake: boolean
  /** The pen is touching the screen. */
  down: boolean
  /** The pen is hovering or touching, as far as its events say. */
  inRange: boolean
  /** It reported hover since it came into range (many pens and tablets never do). */
  hovered: boolean
  /** When it came into range. */
  rangeSince: number
  /** Last pen event of any kind. */
  lastEvent: number
  /** Last event while touching (down, move, up). */
  lastContact: number
  /** Last pen event or poke: the idle countdown runs from here. */
  lastActivity: number
  /** Dismissed by hand: hover alone doesn't wake it again until the pen leaves range or touches. */
  snoozed: boolean
}

export const PEN_IDLE: PenModel = {
  awake: false,
  down: false,
  inRange: false,
  hovered: false,
  rangeSince: 0,
  lastEvent: -Infinity,
  lastContact: -Infinity,
  lastActivity: -Infinity,
  snoozed: false,
}

export type PenEvent = {
  /**
   * hover: a pen event without contact · down/move/up: contact · leave: the pen left range ·
   * poke: someone used the palette · sleep: dismiss now · tick: time passed.
   */
  type: 'hover' | 'down' | 'move' | 'up' | 'leave' | 'poke' | 'sleep' | 'tick'
  /** Timestamp in ms (any monotonic clock). */
  t: number
}

export interface PenEnv {
  /** The full annotation mode is on: its toolbar replaces the palette, so nothing wakes. */
  explicit: boolean
  /** Something keeps the palette up: a `holdAwake()`, a text being edited, a gesture in progress. */
  held: boolean
}

export function penReduce(m: PenModel, e: PenEvent, env: PenEnv): PenModel {
  const t = e.t
  let n = m
  const seen = (contact: boolean): PenModel => ({
    ...m,
    inRange: true,
    rangeSince: m.inRange ? m.rangeSince : t,
    lastEvent: t,
    lastActivity: t,
    lastContact: contact ? t : m.lastContact,
  })
  switch (e.type) {
    case 'hover':
      // A hover event while "down" means the lift was missed.
      n = { ...seen(false), hovered: true, down: false }
      break
    case 'down':
    case 'move':
      n = { ...seen(true), down: true, awake: true, snoozed: false }
      break
    case 'up':
      n = { ...seen(true), down: false }
      break
    case 'leave':
      // A pen that hovers is gone the moment it leaves; one that doesn't "leaves" at every lift, so its
      // palm window runs on from the last contact.
      n = { ...m, inRange: false, down: false, hovered: false, snoozed: false, lastActivity: t, lastContact: m.hovered ? -Infinity : m.lastContact }
      break
    case 'poke':
      n = { ...m, lastActivity: t }
      break
    case 'sleep':
      n = m.awake ? { ...m, awake: false, snoozed: m.inRange } : m
      break
    case 'tick':
      break
  }
  if (env.explicit) return n.awake ? { ...n, awake: false } : n
  if (!n.awake) {
    // In range for the dwell and still sending events: a pen left lying on the glass doesn't wake anything.
    const dwelt = n.inRange && n.hovered && !n.snoozed && t - n.rangeSince >= PEN_TIMING.dwell && t - n.lastEvent < PEN_TIMING.recent
    if (dwelt) n = { ...n, awake: true }
  } else if (!n.down && !env.held && t - n.lastActivity >= PEN_TIMING.idle) {
    n = { ...n, awake: false }
  }
  return n
}

/** Fingers on the page are ignored while this is true (see `PenState.present`). */
export function penPresent(m: PenModel, now: number): boolean {
  if (m.down) return true
  if (m.inRange && m.hovered) return now - m.lastEvent < PEN_TIMING.recent
  return !m.hovered && now - m.lastContact < PEN_TIMING.palm
}

/** When the state next changes by time alone (wake after the dwell, sleep, presence running out), or null. */
export function penDeadline(m: PenModel, now: number, env: PenEnv): number | null {
  const at: number[] = []
  if (!m.awake && !env.explicit && m.inRange && m.hovered && !m.snoozed) at.push(m.rangeSince + PEN_TIMING.dwell)
  if (m.awake && !m.down && !env.held) at.push(m.lastActivity + PEN_TIMING.idle)
  if (!m.down) {
    if (m.inRange && m.hovered) at.push(m.lastEvent + PEN_TIMING.recent)
    else if (!m.hovered) at.push(m.lastContact + PEN_TIMING.palm)
  }
  // A deadline that just passed still needs its tick; older ones have been handled.
  const due = at.filter((x) => Number.isFinite(x) && x > now - 1)
  return due.length ? Math.max(now, Math.min(...due)) : null
}

/* ----------------------------------------------------------------- Runtime */

let model: PenModel = PEN_IDLE
let enabled = false
let holds = 0
let contacts = 0
let timer: ReturnType<typeof setTimeout> | undefined
let timerAt = Infinity

const clock = () => performance.now()
const env = (): PenEnv => ({ explicit: useViewer.getState().annotating, held: holds > 0 || !!useAnnotUI.getState().editing })

/** Back to the resting state: the pen tool (its colour and width are kept), nothing selected, everything saved. */
export function restPen() {
  if (settings().annotations.tool !== 'pen') useSettings.getState().setIn('annotations', { tool: 'pen' })
  const ui = useAnnotUI.getState()
  if (ui.selection || ui.tempEraser) useAnnotUI.setState({ selection: null, tempEraser: false })
  void flush()
}

function publish(was: boolean) {
  const now = clock()
  const next = { awake: model.awake, present: enabled && penPresent(model, now) }
  const cur = usePen.getState()
  if (cur.awake !== next.awake || cur.present !== next.present) usePen.setState(next)
  // Entering the full mode hides the palette without a reset: the chosen tool carries over to the toolbar.
  if (was && !model.awake && !useViewer.getState().annotating) restPen()
  schedule(now)
}

function schedule(now: number) {
  const at = enabled ? penDeadline(model, now, env()) : null
  if (at === null) {
    clearTimeout(timer)
    timer = undefined
    timerAt = Infinity
    return
  }
  // Pen events arrive hundreds of times a second and only ever push deadlines back: a timer that fires
  // early just ticks and re-arms, so it is replaced only when something is due sooner.
  if (timer !== undefined && timerAt <= at) return
  clearTimeout(timer)
  timerAt = at
  timer = setTimeout(() => {
    timer = undefined
    timerAt = Infinity
    dispatch('tick')
  }, Math.max(0, at - now) + 1)
}

function dispatch(type: PenEvent['type']) {
  if (!enabled) return
  const was = model.awake
  model = penReduce(model, { type, t: clock() }, env())
  publish(was)
}

/** Restart the idle countdown, e.g. on any interaction with the palette. */
export function pokePen(): void {
  dispatch('poke')
}

/** Keep the palette awake until the returned function is called (open popover, palette being dragged). */
export function holdAwake(): () => void {
  let released = false
  holds++
  schedule(clock())
  return () => {
    if (released) return
    released = true
    holds--
    // The countdown starts over once nothing holds it.
    dispatch('poke')
  }
}

/** Put the palette to sleep now. */
export function sleepPen(): void {
  dispatch('sleep')
}

/**
 * Goes up each time a pen touches down. A finger that was on the page before that is a resting hand:
 * whoever follows it compares the count from when it landed.
 */
export const penContactCount = () => contacts

/** Exact presence right now (the store's `present` can trail by a timer tick). */
export function isPenPresent(): boolean {
  return enabled && penPresent(model, clock())
}

/** This pointer is a pen that writes on the page: it never taps, turns pages or follows links. */
export function penWrites(e: PointerEvent): boolean {
  return enabled && e.pointerType === 'pen'
}

/** Palm rejection: a touch that lands while a pen is present is not a gesture, for its whole life. */
export function touchBlockedByPen(e: PointerEvent): boolean {
  return e.pointerType === 'touch' && settings().annotations.palmRejection && isPenPresent()
}

function onPointer(e: PointerEvent) {
  if (e.pointerType !== 'pen') return
  switch (e.type) {
    case 'pointerdown':
      contacts++
      return dispatch('down')
    case 'pointermove':
      return dispatch(e.buttons ? 'move' : 'hover')
    case 'pointerup':
    case 'pointercancel':
      return dispatch('up')
    case 'pointerout':
      // No related target: the pen left hover range (or, for a pen without hover, lifted).
      if (!e.relatedTarget) dispatch('leave')
  }
}

const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerout'] as const

// Leaving the full annotation mode rests the tool like falling asleep does.
useViewer.subscribe((v, prev) => {
  if (prev.annotating && !v.annotating) restPen()
})

/**
 * Track the pen while a song is open (`on`; off under performance lock). Mounted once, by the viewer.
 * Listens in the capture phase on the window, so the state is current before any handler on the page runs.
 */
export function usePenPresence(on: boolean) {
  useEffect(() => {
    if (!on) return
    enabled = true
    model = PEN_IDLE
    for (const t of POINTER_EVENTS) window.addEventListener(t, onPointer, true)
    // Entering or leaving the full mode, or a text edit ending, changes what the timers wait for.
    const unViewer = useViewer.subscribe((v, prev) => {
      if (v.annotating !== prev.annotating) dispatch('tick')
    })
    const unEdit = useAnnotUI.subscribe((u, prev) => {
      if (!u.editing !== !prev.editing) dispatch(u.editing ? 'tick' : 'poke')
    })
    return () => {
      for (const t of POINTER_EVENTS) window.removeEventListener(t, onPointer, true)
      unViewer()
      unEdit()
      const was = model.awake
      model = PEN_IDLE
      enabled = false
      publish(was)
    }
  }, [on])
}
