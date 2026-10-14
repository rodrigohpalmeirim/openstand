import { CheckCircle2, FileUp, FolderOpen, Info, Loader2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../../db/db'
import type { Song } from '../../db/schema'
import {
  collectDirectory,
  FILE_PATTERN_PRESETS,
  FOLDER_PATTERN_PRESETS,
  importFiles,
  previewSource,
  sourcesFromDataTransfer,
  sourcesFromFileList,
  stripCommonRoot,
  type ImportResult,
  type ImportSource,
} from '../../files/import'
import { ACCEPT, kindOf } from '../../files/kinds'
import { withPdf } from '../../files/pdf'
import { useSettings } from '../../state/settings'
import { Button, cx, Empty, Field, IconButton, Input, Segmented, Select } from '../../ui/primitives'
import { ChipInput } from '../editor/ChipInput'
import { KindIcon } from '../editor/FilesTab'
import { Section, Sheet, ToggleRow } from '../editor/Sheet'
import { SongEditor } from '../editor/SongEditor'
import { formatBytes } from '../editor/songEdit'
import { IndexImport } from './IndexImport'

const srcKey = (s: ImportSource) => `${s.path ?? s.file.name}|${s.file.size}|${s.file.lastModified}`

/** Import wizard: files or folders with filename/folder patterns, or a book index (CSV / PDF bookmarks). */
export function ImportDialog({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: ImportSource[] }) {
  const [mode, setMode] = useState<'files' | 'index'>('files')
  const [sources, setSources] = useState<ImportSource[]>([])
  const [result, setResult] = useState<ImportResult | null>(null)
  const [editId, setEditId] = useState<string | null>(null)

  // Reset when (re)opened; files dropped while already open are appended.
  const wasOpen = useRef(false)
  useEffect(() => {
    const fresh = open && !wasOpen.current
    wasOpen.current = open
    if (!open) return
    const incoming = initial?.length ? stripCommonRoot(initial) : []
    if (fresh) {
      setResult(null)
      setMode('files')
      setSources(incoming)
    } else if (incoming.length) {
      setResult(null)
      setSources((prev) => [...prev, ...incoming.filter((s) => !prev.some((p) => srcKey(p) === srcKey(s)))])
    }
  }, [open, initial])

  if (!open) return null
  return (
    <>
      <Sheet
        onClose={onClose}
        title="Import"
        subtitle={mode === 'files' ? 'PDFs, images, ChordPro, text and ABC files' : 'Split a songbook PDF into songs'}
        bodyClassName="flex flex-col overflow-hidden"
        actions={
          !result && (
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'files', label: 'Files' },
                { value: 'index', label: 'Book index' },
              ]}
            />
          )
        }
      >
        {result ? (
          <Results result={result} onMore={() => (setResult(null), setSources([]))} onDone={onClose} onEdit={(id) => setEditId(id)} />
        ) : mode === 'files' ? (
          <FilesImport sources={sources} setSources={setSources} onDone={setResult} onCancel={onClose} />
        ) : (
          <IndexImport onDone={setResult} onCancel={onClose} />
        )}
      </Sheet>
      {editId && <SongEditor songId={editId} onClose={() => setEditId(null)} />}
    </>
  )
}

