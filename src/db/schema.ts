/**
 * OpenStand data model.
 *
 * Songs carry their metadata groups (artists, composers, genres, …) as string arrays so Dexie
 * multi-entry indexes can list and filter groups without join tables. Setlists are ordered lists
 * of song references (duplicates allowed); collections are unordered named sets.
 */

export type ID = string

export type FileKind = 'pdf' | 'image' | 'chordpro' | 'text' | 'abc'

/** Metadata fields that behave as browseable "groups" in the library. */
export const GROUP_FIELDS = [
  'artists',
  'composers',
  'albums',
  'genres',
  'collections',
  'keys',
  'signatures',
  'sources',
  'years',
  'tags',
  'custom',
  'custom2',
] as const
export type GroupField = (typeof GROUP_FIELDS)[number]

export interface Crop {
  /** Fractions (0..1) of the page cut from each edge. */
  top: number
  bottom: number
  left: number
  right: number
}

export interface PageRef {
  fileId: ID
  /** 0-based page within the file. */
  page: number
}

export interface PageSettings {
  crop?: Crop
  /** Extra clockwise rotation in degrees. */
  rotation?: 0 | 90 | 180 | 270
}

export interface MetronomeSettings {
  bpm: number
  /** Beats per bar, e.g. 4 in 4/4. */
  beatsPerBar: number
  /** Note value of a beat (4 = quarter). */
  beatUnit: number
  /** Subdivision clicks per beat (1 = none, 2 = eighths, 3 = triplets, 4 = sixteenths). */
  subdivision: number
  accentFirst: boolean
  /** Count-in bars before the song starts (0 = off). */
  countIn: number
  /** Flash the screen border on beats. */
  visual: boolean
  /** Play click audio. */
  audible: boolean
  sound: 'click' | 'wood' | 'beep' | 'cowbell'
  volume: number
  /** Start the metronome when the song opens. */
  autoStart?: boolean
  /** Turn the page every N beats while the metronome runs (0/undefined = off). */
  beatsPerPage?: number
}

export interface AutoScrollSettings {
  /** How the scroll speed is determined. */
  mode: 'duration' | 'speed'
  /** Seconds to wait before scrolling starts. */
  delay: number
  /** Pixels per second (mode = speed). */
  speed: number
  /** Pause at the bottom of each page before turning (seconds). */
  pageDelay: number
  /** Start scrolling when the song opens. */
  startOnLoad?: boolean
}

export type MidiMessageType =
  | 'programChange'
  | 'controlChange'
  | 'noteOn'
  | 'noteOff'
  | 'bankSelect'
  | 'sysex'
  | 'start'
  | 'stop'
  | 'continue'
  /** Bank MSB + bank LSB + program change; each part is sent only when set. */
  | 'patchSelect'
  /** Song Select (F3 ss), data1 = song number. */
  | 'songSelect'
  /** Start/stop sending MIDI timing clock (24 PPQN) at the song's metronome tempo. */
  | 'clockStart'
  | 'clockStop'
  /** Wait `delayMs` before the next command. */
  | 'pause'
  /** Sends `children` in order (no nesting). */
  | 'batch'

export interface MidiCommand {
  type: MidiMessageType
  /** 1..16 */
  channel: number
  /** program / controller / note number */
  data1?: number
  /** controller value / velocity / bank LSB */
  data2?: number
  /** bank MSB for bankSelect / patchSelect */
  msb?: number
  /** hex bytes for sysex, e.g. "F0 7E 7F 06 01 F7" */
  sysex?: string
  /** Optional user label, e.g. "Piano patch". */
  label?: string
  /** bank LSB for patchSelect */
  lsb?: number
  /** pause length in ms (type 'pause') */
  delayMs?: number
  /** sub-commands (type 'batch') */
  children?: MidiCommand[]
  /** Send when the song opens (default true when undefined). */
  sendOnLoad?: boolean
  /** Receiving this message opens the song (in addition to Song.midiRecall). */
  loadOnReceive?: boolean
  /** Output port name; empty/undefined = all enabled outputs. */
  output?: string
}

export interface TextDisplayOverrides {
  transpose?: number
  capo?: number
  fontScale?: number
  showChords?: boolean
  columns?: number
  accidental?: 'sharp' | 'flat' | 'auto'
}

