import {
  Info,
  Keyboard,
  Library as LibraryIcon,
  MonitorPlay,
  Palette,
  Pointer,
  ScanFace,
  ScrollText,
  Timer,
  Type,
  Database,
  ArchiveRestore,
  RadioTower,
  Cable,
  Cloud,
  Monitor,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { BackupSettings } from '../backup/BackupSettings'
import { FaceGestureList, FaceGestureTest, FacePrivacyNote } from '../faces/FaceSettings'
import { LibrarySyncSettings } from '../libsync/ui/LibrarySyncSettings'
import { MidiSettings } from '../midi/MidiSettings'
import { DEFAULT_SETTINGS, useSettings, type Settings } from '../state/settings'
import { SyncSettings } from '../sync/SyncSettings'
import { cx } from '../ui/primitives'
import { ACCENTS } from './accent'
import { AboutInfo, Credits, ShortcutSheet } from './About'
import { KeyBindingsEditor } from './KeyBindings'
import {
  actionItem,
  colorItem,
  customItem,
  Row,
  segItem,
  selectItem,
  sliderItem,
  toggleItem,
  type SettingGroup,
} from './kit'
import { ArticlesInput, FieldLabelsEditor, GroupsEditor, ListFieldsEditor } from './LibraryPrefs'
import { LibraryStorage, StorageUsage } from './StoragePanel'
import { TextPreview } from './TextPreview'
import { ZoneEditor } from './ZoneEditor'

export interface SectionDef {
  id: string
  title: string
  icon: LucideIcon
  /** One line shown under the title in the section list. */
  summary: string
  groups: SettingGroup[]
  /** Restore this section's settings to defaults. Omitted for sections without own settings. */
  reset?: () => void
}

const st = () => useSettings.getState()
const D = DEFAULT_SETTINGS
/** Reset whole top-level keys. */
const resetKeys = (...keys: (keyof Settings)[]) => () => st().set(Object.fromEntries(keys.map((k) => [k, D[k]])) as Partial<Settings>)
/** Reset some fields of a nested section. */
const resetIn = <K extends keyof Settings>(k: K, fields: (keyof Settings[K])[]) => () =>
  st().setIn(k, Object.fromEntries(fields.map((f) => [f, D[k][f]])) as Partial<Settings[K]>)

const sec = (n: number) => (n === 0 ? 'Never' : `${n} s`)
const ms = (n: number) => (n === 0 ? 'Off' : `${n} ms`)
const pct = (n: number) => `${Math.round(n * 100)}%`

/* ---------------------------------------------------------- Appearance */

function AccentPicker() {
  const accent = useSettings((s) => s.s.accent)
  const set = useSettings((s) => s.set)
  const current = ACCENTS[accent] ?? ACCENTS.ember
  return (
    <Row label="Accent colour" hint={`${current.label}: ${current.hint}`}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
        {(Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]).map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={accent === id}
            title={ACCENTS[id].label}
            aria-label={ACCENTS[id].label}
            onClick={() => set({ accent: id })}
            className={cx(
              'flex size-10 items-center justify-center rounded-full border-2 transition',
              accent === id ? 'border-fg' : 'border-transparent hover:border-line',
            )}
          >
            <span className="size-7 rounded-full" style={{ background: `linear-gradient(135deg, ${ACCENTS[id].light} 50%, ${ACCENTS[id].dark} 50%)` }} />
          </button>
        ))}
      </div>
    </Row>
  )
}

const appearance: SectionDef = {
  id: 'appearance',
  title: 'Appearance',
  icon: Palette,
  summary: 'Theme, colours, library layout',
  reset: resetKeys('theme', 'accent', 'libraryView', 'terminology'),
  groups: [
    {
      items: [
        segItem('theme', 'Theme', [
          { value: 'system', label: <><Monitor className="size-4" />Auto</>, title: 'Follow the device setting' },
          { value: 'light', label: <><Sun className="size-4" />Light</> },
          { value: 'dark', label: <><Moon className="size-4" />Dark</> },
        ], 'Auto follows your device’s light or dark setting. Scores are always shown on a dark stage.', 'dark mode light mode system appearance'),
        customItem('accent', 'Accent colour', AccentPicker, 'stage colour color theme'),
      ],
    },
    {
      title: 'Library',
      items: [
        segItem('libraryView', 'Library layout', [
          { value: 'list', label: 'List' },
          { value: 'compact', label: 'Compact' },
          { value: 'grid', label: 'Grid' },
        ], 'Grid shows the first page of each song.', 'density thumbnails'),
        segItem('terminology', 'Call them', [
          { value: 'song', label: 'Songs' },
          { value: 'piece', label: 'Pieces' },
        ], 'Classical musicians may prefer “pieces”. Albums are then called “Books”.', 'terminology classical piece'),
      ],
    },
  ],
}

