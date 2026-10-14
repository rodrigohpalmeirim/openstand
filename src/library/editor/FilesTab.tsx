import {
  ArrowDown,
  ArrowUp,
  Crop as CropIcon,
  FileMusic,
  FilePlus2,
  FileText,
  GripVertical,
  Image as ImageIcon,
  LayoutGrid,
  MoreVertical,
  Music,
  Pencil,
  Plus,
  Replace,
  RotateCcw,
  RotateCw,
  ScanLine,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileKind, Song, SongFile } from '../../db/schema'
import { cropable, autoCropSong } from '../../files/cropPages'
import { capitalizeWords, makeTextFile, metadataFromText, readImportFile, textTemplate } from '../../files/import'
import { ACCEPT, stripExt } from '../../files/kinds'
import { useSettings } from '../../state/settings'
import { Button, cx, Empty, IconButton, Input, Menu, promptDialog, toast, useMenu } from '../../ui/primitives'
import { resolvePageRefs } from '../../viewer/pageSource'
import type { SongPatch } from './FieldsTab'
import { formatPageOrder, normalizePageOrder, parsePageOrder } from './pageOrder'
import { PageThumb } from './PageThumb'
import { Section } from './Sheet'
import { addFiles, formatBytes, pageKey, removeFile, reorderFiles, replaceFile, rotatePages, tidySettings } from './songEdit'
import { moveItem, useDragSort } from './useDragSort'

const KIND_LABEL: Record<FileKind, string> = { pdf: 'PDF', image: 'Image', chordpro: 'ChordPro', text: 'Text', abc: 'ABC' }
export function KindIcon({ kind, className = 'size-5' }: { kind: FileKind; className?: string }) {
  const I = kind === 'pdf' ? FileMusic : kind === 'image' ? ImageIcon : kind === 'abc' ? Music : FileText
  return <I className={className} />
}

