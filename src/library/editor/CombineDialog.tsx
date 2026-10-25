import { FileMusic, FileText, Image as ImageIcon, Music } from 'lucide-react'
import { useState } from 'react'
import type { FileKind, Song, SongFile } from '../../db/schema'
import { Button, cx, Dialog, Field, Input } from '../../ui/primitives'
import { useTerms } from '../browse/terms'
import { applyCombine, combinable, combinedName, combineFiles } from './combine'

const KIND: Record<FileKind, string> = { pdf: 'PDF', image: 'Image', chordpro: 'ChordPro', text: 'Text', abc: 'ABC' }
const ICON: Record<FileKind, typeof FileMusic> = { pdf: FileMusic, image: ImageIcon, chordpro: FileText, text: FileText, abc: Music }

const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`

/**
 * Pick two or more of the song's PDF/image files and merge them into one PDF. `onCombined` receives a
 * transform for the editor draft, so Cancel in the song editor still discards the change. Mount it only
 * while open.
 */
export function CombineDialog({
  song,
  open,
  onClose,
  onCombined,
}: {
  song: Song
  open: boolean
  onClose: () => void
  onCombined: (apply: (s: Song) => Song, file: SongFile, count: number) => void
}) {
  // Mounted when opened, so the initial state is the reset state.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(song.files.filter(combinable).map((f) => f.id)))
  const [name, setName] = useState(() => combinedName(song, song.files.filter(combinable)))
  const [busy, setBusy] = useState<string | null>(null)
  const t = useTerms()
  const [error, setError] = useState<string | null>(null)
  const eligible = song.files.filter(combinable)
  const hasText = eligible.length < song.files.length

  const chosen = song.files.filter((f) => selected.has(f.id))
  const total = chosen.reduce((n, f) => n + f.pageCount, 0)
  const all = selected.size === eligible.length
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setSelected(next)
  }

  const run = async () => {
    setError(null)
    setBusy('Merging pages…')
    try {
      const { file, plan } = await combineFiles(song, selected, name, setBusy)
      onCombined((s) => applyCombine(s, plan, file), file, plan.files.length)
      onClose()
    } catch (e) {
      setError((e as Error).message || 'Could not combine the files')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Combine files into one PDF"
      footer={
        <>
          {busy && (
            <span className="mr-auto flex items-center gap-2 text-xs text-muted" role="status">
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {busy}
            </span>
          )}
          <Button variant="ghost" onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run} disabled={!!busy || chosen.length < 2 || !name.trim()}>
            Combine {chosen.length >= 2 ? chosen.length : ''} files
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="text-sm text-muted">
          The new PDF takes the place of the first chosen file. Page order, crop, rotation, bookmarks, links and annotations carry over; the
          original files stay available to other {t.songs}.
        </p>
        <div className="flex flex-col gap-2">
          <div className="flex min-h-11 items-center gap-2">
            <span className="flex-1 text-xs font-medium uppercase tracking-wide text-muted">
              {chosen.length} of {eligible.length} chosen · {pages(total)}
            </span>
            <Button variant="ghost" size="sm" className="h-11 sm:h-9" onClick={() => setSelected(all ? new Set() : new Set(eligible.map((f) => f.id)))} disabled={!!busy}>
              {all ? 'Select none' : 'Select all'}
            </Button>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {song.files.map((f, i) => {
              const ok = combinable(f)
              const Icon = ICON[f.kind]
              return (
                <li key={f.id}>
                  <label
                    className={cx(
                      'flex min-h-14 items-center gap-3 px-3 py-2',
                      ok ? 'cursor-pointer hover:bg-surface-2' : 'cursor-not-allowed opacity-55',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-[var(--os-accent)]"
                      checked={selected.has(f.id)}
                      disabled={!ok || !!busy}
                      onChange={(e) => toggle(f.id, e.target.checked)}
                    />
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                      <Icon className="size-4.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{f.name}</span>
                      <span className="block truncate text-xs text-muted">
                        {ok ? `${KIND[f.kind]} · ${pages(f.pageCount)}` : `${KIND[f.kind]} · can’t go into a PDF`}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-faint">File {i + 1}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          {hasText && <p className="text-xs text-faint">Text, ChordPro and ABC files are laid out when shown, so they stay separate files.</p>}
        </div>
        <Field label="New file name">
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!busy} spellCheck={false} />
        </Field>
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  )
}
