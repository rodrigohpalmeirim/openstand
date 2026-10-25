import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTerms } from '../library/browse/terms'
import { Button, Dialog, Toggle } from '../ui/primitives'
import type { FileExportOptions } from './exportSongs'

const KEY = 'openstand-export-files'

function Row({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-4">
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </label>
  )
}

function ExportFilesDialog({ count, onDone }: { count: number; onDone: (o: FileExportOptions | null) => void }) {
  const t = useTerms()
  const [o, setO] = useState<FileExportOptions>(() => {
    try {
      return { withAnnotations: true, cropRotate: true, merge: false, useTitles: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    } catch {
      return { withAnnotations: true, cropRotate: true }
    }
  })
  const set = (p: Partial<FileExportOptions>) => setO((x) => ({ ...x, ...p }))
  const finish = (v: FileExportOptions | null) => {
    if (v) localStorage.setItem(KEY, JSON.stringify({ withAnnotations: v.withAnnotations, cropRotate: v.cropRotate, merge: v.merge, useTitles: v.useTitles }))
    onDone(v)
  }
  return (
    <Dialog
      open
      size="sm"
      onClose={() => finish(null)}
      title={count === 1 ? 'Export files' : `Export files of ${t.count(count)}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => finish(o)}>
            Export
          </Button>
        </>
      }
    >
      <div className="grid gap-1 px-5 py-3">
        <Row label="Include annotations" hint="Drawn into the PDF pages (they can no longer be edited there)" checked={!!o.withAnnotations} onChange={(withAnnotations) => set({ withAnnotations })} />
        <Row label="Apply crop and rotation" checked={!!o.cropRotate} onChange={(cropRotate) => set({ cropRotate })} />
        <Row label="Join into one PDF" hint={count > 1 ? `All ${t.songs} in order, one file` : `All files of the ${t.song} in one PDF`} checked={!!o.merge} onChange={(merge) => set({ merge })} />
        <Row label={`Name files after ${t.song} titles`} checked={!!o.useTitles} onChange={(useTitles) => set({ useTitles })} disabled={!!o.merge} />
        <p className="pt-2 text-xs text-muted">
          {o.withAnnotations || o.cropRotate || o.merge
            ? 'PDF and image pages become PDFs. Text and ChordPro files are exported unchanged.'
            : 'Original files, exactly as imported.'}
        </p>
      </div>
    </Dialog>
  )
}

/** Ask how to export files. Mounts its own root so it works from menus and non-React code. */
export function askFileExportOptions(count: number): Promise<FileExportOptions | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (v: FileExportOptions | null) => {
      root.unmount()
      host.remove()
      resolve(v)
    }
    root.render(<ExportFilesDialog count={count} onDone={done} />)
  })
}
