/**
 * Getting generated files to the user: File System Access save picker (Chromium desktop), Web Share
 * (phones/tablets), or a plain download. Long-running exports lose the click's user activation, so
 * when the browser refuses we fall back to a toast with a button that retries inside a fresh tap.
 */
import { toast } from '../ui/primitives'

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}
type SavePicker = (o?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
type DirPicker = (o?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>

export const canSavePicker = () => typeof window !== 'undefined' && 'showSaveFilePicker' in window
export const canPickDirectory = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

export function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.canShare?.({ files })
  } catch {
    return false
  }
}

/** Phones/tablets without a save picker get the share sheet by default. */
export function prefersShare(): boolean {
  return !canSavePicker() && typeof navigator !== 'undefined' && 'share' in navigator && matchMedia?.('(pointer: coarse)').matches
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const isActivation = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function extOf(name: string) {
  const m = /\.[^.]+$/.exec(name)
  return m ? m[0].toLowerCase() : ''
}

/**
 * Ask where to save before doing heavy work (needs the click's user activation).
 * Returns null when the user cancelled, undefined when no picker is available.
 */
export async function pickSaveFile(name: string, description: string, mime: string): Promise<FileSystemFileHandle | null | undefined> {
  if (!canSavePicker()) return undefined
  try {
    const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker
    const ext = extOf(name)
    return await picker({ suggestedName: name, types: ext ? [{ description, accept: { [mime]: [ext] } }] : undefined })
  } catch (e) {
    if (isAbort(e)) return null
    // Activation expired or picker blocked: fall back to download.
    return undefined
  }
}

export async function pickDirectory(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (!canPickDirectory()) return null
  try {
    return await (window as unknown as { showDirectoryPicker: DirPicker }).showDirectoryPicker({ id, mode: 'readwrite' })
  } catch (e) {
    if (!isAbort(e)) toast(String((e as Error).message ?? e), 'error')
    return null
  }
}

export async function writeToHandle(handle: FileSystemFileHandle, blob: Blob) {
  const w = await handle.createWritable()
  try {
    await w.write(blob)
    await w.close()
  } catch (e) {
    await w.abort().catch(() => {})
    throw e
  }
}

export interface DeliverOptions {
  /** true = share sheet, false = save/download, undefined = pick per device */
  share?: boolean
  title?: string
  description?: string
}

/** Hand one or more finished files to the user. Resolves to false if they cancelled. */
export async function deliverFiles(files: File[], opts: DeliverOptions = {}): Promise<boolean> {
  if (!files.length) return false
  const share = opts.share ?? prefersShare()
  if (share && canShareFiles(files)) {
    try {
      await navigator.share({ files, title: opts.title })
      return true
    } catch (e) {
      if (isAbort(e)) return false
      if (isActivation(e)) {
        toast(files.length === 1 ? `${files[0].name} is ready` : `${files.length} files are ready`, 'ok', {
          label: 'Share',
          run: () => void navigator.share({ files, title: opts.title }).catch(() => files.forEach((f) => downloadBlob(f, f.name))),
        })
        return true
      }
      // Share failed for another reason: fall through to saving.
    }
  }
  if (files.length === 1 && canSavePicker()) {
    const f = files[0]
    try {
      const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker
      const ext = extOf(f.name)
      const handle = await picker({
        suggestedName: f.name,
        types: ext ? [{ description: opts.description ?? 'File', accept: { [f.type || 'application/octet-stream']: [ext] } }] : undefined,
      })
      await writeToHandle(handle, f)
      toast(`Saved ${handle.name}`, 'ok')
      return true
    } catch (e) {
      if (isAbort(e)) return false
      if (isActivation(e)) {
        toast(`${f.name} is ready`, 'ok', { label: 'Save', run: () => downloadBlob(f, f.name) })
        return true
      }
      console.warn('save picker failed, downloading instead', e)
    }
  }
  for (const f of files) downloadBlob(f, f.name)
  return true
}

/** Safe file name from a song/setlist title. */
export function safeName(s: string, fallback = 'OpenStand') {
  const clean = s
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return clean || fallback
}

export function dateStamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
