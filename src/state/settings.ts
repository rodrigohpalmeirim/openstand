import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_TEXT_STYLE, type TextStyle } from '../chordpro/style'
import type { AutoScrollSettings, DisplayMode, FitMode, MetronomeSettings } from '../db/schema'
import { ACTIONS, type ActionId } from '../viewer/actions'
import type { AnnotationPreset, ToolConfig, ToolId } from '../annotations/tools'
import { FACE_GESTURES, GESTURE_INFO, type Gesture as FaceGestureId } from '../faces/gestures'

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

/** Accent colour presets (see src/settings/accent.ts). */
export type AccentId = 'ember' | 'ocean' | 'forest' | 'violet' | 'stage'

/** Global metronome preferences (not stored per song). */
export interface MetronomePrefs {
  /** Keep the metronome running when switching songs. */
  keepRunning: boolean
  /** How beats are shown on screen. */
  visualStyle: 'border' | 'dot'
  /** Show the current beat as a large number. */
  bigBeat: boolean
  /** What happens after the count-in bars. */
  afterCountIn: 'continue' | 'stop'
  /** Start auto-scroll when the count-in ends. */
  countInStartsScroll: boolean
}

/** Global auto-scroll preferences (not stored per song). */
export interface AutoScrollPrefs {
  /** Touching the page pauses scrolling until shortly after release. */
  pauseOnTouch: boolean
  showProgress: boolean
}

export interface FaceGestureBinding {
  action: ActionId
  /** 0 (needs big movements) .. 1 (reacts to small ones). */
  sensitivity: number
  /** Minimum time the gesture must be held, 0–900 ms. */
  holdMs: number
}

