/** Helpers shared by the backends: multipart part layout and upload-state validation. */
import { CHUNK, PART } from '../model'
import type { UploadState } from './types'

/** Encrypted container header and per-chunk overhead (crypto.ts §4.2); duplicated to keep backends crypto-free. */
const HEADER = 16
const OVERHEAD = 28

/** §7.1: a part is 8 encrypted chunks (8 MiB + 224 B); part 1 also carries the 16-byte container header. */
export const DEFAULT_PART_SIZE = PART * (CHUNK + OVERHEAD)
export const DEFAULT_PART_HEAD = HEADER

export interface PartLayout {
  partSize: number
  head: number
}

/** Session state persisted in `UploadState.session` by the multipart backends. */
export type MultipartSession = {
  uploadId: string
  partSize: number
  head: number
  parts: { n: number; etag: string }[]
}

export function partCount(size: number, l: PartLayout): number {
  return Math.max(1, Math.ceil(Math.max(0, size - l.head) / l.partSize))
}

/** 1-based part `n` -> `[start, end)` in the source. */
export function partRange(n: number, size: number, l: PartLayout): [number, number] {
  const start = n === 1 ? 0 : l.head + (n - 1) * l.partSize
  const end = Math.min(size, l.head + n * l.partSize)
  return [start, end]
}

/** The session in `state` if it belongs to this backend, key, size and layout; otherwise `null`. */
export function resumableSession(state: UploadState | undefined, backend: string, key: string, size: number, l: PartLayout): MultipartSession | null {
  if (!state || state.v !== 1 || state.backend !== backend || state.key !== key || state.size !== size) return null
  const s = state.session as Partial<MultipartSession> | null
  if (!s || typeof s !== 'object' || typeof s.uploadId !== 'string' || !s.uploadId) return null
  if (s.partSize !== l.partSize || s.head !== l.head || !Array.isArray(s.parts)) return null
  return { uploadId: s.uploadId, partSize: s.partSize, head: s.head, parts: s.parts.filter((p) => p && typeof p.n === 'number' && typeof p.etag === 'string') }
}

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e instanceof Error && e.name === 'AbortError')
}
