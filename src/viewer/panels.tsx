import type { DisplayMode, Song } from '../db/schema'
import { AudioPanel } from '../tools/AudioPanel'
import { AutoScrollPanel } from '../tools/AutoScrollPanel'
import { BookmarksPanel } from '../tools/BookmarksPanel'
import { LinksPanel } from '../tools/LinksPanel'
import { MetronomePanel } from '../tools/MetronomePanel'
import { NotesPanel } from '../tools/NotesPanel'
import { SetlistPanel } from '../tools/SetlistPanel'
import { TextPanel } from '../tools/TextPanel'
import { MidiPanel } from '../midi/MidiPanel'
import type { Panel } from '../state/viewer'
import { DisplayPanel } from './DisplayPanel'
import type { Stop } from './layout'
import type { DisplayPage } from './useDisplayPages'

/** Everything a viewer panel may need about the current performance state. */
export interface PanelProps {
  song: Song
  pages: DisplayPage[]
  stops: Stop[]
  pos: number
  paged: boolean
  mode: DisplayMode
  /** Index into `pages` of the first visible page. */
  currentPage: number
  goToPage: (page: number) => void
  close: () => void
}

export const PANELS: Record<Exclude<Panel, null | 'goto' | 'pages'>, { title: string; side: 'right' | 'bottom'; Component: (p: PanelProps) => React.ReactNode }> = {
  setlist: { title: 'Setlist', side: 'right', Component: SetlistPanel },
  bookmarks: { title: 'Bookmarks', side: 'right', Component: BookmarksPanel },
  display: { title: 'Display', side: 'right', Component: DisplayPanel },
  metronome: { title: 'Metronome', side: 'right', Component: MetronomePanel },
  audio: { title: 'Audio', side: 'right', Component: AudioPanel },
  notes: { title: 'Notes', side: 'right', Component: NotesPanel },
  text: { title: 'Text & chords', side: 'right', Component: TextPanel },
  links: { title: 'Link points', side: 'right', Component: LinksPanel },
  midi: { title: 'MIDI', side: 'right', Component: MidiPanel },
  autoscroll: { title: 'Auto-scroll', side: 'right', Component: AutoScrollPanel },
}