export interface Song {
  id: ID
  title: string
  /** Overrides title for sorting (e.g. strips leading "The"). */
  sortTitle?: string
  artists: string[]
  composers: string[]
  albums: string[]
  genres: string[]
  collections: string[]
  keys: string[]
  signatures: string[]
  sources: string[]
  years: string[]
  tags: string[]
  custom: string[]
  custom2: string[]
  /** 0..5 */
  rating: number
  /** 0 = unset, 1..15 (older data used 1..5; still valid). */
  difficulty: number
  /** Seconds. */
  duration: number
  notes: string
  keywords: string
  /** Page in the source book the song starts at. */
  sourcePage?: number
  /** Optional user song number ("Song ID" in the original), e.g. a hymnal number. */
  songNumber?: number
  /** Tempo marks in BPM (a song may have several, e.g. intro 90 / main 120). */
  tempos?: number[]

  files: SongFile[]
  /** Custom page order; when absent all pages of all files are shown in order. */
  pageOrder?: PageRef[]
  /** Keyed by `${fileId}:${page}`. */
  pageSettings: Record<string, PageSettings>
  /** Song-level display overrides. */
  display?: Partial<SongDisplay>
  text?: TextDisplayOverrides
  metronome?: Partial<MetronomeSettings>
  autoScroll?: Partial<AutoScrollSettings>
  midiOnLoad: MidiCommand[]
  /** Optional MIDI message that recalls this song (program change listener). */
  midiRecall?: MidiCommand
  bookmarks: Bookmark[]
  links: LinkPoint[]
  /** On-page buttons that run an action when tapped (performance tools). */
  smartButtons?: SmartButton[]
  audio: AudioTrack[]

  favorite: boolean
  createdAt: number
  modifiedAt: number
  lastPlayedAt?: number
  playCount: number
}

export interface SongFile {
  id: ID
  name: string
  kind: FileKind
  blobId: ID
  /** For pdf/images known page count; text formats are paginated at render time (1 here). */
  pageCount: number
  size: number
  /** Original relative path when imported from a folder (used by "find missing files"). */
  sourcePath?: string
}

export interface Bookmark {
  id: ID
  name: string
  /** Index into the song's resolved page list. */
  pageIndex: number
  /** Show as a separate entry in the library song list. */
  showInLibrary?: boolean
}

/** A link point jumps from one area of a page to another (repeats, D.S., codas). */
export interface LinkPoint {
  id: ID
  from: { pageIndex: number; x: number; y: number }
  to: { pageIndex: number; x: number; y: number }
  /** Label shown on the marker, e.g. "D.S." */
  label?: string
}

/** What a smart button does when tapped. */
export type SmartButtonKind = 'action' | 'page' | 'song' | 'audio' | 'midi' | 'url'

/** A tappable button placed on a page (position normalised 0..1 like annotations). */
export interface SmartButton {
  id: ID
  label: string
  pageIndex: number
  x: number
  y: number
  kind: SmartButtonKind
  /** kind 'action': an ActionId (kept as string so the schema stays free of viewer imports). */
  action?: string
  /** kind 'page' | 'song': target page index (0-based). */
  page?: number
  /** kind 'song': song to open. */
  songId?: ID
  /** kind 'audio': track of this song to play and the start offset in seconds. */
  trackId?: ID
  start?: number
  /** kind 'midi': commands to send. */
  midi?: MidiCommand[]
  /** kind 'url': address to open in a new tab. */
  url?: string
  size?: 'sm' | 'md' | 'lg'
}

export interface AudioTrack {
  id: ID
  name: string
  blobId?: ID
  url?: string
  /** A-B loop points in seconds. */
  loopStart?: number
  loopEnd?: number
  /** Start playing automatically when the song is opened. */
  autoPlay?: boolean
  volume?: number
  speed?: number
}

export type DisplayMode = 'single' | 'double' | 'halfPage' | 'verticalScroll' | 'horizontalScroll'
export type FitMode = 'page' | 'width' | 'height'

export interface SongDisplay {
  mode: DisplayMode
  fit: FitMode
  /** Extra zoom on top of fit (1 = none). */
  zoom: number
}

