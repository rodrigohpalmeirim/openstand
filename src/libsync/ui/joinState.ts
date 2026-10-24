/** Join-flow state (§10.3, §12.2): scan or paste → preview → mode → progress. Pure. */
import type { JoinPreview } from '../api'
import { LibSyncFailure } from '../api'
import { PairingError, type JoinMode, type PairingPayload } from '../model'
import { errorText, fmtBytes, plural } from './format'

export type JoinStep = 'scan' | 'checking' | 'preview' | 'joining' | 'done'

export interface JoinState {
  step: JoinStep
  payload?: PairingPayload
  preview?: JoinPreview
  mode: JoinMode
  error?: string
}

export type JoinAction =
  | { type: 'code' }
  | { type: 'parsed'; payload: PairingPayload }
  | { type: 'previewed'; preview: JoinPreview }
  | { type: 'failed'; error: string }
  | { type: 'mode'; mode: JoinMode }
  | { type: 'join' }
  | { type: 'joined' }
  | { type: 'back' }

export const initialJoin = (): JoinState => ({ step: 'scan', mode: 'newLibrary' })

export function joinReducer(s: JoinState, a: JoinAction): JoinState {
  switch (a.type) {
    case 'code':
      return { ...s, step: 'checking', error: undefined, payload: undefined, preview: undefined }
    case 'parsed':
      return { ...s, payload: a.payload }
    case 'previewed':
      // §15.4: a non-empty library defaults to a separate new library; merge is an explicit choice.
      return { ...s, step: 'preview', preview: a.preview, mode: a.preview.suggested }
    case 'failed':
      // A failed join goes back to the preview so the user can retry; a bad code back to scanning.
      return { ...s, step: s.step === 'joining' ? 'preview' : 'scan', error: a.error }
    case 'mode':
      return s.step === 'preview' ? { ...s, mode: a.mode } : s
    case 'join':
      return s.step === 'preview' ? { ...s, step: 'joining', error: undefined } : s
    case 'joined':
      return { ...s, step: 'done' }
    case 'back':
      return s.step === 'preview' ? { ...initialJoin() } : s
  }
}

/** What to tell the user when a code can't be read or checked. */
export function joinErrorText(e: unknown): string {
  if (e instanceof PairingError || (e as Error)?.name === 'PairingError') {
    return (e as PairingError).code === 'version'
      ? 'This code comes from a newer OpenStand. Update this device, then try again.'
      : 'That isn’t an OpenStand pairing code. On the other device open Settings → Library sync → Add a device.'
  }
  if (e instanceof LibSyncFailure || (e as Error)?.name === 'LibSyncFailure') {
    const f = e as LibSyncFailure
    if (f.code === 'network') return 'Can’t reach the storage. Check your connection and try again.'
    return errorText({ code: f.code, message: f.message, detail: f.detail }).message
  }
  return (e as Error)?.message || 'Something went wrong. Try again.'
}

/** "Synced library: 1,240 songs, 3.2 GB · This device: 12 songs" */
export function previewLine(p: JoinPreview, name?: string): { remote: string; local: string } {
  return {
    remote: `${name ? `“${name}”` : 'Synced library'}: ${plural(p.remoteSongs, 'song')}${p.remoteBytes ? `, ${fmtBytes(p.remoteBytes)}` : ''}`,
    local: `This device: ${plural(p.localSongs, 'song')}`,
  }
}

/** §10.3: "N of your songs are already in the synced library and will be combined; M will be added." */
export function mergeLine(p: JoinPreview): string {
  const added = Math.max(0, p.localSongs - p.matches)
  if (!p.matches) return `${plural(added, 'song')} from this device will be added to the synced library.`
  return `${p.matches.toLocaleString('en-US')} of your songs ${p.matches === 1 ? 'is' : 'are'} already in the synced library and will be combined; ${added.toLocaleString('en-US')} will be added.`
}
