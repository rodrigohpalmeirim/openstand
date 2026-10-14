import { BookOpen, FileSpreadsheet, FileUp, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type ImportResult, readImportFile } from '../../files/import'
import { autoCropSong } from '../../files/cropPages'
import { decodeText, outlineToEntries, parseIndexCsv, type IndexEntry, type OutlineItem } from '../../files/indexImport'
import { stripExt } from '../../files/kinds'
import { pdfOutline, withPdf } from '../../files/pdf'
import { db } from '../../db/db'
import { useSettings } from '../../state/settings'
import { Button, cx, Empty, Field, Input, Segmented, toast } from '../../ui/primitives'
import { ChipInput } from '../editor/ChipInput'
import { Section, ToggleRow } from '../editor/Sheet'
import { createIndexSongs } from '../editor/songOps'

function pagesLabel(p: number[]) {
  if (!p.length) return ''
  const contiguous = p.every((v, i) => i === 0 || v === p[i - 1] + 1)
  return contiguous ? (p.length === 1 ? `p. ${p[0] + 1}` : `pp. ${p[0] + 1}–${p[p.length - 1] + 1}`) : `${p.length} pages`
}

/**
 * One PDF → many songs. Entries come from the PDF outline or a CSV ("title;pages;…"); every song
 * references the same stored PDF and shows its range through a page order.
 */
