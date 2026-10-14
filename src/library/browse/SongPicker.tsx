import { Search } from 'lucide-react'
import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { Button, cx, Dialog, Field, Input, Select } from '../../ui/primitives'
import { Thumb } from '../Thumb'
import { useLibrary, useSortOptions } from './data'
import { formatDuration, matchesTerms, queryTerms, searchText, sortSongs } from './logic'
import { songCaption } from './SongList'
import { useTerms } from './terms'
import { Badge, Checkbox, useWindow } from './widgets'

const ROW = 56

/**
 * Searchable multi-pick of library songs. With `positions` it also offers an insert position
 * (setlists): value is the index to insert at, `positions.length` = end.
 */
export function SongPicker({
  title,
  onClose,
  onPick,
  exclude,
  positions,
  initialPosition,
}: {
  title: string
  onClose: () => void
  onPick: (ids: string[], at?: number) => void | Promise<void>
  exclude?: Set<string>
  positions?: string[]
  initialPosition?: number
}) {
  const t = useTerms()
  const { songs } = useLibrary()
  const o = useSortOptions()
  const [q, setQ] = useState('')
  const query = useDeferredValue(q)
  const [picked, setPicked] = useState<string[]>([])
  const [at, setAt] = useState(initialPosition ?? positions?.length ?? 0)
  const [hideAdded, setHideAdded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const sorted = useMemo(() => sortSongs(songs, { field: 'title', dir: 'asc' }, o), [songs, o])
  const list = useMemo(() => {
    const terms = queryTerms(query)
    return sorted.filter((s) => (!hideAdded || !exclude?.has(s.id)) && (!terms.length || matchesTerms(searchText(s, 'all'), terms)))
  }, [sorted, query, exclude, hideAdded])
  const win = useWindow(ref, list.length, ROW)
  const pickedSet = new Set(picked)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const submit = async () => {
    await onPick(picked, positions ? at : undefined)
    onClose()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="lg"
      className="sm:h-[80dvh]"
      footer={
        <>
          {picked.length > 0 && (
            <button className="mr-auto text-sm text-muted hover:text-fg" onClick={() => setPicked([])}>
              Clear ({picked.length})
            </button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked.length} onClick={submit}>
            Add {picked.length ? t.count(picked.length) : ''}
          </Button>
        </>
      }
    >
      <div className="flex h-[70dvh] flex-col sm:h-full">
        <div className="flex flex-col gap-3 border-b border-line px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input autoFocus type="search" className="pl-9" placeholder={`Search ${t.songs}`} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {positions && (
              <Field label="Insert" className="min-w-48 flex-1">
                <Select value={at} onChange={(e) => setAt(Number(e.target.value))}>
                  <option value={0}>At the start</option>
                  {positions.map((p, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1 === positions.length ? `At the end (after ${p})` : `After ${i + 1}. ${p}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {exclude && exclude.size > 0 && (
              <label className="flex h-10 items-center gap-2 text-sm text-muted">
                <Checkbox checked={hideAdded} onChange={() => setHideAdded((v) => !v)} />
                <span onClick={() => setHideAdded((v) => !v)}>Hide already added</span>
              </label>
            )}
          </div>
        </div>
        <div ref={ref} className="relative min-h-0 flex-1 overflow-y-auto">
          {list.length === 0 && <div className="p-8 text-center text-sm text-muted">No {t.songs} found.</div>}
          <div className="relative" style={{ height: win.total }}>
            {list.slice(win.start, win.end).map((s, k) => {
              const on = pickedSet.has(s.id)
              const n = on ? picked.indexOf(s.id) + 1 : 0
              return (
                <button
                  key={s.id}
                  type="button"
                  style={{ top: (win.start + k) * ROW, height: ROW }}
                  onClick={() => toggle(s.id)}
                  className={cx('absolute inset-x-0 flex items-center gap-3 border-b border-line/60 px-5 text-left', on ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                >
                  <Checkbox checked={on} />
                  <Thumb song={s} className="h-10 w-7.5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {s.title}
                      {exclude?.has(s.id) && <span className="ml-2 text-xs font-normal text-faint">already added</span>}
                    </div>
                    <div className="truncate text-xs text-muted">{songCaption(s, ['artists', 'composers'])}</div>
                  </div>
                  {s.keys[0] && <Badge>{s.keys[0]}</Badge>}
                  {s.duration > 0 && <span className="w-10 text-right text-xs tabular-nums text-muted">{formatDuration(s.duration)}</span>}
                  {n > 0 && picked.length > 1 && <span className="w-5 text-center text-xs font-semibold text-accent">{n}</span>}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
