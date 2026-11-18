/** Types for the scanner's "correct" mode: editing pages of an existing file instead of new photos. */
import type { Bend, Quad } from './geometry'
import type { FilterParams } from './image'
import type { EncodedPage } from './pdf'
import type { RenderParams } from './processor'

export interface CorrectSource {
  /** The page as an image (a rendered PDF page, or the image file itself). */
  blob: Blob
  /** Quarter turns clockwise the page is shown with (its saved rotation setting). */
  rotation: number
}

/** What the user set for one page. */
export interface PageEdit {
  quad: Quad
  bend?: Bend
  /** Quarter turns clockwise, as shown in the editor. */
  rotation: number
  /** False when the page image couldn't be read: it must be kept as it was. */
  ready: boolean
}

export interface CorrectSaveContext {
  edits: PageEdit[]
  params: FilterParams
  /** Encode page i at full resolution with its outline and the filter; never rotated (rotation stays a page setting). */
  exportPage: (i: number, extra?: Partial<RenderParams>) => Promise<EncodedPage>
  progress: (done: number, total: number) => void
}

export interface CorrectSession {
  pages: CorrectSource[]
  /** Label of the save button. */
  saveLabel: string
  /** Resolves false when the user backed out (the editor stays open). */
  save: (ctx: CorrectSaveContext) => Promise<boolean>
}
