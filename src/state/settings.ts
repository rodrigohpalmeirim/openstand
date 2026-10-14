import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_TEXT_STYLE, type TextStyle } from '../chordpro/render'
import type { AutoScrollSettings, DisplayMode, FitMode, MetronomeSettings } from '../db/schema'
import type { ActionId } from '../viewer/actions'

/** Where on screen a tap lands. The screen is split into a 3x3 grid. */
export type TouchZone = 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'

export interface KeyBinding {
  /** KeyboardEvent.code or key, e.g. "PageDown", "ArrowRight", "Space" */
  key: string
  action: ActionId
  /** Fire on long-press (key held > 500ms) instead of tap. */
  long?: boolean
}

export interface MidiBinding {
  /** e.g. "cc:64:127", "note:60", "pc:5" (channel optional: "ch1:cc:64:127") */
  message: string
  action: ActionId
  /** Learned device name, informative. */
  device?: string
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  /** Library list density */
  libraryView: 'list' | 'grid' | 'compact'
  librarySort: { field: 'title' | 'artist' | 'createdAt' | 'modifiedAt' | 'lastPlayedAt' | 'playCount' | 'rating' | 'difficulty' | 'duration' | 'key'; dir: 'asc' | 'desc' }
  /** Ignore leading articles (The, A, An) when sorting titles. */
  ignoreArticles: boolean
  /** Which group tabs appear in the library sidebar, in order. */
  visibleGroups: string[]
  /** Custom labels for the library fields. */
  fieldLabels: Record<string, string>
  /** Library columns shown for each song in list view. */
  listFields: string[]

  display: {
    mode: DisplayMode
    /** Mode used automatically when the device is in landscape. */
    landscapeMode: DisplayMode | 'same'
    fit: FitMode
    /** Page turn animation */
    transition: 'none' | 'slide' | 'fade' | 'curl'
    /** Half-page turn: fraction of the page shown from the next page (0.5 = halves). */
    halfPageSplit: number
    /** Show page numbers (e.g. "3 / 8") while performing */
    showPageNumber: boolean
    showSongTitle: boolean
    /** Night mode for scores: invert colours (keeps hue) */
    nightMode: boolean
    /** Paper tint for sheet backgrounds */
    paperTone: 'white' | 'cream' | 'sepia'
    brightness: number
    /** Margin around pages in px */
    pageGap: number
    keepScreenOn: boolean
    /** Hide the toolbar automatically after this many seconds (0 = never). */
    toolbarAutoHide: number
    /** Show a hint arrow when the next page is the first page of the next song */
    showNextSongHint: boolean
    /** Fullscreen while performing */
    fullscreen: boolean
    /** Lock performance mode: disables annotations and accidental edits */
    performanceLock: boolean
  }

  pageTurn: {
    /** Action per touch zone (tap). */
    zones: Record<TouchZone, ActionId>
    /** Action for swipes. */
    swipeLeft: ActionId
    swipeRight: ActionId
    swipeUp: ActionId
    swipeDown: ActionId
    doubleTap: ActionId
    longPress: ActionId
    /** Ignore taps that happen within this many ms after a page turn (prevents double turns). */
    debounceMs: number
    /** Next page at end of a song continues to the next song in the setlist. */
    continueToNextSong: boolean
    /** Turn back past page one goes to previous song's last page. */
    backToPrevSong: boolean
    keys: KeyBinding[]
    /** Show the zone overlay briefly when opening a song */
    showZonesHint: boolean
  }

  text: TextStyle

  metronome: MetronomeSettings
  autoScroll: AutoScrollSettings

  midi: {
    enabled: boolean
    /** Selected output device ids (empty = all) */
    outputs: string[]
    inputs: string[]
    /** Send song MIDI commands when a song is loaded */
    sendOnLoad: boolean
    /** Load songs from incoming program changes matching their recall message */
    recallSongs: boolean
    bindings: MidiBinding[]
    /** Default channel for new commands (1-16) */
    defaultChannel: number
  }

  sync: {
    /** Role when connected to other devices */
    role: 'leader' | 'follower' | 'peer'
    deviceName: string
    /** Signalling relay (WebSocket) URL for cross-device sync; empty = same-browser only */
    relayUrl: string
    room: string
    autoConnect: boolean
  }

  faceGestures: {
    enabled: boolean
    /** Head turn right → next page, left → previous */
    headTurn: boolean
    /** Open mouth → next page */
    mouth: boolean
    sensitivity: number
  }

  annotations: {
    /** Only draw with a stylus/pen; fingers pan/turn pages */
    stylusOnly: boolean
    showWhilePerforming: boolean
  }

