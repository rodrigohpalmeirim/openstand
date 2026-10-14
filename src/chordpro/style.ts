/** Display settings for text/ChordPro songs (kept dependency-free: state/settings imports it). */
import type { Accidental, NoteNaming } from '../music/chords'
import type { Instrument } from '../music/diagrams'

export interface TextStyle {
  fontFamily: 'sans' | 'serif' | 'mono'
  /** Lyrics font size in px at zoom 1. */
  fontSize: number
  /** Chord size relative to lyrics. */
  chordScale: number
  chordColor: string
  chordBold: boolean
  lyricsColor: string
  titleColor: string
  commentColor: string
  /** How a chorus is highlighted. */
  chorusStyle: 'bar' | 'background' | 'indent' | 'none'
  chorusColor: string
  lineSpacing: number
  showChords: boolean
  showMeta: boolean
  /** Render choruses again where {chorus} references appear. */
  expandChorusRefs: boolean
  /** Lyrics-only view (hide chord lines entirely). */
  lyricsOnly: boolean
  /** Display locale for chord names. */
  naming: NoteNaming
  /** Locale chords are written in (overridden per file by {meta: notation …}). */
  sourceNaming: NoteNaming
  /** Display chords as Nashville numbers relative to the song key. */
  nashville: boolean
  /** Spelling of transposed chords. */
  accidental: Accidental | 'auto'
  /** Allow double sharps/flats when transposing. */
  allowDouble: boolean
  /** Allow Cb, B#, E#, Fb when transposing. */
  allowUncommon: boolean
  /** Show chords inline "[G]word" instead of above. */
  inlineChords: boolean
  /** Honour {textsize}, {chordcolour}… directives in files. */
  formatDirectives: boolean
  /** Instrument for chord diagrams and {directive-instrument} selectors. */
  instrument: Instrument
  /** Where chord diagrams are shown. */
  diagrams: 'off' | 'bottom' | 'panel'
  /** Tap a chord in the viewer to see its diagram. */
  diagramTap: boolean
  /** Diagram scale. */
  diagramSize: number
  /** Font size of the text editor in px. */
  editorFontSize: number
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'sans',
  fontSize: 20,
  chordScale: 0.9,
  chordColor: '#c2410c',
  chordBold: true,
  lyricsColor: '#1b1a18',
  titleColor: '#1b1a18',
  commentColor: '#6a6760',
  chorusStyle: 'bar',
  chorusColor: '#c2410c',
  lineSpacing: 1.15,
  showChords: true,
  showMeta: true,
  expandChorusRefs: true,
  lyricsOnly: false,
  naming: 'english',
  sourceNaming: 'english',
  nashville: false,
  accidental: 'auto',
  allowDouble: false,
  allowUncommon: false,
  inlineChords: false,
  formatDirectives: true,
  instrument: 'guitar',
  diagrams: 'panel',
  diagramTap: true,
  diagramSize: 1,
  editorFontSize: 15,
}
