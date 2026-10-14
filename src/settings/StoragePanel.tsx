import { useLiveQuery } from 'dexie-react-hooks'
import { HardDrive, ImageOff, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { collectGarbage, db } from '../db/db'
import { Button, confirmDialog, toast } from '../ui/primitives'
import { Row } from './kit'

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`
}

function useStorageInfo() {
  const [info, setInfo] = useState<{ usage?: number; quota?: number; persisted?: boolean; supported: boolean }>({ supported: true })
  const refresh = useCallback(async () => {
    const sm = navigator.storage
    if (!sm?.estimate) return setInfo({ supported: false })
    const [est, persisted] = await Promise.all([sm.estimate(), sm.persisted?.() ?? Promise.resolve(undefined)])
    setInfo({ usage: est.usage, quota: est.quota, persisted, supported: true })
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { info, refresh }
}

export function StorageUsage() {
  const { info, refresh } = useStorageInfo()
  const pct = info.usage && info.quota ? Math.min(100, (info.usage / info.quota) * 100) : 0
  return (
    <>
      <Row stacked label="Space used on this device" hint={!info.supported ? 'Your browser does not report storage use.' : undefined}>
        {info.supported && (
          <div className="flex flex-col gap-1.5">
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(pct, 0.5)}%` }} />
            </div>
            <div className="flex justify-between text-xs text-muted">
              <span>{formatBytes(info.usage ?? 0)} used</span>
              <span>{formatBytes(info.quota ?? 0)} available to OpenStand</span>
            </div>
          </div>
        )}
      </Row>
      <Row
        label="Protect library from automatic cleanup"
        hint={
          info.persisted
            ? 'Done: the browser will not delete your library when space runs low.'
            : 'Browsers may clear site data when the device is low on space. Ask the browser to keep it. Installing the app also helps.'
        }
      >
        {info.persisted ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ok">
            <ShieldCheck className="size-4" /> Protected
          </span>
        ) : (
          <Button
            disabled={!navigator.storage?.persist}
            onClick={async () => {
              const ok = await navigator.storage.persist()
              toast(ok ? 'Library storage is now protected' : 'The browser declined. Try installing OpenStand first.', ok ? 'ok' : 'error')
              void refresh()
            }}
          >
            Protect
          </Button>
        )}
      </Row>
    </>
  )
}

export function LibraryStorage() {
  const stats = useLiveQuery(async () => {
    let fileBytes = 0
    await db.blobs.each((b) => (fileBytes += b.size ?? 0))
    const [songs, files, thumbs] = await Promise.all([db.songs.count(), db.blobs.count(), db.thumbs.count()])
    return { songs, files, thumbs, fileBytes }
  }, [])
  return (
    <>
      <Row label="Library" hint={stats ? `${stats.songs.toLocaleString()} songs, ${stats.files.toLocaleString()} stored files` : 'Counting…'}>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <HardDrive className="size-4" /> {stats ? formatBytes(stats.fileBytes) : '…'}
        </span>
      </Row>
      <Row label="Thumbnail cache" hint={`${stats?.thumbs ?? 0} page previews. They are recreated when needed.`}>
        <Button
          icon={<ImageOff className="size-4" />}
          disabled={!stats?.thumbs}
          onClick={async () => {
            await db.thumbs.clear()
            toast('Thumbnail cache cleared', 'ok')
          }}
        >
          Clear
        </Button>
      </Row>
      <Row label="Remove unused files" hint="Deletes stored files that no song uses any more (for example after deleting songs).">
        <Button
          icon={<Trash2 className="size-4" />}
          onClick={async () => {
            if (!(await confirmDialog({ title: 'Remove unused files?', message: 'Files not used by any song are deleted permanently.', confirmLabel: 'Remove', danger: true })))
              return
            const n = await collectGarbage()
            toast(n ? `Removed ${n} unused file${n === 1 ? '' : 's'}` : 'No unused files found', 'ok')
          }}
        >
          Clean up
        </Button>
      </Row>
    </>
  )
}
