import { Copy, FilePlus, Plus, Redo2, RotateCcw, RotateCw, Square, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { putBlob, uid } from '../../db/db'
import type { PageRef, PageSettings, Song, SongFile } from '../../db/schema'
import { Button, cx, IconButton, Input, Menu, toast, useMenu } from '../../ui/primitives'
import { pageSize, resolvePageRefs } from '../../viewer/pageSource'
import { defaultPageOrder, formatPageOrder, normalizePageOrder, parsePageOrder } from './pageOrder'
import { PageThumb } from './PageThumb'
import { Sheet } from './Sheet'
import { pageKey, rotatePages, tidySettings } from './songEdit'
import { moveItem, useDragSort } from './useDragSort'

interface Item {
  k: string
  ref: PageRef
}
interface State {
  items: Item[]
  settings: Record<string, PageSettings>
  extra: SongFile[]
}

const BLANK_NAME = 'Blank page.pdf'
const wrap = (refs: PageRef[]): Item[] => refs.map((ref) => ({ k: uid(), ref }))

async function makeBlankFile(song: Song): Promise<SongFile> {
  let size = { width: 612, height: 792 }
  const first = song.files.find((f) => f.kind === 'pdf' || f.kind === 'image')
  if (first) size = await pageSize(first, 0).catch(() => size)
  // Images are measured in pixels; scale to a sensible PDF point size keeping the aspect.
  const scale = 792 / Math.max(size.width, size.height)
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  doc.addPage([Math.round(size.width * scale), Math.round(size.height * scale)])
  const bytes = await doc.save()
  const { id, size: n } = await putBlob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'application/pdf')
  return { id: uid(), name: BLANK_NAME, kind: 'pdf', blobId: id, pageCount: 1, size: n }
}

