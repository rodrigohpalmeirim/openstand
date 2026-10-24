import { useLiveQuery } from 'dexie-react-hooks'
import { AudioLines, FileStack, ListChecks, MoreHorizontal, NotebookPen, SlidersVertical } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db, pruneAnnotations, uid } from '../../db/db'
import { emptySong, type Song } from '../../db/schema'
import { MidiCommandsEditor } from '../../midi/MidiCommandsEditor'
import { rebaseOnLatest } from '../../libsync/state'
import { Button, confirmDialog, cx, Dialog, Menu, Textarea, toast, useMenu } from '../../ui/primitives'
import { useTerms } from '../browse/terms'
import { useBackHandler } from '../history'
import { AudioTab } from './AudioTab'
import { clearGroupValueCache } from './ChipInput'
import { FieldsTab, type SongPatch } from './FieldsTab'
import { FilesTab } from './FilesTab'
import { normalizePageOrder } from './pageOrder'
import { Sheet } from './Sheet'
import { tidySettings } from './songEdit'

// Full-screen sub-editors (pdf.js page rendering, pdf-lib flattening) load when first opened.
const CropEditor = lazy(() => import('./CropEditor').then((m) => ({ default: m.CropEditor })))
const PageOrderEditor = lazy(() => import('./PageOrderEditor').then((m) => ({ default: m.PageOrderEditor })))

export type EditorTab = 'fields' | 'files' | 'audio' | 'midi' | 'notes'

const TABS: { id: EditorTab; label: string; icon: typeof ListChecks }[] = [
  { id: 'fields', label: 'Fields', icon: ListChecks },
  { id: 'files', label: 'Files', icon: FileStack },
  { id: 'audio', label: 'Audio', icon: AudioLines },
  { id: 'midi', label: 'MIDI', icon: SlidersVertical },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
]

/** Stable comparison of the user-editable content (ignores timestamps). */
function fingerprint(s: Song | null) {
  if (!s) return ''
  const { modifiedAt: _m, ...rest } = s
  return JSON.stringify({ ...rest, pageSettings: tidySettings(rest.pageSettings) })
}

/**
 * Song editor: full screen on phones, a large dialog on desktop. `songId: null` creates a new song.
 * With `queue` (song ids, e.g. the current selection) a "Save & next" button walks through them.
 */
