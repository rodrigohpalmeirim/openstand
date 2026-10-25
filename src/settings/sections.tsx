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
  ArrowDownUp,
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
import { useTerms, type Terms } from '../library/browse/terms'
import { NAMINGS } from '../music/chords'
import { DEFAULT_SETTINGS, useSettings, type Settings } from '../state/settings'
import { SyncSettings } from '../sync/SyncSettings'
import { cx } from '../ui/primitives'
import { radioGroupProps, radioTabIndex } from '../ui/radio'
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
      <div className="flex flex-wrap gap-2" aria-label="Accent colour" {...radioGroupProps()}>
        {(Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]).map((id, i) => (
          <button
            key={id}
            role="radio"
            aria-checked={accent === id}
            tabIndex={radioTabIndex(accent === id, i, accent in ACCENTS)}
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

const appearance = (t: Terms): SectionDef => ({
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
        ], `Grid shows the first page of each ${t.song}.`, 'density thumbnails'),
        segItem('terminology', 'Call them', [
          { value: 'song', label: 'Songs' },
          { value: 'piece', label: 'Pieces' },
        ], 'Classical musicians may prefer “pieces”. Albums are then called “Books”.', 'terminology classical piece'),
      ],
    },
  ],
})

/* ------------------------------------------------------------- Library */

const library = (t: Terms): SectionDef => ({
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
        selectItem('librarySort.field', `Sort ${t.songs} by`, [
          { value: 'title', label: 'Title' },
          { value: 'artist', label: 'Artist' },
          { value: 'key', label: 'Key' },
          { value: 'createdAt', label: 'Date added' },
          { value: 'modifiedAt', label: 'Date modified' },
          { value: 'lastPlayedAt', label: 'Last played' },
          { value: 'playCount', label: 'Play count' },
          { value: 'rating', label: 'Rating' },
          { value: 'difficulty', label: 'Difficulty' },
          { value: 'duration', label: 'Duration' },
        ], `Default order of the ${t.song} list.`, 'order'),
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
      title: `Opening ${t.songs}`,
      items: [
        toggleItem('loadEntireList', 'Perform the whole list', `Tapping a ${t.song} opens the visible list or setlist starting at that ${t.song}, so you can page straight through.`, 'setlist load next song'),
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
        selectItem('importPrefs.conflict', `When a ${t.song} with the same title exists`, [
          { value: 'create', label: `Add another ${t.song}` },
          { value: 'update', label: 'Add files to it' },
          { value: 'skip', label: 'Skip' },
        ], undefined, 'import duplicate'),
        toggleItem('importPrefs.autoCrop', 'Crop margins on import', 'Removes empty borders from scanned pages.', 'import crop'),
        toggleItem('editor.aggressiveCrop', 'Aggressive cropping', 'Ignores specks and scan borders in the margins when cropping.', 'crop'),
        toggleItem('editor.capitalizeWords', 'Capitalise words', 'Capitalise each word of titles and field values you type.', 'capitalize editor'),
      ],
    },
  ],
})

/* ------------------------------------------------------ Performance display */

const modes = [
  { value: 'single', label: 'One page' },
  { value: 'double', label: 'Two pages' },
  { value: 'halfPage', label: 'Half pages' },
  { value: 'verticalScroll', label: 'Vertical scroll' },
  { value: 'horizontalScroll', label: 'Horizontal scroll' },
] as const

const display = (t: Terms): SectionDef => ({
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
        selectItem('display.mode', 'Display mode', [...modes], `How pages are laid out. Each ${t.song} can override this.`, 'portrait single double half scroll'),
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
        sliderItem('display.pageGap', 'Space between pages', { min: 0, max: 48, step: 2, format: (n) => `${n} px` }, undefined, 'margin gap'),
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
        toggleItem('display.showSongTitle', `${t.Song} title`, 'Shows the title at the top when the toolbar is hidden.'),
        toggleItem('display.showNextSongHint', `Next ${t.song} hint`, `On the last page, shows which ${t.song} comes next.`, 'next up setlist'),
        sliderItem('display.toolbarAutoHide', 'Hide toolbar after', { min: 0, max: 10, step: 1, format: sec }, undefined, 'auto-hide overlay'),
        toggleItem('display.hideCursor', 'Hide mouse cursor', 'Hides the pointer when the mouse is idle.', 'mouse'),
      ],
    },
    {
      title: 'Screen',
      items: [
        toggleItem('display.keepScreenOn', 'Keep screen on', `The screen won’t sleep while a ${t.song} is open.`, 'wake lock sleep'),
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
})