export function FilesTab({
  song,
  update,
  onPageOrder,
  onCrop,
}: {
  song: Song
  update: (p: SongPatch) => void
  onPageOrder: () => void
  onCrop: (pageIndex: number) => void
}) {
  const addInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceId = useRef<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const newMenu = useMenu()
  const capitalize = useSettings((s) => s.s.editor.capitalizeWords)

  // Takes a copy: clearing the input's value empties its live FileList (Chromium) mid-loop.
  const add = async (list: File[]) => {
    if (!list.length) return
    setBusy('Adding files…')
    const files: SongFile[] = []
    const errors: string[] = []
    let text: { kind: FileKind; body: string } | null = null
    for (const file of list) {
      const r = await readImportFile({ file })
      if ('error' in r) errors.push(`${file.name}: ${r.error}`)
      else {
        files.push(r.file)
        if (r.text !== undefined && !text) text = { kind: r.file.kind, body: r.text }
      }
    }
    setBusy(null)
    if (errors.length) toast(errors.join(' · '), 'error')
    if (!files.length) return
    update((s) => {
      let next = addFiles(s, files)
      if (!next.title.trim()) {
        next = { ...next, title: stripExt(files[0].name) }
        if (text) {
          next = structuredClone(next)
          metadataFromText(text.kind, text.body, next)
        }
      }
      return next
    })
  }

  const replace = async (list: FileList | null) => {
    const id = replaceId.current
    const file = list?.[0]
    if (!id || !file) return
    setBusy('Replacing file…')
    const r = await readImportFile({ file })
    setBusy(null)
    if ('error' in r) return toast(r.error, 'error')
    update((s) => replaceFile(s, id, r.file))
    toast(`Replaced with ${file.name}`, 'ok')
  }

  const newText = async (kind: FileKind) => {
    const ext = kind === 'abc' ? 'abc' : kind === 'text' ? 'txt' : 'cho'
    let title = song.title.trim()
    if (!title) {
      // The template carries the title ({title: …} / T:), so ask for it first.
      title = (await promptDialog({ title: 'New song', label: 'Song title' }))?.trim() ?? ''
      if (!title) return
      if (capitalize && title === title.toLowerCase()) title = capitalizeWords(title)
    }
    const f = await makeTextFile(`${title}.${ext}`, textTemplate(kind, { ...song, title }), kind)
    update((s) => ({ ...addFiles(s, [f]), title: s.title.trim() || title }))
    toast(`Created ${f.name} — open the song to edit its text`, 'ok')
  }

  const rename = async (f: SongFile) => {
    const name = await promptDialog({ title: 'Rename file', label: 'File name', initial: f.name })
    if (name?.trim()) update((s) => ({ ...s, files: s.files.map((x) => (x.id === f.id ? { ...x, name: name.trim() } : x)) }))
  }

  const sort = useDragSort((from, to) => update((s) => reorderFiles(s, moveItem(s.files, from, to))))
  const totalPages = resolvePageRefs(song).length

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-7 p-4 sm:p-6">
      <Section
        title={`Files (${song.files.length})`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" ref={newMenu.ref} onClick={newMenu.toggle} icon={<FilePlus2 className="size-4" />}>
              New
            </Button>
            <Button size="sm" onClick={() => addInput.current?.click()} icon={<Plus className="size-4" />}>
              Add files
            </Button>
          </div>
        }
      >
        <Menu
          anchor={newMenu.anchor}
          open={newMenu.open}
          onClose={newMenu.close}
          items={[
            { label: 'New ChordPro file', icon: <FileText className="size-4" />, onSelect: () => newText('chordpro') },
            { label: 'New plain text file', icon: <FileText className="size-4" />, onSelect: () => newText('text') },
            { label: 'New ABC notation file', icon: <Music className="size-4" />, onSelect: () => newText('abc') },
          ]}
        />
        <input ref={addInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ''))} />
        <input ref={replaceInput} type="file" accept={ACCEPT} hidden onChange={(e) => (replace(e.target.files), (e.target.value = ''))} />
        {busy && <div className="text-sm text-muted">{busy}</div>}
        {song.files.length === 0 ? (
          <button
            type="button"
            onClick={() => addInput.current?.click()}
            className="rounded-xl border-2 border-dashed border-line transition hover:border-accent hover:bg-accent-soft"
          >
            <Empty icon={<FilePlus2 className="size-6" />} title="No files yet">
              Add a PDF, images, a ChordPro/text or ABC file. Several files play one after another.
            </Empty>
          </button>
        ) : (
          <ul ref={sort.ref} className="flex flex-col gap-2">
            {song.files.map((f, i) => (
              <FileRow
                key={f.id}
                file={f}
                index={i}
                count={song.files.length}
                dragging={sort.dragging === i}
                onGrip={sort.onPointerDown(i)}
                onMove={(d) => update((s) => reorderFiles(s, moveItem(s.files, i, i + d)))}
                onRename={() => rename(f)}
                onReplace={() => {
                  replaceId.current = f.id
                  replaceInput.current?.click()
                }}
                onRemove={() => update((s) => removeFile(s, f.id))}
              />
            ))}
          </ul>
        )}
      </Section>

      {song.files.length > 0 && (
        <Section
          title={`Pages (${totalPages})`}
          actions={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onPageOrder} icon={<LayoutGrid className="size-4" />}>
                Arrange
              </Button>
              <Button size="sm" variant="ghost" disabled={!song.files.some(cropable)} onClick={() => onCrop(0)} icon={<CropIcon className="size-4" />}>
                Crop
              </Button>
              <AutoCropMenu song={song} update={update} />
            </div>
          }
        >
          <PageOrderField song={song} update={update} />
          <PageStrip song={song} update={update} onCrop={onCrop} />
        </Section>
      )}
    </div>
  )
}