/* ------------------------------------------------------------- Library */

const library: SectionDef = {
  id: 'library',
  title: 'Library',
  icon: LibraryIcon,
  summary: 'Sorting, sections, fields, importing',
  reset: () => {
    resetKeys('librarySort', 'ignoreArticles', 'articles', 'visibleGroups', 'fieldLabels', 'listFields', 'loadEntireList', 'showAlphabet', 'groupSort')()
    resetIn('importPrefs', ['skipDuplicates', 'conflict', 'autoCrop'])()
    resetIn('editor', ['capitalizeWords', 'aggressiveCrop'])()
  },
  groups: [
    {
      title: 'Sorting',
      items: [
        selectItem('librarySort.field', 'Sort songs by', [
          { value: 'title', label: 'Title' },
          { value: 'artist', label: 'Artist' },
          { value: 'key', label: 'Key' },
          { value: 'createdAt', label: 'Date added' },
          { value: 'modifiedAt', label: 'Date modified' },
          { value: 'lastPlayedAt', label: 'Last played' },
          { value: 'playCount', label: 'Times played' },
          { value: 'rating', label: 'Rating' },
          { value: 'difficulty', label: 'Difficulty' },
          { value: 'duration', label: 'Duration' },
        ], 'Default order of the song list.', 'order'),
        segItem('librarySort.dir', 'Direction', [
          { value: 'asc', label: 'Ascending' },
          { value: 'desc', label: 'Descending' },
        ], undefined, 'sort order'),
        toggleItem('ignoreArticles', 'Ignore articles when sorting', '“The Beatles” sorts under B.', 'the a an'),
        customItem('articles', 'Articles to ignore', ArticlesInput, 'the a an sort'),
        toggleItem('showAlphabet', 'A–Z index', 'Jump letters beside lists sorted by title or artist.', 'alphabet letters'),
      ],
    },
    {
      title: 'Opening songs',
      items: [
        toggleItem('loadEntireList', 'Perform the whole list', 'Tapping a song opens the visible list or setlist starting at that song, so you can page straight through.', 'setlist load next song'),
      ],
    },
    {
      title: 'Sections and fields',
      items: [
        customItem('visibleGroups', 'Library sections', GroupsEditor, 'tabs groups order artists composers albums genres setlists'),
        customItem('listFields', 'Details shown in the list', ListFieldsEditor, 'columns fields list view'),
        customItem('fieldLabels', 'Field names', FieldLabelsEditor, 'rename labels custom field'),
      ],
    },
    {
      title: 'Importing and editing',
      items: [
        toggleItem('importPrefs.skipDuplicates', 'Skip duplicate files', 'Files already in the library are not imported again.', 'import'),
        selectItem('importPrefs.conflict', 'When a song with the same title exists', [
          { value: 'create', label: 'Add another song' },
          { value: 'update', label: 'Add files to it' },
          { value: 'skip', label: 'Skip' },
        ], undefined, 'import duplicate'),
        toggleItem('importPrefs.autoCrop', 'Crop margins on import', 'Removes empty borders from scanned pages.', 'import crop'),
        toggleItem('editor.aggressiveCrop', 'Aggressive cropping', 'Ignores specks and scan borders in the margins when cropping.', 'crop'),
        toggleItem('editor.capitalizeWords', 'Capitalise words', 'Capitalise each word of titles and field values you type.', 'capitalize editor'),
      ],
    },
  ],
}

/* ------------------------------------------------------ Performance display */

const modes = [
  { value: 'single', label: 'One page' },
  { value: 'double', label: 'Two pages' },
  { value: 'halfPage', label: 'Half pages' },
  { value: 'verticalScroll', label: 'Vertical scroll' },
  { value: 'horizontalScroll', label: 'Horizontal scroll' },
] as const

