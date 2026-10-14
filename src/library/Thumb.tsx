import { FileMusic, FileText, Music } from 'lucide-react'
import { useEffect, useState } from 'react'
import { db } from '../db/db'
import type { Song } from '../db/schema'
import { cx } from '../ui/primitives'
import { pageSettingsKey, renderPage, resolvePageRefs } from '../viewer/pageSource'

const THUMB_WIDTH = 240
const urls = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

/* Render at most two thumbnails at once so scrolling a big library doesn't flood pdf.js. */
let running = 0
const waiting: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Identity of what the thumbnail shows, so metadata-only edits don't trigger a re-render. */
function thumbSource(song: Song) {
  const ref = resolvePageRefs(song)[0]
  const file = ref && song.files.find((f) => f.id === ref.fileId)
  if (!file || (file.kind !== 'pdf' && file.kind !== 'image')) return null
  const ps = song.pageSettings?.[pageSettingsKey(file.id, ref.page)]
  return { file, ref, ps, sig: JSON.stringify([file.blobId, ref.page, ps?.rotation ?? 0, ps?.crop ?? null]) }
}

async function makeThumb(song: Song): Promise<string | null> {
  const src = thumbSource(song)
  if (!src) return null
  const { file, ref, ps, sig } = src
  const cached = await db.thumbs.get(song.id)
  if (cached && (cached.sig ? cached.sig === sig : cached.updatedAt >= song.modifiedAt)) return URL.createObjectURL(cached.data)
  const blob = await limited(async () => {
    const bmp = await renderPage(file, ref.page, THUMB_WIDTH, ps?.rotation ?? 0)
    const crop = ps?.crop ?? { top: 0, bottom: 0, left: 0, right: 0 }
    const sx = bmp.width * crop.left
    const sy = bmp.height * crop.top
    const sw = Math.max(1, bmp.width * (1 - crop.left - crop.right))
    const sh = Math.max(1, bmp.height * (1 - crop.top - crop.bottom))
    const c = document.createElement('canvas')
    c.width = Math.round(Math.min(THUMB_WIDTH, sw))
    c.height = Math.round((sh / sw) * c.width)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height)
    return new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8))
  })
  if (!blob) return null
  await db.thumbs.put({ id: song.id, data: blob, updatedAt: Date.now(), sig })
  return URL.createObjectURL(blob)
}

/** Thumbnail of a song's first page (PDF/image), or an icon for text formats. */
export function Thumb({ song, className = 'h-12 w-9' }: { song: Song; className?: string }) {
  const key = `${song.id}:${thumbSource(song)?.sig ?? song.files[0]?.kind}`
  const [url, setUrl] = useState<string | null>(urls.get(key) ?? null)
  useEffect(() => {
    if (urls.has(key)) return setUrl(urls.get(key)!)
    setUrl(null)
    let alive = true
    let p = pending.get(key)
    if (!p) {
      p = makeThumb(song).catch(() => null)
      pending.set(key, p)
    }
    p.then((u) => {
      pending.delete(key)
      if (u) urls.set(key, u)
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [key])
  const kind = song.files[0]?.kind
  return (
    <div className={cx(className, 'shrink-0 overflow-hidden rounded-md border border-line bg-white shadow-sm')}>
      {url ? (
        <img src={url} alt="" className="size-full object-cover object-top" loading="lazy" draggable={false} />
      ) : (
        <div
          className={cx(
            'flex size-full items-center justify-center',
            kind === 'chordpro' || kind === 'text' || kind === 'abc' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint',
          )}
        >
          {kind === 'chordpro' || kind === 'text' ? <FileText className="size-[40%] max-w-6" /> : kind === 'abc' ? <Music className="size-[40%] max-w-6" /> : <FileMusic className="size-[40%] max-w-6" />}
        </div>
      )}
    </div>
  )
}