/* --------------------------------------------------------- Page turning */

const turning = (t: Terms): SectionDef => ({
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
        toggleItem('pageTurn.continueToNextSong', `Continue to the next ${t.song}`, `Turning past the last page opens the next ${t.song} in the setlist or list.`, 'setlist'),
        toggleItem('pageTurn.backToPrevSong', `Go back to the previous ${t.song}`, `Turning back from the first page opens the end of the previous ${t.song}.`, 'setlist'),
        toggleItem('pageTurn.pedalStopsAtSongEnd', `Pedals stop at the end of a ${t.song}`, `A pedal won’t change ${t.songs} by accident; tap to move on.`, 'prevent pedal'),
        toggleItem('pageTurn.showZonesHint', `Show tap zones when a ${t.song} opens`, 'Briefly outlines the zones as a reminder.', 'hint overlay'),
      ],
    },
  ],
})

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

const text = (t: Terms): SectionDef => ({
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
        toggleItem('text.showMeta', `Show ${t.song} details`, 'Artist, key, capo and tempo under the title.', 'meta header'),
        segItem('text.chorusStyle', 'Chorus style', [
          { value: 'bar', label: 'Bar' },
          { value: 'background', label: 'Shaded' },
          { value: 'indent', label: 'Indent' },
          { value: 'none', label: 'Plain' },
        ]),
        toggleItem('text.expandChorusRefs', 'Repeat chorus in full', `Where the ${t.song} says {chorus}, print the whole chorus again.`),
      ],
    },
    {
      title: 'Chords',
      items: [
        toggleItem('text.showChords', 'Show chords', undefined, 'lyrics only'),
        toggleItem('text.inlineChords', 'Chords inline', 'Shows [G]chords inside the lyric line instead of above it.'),
        toggleItem('text.chordBold', 'Bold chords'),
        sliderItem('text.chordScale', 'Chord size', { min: 0.6, max: 1.4, step: 0.05, format: pct }, 'Relative to the lyrics.'),
        selectItem(
          'text.naming',
          'Show chords as',
          NAMINGS.map((n) => ({ value: n.value, label: `${n.label} (${n.hint})` })),
          `Note names, or Nashville numbers relative to the ${t.song} key.`,
          'note names notation locale localization solfege german nashville numbers',
        ),
        segItem('text.sourceNaming', 'Chords in files are written as', [
          { value: 'english', label: 'B and Bb' },
          { value: 'german', label: 'H and B (German)' },
        ], 'In German-style files B means B♭ and H means B. A file can also say {meta: notation german}.', 'note names notation german h'),
        segItem('text.accidental', 'Sharps or flats', [
          { value: 'auto', label: 'From key' },
          { value: 'sharp', label: '♯' },
          { value: 'flat', label: '♭' },
        ], 'Spelling used when transposing.', 'accidentals transpose'),
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
})

/* ------------------------------------------------ Metronome / auto-scroll */