  /** Names of user-defined annotation layers */
  recentSearches: string[]
  /** Onboarding has been shown */
  onboarded: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  libraryView: 'list',
  librarySort: { field: 'title', dir: 'asc' },
  ignoreArticles: true,
  visibleGroups: ['setlists', 'collections', 'artists', 'composers', 'albums', 'genres', 'keys', 'sources', 'tags', 'years', 'signatures'],
  fieldLabels: {},
  listFields: ['artists', 'keys'],

  display: {
    mode: 'single',
    landscapeMode: 'double',
    fit: 'page',
    transition: 'slide',
    halfPageSplit: 0.5,
    showPageNumber: true,
    showSongTitle: true,
    nightMode: false,
    paperTone: 'white',
    brightness: 1,
    pageGap: 0,
    keepScreenOn: true,
    toolbarAutoHide: 3,
    showNextSongHint: true,
    fullscreen: false,
    performanceLock: false,
  },

  pageTurn: {
    zones: {
      tl: 'prevPage',
      tc: 'toggleToolbar',
      tr: 'nextPage',
      ml: 'prevPage',
      mc: 'toggleToolbar',
      mr: 'nextPage',
      bl: 'prevPage',
      bc: 'toggleToolbar',
      br: 'nextPage',
    },
    swipeLeft: 'nextPage',
    swipeRight: 'prevPage',
    swipeUp: 'none',
    swipeDown: 'none',
    doubleTap: 'none',
    longPress: 'none',
    debounceMs: 250,
    continueToNextSong: true,
    backToPrevSong: true,
    keys: [
      { key: 'ArrowRight', action: 'nextPage' },
      { key: 'ArrowDown', action: 'nextPage' },
      { key: 'PageDown', action: 'nextPage' },
      { key: 'Space', action: 'nextPage' },
      { key: 'ArrowLeft', action: 'prevPage' },
      { key: 'ArrowUp', action: 'prevPage' },
      { key: 'PageUp', action: 'prevPage' },
      { key: 'Home', action: 'firstPage' },
      { key: 'End', action: 'lastPage' },
      { key: 'KeyN', action: 'nextSong' },
      { key: 'KeyP', action: 'prevSong' },
      { key: 'KeyM', action: 'toggleMetronome' },
      { key: 'KeyA', action: 'toggleAutoScroll' },
      { key: 'KeyF', action: 'toggleFullscreen' },
      { key: 'KeyB', action: 'showBookmarks' },
      { key: 'KeyD', action: 'toggleAnnotate' },
      { key: 'KeyI', action: 'toggleNightMode' },
      { key: 'Escape', action: 'closeSong' },
    ],
    showZonesHint: true,
  },

  text: DEFAULT_TEXT_STYLE,

  metronome: {
    bpm: 100,
    beatsPerBar: 4,
    beatUnit: 4,
    subdivision: 1,
    accentFirst: true,
    countIn: 0,
    visual: true,
    audible: true,
    sound: 'click',
    volume: 0.8,
  },
  autoScroll: { mode: 'duration', delay: 5, speed: 30, pageDelay: 2 },

  midi: {
    enabled: false,
    outputs: [],
    inputs: [],
    sendOnLoad: true,
    recallSongs: false,
    bindings: [],
    defaultChannel: 1,
  },

  sync: { role: 'peer', deviceName: '', relayUrl: '', room: 'band', autoConnect: false },

  faceGestures: { enabled: false, headTurn: true, mouth: false, sensitivity: 0.5 },

  annotations: { stylusOnly: false, showWhilePerforming: true },

  recentSearches: [],
  onboarded: false,
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return (patch ?? base) as T
  const out = { ...base } as Record<string, unknown>
  if (patch && typeof patch === 'object') {
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in out ? deepMerge(out[k], v) : v
    }
  }
  return out as T
}

interface SettingsStore {
  s: Settings
  set: (patch: Partial<Settings>) => void
  setIn: <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) => void
  reset: () => void
  replace: (s: Settings) => void
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      s: DEFAULT_SETTINGS,
      set: (patch) => set((st) => ({ s: { ...st.s, ...patch } })),
      setIn: (section, patch) =>
        set((st) => ({ s: { ...st.s, [section]: { ...(st.s[section] as object), ...patch } } })),
      reset: () => set({ s: DEFAULT_SETTINGS }),
      replace: (s) => set({ s: deepMerge(DEFAULT_SETTINGS, s) }),
    }),
    {
      name: 'openstand-settings',
      version: 1,
      merge: (persisted, current) => ({
        ...current,
        s: deepMerge(DEFAULT_SETTINGS, (persisted as { s?: Settings })?.s),
      }),
    },
  ),
)

export const settings = () => useSettings.getState().s