export interface SetlistEntry {
  /** Unique within the setlist so duplicates of the same song can be reordered. */
  key: ID
  songId: ID
  /** Optional per-entry note shown in the setlist, e.g. "segue", "capo 2". */
  note?: string
  /** Per-entry transposition for text songs. */
  transpose?: number
  /** Marks a set break ("Intermission"); songId is '' for breaks. */
  isBreak?: boolean
  breakLabel?: string
}

export interface Setlist {
  id: ID
  name: string
  entries: SetlistEntry[]
  notes: string
  /** ISO date of the gig, optional. */
  date?: string
  venue?: string
  createdAt: number
  modifiedAt: number
  lastPlayedAt?: number
}

/* ------------------------------------------------------------- Annotations */

export type AnnotationTool =
  | 'pen'
  | 'highlighter'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'stamp'
  | 'crescendo'
  | 'decrescendo'
  | 'staff'
  | 'image'

export interface Point {
  x: number
  y: number
  /** pressure 0..1 */
  p?: number
}

interface AnnotationBase {
  id: ID
  /** Coordinates are normalised to the uncropped, unrotated page: 0..1 on both axes. */
  layer: string
  color: string
  /** 0..1 */
  opacity: number
  createdAt: number
}

export interface StrokeAnnotation extends AnnotationBase {
  type: 'pen' | 'highlighter'
  /** Stroke width as a fraction of page width. */
  width: number
  points: Point[]
  dashed?: boolean
}

export interface ShapeAnnotation extends AnnotationBase {
  type: 'line' | 'arrow' | 'rect' | 'ellipse' | 'crescendo' | 'decrescendo' | 'staff'
  width: number
  a: Point
  b: Point
  fill?: boolean
  dashed?: boolean
  /** Hairpin opening (crescendo/decrescendo) as a fraction of page width. */
  height?: number
  /** Piano staff (grand staff): number of measures; `a`/`b` are opposite corners of the system. */
  measures?: number
}

export interface TextAnnotation extends AnnotationBase {
  type: 'text'
  at: Point
  text: string
  /** Font size as a fraction of page height. */
  size: number
  bold?: boolean
  italic?: boolean
  font?: 'sans' | 'serif' | 'mono'
  /** Draw a background box behind the text. */
  background?: string
}

export interface StampAnnotation extends AnnotationBase {
  type: 'stamp'
  at: Point
  stamp: string
  /** Stamp height as a fraction of page height. */
  size: number
}

/** A placed picture (user stamp image); `a`/`b` are opposite corners. */
export interface ImageAnnotation extends AnnotationBase {
  type: 'image'
  a: Point
  b: Point
  /** data: URL (downscaled on import). */
  src: string
}

export type Annotation = StrokeAnnotation | ShapeAnnotation | TextAnnotation | StampAnnotation | ImageAnnotation

/** All annotations for one page of one file. */
export interface PageAnnotations {
  /** `${songId}:${fileId}:${page}` */
  id: string
  songId: ID
  fileId: ID
  page: number
  items: Annotation[]
}

export interface Layer {
  id: string
  name: string
  visible: boolean
}

/** Layer definitions of one song, stored in db.kv under `layers:${songId}`. */
export interface SongLayers {
  layers: Layer[]
  /** Layer new annotations go to. */
  current: string
}

/* --------------------------------------------------------------- Storage */

export interface BlobRecord {
  id: ID
  data: Blob
  size: number
  /** SHA-256 hex of the content; used for de-duplication. */
  hash: string
  mime: string
}

export interface ThumbRecord {
  /** songId */
  id: ID
  data: Blob
  updatedAt: number
  /** What the thumbnail was rendered from (first page file/page/crop); re-render only when it changes. */
  sig?: string
}

export interface KV<T = unknown> {
  key: string
  value: T
}

export function emptySong(partial: Partial<Song> & { id: ID; title: string }): Song {
  const now = Date.now()
  return {
    artists: [],
    composers: [],
    albums: [],
    genres: [],
    collections: [],
    keys: [],
    signatures: [],
    sources: [],
    years: [],
    tags: [],
    custom: [],
    custom2: [],
    rating: 0,
    difficulty: 0,
    duration: 0,
    notes: '',
    keywords: '',
    files: [],
    pageSettings: {},
    midiOnLoad: [],
    bookmarks: [],
    links: [],
    audio: [],
    favorite: false,
    createdAt: now,
    modifiedAt: now,
    playCount: 0,
    ...partial,
  }
}