const display: SectionDef = {
  id: 'display',
  title: 'Performance display',
  icon: MonitorPlay,
  summary: 'Page layout, night mode, screen',
  reset: () => {
    resetKeys('display')()
    resetIn('annotations', ['showWhilePerforming', 'stylusOnly', 'palmRejection', 'pressure', 'smoothing'])()
  },
  groups: [
    {
      title: 'Layout',
      items: [
        selectItem('display.mode', 'Display mode', [...modes], 'How pages are laid out. Each song can override this.', 'portrait single double half scroll'),
        selectItem('display.landscapeMode', 'In landscape', [{ value: 'same', label: 'Same as above' }, ...modes], 'Switches automatically when you rotate the device.', 'orientation rotate'),
        segItem('display.fit', 'Fit pages to', [
          { value: 'page', label: 'Whole page' },
          { value: 'width', label: 'Width' },
          { value: 'height', label: 'Height' },
        ], undefined, 'zoom scale'),
        selectItem('display.twoPageTurn', 'Two-page turns', [
          { value: 'two', label: 'Advance two pages' },
          { value: 'single', label: 'Advance one page' },
          { value: 'alternate', label: 'Replace the older page' },
        ], '“Replace the older page” swaps one side at a time (1|2 → 3|2 → 3|4), so you can keep reading while it turns.'),
        sliderItem('display.halfPageSplit', 'Half-page split', { min: 0.3, max: 0.7, step: 0.05, format: pct }, 'How much of the page the top half shows in half-page mode.'),
        sliderItem('display.pageGap', 'Space around pages', { min: 0, max: 48, step: 2, format: (n) => `${n} px` }, undefined, 'margin gap'),
        selectItem('display.transition', 'Page turn animation', [
          { value: 'none', label: 'None (instant)' },
          { value: 'slide', label: 'Slide' },
          { value: 'fade', label: 'Fade' },
          { value: 'curl', label: 'Page curl' },
        ], undefined, 'transition'),
      ],
    },
    {
      title: 'Page look',
      items: [
        toggleItem('display.nightMode', 'Night mode', 'Inverts pages to light notes on black.', 'dark invert'),
        selectItem('display.paperTone', 'Paper tone', [
          { value: 'white', label: 'White' },
          { value: 'cream', label: 'Cream' },
          { value: 'sepia', label: 'Sepia' },
          { value: 'gray', label: 'Grey' },
          { value: 'cool', label: 'Cool' },
        ], 'Tints pages to reduce glare.', 'colour tint glare'),
        sliderItem('display.brightness', 'Page brightness', { min: 0.4, max: 1, step: 0.05, format: pct }, undefined, 'dim'),
      ],
    },
    {
      title: 'While performing',
      items: [
        toggleItem('display.showPageNumber', 'Page numbers', 'Shows “3 / 8” in a corner.'),
        toggleItem('display.showSongTitle', 'Song title', 'Shows the title at the top when the toolbar is hidden.'),
        toggleItem('display.showNextSongHint', 'Next song hint', 'On the last page, shows which song comes next.', 'next up setlist'),
        sliderItem('display.toolbarAutoHide', 'Hide toolbar after', { min: 0, max: 10, step: 1, format: sec }, undefined, 'auto-hide overlay'),
        toggleItem('display.hideCursor', 'Hide mouse cursor', 'Hides the pointer when the mouse is idle.', 'mouse'),
      ],
    },
    {
      title: 'Screen',
      items: [
        toggleItem('display.keepScreenOn', 'Keep screen on', 'The screen won’t sleep while a song is open.', 'wake lock sleep'),
        toggleItem('display.fullscreen', 'Fullscreen', 'Hides browser and system bars while performing.'),
        toggleItem('display.performanceLock', 'Performance lock', 'Blocks annotating, zooming and editing so nothing changes by accident on stage.', 'lock'),
      ],
    },
    {
      title: 'Annotations',
      items: [
        toggleItem('annotations.showWhilePerforming', 'Show annotations', 'Your markings are shown on the pages.'),
        toggleItem('annotations.stylusOnly', 'Draw with stylus only', 'Fingers turn pages and scroll; only a pen draws.', 'pen'),
        toggleItem('annotations.palmRejection', 'Palm rejection', 'Ignores your hand resting on the screen while using a pen.', 'stylus'),
        toggleItem('annotations.pressure', 'Pressure-sensitive pen', 'Line width follows pen pressure.', 'stylus'),
        segItem('annotations.smoothing', 'Ink smoothing', [
          { value: 0, label: 'Off' },
          { value: 1, label: 'Light' },
          { value: 2, label: 'Medium' },
          { value: 3, label: 'Strong' },
        ]),
      ],
    },
  ],
}

