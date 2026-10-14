import { FileText, Music, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Crop, SongFile } from '../../db/schema'
import { displayAspect, pageSize } from '../../viewer/pageSource'
import { PageView } from '../../viewer/PageView'
import { cx } from '../../ui/primitives'

/** Page aspect (w/h after rotation and crop), loaded lazily. */
export function usePageAspect(file: SongFile | undefined, page: number, rotation: number, crop?: Crop) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    let alive = true
    if (!file || (file.kind !== 'pdf' && file.kind !== 'image')) return
    pageSize(file, page).then(
      (s) => alive && setSize(s),
      () => alive && setSize({ width: 612, height: 792 }),
    )
    return () => {
      alive = false
    }
  }, [file, page])
  return size ? displayAspect(size, rotation, crop) : null
}

/** A page fitted inside a `box` x `box*1.3` area (PDF/images), or an icon tile for text formats. */
export function PageThumb({
  file,
  page,
  rotation = 0,
  crop,
  width = 112,
  className,
}: {
  file: SongFile
  page: number
  rotation?: number
  crop?: Crop
  width?: number
  className?: string
}) {
  const boxH = Math.round(width * 1.3)
  const aspect = usePageAspect(file, page, rotation, crop)
  if (file.kind !== 'pdf' && file.kind !== 'image') {
    const Icon = file.kind === 'abc' ? Music : file.name.includes('blank') ? Square : FileText
    return (
      <div className={cx('flex flex-col items-center justify-center gap-1.5 rounded-md border border-line bg-surface-2 p-2 text-center text-muted', className)} style={{ width, height: boxH }}>
        <Icon className="size-6" />
        <span className="line-clamp-2 break-all text-[10px] leading-tight">{file.name}</span>
      </div>
    )
  }
  let w = width
  let h = boxH
  if (aspect) {
    if (aspect > width / boxH) h = Math.round(width / aspect)
    else w = Math.round(boxH * aspect)
  }
  return (
    <div className={cx('flex items-center justify-center', className)} style={{ width, height: boxH }}>
      {aspect ? <PageView file={file} page={page} width={w} height={h} rotation={rotation} crop={crop} priority={false} /> : <div className="size-full animate-pulse rounded bg-surface-2" />}
    </div>
  )
}