function FileRow({
  file,
  index,
  count,
  dragging,
  onGrip,
  onMove,
  onRename,
  onReplace,
  onRemove,
}: {
  file: SongFile
  index: number
  count: number
  dragging: boolean
  onGrip: (e: React.PointerEvent) => void
  onMove: (d: number) => void
  onRename: () => void
  onReplace: () => void
  onRemove: () => void
}) {
  const m = useMenu()
  return (
    <li
      data-sort-index={index}
      className={cx(
        'flex items-center gap-1 rounded-xl border bg-surface py-1.5 pl-1 pr-1.5 transition-shadow',
        dragging ? 'z-10 border-accent shadow-lg ring-2 ring-accent-soft' : 'border-line',
      )}
    >
      <button
        type="button"
        aria-label={`Drag to reorder ${file.name}`}
        disabled={count < 2}
        onPointerDown={onGrip}
        className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-faint hover:text-fg disabled:invisible active:cursor-grabbing"
      >
        <GripVertical className="size-4.5" />
      </button>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
        <KindIcon kind={file.kind} />
      </div>
      <button type="button" className="min-w-0 flex-1 px-2 text-left" onClick={onRename} title="Rename">
        <div className="truncate text-sm font-medium">{file.name}</div>
        <div className="truncate text-xs text-muted">
          {KIND_LABEL[file.kind]}
          {(file.kind === 'pdf' || file.kind === 'image') && ` · ${file.pageCount} page${file.pageCount === 1 ? '' : 's'}`} · {formatBytes(file.size)}
        </div>
      </button>
      <span className="mr-1 hidden rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted sm:inline">File {index + 1}</span>
      <IconButton ref={m.ref} label={`Options for ${file.name}`} onClick={m.toggle} className="size-11">
        <MoreVertical className="size-4.5" />
      </IconButton>
      <Menu
        anchor={m.anchor}
        open={m.open}
        onClose={m.close}
        items={[
          { label: 'Rename', icon: <Pencil className="size-4" />, onSelect: onRename },
          { label: 'Replace with another file…', icon: <Replace className="size-4" />, onSelect: onReplace },
          { divider: true, label: '' },
          { label: 'Move up', icon: <ArrowUp className="size-4" />, disabled: index === 0, onSelect: () => onMove(-1) },
          { label: 'Move down', icon: <ArrowDown className="size-4" />, disabled: index === count - 1, onSelect: () => onMove(1) },
          { divider: true, label: '' },
          { label: 'Remove from song', icon: <Trash2 className="size-4" />, danger: true, onSelect: onRemove },
        ]}
      />
    </li>
  )
}

/** Text page order with live validation; applied on blur / Enter. */
function PageOrderField({ song, update }: { song: Song; update: (p: SongPatch) => void }) {
  const refs = useMemo(() => resolvePageRefs(song), [song])
  const canonical = formatPageOrder(refs, song.files)
  const [text, setText] = useState(canonical)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(canonical)
  }, [canonical, focused])
  const parsed = parsePageOrder(text, song.files)
  const apply = () => {
    if (!parsed.ok) return
    update((s) => ({ ...s, pageOrder: normalizePageOrder(parsed.refs, s.files) }))
  }
  const multi = song.files.length > 1
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium uppercase tracking-wide text-muted" htmlFor="page-order-text">
        Page order
      </label>
      <div className="flex gap-2">
        <Input
          id="page-order-text"
          value={text}
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!parsed.ok}
          aria-describedby="page-order-help"
          className={cx('font-mono', !parsed.ok && 'border-danger focus:border-danger')}
          onFocus={() => setFocused(true)}
          onChange={(e) => setText(e.target.value.replace(/[^0-9,:\-–— ]/g, ''))}
          onBlur={() => {
            setFocused(false)
            apply()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              apply()
            }
          }}
        />
        {song.pageOrder && (
          <Button variant="ghost" onClick={() => update({ pageOrder: undefined })} title="Show all pages of all files in order">
            Reset
          </Button>
        )}
      </div>
      <p id="page-order-help" className={cx('text-xs', parsed.ok ? 'text-faint' : 'text-danger')}>
        {!parsed.ok
          ? parsed.error
          : `${parsed.refs.length} page${parsed.refs.length === 1 ? '' : 's'} · repeats ("1-4, 2-3") and backwards ranges ("5-3") are allowed${multi ? ' · "2:1-4" = pages 1-4 of file 2 (later numbers stay in file 2 until another "N:")' : ''}`}
      </p>
    </div>
  )
}