const faceGestureDefaults = (actions: Partial<Record<FaceGestureId, ActionId>>, sensitivity = 0.5) =>
  Object.fromEntries(
    FACE_GESTURES.map((g) => [g, { action: actions[g] ?? 'none', sensitivity, holdMs: GESTURE_INFO[g].holdMs }]),
  ) as Record<FaceGestureId, FaceGestureBinding>

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  accent: AccentId
  /** Classical musicians often prefer "piece" over "song". */
  terminology: 'song' | 'piece'
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
  /* Library prefs (library module). */
  /** Comma-separated leading articles ignored for sorting and the A–Z index. */
  articles: string
  /** Tapping a song performs the whole visible list (or setlist) starting there, not just that song. */
  loadEntireList: boolean
  /** Show the A–Z jump index next to title/artist-sorted lists. */
  showAlphabet: boolean
  /** Sorting of each group section ('artists' → 'name-asc' | 'name-desc' | 'count-desc' | 'count-asc'). */
  groupSort: Record<string, string>

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
    paperTone: 'white' | 'cream' | 'sepia' | 'gray' | 'cool'
    /** Two-page mode step: two pages, one page ([1|2]→[2|3]) or alternate ([1|2]→[3|2]→[3|4]). */
    twoPageTurn: 'two' | 'single' | 'alternate'
    /** Hide the mouse cursor while performing after a short idle time. */
    hideCursor: boolean
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
    twoFingerTap: ActionId
    threeFingerTap: ActionId
    /** Pedals/keys stop at the end of a song; a tap is needed to move on (avoids accidental song changes). */
    pedalStopsAtSongEnd: boolean
    /** Next page at end of a song continues to the next song in the setlist. */
    continueToNextSong: boolean
    /** Turn back past page one goes to previous song's last page. */
    backToPrevSong: boolean
    keys: KeyBinding[]
    /** Show the zone overlay briefly when opening a song */
    showZonesHint: boolean
  }

  text: TextStyle

  metronome: MetronomeSettings & MetronomePrefs
  autoScroll: AutoScrollSettings & AutoScrollPrefs
  /** Performance tools (src/tools): audio player, notes popup, on-score overlays, link markers. */
  audio: {
    /** Keep the current track playing when the next song opens. */
    keepPlayingAcrossSongs: boolean
    /** Seconds skipped by rewind / forward. */
    skipSeconds: number
    /** Show the mini player automatically when a song with audio opens. */
    showPlayerOnLoad: boolean
  }
  notes: {
    /** Pop up the song's notes when it opens. */
    showOnLoad: boolean
    /** Popup/editor text size in px. */
    fontSize: number
    /** Hide the popup after this many seconds (0 = until tapped). */
    autoHideSeconds: number
  }
  overlays: {
    clock: 'off' | 'tl' | 'tr' | 'bl' | 'br'
    clock24h: boolean
    /** Show "Capo N" on text songs that use a capo. */
    capo: boolean
  }
  linkPoints: {
    /** Marker diameter in px. */
    markerSize: number
    /** Also mark link destinations. */
    showDestinations: boolean
  }

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
    /** Only react to incoming messages on this channel (1-16); 0 = any channel */
    receiveChannel: number
    /** Gap between consecutive song-load commands in ms (some synths drop messages sent back-to-back) */
    commandGapMs: number
  }

  sync: {
    /** Role when connected to other devices */
    role: 'leader' | 'follower' | 'peer'
    deviceName: string
    /** Signalling relay (WebSocket) URL for cross-device sync; empty = same-browser only */
    relayUrl: string
    room: string
    autoConnect: boolean
    /** Follower: obey page turns from the leader */
    followPages: boolean
    /** Follower: open songs/setlists opened on the leader */
    followSongs: boolean
  }

  backup: {
    /** Remind to back up after this many days (0 = never) */
    reminderDays: number
    /** Write a backup automatically into a chosen folder (Chromium; folder handle kept in IndexedDB) */
    autoBackup: boolean
    autoEveryDays: number
    /** Automatic backups to keep in the folder */
    keepCount: number
    includeSettings: boolean
  }

  faceGestures: {
    enabled: boolean
    /** Minimum time between two recognised gestures. */
    cooldownMs: number
    /** Every gesture; one is off while its action is 'none'. */
    gestures: Record<FaceGestureId, FaceGestureBinding>
  }

  annotations: {
    /** Only draw with a stylus/pen; fingers pan/turn pages */
    stylusOnly: boolean
    showWhilePerforming: boolean
    /** Vary pen width with stylus pressure. */
    pressure: boolean
    /** Ignore touches while a stylus is in use, and large (palm-sized) contacts. */
    palmRejection: boolean
    /** Ink smoothing: 0 off, 1 light, 2 medium, 3 strong. */
    smoothing: number
    /** Last used tool and per-tool settings (overrides of DEFAULT_TOOLS). */
    tool: ToolId
    tools: Partial<Record<ToolId, Partial<ToolConfig>>>
    /** Saved tool presets ("favourites"), in display order. */
    presets: AnnotationPreset[]
    /** Recently used custom colours, newest first. */
    recentColors: string[]
    /** Annotation grid: snap placed/moved objects, show the grid while annotating, cell size in thousandths of page width. */
    grid: { snap: boolean; show: boolean; size: number }
  }

  /** Names of user-defined annotation layers */
  recentSearches: string[]
  /** Onboarding has been shown */
  onboarded: boolean

  /** Song editor preferences. */
  editor: {
    /** Field keys hidden in the Fields tab ("Configure fields"). */
    hiddenFields: string[]
    /** Capitalize the first letter of each word in titles and group values. */
    capitalizeWords: boolean
    /** Crop editor: which pages a crop change applies to. */
    cropApplyTo: 'page' | 'file' | 'song'
    /** Auto-crop ignores sparse specks/scan borders in the margins. */
    aggressiveCrop: boolean
  }

  /** Import dialog preferences. */
  importPrefs: {
    /** Filename pattern, e.g. "%artist% - %title%" ('' = filename is the title). */
    filePattern: string
    /** Folder pattern, e.g. "%genre%/%artist%" ('' = off). */
    folderPattern: string
    /** Match the folder pattern against the folders at the end of the path (else from the import root). */
    folderFromEnd: boolean
    skipDuplicates: boolean
    /** When a song with the same title exists. */
    conflict: 'create' | 'update' | 'skip'
    autoCrop: boolean
  }
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  accent: 'ember',
  terminology: 'song',
  libraryView: 'list',
  librarySort: { field: 'title', dir: 'asc' },
  ignoreArticles: true,
  visibleGroups: ['setlists', 'collections', 'artists', 'composers', 'albums', 'genres', 'keys', 'sources', 'tags', 'years', 'signatures'],
  fieldLabels: {},
  listFields: ['artists', 'keys', 'duration', 'rating'],
  articles: 'A, An, The',
  loadEntireList: true,
  showAlphabet: true,
  groupSort: {},

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
    twoPageTurn: 'two',
    hideCursor: true,
    brightness: 1,
    pageGap: 0,
    keepScreenOn: true,
    toolbarAutoHide: 3,
    showNextSongHint: true,
    fullscreen: true,
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
    twoFingerTap: 'resetZoom',
    threeFingerTap: 'toggleAnnotate',
    pedalStopsAtSongEnd: false,
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
    keepRunning: false,
    visualStyle: 'border',
    bigBeat: false,
    afterCountIn: 'continue',
    countInStartsScroll: false,
  },
  autoScroll: { mode: 'duration', delay: 5, speed: 30, pageDelay: 2, pauseOnTouch: true, showProgress: true },
  audio: { keepPlayingAcrossSongs: false, skipSeconds: 5, showPlayerOnLoad: false },
  notes: { showOnLoad: false, fontSize: 20, autoHideSeconds: 0 },
  overlays: { clock: 'off', clock24h: true, capo: true },
  linkPoints: { markerSize: 30, showDestinations: true },

  midi: {
    enabled: false,
    outputs: [],
    inputs: [],
    sendOnLoad: true,
    recallSongs: false,
    bindings: [],
    defaultChannel: 1,
    receiveChannel: 0,
    commandGapMs: 0,
  },

  sync: { role: 'peer', deviceName: '', relayUrl: '', room: 'band', autoConnect: false, followPages: true, followSongs: true },

  backup: { reminderDays: 14, autoBackup: false, autoEveryDays: 1, keepCount: 5, includeSettings: true },

  faceGestures: {
    enabled: false,
    cooldownMs: 1200,
    gestures: faceGestureDefaults({ turnLeft: 'prevPage', turnRight: 'nextPage' }),
  },

  annotations: {
    stylusOnly: false,
    showWhilePerforming: true,
    pressure: true,
    palmRejection: true,
    smoothing: 2,
    tool: 'pen',
    tools: {},
    presets: [],
    recentColors: [],
    grid: { snap: false, show: false, size: 20 },
  },

  recentSearches: [],
  onboarded: false,

  editor: { hiddenFields: ['sortTitle', 'songNumber', 'custom2'], capitalizeWords: true, cropApplyTo: 'page', aggressiveCrop: false },
  importPrefs: { filePattern: '', folderPattern: '', folderFromEnd: true, skipDuplicates: true, conflict: 'create', autoCrop: false },
}