/** Visual + text page-order editor. Rotation is per page (every occurrence of that page turns). */
export function PageOrderEditor({
  song,
  onApply,
  onClose,
}: {
  song: Song
  onApply: (p: Pick<Song, 'files' | 'pageOrder' | 'pageSettings'>) => void
  onClose: () => void
}) {
  const initial = useMemo<State>(() => ({ items: wrap(resolvePageRefs(song)), settings: song.pageSettings, extra: [] }), [song])
  const [st, setSt] = useState<State>(initial)
  const [past, setPast] = useState<State[]>([])
  const [future, setFuture] = useState<State[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const gridRef = useRef<HTMLOListElement | null>(null)
  const files = useMemo(() => [...song.files, ...st.extra], [song.files, st.extra])
  const fileMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files])
  const multi = song.files.length > 1

  const lastTag = useRef<string | null>(null)
  /** Record a change; consecutive changes with the same tag (one drag gesture) form one undo step. */
  const commit = (fn: (s: State) => State, tag?: string) => {
    const next = fn(st)
    if (next === st) return
    if (!tag || lastTag.current !== tag) {
      setPast((p) => [...p.slice(-99), st])
      setFuture([])
    }
    lastTag.current = tag ?? null
    setSt(next)
  }
  const undo = () => {
    if (!past.length) return
    setFuture((f) => [st, ...f])
    setSt(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
  }
  const redo = () => {
    if (!future.length) return
    setPast((p) => [...p, st])
    setSt(future[0])
    setFuture((f) => f.slice(1))
  }

  const at = (i: number | null) => (i === null ? st.items.length : i + 1)
  const remove = (i: number) => {
    commit((s) => ({ ...s, items: s.items.filter((_, k) => k !== i) }))
    setSel(null)
  }
  const duplicate = (i: number) => {
    commit((s) => {
      const items = s.items.slice()
      items.splice(i + 1, 0, { k: uid(), ref: s.items[i].ref })
      return { ...s, items }
    })
    setSel(i + 1)
  }
  const rotate = (keys: string[], d: number) => commit((s) => ({ ...s, settings: rotatePages(s.settings, keys, d) }))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= st.items.length) return
    commit((s) => ({ ...s, items: moveItem(s.items, from, to) }))
    setSel(to)
  }
  const insert = (refs: PageRef[], extra?: SongFile) => {
    const pos = at(sel)
    commit((s) => {
      const items = s.items.slice()
      items.splice(pos, 0, ...wrap(refs))
      return { ...s, items, extra: extra && !s.extra.some((f) => f.id === extra.id) ? [...s.extra, extra] : s.extra }
    })
    setSel(pos + refs.length - 1)
  }
  const insertBlank = async () => {
    try {
      const existing = files.find((f) => f.name === BLANK_NAME && f.kind === 'pdf')
      const f = existing ?? (await makeBlankFile(song))
      insert([{ fileId: f.id, page: 0 }], existing ? undefined : f)
    } catch (e) {
      toast(`Could not create a blank page: ${(e as Error).message}`, 'error')
    }
  }

  // Text editing of the same order.
  const canonical = formatPageOrder(st.items.map((i) => i.ref), files)
  const [text, setText] = useState(canonical)
  const [textFocus, setTextFocus] = useState(false)
  useEffect(() => {
    if (!textFocus) setText(canonical)
  }, [canonical, textFocus])
  const parsed = parsePageOrder(text, files)
  const applyText = () => {
    if (parsed.ok && text !== canonical) commit((s) => ({ ...s, items: wrap(parsed.refs) }))
  }

  const dragSession = useRef(0)
  const sort = useDragSort((from, to) => {
    commit((s) => ({ ...s, items: moveItem(s.items, from, to) }), `drag${dragSession.current}`)
    setSel(to)
  }, { longPress: true })
  useEffect(() => {
    if (sort.dragging === null) dragSession.current++
  }, [sort.dragging])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || (e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const focusTile = (i: number) => requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-sort-index="${i}"] [data-tile]`)?.focus())
  const onTileKey = (e: React.KeyboardEvent, i: number) => {
    const mod = e.altKey || e.ctrlKey || e.metaKey
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
    if (step) {
      e.preventDefault()
      const to = Math.max(0, Math.min(st.items.length - 1, i + step))
      if (mod) move(i, to)
      else setSel(to)
      focusTile(to)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(i)
      focusTile(Math.max(0, i - 1))
    } else if (e.key === 'd' || e.key === 'D') duplicate(i)
    else if (e.key === 'r' || e.key === 'R') rotate([pageKey(st.items[i].ref)], e.shiftKey ? -90 : 90)
  }

  const addMenu = useMenu()
  const dirty = past.length > 0
  const done = () => {
    const usedIds = new Set(st.items.map((i) => i.ref.fileId))
    const finalFiles = [...song.files, ...st.extra.filter((f) => usedIds.has(f.id))]
    const refs = st.items.map((i) => i.ref)
    onApply({ files: finalFiles, pageOrder: normalizePageOrder(refs, finalFiles), pageSettings: tidySettings(st.settings) })
  }

  return (
    <Sheet
      size="full"
      onClose={onClose}
      title="Arrange pages"
      subtitle={`${st.items.length} page${st.items.length === 1 ? '' : 's'} · ${song.title || 'New song'}`}
      bodyClassName="flex flex-col overflow-hidden"
      footer={
        <>
          <span className="mr-auto hidden text-xs text-muted sm:block">
            Drag to reorder (touch: press and hold) · Alt+arrows move · R rotate · D duplicate · Del remove
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!st.items.length || !dirty} onClick={done}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-3 sm:px-4">
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <Input
              aria-label="Page order"
              value={text}
              spellCheck={false}
              className={cx('font-mono', !parsed.ok && 'border-danger')}
              onFocus={() => setTextFocus(true)}
              onBlur={() => {
                setTextFocus(false)
                applyText()
              }}
              onChange={(e) => setText(e.target.value.replace(/[^0-9,:\-–— ]/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && applyText()}
            />
            <p className={cx('mt-1 text-xs', parsed.ok ? 'text-faint' : 'text-danger')}>
              {parsed.ok ? `Pages are 1-based; ranges may run backwards; repeats allowed${files.length > 1 ? '; "2:1-3" = file 2' : ''}` : parsed.error}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <IconButton label="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
            <Undo2 className="size-4.5" />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}>
            <Redo2 className="size-4.5" />
          </IconButton>
          <div className="mx-1 h-6 w-px bg-line" />
          <IconButton label="Rotate all left" onClick={() => rotate(st.items.map((i) => pageKey(i.ref)), -90)}>
            <RotateCcw className="size-4.5" />
          </IconButton>
          <IconButton label="Rotate all right" onClick={() => rotate(st.items.map((i) => pageKey(i.ref)), 90)}>
            <RotateCw className="size-4.5" />
          </IconButton>
          <div className="mx-1 h-6 w-px bg-line" />
          <Button size="sm" variant="ghost" icon={<Square className="size-4" />} onClick={insertBlank}>
            Blank page
          </Button>
          <Button size="sm" variant="ghost" ref={addMenu.ref} onClick={addMenu.toggle} icon={<FilePlus className="size-4" />}>
            Add pages
          </Button>
          <Menu
            anchor={addMenu.anchor}
            open={addMenu.open}
            onClose={addMenu.close}
            items={files.map((f, i) => ({
              label: `${f.name}`,
              hint: `${multi ? `file ${i + 1} · ` : ''}${f.pageCount} p.`,
              icon: <Plus className="size-4" />,
              onSelect: () => insert(defaultPageOrder([f])),
            }))}
          />
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => commit((s) => ({ ...s, items: wrap(defaultPageOrder(song.files)) }))}
            title="All pages of all files in order"
          >
            Reset
          </Button>
        </div>
        {sel !== null && <p className="text-xs text-muted">New pages are inserted after page {sel + 1}.</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4" onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {st.items.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted">No pages. Use “Add pages” or “Reset”.</p>
        ) : (
          <ol
            ref={(el) => {
              gridRef.current = el
              sort.ref(el)
            }}
            className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(132px,1fr))]">
            {st.items.map((it, i) => {
              const f = fileMap.get(it.ref.fileId)
              if (!f) return null
              const ps = st.settings[pageKey(it.ref)]
              const fileNo = files.indexOf(f) + 1
              return (
                <li
                  key={it.k}
                  data-sort-index={i}
                  className={cx(
                    'group relative flex select-none flex-col items-center gap-1 rounded-xl border p-1.5 transition',
                    sel === i ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2',
                    sort.dragging === i && 'z-10 scale-[1.03] shadow-xl ring-2 ring-accent',
                  )}
                  onPointerDown={sort.onPointerDown(i)}
                  style={{ WebkitTouchCallout: 'none' }}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <button
                    type="button"
                    data-tile
                    aria-label={`Position ${i + 1}: ${f.name} page ${it.ref.page + 1}`}
                    aria-pressed={sel === i}
                    className="relative w-full cursor-grab rounded-md outline-offset-2 active:cursor-grabbing"
                    onClick={() => setSel(sel === i ? null : i)}
                    onKeyDown={(e) => onTileKey(e, i)}
                  >
                    <PageThumb file={f} page={it.ref.page} rotation={ps?.rotation} crop={ps?.crop} width={120} className="pointer-events-none mx-auto w-full" />
                    <span className="absolute left-1 top-1 rounded-md bg-fg/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-bg">{i + 1}</span>
                  </button>
                  <span className="text-[11px] tabular-nums text-muted">
                    {f.name === BLANK_NAME ? 'Blank' : files.length > 1 ? `File ${fileNo} · p. ${it.ref.page + 1}` : `Page ${it.ref.page + 1}`}
                  </span>
                  <div className="flex w-full justify-between">
                    <IconButton label="Rotate right" className="size-9" onPointerDown={(e) => e.stopPropagation()} onClick={() => rotate([pageKey(it.ref)], 90)}>
                      <RotateCw className="size-4" />
                    </IconButton>
                    <IconButton label="Duplicate" className="size-9" onPointerDown={(e) => e.stopPropagation()} onClick={() => duplicate(i)}>
                      <Copy className="size-4" />
                    </IconButton>
                    <IconButton label="Remove" className="size-9 text-danger" onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(i)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </Sheet>
  )
}