export function IndexImport({ onDone, onCancel }: { onDone: (r: ImportResult) => void; onCancel: () => void }) {
  const [pdf, setPdf] = useState<File | null>(null)
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null)
  const [source, setSource] = useState<'bookmarks' | 'csv'>('bookmarks')
  const [numPages, setNumPages] = useState(0)
  const [outline, setOutline] = useState<OutlineItem[] | null>(null)
  const [depth, setDepth] = useState<'top' | 'all'>('top')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')
  const [collections, setCollections] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const autoCrop = useSettings((s) => s.s.importPrefs.autoCrop)
  const aggressive = useSettings((s) => s.s.editor.aggressiveCrop)
  const setIn = useSettings((s) => s.setIn)
  const input = useRef<HTMLInputElement>(null)

  const pick = async (list: FileList | null) => {
    for (const f of list ?? []) {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        setPdf(f)
        setCollections((c) => (c.length ? c : [stripExt(f.name)]))
      } else {
        setCsv({ name: f.name, text: decodeText(await f.arrayBuffer()) })
        setSource('csv')
      }
    }
  }

  useEffect(() => {
    if (!pdf) return
    let alive = true
    setOutline(null)
    setLoadError(null)
    setBusy('Reading PDF…')
    withPdf(pdf, async (doc) => ({ n: doc.numPages, items: await pdfOutline(doc) }))
      .then(({ n, items }) => {
        if (!alive) return
        setNumPages(n)
        setOutline(items)
        if (!items.length && !csv) setSource('csv')
      })
      .catch(() => alive && setLoadError(`Could not read ${pdf.name}`))
      .finally(() => alive && setBusy(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf])

  const hasNested = !!outline?.some((o) => o.depth > 0)
  const csvParse = useMemo(() => (csv ? parseIndexCsv(csv.text, { pageCount: numPages || undefined, offset }) : null), [csv, numPages, offset])
  const entries: IndexEntry[] = useMemo(() => {
    if (source === 'csv') return csvParse?.entries ?? []
    return outline ? outlineToEntries(outline, numPages, depth === 'top' ? 0 : Infinity) : []
  }, [source, csvParse, outline, numPages, depth])
  useEffect(() => setSelected(new Set(entries.map((_, i) => i))), [entries])

  const visible = entries.map((e, i) => ({ e, i })).filter(({ e }) => !query.trim() || e.title.toLowerCase().includes(query.trim().toLowerCase()))
  const error =
    loadError ??
    (source === 'csv'
      ? csv
        ? csvParse?.error
        : null
      : pdf && outline && !outline.length
        ? `No bookmarks found in ${pdf.name}`
        : null)

  const run = async () => {
    if (!pdf) return
    const chosen = entries.filter((_, i) => selected.has(i))
    if (!chosen.length) return
    setBusy('Storing PDF…')
    try {
      const r = await readImportFile({ file: pdf })
      if ('error' in r) {
        toast(r.error, 'error')
        return
      }
      const { id: _id, ...file } = r.file
      setBusy(`Creating ${chosen.length} songs…`)
      const songs = await createIndexSongs(file, chosen, { collection: collections[0] })
      for (const extra of collections.slice(1)) for (const s of songs) s.collections.push(extra)
      if (autoCrop) {
        let n = 0
        for (const s of songs) {
          setBusy(`Cropping ${++n}/${songs.length}`)
          s.pageSettings = await autoCropSong(s, { aggressive, pages: s.pageOrder })
        }
      }
      if (autoCrop || collections.length > 1) await db.songs.bulkPut(songs)
      onDone({ songs, updated: [], skipped: [] })
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input ref={input} type="file" multiple accept=".pdf,.csv,.txt,.tsv,application/pdf,text/csv" hidden onChange={(e) => (pick(e.target.files), (e.target.value = ''))} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 p-4 sm:p-5 lg:min-h-0 lg:flex-1 lg:shrink lg:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={pdf ? 'secondary' : 'primary'} icon={<FileUp className="size-4" />} onClick={() => input.current?.click()}>
              {pdf ? 'Change files' : 'Choose PDF (and CSV)'}
            </Button>
            {pdf && (
              <span className="flex min-w-0 items-center gap-1.5 text-sm">
                <BookOpen className="size-4 shrink-0 text-muted" />
                <span className="truncate">{pdf.name}</span>
                {numPages > 0 && <span className="shrink-0 text-muted">· {numPages} pages</span>}
              </span>
            )}
            {csv && (
              <span className="flex min-w-0 items-center gap-1.5 text-sm">
                <FileSpreadsheet className="size-4 shrink-0 text-muted" />
                <span className="truncate">{csv.name}</span>
              </span>
            )}
          </div>
          {!pdf && !csv ? (
            <div className="flex min-h-64 flex-1 items-center justify-center rounded-2xl border-2 border-dashed border-line">
              <Empty icon={<BookOpen className="size-6" />} title="Split a songbook into songs">
                Pick a PDF with bookmarks, or a PDF plus a CSV index (<code className="font-mono text-xs">title;pages;artist</code>). Every song shares the one PDF — no copies are made.
              </Empty>
            </div>
          ) : (
            <>
              {csvParse?.pdfName && pdf && csvParse.pdfName.toLowerCase() !== pdf.name.toLowerCase() && source === 'csv' && (
                <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
                  The CSV names “{csvParse.pdfName}”, but “{pdf.name}” is selected.
                </p>
              )}
              {!pdf && <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">Also choose the PDF{csvParse?.pdfName ? ` (“${csvParse.pdfName}”)` : ''}.</p>}
              {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
              {busy && !entries.length && <p className="text-sm text-muted">{busy}</p>}
              {entries.length > 0 && (
                <>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                      <Input className="pl-9" placeholder={`Search ${entries.length} songs`} value={query} onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(selected.size === entries.length ? new Set() : new Set(entries.map((_, i) => i)))}>
                      {selected.size === entries.length ? 'Select none' : 'Select all'}
                    </Button>
                  </div>
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {visible.map(({ e, i }) => (
                      <li key={i}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-surface-2">
                          <input
                            type="checkbox"
                            className="size-4 shrink-0 accent-[var(--os-accent)]"
                            checked={selected.has(i)}
                            onChange={(ev) => {
                              const next = new Set(selected)
                              if (ev.target.checked) next.add(i)
                              else next.delete(i)
                              setSelected(next)
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{e.title}</span>
                            {Object.keys(e.fields).length > 0 && <span className="block truncate text-xs text-muted">{Object.values(e.fields).join(' · ')}</span>}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted">{pagesLabel(e.pages)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {source === 'csv' && csvParse && csvParse.warnings.length > 0 && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">{csvParse.warnings.length} row(s) ignored</summary>
                  <ul className="mt-1 list-disc pl-5">
                    {csvParse.warnings.slice(0, 50).map((w, k) => (
                      <li key={k}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
        <aside className="flex shrink-0 flex-col gap-5 border-t border-line p-4 sm:p-5 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <Section title="Index source">
            <Segmented
              size="sm"
              className="w-full"
              value={source}
              onChange={setSource}
              options={[
                { value: 'bookmarks', label: 'PDF bookmarks' },
                { value: 'csv', label: 'CSV file' },
              ]}
            />
            {source === 'bookmarks' && hasNested && (
              <Field label="Bookmark levels">
                <Segmented
                  size="sm"
                  className="w-full"
                  value={depth}
                  onChange={setDepth}
                  options={[
                    { value: 'top', label: 'Top level' },
                    { value: 'all', label: 'All levels' },
                  ]}
                />
              </Field>
            )}
            {source === 'csv' && (
              <>
                {!csv && (
                  <Button onClick={() => input.current?.click()} icon={<FileSpreadsheet className="size-4" />}>
                    Choose CSV
                  </Button>
                )}
                <Field label="Page offset" hint="Added to every page in the CSV, e.g. 4 when printed page 1 is PDF page 5">
                  <Input type="number" inputMode="numeric" value={offset} onChange={(e) => setOffset(Math.round(Number(e.target.value)) || 0)} className="w-28" />
                </Field>
                <p className="text-xs text-faint">
                  Format: optional first line with the PDF name, then a header such as <code className="font-mono">title;pages;artist;key</code>. Pages: “12”, “12-14” or “12-13, 15”.
                </p>
              </>
            )}
          </Section>
          <Section title="Songs">
            <Field label="Add to collection">
              <ChipInput aria-label="Add to collection" field="collections" value={collections} onChange={setCollections} placeholder="Optional" />
            </Field>
            <ToggleRow label="Crop page margins" hint="Detect white margins (slower)" checked={autoCrop} onChange={(v) => setIn('importPrefs', { autoCrop: v })} />
          </Section>
        </aside>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2.5 sm:px-4" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
        {busy && entries.length > 0 && <span className="mr-auto text-xs text-muted">{busy}</span>}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!pdf || !selected.size || !!busy} onClick={run} className={cx(busy && 'opacity-60')}>
          Create {selected.size || ''} song{selected.size === 1 ? '' : 's'}
        </Button>
      </footer>
    </div>
  )
}