/**
 * Overlay `patch` onto `base`, keeping the shape of `base`: values whose type doesn't match the
 * default are dropped, so a corrupt or foreign settings file can't break the app.
 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base)) return (Array.isArray(patch) ? patch : base) as T
  if (typeof base !== 'object' || base === null) {
    if (base === undefined || base === null) return patch as T
    return (typeof patch === typeof base && !(typeof patch === 'number' && !Number.isFinite(patch)) ? patch : base) as T
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out as T
}

const isAction = (a: unknown): a is ActionId => typeof a === 'string' && a in ACTIONS

/** Repair values the type system can't guarantee after loading (unknown actions, duplicate keys). */
function sanitize(s: Settings): Settings {
  const fixAction = (a: unknown): ActionId => (isAction(a) ? a : 'none')
  const pt = s.pageTurn
  const zones = { ...pt.zones }
  for (const z of Object.keys(DEFAULT_SETTINGS.pageTurn.zones) as TouchZone[]) zones[z] = fixAction(zones[z])
  const seen = new Set<string>()
  const keys = pt.keys.filter((k) => {
    if (!k || typeof k.key !== 'string' || !k.key || !isAction(k.action)) return false
    const id = `${k.key}|${!!k.long}|${k.action}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  const fg = s.faceGestures
  return {
    ...s,
    pageTurn: {
      ...pt,
      zones,
      keys,
      swipeLeft: fixAction(pt.swipeLeft),
      swipeRight: fixAction(pt.swipeRight),
      swipeUp: fixAction(pt.swipeUp),
      swipeDown: fixAction(pt.swipeDown),
      doubleTap: fixAction(pt.doubleTap),
      longPress: fixAction(pt.longPress),
      twoFingerTap: fixAction(pt.twoFingerTap),
      threeFingerTap: fixAction(pt.threeFingerTap),
    },
    faceGestures: sanitizeFaceGestures(fg, fixAction),
  }
}

/** Face gesture settings before per-gesture bindings (head turns + open mouth, one sensitivity). */
interface LegacyFaceGestures {
  headTurn?: unknown
  mouth?: unknown
  sensitivity?: unknown
  turnLeftAction?: unknown
  turnRightAction?: unknown
  mouthAction?: unknown
}

function sanitizeFaceGestures(fg: Settings['faceGestures'], fixAction: (a: unknown) => ActionId): Settings['faceGestures'] {
  const unit = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d)
  let gestures = fg.gestures
  const old = fg as LegacyFaceGestures
  if (['headTurn', 'mouth', 'sensitivity', 'turnLeftAction', 'turnRightAction', 'mouthAction'].some((k) => k in old)) {
    // Old shape (the new one never has these keys): keep the user's behaviour, using the old defaults
    // for anything missing.
    const turns = old.headTurn !== false
    gestures = faceGestureDefaults(
      {
        turnLeft: turns ? fixAction(old.turnLeftAction ?? 'prevPage') : 'none',
        turnRight: turns ? fixAction(old.turnRightAction ?? 'nextPage') : 'none',
        mouthOpen: old.mouth === true ? fixAction(old.mouthAction ?? 'nextPage') : 'none',
      },
      unit(old.sensitivity, 0.5),
    )
  }
  const D = DEFAULT_SETTINGS.faceGestures.gestures
  const fixed = Object.fromEntries(
    FACE_GESTURES.map((g) => {
      const b = (gestures?.[g] ?? D[g]) as Partial<FaceGestureBinding>
      const hold = typeof b.holdMs === 'number' && Number.isFinite(b.holdMs) ? Math.round(Math.min(900, Math.max(0, b.holdMs))) : D[g].holdMs
      return [g, { action: fixAction(b.action), sensitivity: unit(b.sensitivity, D[g].sensitivity), holdMs: hold }]
    }),
  ) as Record<FaceGestureId, FaceGestureBinding>
  return { enabled: fg.enabled, cooldownMs: Math.min(5000, Math.max(0, fg.cooldownMs)), gestures: fixed }
}

/** Merge persisted/imported settings over the current defaults. */
export function mergeSettings(patch: unknown): Settings {
  return sanitize(deepMerge(DEFAULT_SETTINGS, patch))
}

export const SETTINGS_VERSION = 2

type Raw = Record<string, unknown>
/** Step n upgrades data written by version n to n + 1. Only structural changes need a step. */
const MIGRATIONS: Record<number, (s: Raw) => Raw> = {
  // v1 could store keys as KeyboardEvent.key; the space bar's key (" ") is now stored by code.
  1: (s) => {
    const pt = s.pageTurn as { keys?: { key: string }[] } | undefined
    if (!Array.isArray(pt?.keys)) return s
    const keys = pt.keys.map((k) => (k && (k.key === ' ' || k.key === 'Spacebar') ? { ...k, key: 'Space' } : k))
    return { ...s, pageTurn: { ...pt, keys } }
  },
}

/** Upgrade settings saved by an older version, then merge them over the defaults. */
export function migrateSettings(raw: unknown, fromVersion: number): Settings {
  let s = (raw && typeof raw === 'object' ? raw : {}) as Raw
  for (let v = Math.max(1, fromVersion); v < SETTINGS_VERSION; v++) s = MIGRATIONS[v]?.(s) ?? s
  return mergeSettings(s)
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
      replace: (s) => set({ s: mergeSettings(s) }),
    }),
    {
      name: 'openstand-settings',
      version: SETTINGS_VERSION,
      migrate: (persisted, version) => ({ s: migrateSettings((persisted as { s?: unknown })?.s, version) }) as unknown as SettingsStore,
      merge: (persisted, current) => ({
        ...current,
        s: mergeSettings((persisted as { s?: Settings })?.s),
      }),
    },
  ),
)

export const settings = () => useSettings.getState().s