/* --------------------------------------------------------- Page turning */

const turning: SectionDef = {
  id: 'turning',
  title: 'Page turning',
  icon: Pointer,
  summary: 'Tap zones, swipes, gestures',
  reset: () => {
    const keys = st().s.pageTurn.keys
    st().setIn('pageTurn', { ...D.pageTurn, keys })
  },
  groups: [
    {
      items: [customItem('pageTurn.zones', 'Tap zones', ZoneEditor, 'touch areas tap page turn grid')],
    },
    {
      title: 'Gestures',
      items: [
        actionItem('pageTurn.swipeLeft', 'Swipe left', undefined, 'swipe'),
        actionItem('pageTurn.swipeRight', 'Swipe right', undefined, 'swipe'),
        actionItem('pageTurn.swipeUp', 'Swipe up', undefined, 'swipe'),
        actionItem('pageTurn.swipeDown', 'Swipe down', undefined, 'swipe'),
        actionItem('pageTurn.doubleTap', 'Double tap', 'Single taps wait a moment when this is set.', 'tap'),
        actionItem('pageTurn.longPress', 'Long press', undefined, 'hold'),
        actionItem('pageTurn.twoFingerTap', 'Two-finger tap', undefined, 'fingers'),
        actionItem('pageTurn.threeFingerTap', 'Three-finger tap', undefined, 'fingers'),
      ],
    },
    {
      title: 'Behaviour',
      items: [
        sliderItem('pageTurn.debounceMs', 'Ignore repeat turns within', { min: 0, max: 2000, step: 50, format: ms }, 'Stops a bouncy pedal or an accidental double tap from turning two pages.', 'debounce double'),
        toggleItem('pageTurn.continueToNextSong', 'Continue to the next song', 'Turning past the last page opens the next song in the setlist or list.', 'setlist'),
        toggleItem('pageTurn.backToPrevSong', 'Go back to the previous song', 'Turning back from the first page opens the end of the previous song.', 'setlist'),
        toggleItem('pageTurn.pedalStopsAtSongEnd', 'Pedals stop at the end of a song', 'A pedal won’t change songs by accident; tap to move on.', 'prevent pedal'),
        toggleItem('pageTurn.showZonesHint', 'Show tap zones when a song opens', 'Briefly outlines the zones as a reminder.', 'hint overlay'),
      ],
    },
  ],
}

const pedals: SectionDef = {
  id: 'pedals',
  title: 'Pedals & keyboard',
  icon: Keyboard,
  summary: 'Bluetooth page turners, shortcuts',
  reset: () => st().setIn('pageTurn', { keys: D.pageTurn.keys }),
  groups: [
    {
      items: [
        customItem('pageTurn.keys', 'Keys and pedals', KeyBindingsEditor, 'bluetooth pedal airturn pageflip donner blueturn shortcut key binding learn'),
      ],
    },
  ],
}

/* ------------------------------------------------------------ Text & chords */