export function SongEditor({
  songId,
  onClose,
  initialTab = 'fields',
  queue,
  onSaved,
  backLayer = 'editor',
}: {
  songId: string | null
  onClose: () => void
  initialTab?: EditorTab
  /** Songs to edit one after another ("Save & next"). */
  queue?: string[]
  /** Called after every successful save. */
  onSaved?: (song: Song) => void
  /** History layer whose Back press this editor handles (see library/history.ts). */
  backLayer?: string
}) {
  const [currentId, setCurrentId] = useState(songId)
  const [draft, setDraft] = useState<Song | null>(null)
  const [base, setBase] = useState<Song | null>(null)
  const [tab, setTab] = useState<EditorTab>(initialTab)
  const [titleError, setTitleError] = useState<string>()
  const [sub, setSub] = useState<null | { kind: 'order' } | { kind: 'crop'; index: number }>(null)
  const [guard, setGuard] = useState<null | (() => void)>(null)
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const t = useTerms()
  const isNew = !currentId
  const missing = useLiveQuery(async () => (currentId ? !(await db.songs.get(currentId)) : false), [currentId])

  // Load (or create) the draft whenever the edited song changes.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const s = currentId ? await db.songs.get(currentId) : emptySong({ id: uid(), title: '' })
      if (!alive || !s) return
      setDraft(structuredClone(s))
      setBase(s)
      setTitleError(undefined)
    })()
    return () => {
      alive = false
    }
  }, [currentId])

  // Leaving a song (closed, discarded or saved) drops annotations of files it no longer has, such as
  // the copies a cancelled "Combine" made or the originals of files that were combined.
  useEffect(() => {
    const id = currentId
    return () => {
      if (id) void pruneAnnotations(id)
    }
  }, [currentId])

  const update = useCallback((p: SongPatch) => {
    setDraft((d) => (d ? (typeof p === 'function' ? p(d) : { ...d, ...p }) : d))
    if (typeof p === 'function' || 'title' in p) setTitleError(undefined)
  }, [])

  const original = useMemo(() => fingerprint(base), [base])
  const dirty = !!draft && fingerprint(draft) !== original

  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const save = async (opts: { asNew?: boolean } = {}): Promise<Song | null> => {
    if (!draft) return null
    const title = draft.title.trim()
    if (!title) {
      setTitleError(`A title is required for every ${t.song}.`)
      setTab('fields')
      requestAnimationFrame(() => titleRef.current?.focus())
      return null
    }
    setSaving(true)
    try {
      const now = Date.now()
      let s: Song = {
        ...draft,
        title,
        sortTitle: draft.sortTitle?.trim() || undefined,
        pageOrder: draft.pageOrder ? normalizePageOrder(draft.pageOrder, draft.files) : undefined,
        pageSettings: tidySettings(draft.pageSettings),
        modifiedAt: now,
      }
      if (opts.asNew) Object.assign(s, { id: uid(), createdAt: now, playCount: 0, lastPlayedAt: undefined })
      else if (base && !isNew) {
        // The draft may be minutes old: apply only the user's changes to the song as stored now, so
        // edits that arrived from another device meanwhile (sync) aren't reverted (docs/SYNC.md §8.4).
        const latest = await rebaseOnLatest(db, base, s)
        if (latest === 'deleted') {
          const again = await confirmDialog({
            title: `This ${t.song} was deleted on another device`,
            message: `Save it again with your changes?`,
            confirmLabel: 'Save again',
          })
          if (!again) return null
        } else s = latest
      }
      await db.songs.put(s)
      clearGroupValueCache()
      setBase(s)
      setDraft(s)
      onSaved?.(s)
      return s
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`, 'error')
      return null
    } finally {
      setSaving(false)
    }
  }

  const qIndex = queue && currentId ? queue.indexOf(currentId) : -1
  const nextId = queue && qIndex >= 0 && qIndex < queue.length - 1 ? queue[qIndex + 1] : null

  /** Run `then` now, or after the user chooses to save/discard pending changes. */
  const guarded = (then: () => void) => {
    if (sub) return
    if (dirty) setGuard(() => then)
    else then()
  }
  const requestClose = () => guarded(onClose)
  // Back closes the crop/page-order editor or the save prompt first, and asks before discarding edits.
  useBackHandler(backLayer, () => (sub ? setSub(null) : guard ? setGuard(null) : requestClose()))

  const saveAndClose = async () => {
    const s = await save()
    if (s) {
      toast(isNew ? `Created “${s.title}”` : 'Saved', 'ok')
      onClose()
    }
  }
  const saveAndNext = async () => {
    if (!nextId) return
    const s = dirty ? await save() : draft
    if (s) {
      setCurrentId(nextId)
      if (dirty) toast(`Saved “${s.title}”`, 'ok')
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !sub && !guard) {
        e.preventDefault()
        void saveAndClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const more = useMenu()

  const title = isNew ? (draft?.title.trim() ? `New ${t.song}: ${draft.title.trim()}` : `New ${t.song}`) : `Edit ${t.song}`
  const subtitle = !isNew && draft ? (
    <>
      {draft.title || 'Untitled'}
      {queue && qIndex >= 0 && queue.length > 1 && <span className="text-faint"> · {qIndex + 1} of {queue.length}</span>}
    </>
  ) : undefined

  return (
    <>
      <Sheet
        onClose={requestClose}
        title={title}
        subtitle={subtitle}
        labelledBy="song-editor-title"
        bodyClassName="flex flex-col overflow-hidden"
        actions={
          !isNew && (
            <>
              <Button variant="ghost" size="sm" ref={more.ref} onClick={more.toggle} aria-label="More actions" className="size-10 px-0">
                <MoreHorizontal className="size-5" />
              </Button>
              <Menu
                anchor={more.anchor}
                open={more.open}
                onClose={more.close}
                items={[
                  {
                    label: `Save as new ${t.song}`,
                    onSelect: async () => {
                      const s = await save({ asNew: true })
                      if (s) {
                        toast(`Created “${s.title}”`, 'ok')
                        setCurrentId(s.id)
                      }
                    },
                  },
                  { label: 'Discard changes', disabled: !dirty, onSelect: () => base && setDraft(structuredClone(base)) },
                ]}
              />
            </>
          )
        }
        footer={
          <>
            {dirty && <span className="mr-auto hidden text-xs text-muted sm:inline">Unsaved changes</span>}
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            {nextId && (
              <Button onClick={saveAndNext} disabled={saving}>
                {dirty ? 'Save & next' : 'Next'}
              </Button>
            )}
            <Button variant="primary" onClick={saveAndClose} disabled={saving || !draft}>
              {isNew ? `Create ${t.song}` : 'Save'}
            </Button>
          </>
        }
      >
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 sm:px-4" role="tablist" aria-label="Song editor sections">
          {TABS.map((t) => {
            const count = draft ? (t.id === 'files' ? draft.files.length : t.id === 'audio' ? draft.audio.length : t.id === 'midi' ? draft.midiOnLoad.length : 0) : 0
            return (
              <button
                key={t.id}
                role="tab"
                id={`se-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="se-panel"
                onClick={() => setTab(t.id)}
                className={cx(
                  'relative flex h-12 shrink-0 items-center gap-1.5 px-2.5 text-sm font-medium transition sm:gap-2 sm:px-3',
                  tab === t.id ? 'text-accent' : 'text-muted hover:text-fg',
                )}
              >
                <t.icon className="hidden size-4 sm:block" />
                {t.label}
                {count > 0 && <span className="rounded-full bg-surface-2 px-1.5 text-[11px] tabular-nums text-muted">{count}</span>}
                {t.id === 'fields' && titleError && <span className="size-2 rounded-full bg-danger" aria-label="has errors" />}
                {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />}
              </button>
            )
          })}
        </nav>
        <div id="se-panel" role="tabpanel" aria-labelledby={`se-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
          {missing ? (
            <p className="p-8 text-center text-sm text-muted">This {t.song} no longer exists.</p>
          ) : !draft ? (
            <div className="p-8 text-center text-sm text-muted">Loading…</div>
          ) : tab === 'fields' ? (
            <FieldsTab song={draft} update={update} titleError={titleError} titleRef={titleRef} />
          ) : tab === 'files' ? (
            <FilesTab song={draft} update={update} onPageOrder={() => setSub({ kind: 'order' })} onCrop={(index) => setSub({ kind: 'crop', index })} />
          ) : tab === 'audio' ? (
            <AudioTab song={draft} update={update} />
          ) : tab === 'midi' ? (
            <div className="mx-auto max-w-3xl p-2 sm:p-4">
              <MidiCommandsEditor
                value={draft.midiOnLoad}
                onChange={(midiOnLoad) => update({ midiOnLoad })}
                recall={draft.midiRecall}
                onRecallChange={(midiRecall) => update({ midiRecall })}
              />
            </div>
          ) : (
            <div className="mx-auto flex h-full max-w-3xl flex-col gap-2 p-4 sm:p-6">
              <label htmlFor="se-notes" className="text-xs font-medium uppercase tracking-wide text-muted">
                Song notes
              </label>
              <Textarea
                id="se-notes"
                value={draft.notes}
                onChange={(e) => update({ notes: e.target.value })}
                placeholder="Performance notes, cues, lyrics reminders… shown in the notes panel while performing."
                className="min-h-64 flex-1 resize-none text-base leading-relaxed"
              />
            </div>
          )}
        </div>
      </Sheet>

      <Suspense fallback={<SubLoading />}>
      {draft && sub?.kind === 'order' && (
        <PageOrderEditor
          song={draft}
          onClose={() => setSub(null)}
          onApply={(p) => {
            update(p)
            setSub(null)
          }}
        />
      )}
      {draft && sub?.kind === 'crop' && (
        <CropEditor
          song={draft}
          startIndex={sub.index}
          onClose={() => setSub(null)}
          onApply={(pageSettings) => {
            update({ pageSettings })
            setSub(null)
          }}
        />
      )}
      </Suspense>

      <Dialog
        open={!!guard}
        size="sm"
        onClose={() => setGuard(null)}
        title="Save changes?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGuard(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const then = guard
                setGuard(null)
                setBase(draft)
                then?.()
              }}
            >
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const then = guard
                setGuard(null)
                if (await save()) then?.()
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <p className="px-5 py-4 text-sm text-muted">
          {draft?.title.trim() ? `“${draft.title.trim()}” has unsaved changes.` : `This ${t.song} has unsaved changes.`}
        </p>
      </Dialog>
    </>
  )
}

function SubLoading() {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/60">
      <div className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-40" />
    </div>
  )
}