function PageStrip({ song, update, onCrop }: { song: Song; update: (p: SongPatch) => void; onCrop: (i: number) => void }) {
  const refs = resolvePageRefs(song)
  const files = new Map(song.files.map((f) => [f.id, f]))
  const multi = song.files.length > 1
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
      <ol className="flex w-max gap-3">
        {refs.map((r, i) => {
          const f = files.get(r.fileId)!
          const st = song.pageSettings[pageKey(r)]
          const visual = cropable(f)
          return (
            <li key={i} className="flex w-28 flex-col items-center gap-1">
              <button
                type="button"
                disabled={!visual}
                className="rounded-md outline-offset-2 transition hover:opacity-90 disabled:cursor-default"
                onClick={() => onCrop(i)}
                aria-label={`Page ${i + 1}${visual ? ', open crop editor' : ''}`}
              >
                <PageThumb file={f} page={r.page} rotation={st?.rotation} crop={st?.crop} width={112} />
              </button>
              <div className="flex w-full items-center justify-between">
                <IconButton label="Rotate left" size="sm" disabled={!visual} onClick={() => update((s) => ({ ...s, pageSettings: rotatePages(s.pageSettings, [pageKey(r)], -90) }))}>
                  <RotateCcw className="size-4" />
                </IconButton>
                <span className="text-xs tabular-nums text-muted" title={`${f.name}, page ${r.page + 1}`}>
                  {i + 1}
                  {multi && <span className="text-faint"> · {song.files.indexOf(f) + 1}:{r.page + 1}</span>}
                </span>
                <IconButton label="Rotate right" size="sm" disabled={!visual} onClick={() => update((s) => ({ ...s, pageSettings: rotatePages(s.pageSettings, [pageKey(r)], 90) }))}>
                  <RotateCw className="size-4" />
                </IconButton>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function AutoCropMenu({ song, update }: { song: Song; update: (p: SongPatch) => void }) {
  const m = useMenu()
  const aggressive = useSettings((s) => s.s.editor.aggressiveCrop)
  const setIn = useSettings((s) => s.setIn)
  const [progress, setProgress] = useState<string | null>(null)
  const run = async (aggr: boolean) => {
    setProgress('Cropping…')
    try {
      const ps = await autoCropSong(song, { aggressive: aggr, onProgress: (d, t) => setProgress(`Cropping ${d}/${t}`) })
      update({ pageSettings: tidySettings(ps) })
      toast('Margins cropped', 'ok')
    } catch (e) {
      toast(`Auto-crop failed: ${(e as Error).message}`, 'error')
    } finally {
      setProgress(null)
    }
  }
  const anyCrop = Object.values(song.pageSettings).some((s) => s.crop)
  return (
    <>
      <Button size="sm" variant="ghost" ref={m.ref} onClick={m.toggle} disabled={!!progress || !song.files.some(cropable)} icon={<ScanLine className="size-4" />}>
        {progress ?? 'Auto-crop'}
      </Button>
      <Menu
        anchor={m.anchor}
        open={m.open}
        onClose={m.close}
        items={[
          { label: 'Auto-crop all pages', onSelect: () => run(aggressive) },
          { label: 'Ignore specks and scan borders', checked: aggressive, onSelect: () => setIn('editor', { aggressiveCrop: !aggressive }) },
          { divider: true, label: '' },
          {
            label: 'Reset all crops',
            danger: true,
            disabled: !anyCrop,
            onSelect: () =>
              update((s) => ({ ...s, pageSettings: tidySettings(Object.fromEntries(Object.entries(s.pageSettings).map(([k, v]) => [k, { ...v, crop: undefined }]))) })),
          },
        ]}
      />
    </>
  )
}
