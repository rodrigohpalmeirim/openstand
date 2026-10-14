import { FileMusic, FileText, Music } from 'lucide-react'
import { useEffect, useState } from 'react'
import { db } from '../db/db'
import type { Song } from '../db/schema'
import { renderPage } from '../viewer/pageSource'

const urls = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

async function makeThumb(song: Song): Promise<string | null> {
  const cached = await db.thumbs.get(song.id)
  const first = song.files[0]
  if (cached && cached.updatedAt >= song.modifiedAt) return URL.createObjectURL(cached.data)
  if (!first || (first.kind !== 'pdf' && first.kind !== 'image')) return null
  const bmp = await renderPage(first, 0, 160)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8))
  if (!blob) return null
  await db.thumbs.put({ id: song.id, data: blob, updatedAt: Date.now() })
  return URL.createObjectURL(blob)
}

export function Thumb({ song, className = 'h-12 w-9' }: { song: Song; className?: string }) {
  const key = `${song.id}:${song.modifiedAt}`
  const [url, setUrl] = useState<string | null>(urls.get(key) ?? null)
  useEffect(() => {
    if (urls.has(key)) return setUrl(urls.get(key)!)
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
  }, [key, song])
  const kind = song.files[0]?.kind
  return (
    <div className={`${className} shrink-0 overflow-hidden rounded-md border border-line bg-white shadow-sm`}>
      {url ? (
        <img src={url} alt="" className="size-full object-cover object-top" loading="lazy" draggable={false} />
      ) : (
        <div className="flex size-full items-center justify-center bg-surface-2 text-faint">
          {kind === 'chordpro' || kind === 'text' ? <FileText className="size-4" /> : kind === 'abc' ? <Music className="size-4" /> : <FileMusic className="size-4" />}
        </div>
      )}
    </div>
  )
}