function FilesImport({
  sources,
  setSources,
  onDone,
  onCancel,
}: {
  sources: ImportSource[]
  setSources: (s: ImportSource[] | ((p: ImportSource[]) => ImportSource[])) => void
  onDone: (r: ImportResult) => void
  onCancel: () => void
}) {
  const prefs = useSettings((s) => s.s.importPrefs)
  const aggressive = useSettings((s) => s.s.editor.aggressiveCrop)
  const setIn = useSettings((s) => s.setIn)
  const [combine, setCombine] = useState(false)
  const [collections, setCollections] = useState<string[]>([])
  const [pdfTitle, setPdfTitle] = useState(false)
  const [customPattern, setCustomPattern] = useState(!['', ...FILE_PATTERN_PRESETS].includes(prefs.filePattern))
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [titles, setTitles] = useState<Set<string>>(new Set())
  const [pages, setPages] = useState<Record<string, number | 'err'>>({})
  const abort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = new Set<string>()
    db.songs.each((s) => void t.add(s.title.trim().toLowerCase())).then(() => setTitles(t))
  }, [])

  // Page counts for the first PDFs (lazy, a few at a time).
  useEffect(() => {
    let alive = true
    const todo = sources.filter((s) => kindOf(s.file.name, s.file.type) === 'pdf' && pages[srcKey(s)] === undefined).slice(0, 60)
    ;(async () => {
      for (const s of todo) {
        if (!alive) return
        const n = await withPdf(s.file, async (d) => d.numPages).catch(() => 'err' as const)
        if (alive) setPages((p) => ({ ...p, [srcKey(s)]: n }))
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources])

  const hasFolders = sources.some((s) => s.path?.includes('/'))
  const opts = { filePattern: prefs.filePattern, folderPattern: hasFolders ? prefs.folderPattern : '', folderFromEnd: prefs.folderFromEnd }
  const previews = useMemo(() => sources.map((s) => previewSource(s, opts)), [sources, opts.filePattern, opts.folderPattern, opts.folderFromEnd]) // eslint-disable-line react-hooks/exhaustive-deps
  const unmatched = previews.filter((p) => !p.matched).length

  const addSources = (more: ImportSource[], fromFolder = false) => {
    const list = fromFolder ? stripCommonRoot(more) : more
    setSources((prev) => {
      const seen = new Set(prev.map(srcKey))
      return [...prev, ...list.filter((s) => !seen.has(srcKey(s)))]
    })
  }
  const pickFolder = async () => {
    const w = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
    if (w.showDirectoryPicker) {
      try {
        const dir = await w.showDirectoryPicker()
        addSources(await collectDirectory(dir))
      } catch {
        /* cancelled */
      }
    } else dirInput.current?.click()
  }

  const run = async () => {
    abort.current = new AbortController()
    setProgress({ done: 0, total: sources.length, name: '' })
    try {
      const r = await importFiles(sources, {
        ...opts,
        combine,
        groups: collections.length ? { collections } : undefined,
        skipDuplicates: prefs.skipDuplicates,
        conflict: combine ? 'create' : prefs.conflict,
        autoCrop: prefs.autoCrop ? (aggressive ? 'aggressive' : true) : false,
        pdfTitle,
        signal: abort.current.signal,
        onProgress: (done, total, name) => setProgress({ done, total, name }),
      })
      onDone(r)
    } finally {
      setProgress(null)
    }
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setDragOver(false)
        addSources(await sourcesFromDataTransfer(e.dataTransfer), true)
      }}
    >
      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (e.target.files && addSources(sourcesFromFileList(e.target.files)), (e.target.value = ''))} />
      <input
        ref={dirInput}
        type="file"
        hidden
        {...({ webkitdirectory: '' } as object)}
        onChange={(e) => (e.target.files && addSources(sourcesFromFileList(e.target.files), true), (e.target.value = ''))}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 p-4 sm:p-5 lg:min-h-0 lg:flex-1 lg:shrink lg:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => fileInput.current?.click()}>
              Choose files
            </Button>
            <Button icon={<FolderOpen className="size-4" />} onClick={pickFolder}>
              Choose folder
            </Button>
            {sources.length > 0 && (
              <Button variant="ghost" className="ml-auto" onClick={() => setSources([])}>
                Clear
              </Button>
            )}
          </div>
          {sources.length === 0 ? (
            <div className="flex min-h-64 flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-line">
              <Empty icon={<Upload className="size-6" />} title="Drop files or folders here">
                Folders are searched recursively. Folder and file names can fill in artist, album, genre and more.
              </Empty>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs text-muted">
                <span>
                  {sources.length} file{sources.length === 1 ? '' : 's'} · {formatBytes(sources.reduce((a, s) => a + s.file.size, 0))}
                </span>
                {unmatched > 0 && prefs.filePattern && (
                  <span className="text-warn">
                    · {unmatched} name{unmatched === 1 ? '' : 's'} don’t match the pattern (filename used)
                  </span>
                )}
              </div>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {sources.map((s, i) => {
                  const p = previews[i]
                  const kind = kindOf(s.file.name, s.file.type) ?? 'text'
                  const exists = !combine && titles.has(p.song.title.trim().toLowerCase())
                  const n = pages[srcKey(s)]
                  const meta = [...p.song.artists, ...p.song.composers, ...p.song.albums, ...p.song.genres, ...p.song.keys, ...p.song.collections, ...p.song.years].join(' · ')
                  return (
                    <li key={srcKey(s)} className="flex items-center gap-3 py-2 pl-3 pr-1">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                        <KindIcon kind={kind} className="size-4.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cx('truncate text-sm font-medium', combine && i > 0 && 'text-muted')}>{combine && i > 0 ? `+ file ${i + 1}` : p.song.title}</span>
                          {exists && (
                            <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn" title="A song with this title already exists">
                              {prefs.conflict === 'update' ? 'update' : prefs.conflict === 'skip' ? 'skip' : 'exists'}
                            </span>
                          )}
                        </div>
                        {meta && <div className="truncate text-xs text-accent">{meta}</div>}
                        <div className="truncate text-xs text-faint">
                          {s.path ?? s.file.name} · {formatBytes(s.file.size)}
                          {n !== undefined && ` · ${n === 'err' ? 'unreadable' : `${n} page${n === 1 ? '' : 's'}`}`}
                        </div>
                      </div>
                      <IconButton label={`Remove ${s.file.name}`} onClick={() => setSources((prev) => prev.filter((x) => x !== s))} className="size-10">
                        <X className="size-4" />
                      </IconButton>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>

        <aside className="flex shrink-0 flex-col gap-5 border-t border-line p-4 sm:p-5 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <Section title="Titles & fields">
            <Field label="File name pattern" hint={<PatternHint />}>
              <Select
                value={customPattern ? '__custom' : prefs.filePattern}
                onChange={(e) => {
                  if (e.target.value === '__custom') setCustomPattern(true)
                  else {
                    setCustomPattern(false)
                    setIn('importPrefs', { filePattern: e.target.value })
                  }
                }}
              >
                <option value="">File name is the title</option>
                {FILE_PATTERN_PRESETS.filter((p) => p !== '%title%').map((p) => (
                  <option key={p} value={p}>
                    {p.replace(/%(\w+)%/g, (_, t: string) => t[0].toUpperCase() + t.slice(1))}
                  </option>
                ))}
                <option value="__custom">Custom pattern…</option>
              </Select>
            </Field>
            {customPattern && (
              <Input aria-label="Custom file name pattern" value={prefs.filePattern} placeholder="%artist% - %title% (%key%)" onChange={(e) => setIn('importPrefs', { filePattern: e.target.value })} className="font-mono" />
            )}
            {hasFolders && (
              <>
                <Field label="Folder pattern" hint="One token per folder level, e.g. %genre%/%artist%">
                  <Input value={prefs.folderPattern} placeholder="Not used" list="folder-pattern-presets" className="font-mono" onChange={(e) => setIn('importPrefs', { folderPattern: e.target.value })} />
                  <datalist id="folder-pattern-presets">
                    {FOLDER_PATTERN_PRESETS.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </Field>
                <ToggleRow
                  label="Match folders at the end of the path"
                  hint={prefs.folderFromEnd ? 'The last pattern level is the folder that contains the file' : 'The first pattern level is the first folder inside the chosen one'}
                  checked={prefs.folderFromEnd}
                  onChange={(v) => setIn('importPrefs', { folderFromEnd: v })}
                />
              </>
            )}
            <ToggleRow label="Use PDF titles" hint="Take the title from the PDF’s properties when available" checked={pdfTitle} onChange={setPdfTitle} />
          </Section>
          <Section title="Songs">
            <ToggleRow label="Combine into one song" hint="All files become pages of a single song, in this order" checked={combine} onChange={setCombine} />
            <Field label="Add to collection">
              <ChipInput aria-label="Add to collection" field="collections" value={collections} onChange={setCollections} placeholder="Optional" showAllOnFocus />
            </Field>
            <ToggleRow label="Skip files already in the library" hint="Same file content" checked={prefs.skipDuplicates} onChange={(v) => setIn('importPrefs', { skipDuplicates: v })} />
            {!combine && (
              <Field label="When a song with the same title exists">
                <Segmented
                  size="sm"
                  className="w-full"
                  value={prefs.conflict}
                  onChange={(v) => setIn('importPrefs', { conflict: v })}
                  options={[
                    { value: 'create', label: 'Add new' },
                    { value: 'update', label: 'Update it', title: 'Replace its file and add new field values' },
                    { value: 'skip', label: 'Skip' },
                  ]}
                />
              </Field>
            )}
            <ToggleRow label="Crop page margins" hint="Detect white margins after import (slower)" checked={prefs.autoCrop} onChange={(v) => setIn('importPrefs', { autoCrop: v })} />
          </Section>
        </aside>
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2.5 sm:px-4" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!sources.length || !!progress} onClick={run}>
          {combine ? 'Import as one song' : `Import ${sources.length || ''} file${sources.length === 1 ? '' : 's'}`}
        </Button>
      </footer>

      {progress && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/85 backdrop-blur-sm">
          <div className="flex w-80 max-w-[90%] flex-col items-center gap-3 text-center">
            <Loader2 className="size-7 animate-spin text-accent" />
            <div className="text-sm font-medium">
              Importing {Math.min(progress.done + 1, progress.total)} of {progress.total}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </div>
            <div className="w-full truncate text-xs text-muted">{progress.name}</div>
            <Button variant="ghost" size="sm" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          </div>
        </div>
      )}
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft text-base font-semibold">
          Drop to add
        </div>
      )}
    </div>
  )
}

function PatternHint() {
  return (
    <span>
      Tokens: %title% %artist% %composer% %album% %genre% %key% %year% %collection% %ignore%
    </span>
  )
}

function Results({ result, onMore, onDone, onEdit }: { result: ImportResult; onMore: () => void; onDone: () => void; onEdit: (id: string) => void }) {
  const all: (Song & { updated?: boolean })[] = [...result.songs, ...result.updated.map((s) => ({ ...s, updated: true }))]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <div className="flex items-center gap-3">
            <CheckCircle2 className={cx('size-9 shrink-0', all.length ? 'text-ok' : 'text-muted')} />
            <div>
              <div className="text-lg font-semibold">
                {result.songs.length} song{result.songs.length === 1 ? '' : 's'} imported
                {result.updated.length > 0 && `, ${result.updated.length} updated`}
              </div>
              {result.skipped.length > 0 && <div className="text-sm text-muted">{result.skipped.length} skipped</div>}
            </div>
          </div>
          {all.length > 0 && (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {all.slice(0, 200).map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-1.5 pl-3 pr-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.title}</div>
                    <div className="truncate text-xs text-muted">
                      {[s.updated ? 'Updated' : null, ...s.artists, `${s.files.length} file${s.files.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => onEdit(s.id)}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <Section title="Skipped">
              <ul className="flex flex-col gap-1 text-sm">
                {result.skipped.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <Info className="mt-0.5 size-4 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="font-medium">{s.name}</span> <span className="text-muted">— {s.reason}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2.5 sm:px-4" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
        <Button variant="ghost" onClick={onMore}>
          Import more
        </Button>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </footer>
    </div>
  )
}