const metronome = (t: Terms): SectionDef => ({
  id: 'metronome',
  title: 'Metronome',
  icon: Timer,
  summary: 'Default tempo, sound, count-in',
  reset: resetKeys('metronome'),
  groups: [
    {
      description: `Defaults for ${t.songs} without their own metronome settings.`,
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
})

const autoscroll = (t: Terms): SectionDef => ({
  id: 'autoscroll',
  title: 'Auto-scroll',
  icon: ScrollText,
  summary: 'Default scrolling speed and pauses',
  reset: resetKeys('autoScroll'),
  groups: [
    {
      description: `Defaults for ${t.songs} without their own auto-scroll settings.`,
      items: [
        segItem('autoScroll.mode', 'Speed from', [
          { value: 'duration', label: `${t.Song} duration` },
          { value: 'speed', label: 'Fixed speed' },
        ], `With “${t.Song} duration” the whole ${t.song} scrolls by in the time set in its details.`),
        sliderItem('autoScroll.speed', 'Fixed speed', { min: 5, max: 200, step: 5, format: (n) => `${n} px/s` }),
        sliderItem('autoScroll.delay', 'Wait before starting', { min: 0, max: 30, step: 1, format: (n) => `${n} s` }, undefined, 'delay'),
        sliderItem('autoScroll.pageDelay', 'Pause at the end of each page', { min: 0, max: 10, step: 0.5, format: (n) => `${n} s` }),
      ],
    },
  ],
})

/* ------------------------------------------------- Modules owned elsewhere */

const wrap = (C: () => ReactNode) =>
  function Wrapped() {
    return <div className="px-4 py-4">{C()}</div>
  }

const midi = (t: Terms): SectionDef => ({
  id: 'midi',
  title: 'MIDI',
  icon: Cable,
  summary: `Devices, ${t.song} recall, MIDI actions`,
  groups: [{ items: [customItem('midi', 'MIDI devices and messages', wrap(() => <MidiSettings />), 'midi devices channel program change controller pedal')] }],
})

const libsync: SectionDef = {
  id: 'libsync',
  title: 'Library sync',
  icon: Cloud,
  summary: 'Your library on all your devices, end-to-end encrypted',
  groups: [{ items: [customItem('libsync', 'Library sync', wrap(() => <LibrarySyncSettings />), 'sync cloud s3 r2 backblaze dropbox google drive onedrive devices pair qr relay encrypted')] }],
}

const sync: SectionDef = {
  id: 'sync',
  title: 'Page sync',
  icon: RadioTower,
  summary: 'Turn pages together with your band',
  groups: [{ items: [customItem('sync', 'Connect devices', wrap(() => <SyncSettings />), 'sync band leader follower remote connect devices relay server room page turn')] }],
}

const backup: SectionDef = {
  id: 'backup',
  title: 'Export & import',
  icon: ArrowDownUp,
  summary: 'Export to a file, or import one',
  groups: [{ items: [customItem('backup', 'Export and import', wrap(() => <BackupSettings />), 'export import backup restore reminder package osbackup')] }],
}

/* -------------------------------------------------------- Face gestures */

const faces = (t: Terms): SectionDef => ({
  id: 'faces',
  title: 'Face gestures',
  icon: ScanFace,
  summary: 'Hands-free control with head and face gestures',
  reset: resetKeys('faceGestures'),
  groups: [
    {
      description: 'Turn pages and more hands-free with the front camera: wink, smile, turn or tilt your head…',
      items: [toggleItem('faceGestures.enabled', 'Use face gestures', `Turns the camera on while a ${t.song} is open.`, 'camera head mouth hands-free')],
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
})

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
        customItem('about.info', 'About OpenStand', AboutInfo, 'version licence license mobilesheets privacy policy'),
        customItem('about.shortcuts', 'Keyboard shortcuts', ShortcutSheet, 'cheat sheet keys'),
        customItem('about.credits', 'Credits', Credits, 'open source licences libraries pdf.js abcjs'),
      ],
    },
  ],
}

let cached: { key: string; list: SectionDef[] } | undefined

/** All settings sections, worded for the current terminology (rebuilt only when it changes). */
export function sections(t: Terms): SectionDef[] {
  if (cached?.key !== t.song) {
    cached = {
      key: t.song,
      list: [
        appearance(t),
        library(t),
        display(t),
        turning(t),
        pedals,
        text(t),
        metronome(t),
        autoscroll(t),
        midi(t),
        libsync,
        sync,
        backup,
        faces(t),
        storage,
        about,
      ],
    }
  }
  return cached.list
}

export function useSections(): SectionDef[] {
  return sections(useTerms())
}

