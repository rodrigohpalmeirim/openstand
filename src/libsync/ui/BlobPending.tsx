/** Placeholders for files that synced as references but whose data hasn't arrived yet (§12.2). */
import { CloudDownload, CloudOff, FileX, Hourglass } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { prioritizeSongs, type BlobState } from '../api'
import { cx } from '../../ui/primitives'
import { useBlobRaw, useBlobReady } from './client'
import { pendingCaption } from './format'

/**
 * Viewer page placeholder on the dark stage, sized like the page, for a `MissingBlobError`. `onReady` fires
 * when the file arrives (also if it arrived between the error and this mount), so the caller re-renders.
 */
export function BlobPending({
  blobId,
  songId,
  width,
  height,
  onReady,
}: {
  blobId: string
  /** Moves this song's files to the front of the download queue. */
  songId?: string
  width?: number
  height?: number
  onReady?: () => void
}) {
  const raw = useBlobRaw(blobId)
  const b: BlobState = raw ?? { state: 'queued' }
  // `local` as the first known state means the data is there under another id (or sync is off), so the
  // caller's retry would fail again: show "missing" and don't loop on onReady.
  const [startedLocal, setStartedLocal] = useState<boolean | undefined>(undefined)
  if (raw && startedLocal === undefined) setStartedLocal(raw.state === 'local')
  const fired = useRef(false)
  const readyCb = useRef(onReady)
  useEffect(() => {
    readyCb.current = onReady
  })
  const fire = useCallback(() => {
    if (fired.current) return
    fired.current = true
    readyCb.current?.()
  }, [])
  useBlobReady(blobId, fire)
  const ready = b.state === 'local' && startedLocal === false
  useEffect(() => {
    if (ready) fire()
  }, [ready, fire])
  useEffect(() => {
    if (songId) prioritizeSongs([songId])
  }, [songId])
  const pct = b.state === 'downloading' && b.progress !== undefined ? Math.round(b.progress * 100) : undefined
  const offline = b.state === 'offline'
  const waiting = b.state === 'waiting'
  const missing = b.state === 'missing' || (b.state === 'local' && startedLocal)
  const Icon = offline ? CloudOff : missing ? FileX : waiting ? Hourglass : CloudDownload
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 rounded-sm bg-white/[0.04] p-6 text-center text-white/75 ring-1 ring-white/10"
      style={{ width, height }}
    >
      <Icon className={cx('size-8 text-white/50', b.state === 'downloading' && 'animate-pulse')} />
      <p className="max-w-64 text-sm">
        {offline
          ? 'Not downloaded yet. Connect to the internet to get it.'
          : missing
            ? 'This file isn’t on this device yet, and no synced device has uploaded it.'
            : waiting
            ? 'Waiting for the device that added this file to upload it.'
            : `Downloading this file…${pct !== undefined ? ` ${pct}%` : ''}`}
      </p>
      {!offline && !waiting && !missing && (
        <div className="h-1 w-40 overflow-hidden rounded-full bg-white/15" aria-hidden>
          <div className={cx('h-full rounded-full bg-white/70 transition-[width] duration-300', pct === undefined && 'w-1/3 animate-pulse')} style={pct !== undefined ? { width: `${pct}%` } : undefined} />
        </div>
      )}
    </div>
  )
}

/** Thumbnail placeholder (song rows, grid): a small cloud icon with the caption as label. */
export function PendingThumb({ state, className }: { state: BlobState; className?: string }) {
  const caption = pendingCaption(state) ?? ''
  const Icon = state.state === 'offline' ? CloudOff : CloudDownload
  return (
    <div className={cx(className, 'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-line bg-surface-2 text-muted')} role="img" aria-label={caption} title={caption}>
      <Icon className={cx('size-[40%] max-w-6', state.state === 'downloading' && 'animate-pulse text-accent')} />
    </div>
  )
}