const text: SectionDef = {
  id: 'text',
  title: 'Text & chords',
  icon: Type,
  summary: 'ChordPro font, chords, colours',
  reset: resetKeys('text'),
  groups: [
    { items: [customItem('text.preview', 'Preview', TextPreview, 'chordpro sample')] },
    {
      title: 'Text',
      items: [
        segItem('text.fontFamily', 'Font', [
          { value: 'sans', label: 'Sans' },
          { value: 'serif', label: 'Serif' },
          { value: 'mono', label: 'Mono' },
        ], undefined, 'typeface'),
        sliderItem('text.fontSize', 'Text size', { min: 12, max: 40, step: 1, format: (n) => `${n} px` }, undefined, 'font'),
        sliderItem('text.lineSpacing', 'Line spacing', { min: 1, max: 2, step: 0.05, format: (n) => n.toFixed(2) }),
        toggleItem('text.showMeta', 'Show song details', 'Artist, key, capo and tempo under the title.', 'meta header'),
        segItem('text.chorusStyle', 'Chorus style', [
          { value: 'bar', label: 'Bar' },
          { value: 'background', label: 'Shaded' },
          { value: 'indent', label: 'Indent' },
          { value: 'none', label: 'Plain' },
        ]),
        toggleItem('text.expandChorusRefs', 'Repeat chorus in full', 'Where the song says {chorus}, print the whole chorus again.'),
      ],
    },
    {
      title: 'Chords',
      items: [
        toggleItem('text.showChords', 'Show chords', undefined, 'lyrics only'),
        toggleItem('text.inlineChords', 'Chords inline', 'Shows [G]chords inside the lyric line instead of above it.'),
        toggleItem('text.chordBold', 'Bold chords'),
        sliderItem('text.chordScale', 'Chord size', { min: 0.6, max: 1.4, step: 0.05, format: pct }, 'Relative to the lyrics.'),
        segItem('text.naming', 'Note names', [
          { value: 'english', label: 'C D E … B' },
          { value: 'german', label: 'German (H)' },
          { value: 'latin', label: 'Do Re Mi' },
        ], undefined, 'locale localization solfege'),
        segItem('text.accidental', 'Sharps or flats', [
          { value: 'auto', label: 'From key' },
          { value: 'sharp', label: '♯' },
          { value: 'flat', label: '♭' },
        ], 'Spelling used when transposing.', 'accidentals transpose'),
        toggleItem('text.nashville', 'Nashville numbers', 'Shows chords as numbers relative to the song key (1, 4, 5m…).'),
      ],
    },
    {
      title: 'Colours',
      items: [
        colorItem('text.lyricsColor', 'Lyrics'),
        colorItem('text.chordColor', 'Chords'),
        colorItem('text.titleColor', 'Title'),
        colorItem('text.commentColor', 'Comments and labels'),
        colorItem('text.chorusColor', 'Chorus marker'),
      ],
    },
  ],
}

/* ------------------------------------------------ Metronome / auto-scroll */

const metronome: SectionDef = {
  id: 'metronome',
  title: 'Metronome',
  icon: Timer,
  summary: 'Default tempo, sound, count-in',
  reset: resetKeys('metronome'),
  groups: [
    {
      description: 'Defaults for songs without their own metronome settings.',
      items: [
        sliderItem('metronome.bpm', 'Tempo', { min: 30, max: 300, step: 1, format: (n) => `${n} BPM` }, undefined, 'bpm speed'),
        selectItem('metronome.beatsPerBar', 'Beats per bar', Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) })), undefined, 'time signature'),
        segItem('metronome.beatUnit', 'Beat unit', [
          { value: 2, label: '𝅗𝅥 2' },
          { value: 4, label: '♩ 4' },
          { value: 8, label: '♪ 8' },
        ], undefined, 'time signature'),
        segItem('metronome.subdivision', 'Subdivision', [
          { value: 1, label: 'None' },
          { value: 2, label: '8ths' },
          { value: 3, label: 'Triplets' },
          { value: 4, label: '16ths' },
        ]),
        toggleItem('metronome.accentFirst', 'Accent the first beat'),
        selectItem('metronome.countIn', 'Count-in', [0, 1, 2, 4].map((n) => ({ value: n, label: n ? `${n} bar${n > 1 ? 's' : ''}` : 'Off' }))),
        toggleItem('metronome.audible', 'Click sound'),
        selectItem('metronome.sound', 'Sound', [
          { value: 'click', label: 'Click' },
          { value: 'wood', label: 'Woodblock' },
          { value: 'beep', label: 'Beep' },
          { value: 'cowbell', label: 'Cowbell' },
        ]),
        sliderItem('metronome.volume', 'Volume', { min: 0, max: 1, step: 0.05, format: pct }),
        toggleItem('metronome.visual', 'Flash on the beat', 'Pulses the screen edge, useful with the sound off.', 'visual'),
      ],
    },
  ],
}

const autoscroll: SectionDef = {
  id: 'autoscroll',
  title: 'Auto-scroll',
  icon: ScrollText,
  summary: 'Default scrolling speed and pauses',
  reset: resetKeys('autoScroll'),
  groups: [
    {
      description: 'Defaults for songs without their own auto-scroll settings.',
      items: [
        segItem('autoScroll.mode', 'Speed from', [
          { value: 'duration', label: 'Song duration' },
          { value: 'speed', label: 'Fixed speed' },
        ], 'With “Song duration” the whole song scrolls by in the time set in its details.'),
        sliderItem('autoScroll.speed', 'Fixed speed', { min: 5, max: 200, step: 5, format: (n) => `${n} px/s` }),
        sliderItem('autoScroll.delay', 'Wait before starting', { min: 0, max: 30, step: 1, format: (n) => `${n} s` }, undefined, 'delay'),
        sliderItem('autoScroll.pageDelay', 'Pause at the end of each page', { min: 0, max: 10, step: 0.5, format: (n) => `${n} s` }),
      ],
    },
  ],
}

