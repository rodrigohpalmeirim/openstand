import { ArrowDown, ArrowUp, Check, Database, FolderPlus, ListMusic, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { GroupField } from '../../db/schema'
import { useSettings } from '../../state/settings'
import { Button, confirmDialog, cx, Dialog, Field, IconButton, Input, promptDialog, Segmented, Select, Toggle, toast } from '../../ui/primitives'
import { useLibrary } from './data'
import { createLibrary, deleteLibrary, renameLibrary, switchLibrary, useLibraries } from './libraries'
import { collator, groupValues, normalize, songHasValue } from './logic'
import { addToGroup, addToSetlist, batchEdit, createCollection, createSetlist, removeFromGroup, type BatchEdit as BatchEditSpec, type BatchOp } from './ops'
import { openSetlist } from './songActions'
import { BROWSE_GROUPS, useTerms } from './terms'
import { useLibraryUI } from './ui'
import { StarInput } from './widgets'

/* ------------------------------------------------------- Add to setlist/collection */

export function AddToDialog() {
  const st = useLibraryUI((u) => u.addTo)
  return st ? <AddTo st={st} /> : null
}

function AddTo({ st }: { st: { kind: 'setlist' | 'collection'; ids: string[] } }) {
  const t = useTerms()
  const lib = useLibrary()
  const close = () => useLibraryUI.getState().set({ addTo: null })
  const [q, setQ] = useState('')
  const [name, setName] = useState('')
  const { kind, ids } = st

  const options = useMemo(() => {
    const nq = normalize(q)
    if (kind === 'setlist')
      return [...lib.setlists]
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .filter((s) => !nq || normalize(s.name).includes(nq))
        .map((s) => ({ key: s.id, name: s.name, sub: t.count(s.entries.filter((e) => !e.isBreak).length), all: false }))
    const vals = groupValues(lib.songs, 'collections')
    for (const c of lib.extraCollections) if (!vals.some((v) => normalize(v.name) === normalize(c))) vals.push({ name: c, count: 0, duration: 0 })
    const col = collator()
    return vals
      .sort((a, b) => col.compare(a.name, b.name))
      .filter((v) => !nq || normalize(v.name).includes(nq))
      .map((v) => {
        const inIt = ids.filter((id) => {
          const s = lib.byId.get(id)
          return s && songHasValue(s, 'collections', v.name)
        }).length
        return { key: v.name, name: v.name, sub: t.count(v.count), all: inIt === ids.length && ids.length > 0 }
      })
  }, [kind, lib, q, ids, t])

  const what = ids.length === 1 ? (lib.byId.get(ids[0])?.title ?? `1 ${t.song}`) : t.count(ids.length)

  const pick = async (o: (typeof options)[number]) => {
    close()
    if (kind === 'setlist') {
      await addToSetlist(o.key, ids)
      toast(`Added ${what} to “${o.name}”`, 'ok', { label: 'Open', run: () => openSetlist(o.key) })
    } else if (o.all) {
      await removeFromGroup('collections', o.name, ids)
      toast(`Removed ${what} from “${o.name}”`, 'ok')
    } else {
      await addToGroup('collections', o.name, ids)
      toast(`Added ${what} to “${o.name}”`, 'ok')
    }
  }
  const create = async () => {
    const n = name.trim()
    if (!n) return
    close()
    if (kind === 'setlist') {
      const id = await createSetlist(n, ids)
      toast(`Created “${n}”`, 'ok', { label: 'Open', run: () => openSetlist(id) })
    } else {
      await createCollection(n, ids)
      toast(`Created collection “${n}”`, 'ok')
    }
  }

  return (
    <Dialog open onClose={close} title={`Add ${what} to ${kind === 'setlist' ? 'setlist' : 'collection'}`} size="sm">
      <div className="flex flex-col">
        <form
          className="flex gap-2 border-b border-line px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          <Input autoFocus placeholder={kind === 'setlist' ? 'New setlist name' : 'New collection name'} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!name.trim()} icon={<Plus className="size-4" />}>
            Create
          </Button>
        </form>
        {options.length > 6 && (
          <div className="px-5 pt-3">
            <Input type="search" className="h-9" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
        <div className="max-h-[50dvh] overflow-y-auto p-2">
          {options.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">No {kind === 'setlist' ? 'setlists' : 'collections'} yet — create one above.</div>}
          {options.map((o) => (
            <button key={o.key} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2" onClick={() => pick(o)}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                {kind === 'setlist' ? <ListMusic className="size-4" /> : <FolderPlus className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{o.name}</span>
                <span className="block truncate text-xs text-muted">{o.all ? 'Already added · tap to remove' : o.sub}</span>
              </span>
              {o.all && <Check className="size-4 text-accent" />}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------- Batch edit */

const KEYS = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'].flatMap((k) => [k, `${k}m`])

export function BatchEditDialog() {
  const ids = useLibraryUI((u) => u.batch)
  return ids ? <BatchEdit ids={ids} /> : null
}

function BatchEdit({ ids }: { ids: string[] }) {
  const t = useTerms()
  const lib = useLibrary()
  const close = () => useLibraryUI.getState().set({ batch: null })
  const [ops, setOps] = useState<BatchOp[]>([{ kind: 'group', field: 'genres', mode: 'add', value: '' }])
  const [rating, setRating] = useState<number | null>(null)
  const [difficulty, setDifficulty] = useState<number | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const fields: GroupField[] = ['collections', ...BROWSE_GROUPS]
  const valid = ops.filter((o) => o.mode === 'set' || o.value.trim())
  const changes = valid.length + (rating !== null ? 1 : 0) + (difficulty !== null ? 1 : 0) + (key !== null ? 1 : 0)
  const apply = async () => {
    const edit: BatchEditSpec = { groups: valid, rating: rating ?? undefined, difficulty: difficulty ?? undefined, key: key ?? undefined }
    await batchEdit(ids, edit)
    toast(`Updated ${t.count(ids.length)}`, 'ok')
    close()
  }
  const setOp = (i: number, p: Partial<BatchOp>) => setOps(ops.map((o, j) => (j === i ? { ...o, ...p } : o)))
  const enable = (on: boolean, set: () => void, clear: () => void) => (on ? set() : clear())
  return (
    <Dialog
      open
      onClose={close}
      title={`Edit ${t.count(ids.length)}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changes} onClick={apply}>
            Apply {changes ? `${changes} change${changes === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 px-5 py-4">
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Groups</div>
          {ops.map((op, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Segmented
                size="sm"
                value={op.mode}
                onChange={(mode) => setOp(i, { mode })}
                options={[
                  { value: 'add', label: 'Add' },
                  { value: 'remove', label: 'Remove' },
                  { value: 'set', label: 'Replace' },
                ]}
              />
              <Select className="h-9! w-auto!" value={op.field} onChange={(e) => setOp(i, { field: e.target.value as GroupField })} aria-label="Field">
                {fields.map((f) => (
                  <option key={f} value={f}>
                    {t.one(f)}
                  </option>
                ))}
              </Select>
              <Input
                className="h-9 min-w-36 flex-1"
                list={`batch-values-${op.field}`}
                placeholder={op.mode === 'set' ? 'Values; separated; by semicolons (empty = clear)' : 'Value'}
                value={op.value}
                onChange={(e) => setOp(i, { value: e.target.value })}
              />
              <datalist id={`batch-values-${op.field}`}>
                {groupValues(lib.songs, op.field).map((v) => (
                  <option key={v.name} value={v.name} />
                ))}
              </datalist>
              <IconButton size="sm" label="Remove change" onClick={() => setOps(ops.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="self-start" icon={<Plus className="size-4" />} onClick={() => setOps([...ops, { kind: 'group', field: 'tags', mode: 'add', value: '' }])}>
            Another group change
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted">
              Rating
              <Toggle label="Set rating" checked={rating !== null} onChange={(on) => enable(on, () => setRating(0), () => setRating(null))} />
            </label>
            <div className={cx(rating === null && 'pointer-events-none opacity-40')}>
              <StarInput value={rating ?? 0} onChange={setRating} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted">
              Difficulty
              <Toggle label="Set difficulty" checked={difficulty !== null} onChange={(on) => enable(on, () => setDifficulty(0), () => setDifficulty(null))} />
            </label>
            <Select disabled={difficulty === null} value={difficulty ?? 0} onChange={(e) => setDifficulty(Number(e.target.value))}>
              <option value={0}>Not set</option>
              {Array.from({ length: 15 }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted">
              Key
              <Toggle label="Set key" checked={key !== null} onChange={(on) => enable(on, () => setKey(''), () => setKey(null))} />
            </label>
            <Select disabled={key === null} value={key ?? ''} onChange={(e) => setKey(e.target.value)}>
              <option value="">Not set</option>
              {KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/* ---------------------------------------------------------- Preferences */

/** Library preferences (also usable inside the Settings screen). */
export function LibraryPrefsPanel() {
  const t = useTerms()
  const s = useSettings((st) => st.s)
  const set = useSettings((st) => st.set)
  const groups = ['setlists', 'collections', ...BROWSE_GROUPS]
  const visible = s.visibleGroups.filter((g) => groups.includes(g))
  const hidden = groups.filter((g) => !visible.includes(g))
  const move = (g: string, d: -1 | 1) => {
    const i = visible.indexOf(g)
    const j = i + d
    if (j < 0 || j >= visible.length) return
    const next = [...visible]
    ;[next[i], next[j]] = [next[j], next[i]]
    set({ visibleGroups: next })
  }
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      {control}
    </div>
  )
  const label = (g: string) => (g === 'setlists' ? 'Setlists' : t.group(g as GroupField))
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">General</h3>
        {row(
          'Terminology',
          'Call items songs or pieces throughout the app.',
          <Segmented
            size="sm"
            value={s.terminology}
            onChange={(v) => set({ terminology: v })}
            options={[
              { value: 'song', label: 'Songs' },
              { value: 'piece', label: 'Pieces' },
            ]}
          />,
        )}
        {row('Perform the whole list', `Tapping a ${t.song} queues the rest of the list or setlist after it.`, <Toggle checked={s.loadEntireList} onChange={(v) => set({ loadEntireList: v })} />)}
        {row('A–Z index', 'Show the letter strip next to sorted lists.', <Toggle checked={s.showAlphabet} onChange={(v) => set({ showAlphabet: v })} />)}
        {row('Ignore leading articles', 'Sort “The Entertainer” under E.', <Toggle checked={s.ignoreArticles} onChange={(v) => set({ ignoreArticles: v })} />)}
        {s.ignoreArticles && (
          <Field label="Articles (comma-separated)" className="mt-1">
            <Input value={s.articles} onChange={(e) => set({ articles: e.target.value })} placeholder="A, An, The, Der, Die, Das, Le, La, L'" />
          </Field>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Sidebar sections</h3>
        <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
          {visible.map((g, i) => (
            <div key={g} className="flex items-center gap-2 px-3 py-1.5">
              <Toggle label={`Show ${label(g)}`} checked onChange={() => set({ visibleGroups: visible.filter((x) => x !== g) })} />
              {g === 'setlists' ? (
                <span className="flex-1 px-3 text-sm">Setlists</span>
              ) : (
                <Input
                  className="h-8 flex-1 border-transparent bg-transparent hover:border-line"
                  aria-label={`Label for ${g}`}
                  value={s.fieldLabels[g] ?? ''}
                  placeholder={label(g)}
                  onChange={(e) => set({ fieldLabels: { ...s.fieldLabels, [g]: e.target.value } })}
                />
              )}
              <IconButton size="sm" label="Move up" disabled={i === 0} onClick={() => move(g, -1)}>
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton size="sm" label="Move down" disabled={i === visible.length - 1} onClick={() => move(g, 1)}>
                <ArrowDown className="size-4" />
              </IconButton>
            </div>
          ))}
          {hidden.map((g) => (
            <div key={g} className="flex items-center gap-2 px-3 py-1.5 opacity-70">
              <Toggle label={`Show ${label(g)}`} checked={false} onChange={() => set({ visibleGroups: [...visible, g] })} />
              <span className="flex-1 px-3 text-sm">{label(g)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-faint">Rename a section by typing over its label (e.g. “Custom” → “Hymnal number”).</p>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Libraries</h3>
        <Button icon={<Database className="size-4" />} onClick={() => useLibraryUI.getState().set({ libraries: true, prefs: false })}>
          Manage libraries…
        </Button>
      </section>
    </div>
  )
}

export function LibraryPrefsDialog() {
  const open = useLibraryUI((u) => u.prefs)
  const close = () => useLibraryUI.getState().set({ prefs: false })
  return (
    <Dialog open={open} onClose={close} title="Library preferences" size="lg" footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="px-5 py-4">
        <LibraryPrefsPanel />
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ Libraries */

export function LibrariesDialog() {
  const open = useLibraryUI((u) => u.libraries)
  const { list, active } = useLibraries()
  const close = () => useLibraryUI.getState().set({ libraries: false })
  const add = async () => {
    const name = (await promptDialog({ title: 'New library', label: 'Library name' }))?.trim()
    if (!name) return
    const id = createLibrary(name)
    switchLibrary(id)
    close()
    toast(`Switched to “${name}”`, 'ok')
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Libraries"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={add}>
            New library
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1 p-2">
        <p className="px-3 pb-2 pt-1 text-xs text-muted">
          Each library keeps its own songs, setlists and annotations — e.g. one per band or per student. Settings are shared.
        </p>
        {list.map((l) => (
          <div key={l.id} className={cx('flex items-center gap-2 rounded-xl px-3 py-2', l.id === active ? 'bg-accent-soft' : 'hover:bg-surface-2')}>
            <Database className={cx('size-4 shrink-0', l.id === active ? 'text-accent' : 'text-muted')} />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                if (l.id !== active) {
                  switchLibrary(l.id)
                  toast(`Switched to “${l.name}”`, 'ok')
                }
                close()
              }}
            >
              <div className="truncate text-sm font-medium">{l.name}</div>
              <div className="text-xs text-muted">{l.id === active ? 'Active' : 'Tap to switch'}</div>
            </button>
            <IconButton
              size="sm"
              label={`Rename ${l.name}`}
              onClick={async () => {
                const name = (await promptDialog({ title: 'Rename library', label: 'Name', initial: l.name }))?.trim()
                if (name) renameLibrary(l.id, name)
              }}
            >
              <Pencil className="size-4" />
            </IconButton>
            {l.id !== 'default' && (
              <IconButton
                size="sm"
                label={`Delete ${l.name}`}
                className="text-danger!"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Delete “${l.name}”?`,
                    message: 'All songs, files, setlists and annotations in this library will be permanently deleted. Other libraries are not affected.',
                    confirmLabel: 'Delete library',
                    danger: true,
                  })
                  if (!ok) return
                  await deleteLibrary(l.id)
                  toast(`Deleted “${l.name}”`, 'ok')
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </div>
        ))}
      </div>
    </Dialog>
  )
}
