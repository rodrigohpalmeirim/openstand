import { create } from 'zustand'
import { db, getBlob, updateSong } from '../../db/db'
import type { AudioTrack, Song } from '../../db/schema'
import { settings } from '../../state/settings'
import { toast } from '../../ui/primitives'

interface AudioStatus {
  songId: string | null
  trackId: string | null
  playing: boolean
  time: number
  duration: number
  volume: number
  speed: number
  loopStart?: number
  loopEnd?: number
  /** A set, waiting for B. */
  settingLoop: boolean
}

export const useAudio = create<AudioStatus>(() => ({
  songId: null,
  trackId: null,
  playing: false,
  time: 0,
  duration: 0,
  volume: 1,
  speed: 1,
  settingLoop: false,
}))

export const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/**
 * Single <audio> element shared by the whole viewer so playback survives page turns and panel
 * changes. Track volume/speed/loop are saved on the song's AudioTrack.
 */
class Player {
  private el: HTMLAudioElement | null = null
  private url: string | null = null
  private raf = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  private audio(): HTMLAudioElement {
    if (this.el) return this.el
    const el = new Audio()
    el.preload = 'auto'
    el.addEventListener('play', () => {
      useAudio.setState({ playing: true })
      this.tick()
    })
    el.addEventListener('pause', () => useAudio.setState({ playing: false }))
    el.addEventListener('ended', () => useAudio.setState({ playing: false }))
    el.addEventListener('loadedmetadata', () => useAudio.setState({ duration: el.duration || 0 }))
    el.addEventListener('timeupdate', () => useAudio.setState({ time: el.currentTime }))
    this.el = el
    return el
  }

  /** Poll while playing: smooth time display and tight A-B looping (timeupdate is only ~4 Hz). */
  private tick = () => {
    cancelAnimationFrame(this.raf)
    const el = this.el
    if (!el || el.paused) return
    const { loopStart, loopEnd } = useAudio.getState()
    if (loopStart !== undefined && loopEnd !== undefined && loopEnd > loopStart && el.currentTime >= loopEnd) el.currentTime = loopStart
    useAudio.setState({ time: el.currentTime })
    this.raf = requestAnimationFrame(this.tick)
  }

  get loaded() {
    return !!useAudio.getState().trackId
  }

  async load(song: Song, track: AudioTrack, opts: { play?: boolean; at?: number } = {}) {
    const el = this.audio()
    const st = useAudio.getState()
    if (st.trackId !== track.id || st.songId !== song.id) {
      el.pause()
      let src = track.url ?? ''
      if (track.blobId) {
        try {
          const blob = await getBlob(track.blobId)
          if (this.url) URL.revokeObjectURL(this.url)
          this.url = URL.createObjectURL(blob)
          src = this.url
        } catch {
          toast(`Audio file for "${track.name}" is missing`, 'error')
          return
        }
      }
      if (!src) return toast('This track has no audio file', 'error')
      el.src = src
      el.preservesPitch = true
      useAudio.setState({
        songId: song.id,
        trackId: track.id,
        time: 0,
        duration: 0,
        volume: track.volume ?? 1,
        speed: track.speed ?? 1,
        loopStart: track.loopStart,
        loopEnd: track.loopEnd,
        settingLoop: false,
      })
      el.volume = track.volume ?? 1
      el.playbackRate = track.speed ?? 1
    }
    const at = opts.at ?? (st.trackId === track.id ? undefined : track.loopStart)
    if (at !== undefined) el.currentTime = at
    if (opts.play) await this.play()
  }

  async play() {
    const el = this.el
    if (!el || !el.src) return
    try {
      await el.play()
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError') toast('Tap play to start the audio')
      else console.warn('audio play failed', e)
    }
  }

  pause() {
    this.el?.pause()
  }

  stop() {
    if (!this.el) return
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    useAudio.setState({ songId: null, trackId: null, playing: false, time: 0, duration: 0, loopStart: undefined, loopEnd: undefined, settingLoop: false })
  }

  /** Play/pause; with nothing loaded, starts the song's first (or auto-play) track. */
  async toggle(song: Song | undefined) {
    const st = useAudio.getState()
    if (st.trackId && (!song || st.songId === song.id || settings().audio.keepPlayingAcrossSongs)) {
      if (this.el?.paused) await this.play()
      else this.pause()
      return
    }
    const track = song?.audio.find((t) => t.autoPlay) ?? song?.audio[0]
    if (!song || !track) return toast('This song has no audio tracks')
    await this.load(song, track, { play: true })
  }

  seek(t: number) {
    if (!this.el) return
    this.el.currentTime = Math.max(0, Math.min(t, this.el.duration || t))
    useAudio.setState({ time: this.el.currentTime })
  }

  skip(delta: number) {
    if (this.el) this.seek(this.el.currentTime + delta)
  }

  setVolume(v: number) {
    const vol = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100
    if (this.el) this.el.volume = vol
    useAudio.setState({ volume: vol })
    this.persist({ volume: vol })
  }

  setSpeed(v: number) {
    const speed = Math.round(Math.max(0.5, Math.min(1.5, v)) * 100) / 100
    if (this.el) {
      this.el.preservesPitch = true
      this.el.playbackRate = speed
    }
    useAudio.setState({ speed })
    this.persist({ speed })
  }

  /** A-B button: first press sets A, second sets B (and loops), third clears. */
  abLoop() {
    const st = useAudio.getState()
    const now = this.el?.currentTime ?? 0
    if (st.loopStart !== undefined && st.loopEnd !== undefined) {
      useAudio.setState({ loopStart: undefined, loopEnd: undefined, settingLoop: false })
      this.persist({ loopStart: undefined, loopEnd: undefined }, true)
    } else if (st.settingLoop && st.loopStart !== undefined) {
      if (now <= st.loopStart + 0.2) return toast('B must be after A')
      useAudio.setState({ loopEnd: now, settingLoop: false })
      this.persist({ loopStart: st.loopStart, loopEnd: now }, true)
    } else {
      useAudio.setState({ loopStart: now, loopEnd: undefined, settingLoop: true })
    }
  }

  /** Save track settings back to the song (debounced unless `now`). */
  private persist(patch: Partial<AudioTrack>, now = false) {
    const { songId, trackId } = useAudio.getState()
    if (!songId || !trackId) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const run = async () => {
      const song = await db.songs.get(songId)
      if (!song) return
      await updateSong(songId, { audio: song.audio.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) })
    }
    if (now) void run()
    else this.saveTimer = setTimeout(() => void run(), 600)
  }
}

export const player = new Player()

/** Move to the previous/next track of the song (wraps), keeping play state. */
export async function stepTrack(song: Song | undefined, dir: 1 | -1) {
  if (!song?.audio.length) return toast('This song has no audio tracks')
  const st = useAudio.getState()
  const at = song.audio.findIndex((t) => t.id === st.trackId)
  const i = at < 0 ? 0 : (at + dir + song.audio.length) % song.audio.length
  await player.load(song, song.audio[i], { play: st.playing || at < 0 })
  toast(song.audio[i].name)
}
