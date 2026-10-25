import type { FileKind } from '../db/schema'

const EXT: Record<string, FileKind> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  avif: 'image',
  cho: 'chordpro',
  chopro: 'chordpro',
  chordpro: 'chordpro',
  crd: 'chordpro',
  pro: 'chordpro',
  chord: 'chordpro',
  txt: 'text',
  text: 'text',
  abc: 'abc',
}

export const ACCEPT = Object.keys(EXT)
  .map((e) => '.' + e)
  .join(',')

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? name : name.slice(0, i)
}

export function kindOf(name: string, mime = ''): FileKind | null {
  const k = EXT[extOf(name)]
  if (k) return k
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/')) return 'text'
  return null
}

/** Audio recordings aren't sheet music: they're attached in a song's Audio tab instead. */
export function isAudioFile(name: string, mime = ''): boolean {
  return mime.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|aiff?|wma)$/i.test(name)
}

export function mimeOf(kind: FileKind, name: string): string {
  switch (kind) {
    case 'pdf':
      return 'application/pdf'
    case 'image': {
      const e = extOf(name)
      return e === 'jpg' ? 'image/jpeg' : `image/${e || 'png'}`
    }
    default:
      return 'text/plain;charset=utf-8'
  }
}

export const isTextKind = (k: FileKind) => k === 'chordpro' || k === 'text' || k === 'abc'
