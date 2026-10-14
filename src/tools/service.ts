import { registerService } from '../services'
import { settings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { on } from '../viewer/events'
import { player, useAudio } from './audio/player'
import { songAutoScroll } from './autoScroll/config'
import { metronome, songMetronome } from './metronome/engine'
import { startAutoScroll, useTools } from './store'

/**
 * Song lifecycle for the performance tools: per-song metronome settings and auto-start, audio
 * auto-play, notes popup, auto-scroll on load; everything stops when the viewer closes.
 */
registerService(() => {
  let current: string | null = null
  let scrollTimer: ReturnType<typeof setTimeout> | undefined

  const offOpen = on('songOpened', ({ song }) => {
    if (song.id === current) return
    current = song.id
    clearTimeout(scrollTimer)
    useTools.setState({
      linkPointer: 0,
      buttonPointer: 0,
      pick: null,
      scrollFactor: 1,
      notesPopup: settings().notes.showOnLoad && !!song.notes?.trim(),
    })

    const met = songMetronome(song)
    const keep = settings().metronome.keepRunning
    if (metronome.running && !keep) metronome.stop()
    metronome.configure(met, song.id)
    const countInScroll = met.autoStart && met.countIn > 0 && settings().metronome.countInStartsScroll
    if (met.autoStart && !metronome.running) metronome.start()

    const a = useAudio.getState()
    if (a.trackId && a.songId !== song.id && !settings().audio.keepPlayingAcrossSongs) player.stop()
    const auto = song.audio.find((t) => t.autoPlay)
    if (auto && !useAudio.getState().playing) void player.load(song, auto, { play: true })
    if (song.audio.length && (auto || settings().audio.showPlayerOnLoad)) useTools.setState({ playerVisible: true })
    else if (!useAudio.getState().trackId) useTools.setState({ playerVisible: false })

    // Give the viewer a moment to lay the song out before measuring it.
    if (songAutoScroll(song).startOnLoad && !countInScroll) scrollTimer = setTimeout(() => startAutoScroll(), 400)
  })

  const offViewer = useViewer.subscribe((s, prev) => {
    if (prev.queue.length && !s.queue.length) {
      clearTimeout(scrollTimer)
      current = null
      metronome.stop()
      player.stop()
      useTools.setState({ pick: null, notesPopup: false, playerVisible: false, scrollFactor: 1 })
    }
  })

  return () => {
    offOpen()
    offViewer()
    metronome.stop()
    player.stop()
  }
})
