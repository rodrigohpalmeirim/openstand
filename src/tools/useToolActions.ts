import { useEffect, useRef } from 'react'
import { db, updateSong } from '../db/db'
import type { Song } from '../db/schema'
import { terms } from '../library/browse/terms'
import { settings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { toast } from '../ui/primitives'
import { registerActions } from '../viewer/actions'
import { viewerApi } from '../viewer/api'
import type { PanelProps } from '../viewer/panels'
import { player, stepTrack, useAudio } from './audio/player'
import { stepFactor } from './autoScroll/math'
import { followLink, stepSmartButton } from './commands'
import { metronome, songMetronome, useMetronome } from './metronome/engine'
import { nextTempoIndex, retempo, tapTempo } from './metronome/tempo'
import { linkToActivate, nextBookmark, prevBookmark, visiblePages } from './navigation'
import { useTools } from './store'

let taps: number[] = []
let tempoWrites = Promise.resolve()

/**
 * Save a metronome tempo change into the song's tempo list (see `retempo`). Writes run one after another
 * against the stored song, so a dragged slider edits the same entry throughout.
 */
export function saveTempo(songId: string, from: number, to: number) {
  tempoWrites = tempoWrites
    .then(async () => {
      const s = await db.songs.get(songId)
      if (s) await updateSong(songId, retempo(s, from, to))
    })
    .catch((e) => console.warn('saving tempo failed', e))
}

/** Apply a tap-tempo tap to the current song (saved per song). */
export function tap(song: Song) {
  const r = tapTempo(taps, performance.now())
  taps = r.taps
  if (r.bpm === null) return null
  const cfg = songMetronome(song)
  const from = metronome.songId === song.id ? useMetronome.getState().bpm : cfg.bpm
  metronome.configure({ ...cfg, bpm: r.bpm }, song.id)
  saveTempo(song.id, from, r.bpm)
  return r.bpm
}

/** Start/stop. The engine is configured for the song when it opens (see service.ts) and by the panel. */
export function startMetronomeFor(song: Song) {
  if (!metronome.running && metronome.songId !== song.id) metronome.configure(songMetronome(song), song.id)
  metronome.toggle()
}

/**
 * Pedal/keyboard/MIDI/touch handlers for the performance tools. The viewer itself owns page/song
 * navigation; start/stop metronome and auto-scroll are registered by the MIDI service on top of the
 * toggles registered here.
 */
export function useToolActions(props: PanelProps) {
  const live = useRef(props)
  live.current = props

  useEffect(() => {
    const song = () => live.current.song
    const visible = () => {
      const p = live.current
      return visiblePages(p.stops, p.pos, p.paged, p.currentPage)
    }
    return registerActions({
      toggleMetronome: () => startMetronomeFor(song()),
      tapTempo: () => {
        const bpm = tap(song())
        toast(bpm ? `${bpm} BPM` : 'Keep tapping…')
      },
      nextTempo: () => {
        const s = song()
        const tempos = (s.tempos ?? []).filter((t) => t > 0)
        if (!tempos.length) return toast(`No tempos saved for this ${terms(settings()).song}`)
        const i = nextTempoIndex(tempos, useMetronome.getState().bpm)
        metronome.configure({ ...metronome.cfg, bpm: tempos[i] })
        toast(`Tempo ${i + 1}/${tempos.length}: ${tempos[i]} BPM`)
      },
      toggleAutoScroll: () => useViewer.setState({ autoScrollOn: !useViewer.getState().autoScrollOn }),
      autoScrollFaster: () => {
        const f = stepFactor(useTools.getState().scrollFactor, 1)
        useTools.setState({ scrollFactor: f })
        toast(`Scroll speed ${Math.round(f * 100)}%`)
      },
      autoScrollSlower: () => {
        const f = stepFactor(useTools.getState().scrollFactor, -1)
        useTools.setState({ scrollFactor: f })
        toast(`Scroll speed ${Math.round(f * 100)}%`)
      },
      toggleAudio: () => void player.toggle(song()),
      audioRewind: () => player.skip(-settings().audio.skipSeconds),
      audioForward: () => player.skip(settings().audio.skipSeconds),
      audioVolumeUp: () => {
        player.setVolume(useAudio.getState().volume + 0.05)
        toast(`Volume ${Math.round(useAudio.getState().volume * 100)}%`)
      },
      audioVolumeDown: () => {
        player.setVolume(useAudio.getState().volume - 0.05)
        toast(`Volume ${Math.round(useAudio.getState().volume * 100)}%`)
      },
      prevAudioTrack: () => void stepTrack(song(), -1),
      nextAudioTrack: () => void stepTrack(song(), 1),
      toggleAudioPlayer: () => useTools.setState({ playerVisible: !useTools.getState().playerVisible }),
      nextBookmark: () => {
        const b = nextBookmark(song().bookmarks, visible())
        if (!b) return toast('No more bookmarks')
        viewerApi()?.goToPage(b.pageIndex)
        toast(b.name)
      },
      prevBookmark: () => {
        const b = prevBookmark(song().bookmarks, visible())
        if (!b) return toast('No earlier bookmarks')
        viewerApi()?.goToPage(b.pageIndex)
        toast(b.name)
      },
      activateLinkOrTurn: () => {
        const s = song()
        const i = linkToActivate(s.links, useTools.getState().linkPointer, visible())
        if (i < 0) viewerApi()?.next()
        else followLink(s, i)
      },
      followLink: () => {
        const s = song()
        const p = useTools.getState().linkPointer
        if (!s.links.length) return toast(`This ${terms(settings()).song} has no link points`)
        if (p >= s.links.length) return toast('End of link points')
        followLink(s, p)
      },
      resetLinks: () => {
        useTools.setState({ linkPointer: 0 })
        toast('Link points reset')
      },
      nextSmartButton: () => stepSmartButton(song(), 1),
      prevSmartButton: () => stepSmartButton(song(), -1),
      showNotesPopup: () => {
        if (!song().notes.trim()) return toast(`This ${terms(settings()).song} has no notes`)
        useTools.setState({ notesPopup: !useTools.getState().notesPopup })
      },
    })
  }, [])
}
