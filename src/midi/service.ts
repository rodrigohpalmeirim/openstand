/**
 * MIDI background service: sends song commands on open, recalls songs from incoming messages,
 * runs bound actions, and exposes a capture hook for "learn"/"listen" UIs.
 */
import { liveQuery } from 'dexie'
import { db } from '../db/db'
import type { MidiCommand, Song } from '../db/schema'
import { terms } from '../library/browse/terms'
import { registerService } from '../services'
import { settings, useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions, runAction, type ActionId } from '../viewer/actions'
import { on } from '../viewer/events'
import { commandMatches, isTriggerEvent, matchKey, parseKey, updateBanks, type BankState, type MidiEvent } from './codec'
import { songBpm } from '../tools/metronome/tempo'
import { lastSongSendAt, onMidi, sendCommands, stopClock, watchMidiSetting } from './midi'

type Capture = (e: MidiEvent, port: string) => void
const captures = new Set<Capture>()

/** While a capture is active, incoming messages go only to it (no actions, no song recall). */
export function startCapture(c: Capture): () => void {
  captures.add(c)
  return () => captures.delete(c)
}

const banks = new Map<number, BankState>()
let recallIndex: { id: string; title: string; triggers: MidiCommand[] }[] = []

/** Ignore recall triggers this long after we sent song commands (MIDI thru / echo loops). */
const LOOP_GUARD_MS = 1500

function recallTriggers(s: Song): MidiCommand[] {
  const t = s.midiOnLoad.filter((c) => c.loadOnReceive)
  if (s.midiRecall) t.unshift(s.midiRecall)
  return t
}

export function findRecallSong(e: MidiEvent): { id: string; title: string } | undefined {
  const bank = 'channel' in e ? banks.get(e.channel) : undefined
  return recallIndex.find((r) => r.triggers.some((c) => commandMatches(c, e, bank)))
}

function openSong(id: string, title: string) {
  const v = useViewer.getState()
  if (v.queue[v.index] === id) return
  const i = v.queue.indexOf(id)
  if (i >= 0) v.goSong(i)
  else v.open([id])
  toast(`MIDI: ${title}`)
}

function handle(e: MidiEvent, port: string) {
  if (!settings().midi.enabled) return
  if (captures.size) {
    captures.forEach((c) => c(e, port))
    return
  }
  const m = settings().midi
  if (m.receiveChannel && 'channel' in e && e.channel !== m.receiveChannel) return
  updateBanks(banks, e)
  if (!isTriggerEvent(e)) return

  for (const b of m.bindings) {
    const p = parseKey(b.message)
    if (p && matchKey(p, e)) runAction(b.action as ActionId, 'midi')
  }

  if (m.recallSongs && Date.now() - lastSongSendAt > LOOP_GUARD_MS) {
    const hit = findRecallSong(e)
    if (hit) openSong(hit.id, hit.title)
  }
}

async function sendSong(song: Song, onLoadOnly: boolean) {
  const bpm = songBpm(song) ?? settings().metronome.bpm
  await sendCommands(song.midiOnLoad, { bpm, onLoadOnly })
}

async function currentSong(): Promise<Song | undefined> {
  const v = useViewer.getState()
  const id = v.queue[v.index]
  return id ? db.songs.get(id) : undefined
}

/** Re-send the current song's commands (all of them, ignoring the send-on-load flag). */
export async function resendCurrentSong() {
  const s = await currentSong()
  if (!s) return
  if (!s.midiOnLoad.length) return toast(`This ${terms(settings()).song} has no MIDI commands`)
  await sendSong(s, false)
}

registerService(() => {
  const stops: (() => void)[] = [watchMidiSetting(), onMidi(handle)]

  stops.push(
    on('songOpened', ({ song }) => {
      const m = settings().midi
      if (!m.enabled || !m.sendOnLoad || !song.midiOnLoad?.length) return
      void sendSong(song, true)
    }),
    on('songClosed', () => stopClock()),
  )

  // Keep a small index of songs that can be recalled, only while recall is on.
  let sub: { unsubscribe(): void } | null = null
  const watchRecall = () => {
    const m = settings().midi
    const want = m.enabled && m.recallSongs
    if (want && !sub) {
      sub = liveQuery(() => db.songs.filter((s) => !!s.midiRecall || s.midiOnLoad.some((c) => c.loadOnReceive)).toArray()).subscribe({
        next: (songs) => {
          recallIndex = songs.map((s) => ({ id: s.id, title: s.title, triggers: recallTriggers(s) }))
        },
        error: (err) => console.warn('MIDI recall index failed', err),
      })
    } else if (!want && sub) {
      sub.unsubscribe()
      sub = null
      recallIndex = []
    }
  }
  watchRecall()
  stops.push(useSettings.subscribe(watchRecall), () => sub?.unsubscribe())

  // MIDI-friendly absolute start/stop actions built on the viewer's toggles.
  stops.push(
    registerActions({
      sendMidi: () => {
        if (!settings().midi.enabled) return toast('Turn on MIDI in Settings first')
        void resendCurrentSong()
      },
      startAutoScroll: () => !useViewer.getState().autoScrollOn && runAction('toggleAutoScroll', 'midi'),
      stopAutoScroll: () => useViewer.getState().autoScrollOn && runAction('toggleAutoScroll', 'midi'),
      startMetronome: () => !useViewer.getState().metronomeOn && runAction('toggleMetronome', 'midi'),
      stopMetronome: () => useViewer.getState().metronomeOn && runAction('toggleMetronome', 'midi'),
    }),
  )

  return () => stops.forEach((s) => s())
})