/* ------------------------------------------------- Modules owned elsewhere */

const wrap = (C: () => ReactNode) =>
  function Wrapped() {
    return <div className="px-4 py-4">{C()}</div>
  }

const midi: SectionDef = {
  id: 'midi',
  title: 'MIDI',
  icon: Cable,
  summary: 'Devices, song recall, MIDI actions',
  groups: [{ items: [customItem('midi', 'MIDI devices and messages', wrap(() => <MidiSettings />), 'midi devices channel program change controller pedal')] }],
}

const libsync: SectionDef = {
  id: 'libsync',
  title: 'Library sync',
  icon: Cloud,
  summary: 'Your library on all your devices, end-to-end encrypted',
  groups: [{ items: [customItem('libsync', 'Library sync', wrap(() => <LibrarySyncSettings />), 'sync cloud s3 r2 backblaze dropbox devices pair qr')] }],
}

const sync: SectionDef = {
  id: 'sync',
  title: 'Devices & sync',
  icon: RadioTower,
  summary: 'Turn pages together with your band',
  groups: [{ items: [customItem('sync', 'Connect devices', wrap(() => <SyncSettings />), 'sync band leader follower remote connect devices')] }],
}

const backup: SectionDef = {
  id: 'backup',
  title: 'Backup & restore',
  icon: ArchiveRestore,
  summary: 'Save and restore your library',
  groups: [{ items: [customItem('backup', 'Backup and restore', wrap(() => <BackupSettings />), 'backup restore export import reminder')] }],
}

/* -------------------------------------------------------- Face gestures */

const faces: SectionDef = {
  id: 'faces',
  title: 'Face gestures',
  icon: ScanFace,
  summary: 'Hands-free control with head and face gestures',
  reset: resetKeys('faceGestures'),
  groups: [
    {
      description: 'Turn pages and more hands-free with the front camera: wink, smile, turn or tilt your head…',
      items: [toggleItem('faceGestures.enabled', 'Use face gestures', 'Turns the camera on while a song is open.', 'camera head mouth hands-free')],
    },
    {
      title: 'Gestures',
      description: 'Make the gesture, then return to a resting face.',
      items: [
        customItem('faceGestures.test', 'Test and tune', FaceGestureTest, 'camera preview test sensitivity meter'),
        customItem('faceGestures.gestures', 'Gestures', FaceGestureList, 'wink eye smile head turn tilt nod eyebrows mouth lips action sensitivity hold'),
      ],
    },
    {
      title: 'Tuning',
      items: [
        sliderItem('faceGestures.cooldownMs', 'Pause after a gesture', { min: 300, max: 3000, step: 100, format: (n) => `${(n / 1000).toFixed(1)} s` }, 'Gestures in this time are ignored.', 'cooldown'),
        customItem('faceGestures.privacy', 'Privacy', FacePrivacyNote, 'privacy camera download model'),
      ],
    },
  ],
}

/* --------------------------------------------------------- Storage / About */

const storage: SectionDef = {
  id: 'storage',
  title: 'Storage',
  icon: Database,
  summary: 'Space used, cleanup',
  groups: [
    {
      items: [
        customItem('storage.usage', 'Space used on this device', StorageUsage, 'quota persist protect storage'),
        customItem('storage.library', 'Library size and cleanup', LibraryStorage, 'thumbnails cache unused files garbage clean'),
      ],
    },
  ],
}

const about: SectionDef = {
  id: 'about',
  title: 'About',
  icon: Info,
  summary: 'Version, licence, shortcuts',
  groups: [
    {
      items: [
        customItem('about.info', 'About OpenStand', AboutInfo, 'version licence license mobilesheets'),
        customItem('about.shortcuts', 'Keyboard shortcuts', ShortcutSheet, 'cheat sheet keys'),
        customItem('about.credits', 'Credits', Credits, 'open source licences libraries pdf.js abcjs'),
      ],
    },
  ],
}

export const SECTIONS: SectionDef[] = [
  appearance,
  library,
  display,
  turning,
  pedals,
  text,
  metronome,
  autoscroll,
  midi,
  libsync,
  sync,
  backup,
  faces,
  storage,
  about,
]

