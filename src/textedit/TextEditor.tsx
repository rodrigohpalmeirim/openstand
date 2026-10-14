/**
 * Full-screen editor for ChordPro, plain-text and ABC files with live preview, insert templates,
 * chord tap mode, whole-file transposition, text → ChordPro conversion and find/replace.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownUp,
  CaseSensitive,
  ChevronDown,
  Eye,
  EyeOff,
  Minus,
  Music2,
  Plus,
  Replace,
  Search,
  Wand2,
  X,
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { AbcView } from '../abc/AbcView'
import { transposeAbcText } from '../abc/engine'
import { looksLikeChordPro, parseChordPro, songChords, textToChordPro } from '../chordpro/parse'
import { songBlocks, textContainerStyle } from '../chordpro/render'
import { chordInsertion, detectKey, transposeChordProText, transposePlainText } from '../chordpro/transform'
import { db, updateSong } from '../db/db'
import type { FileKind } from '../db/schema'
import { updateTextFile } from '../files/import'
import { formatKey, makeTransposer } from '../music/chords'
import { useSettings } from '../state/settings'
import { Button, confirmDialog, Dialog, IconButton, Input, Menu, toast, useMenu, cx } from '../ui/primitives'
import { fileText } from '../viewer/useDisplayPages'

/* ------------------------------------------------------------------ store */

interface EditorTarget {
  songId: string
  fileId: string
}

const useTextEditor = create<{ target: EditorTarget | null }>(() => ({ target: null }))

/** Open the full-screen text editor for a file of a song. */
export function openTextEditor(songId: string, fileId: string) {
  useTextEditor.setState({ target: { songId, fileId } })
}

/** Mount once (App.tsx); renders the editor while one is open. */
export function TextEditorHost() {
  const target = useTextEditor((s) => s.target)
  if (!target) return null
  return <TextEditor key={`${target.songId}:${target.fileId}`} {...target} onClose={() => useTextEditor.setState({ target: null })} />
}

/* -------------------------------------------------------------- templates */

interface Template {
  label: string
  text: string
}

/** "|" marks where the caret goes. */
const CHORDPRO_TEMPLATES: (Template | null)[] = [
  { label: 'Title', text: '{title: |}' },
  { label: 'Artist', text: '{artist: |}' },
  { label: 'Key', text: '{key: |}' },
  { label: 'Capo', text: '{capo: |}' },
  { label: 'Tempo', text: '{tempo: |}' },
  null,
  { label: 'Chord', text: '[|]' },
  { label: 'Comment', text: '{comment: |}' },
  { label: 'Verse', text: '{start_of_verse: Verse}\n|\n{end_of_verse}' },
  { label: 'Chorus', text: '{start_of_chorus}\n|\n{end_of_chorus}' },
  { label: 'Bridge', text: '{start_of_bridge}\n|\n{end_of_bridge}' },
  { label: 'Repeat chorus', text: '{chorus}|' },
  { label: 'Tab', text: '{start_of_tab}\n|\n{end_of_tab}' },
  { label: 'Chord grid', text: '{start_of_grid}\n| | . . . | . . . . |\n{end_of_grid}' },
  { label: 'ABC notation', text: '{start_of_abc}\nX:1\nM:4/4\nL:1/8\nK:C\n|\n{end_of_abc}' },
  null,
  { label: 'Chord diagram', text: '{define: | base-fret 1 frets x 3 2 0 1 0}' },
  { label: 'Column break', text: '{column_break}|' },
  { label: 'Page break', text: '{new_page}|' },
]

const ABC_TEMPLATES: (Template | null)[] = [
  { label: 'New tune', text: 'X:1\nT:|\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\n' },
  { label: 'Title (T:)', text: 'T:|' },
  { label: 'Composer (C:)', text: 'C:|' },
  { label: 'Meter (M:)', text: 'M:|' },
  { label: 'Tempo (Q:)', text: 'Q:1/4=|' },
  { label: 'Key (K:)', text: 'K:|' },
  { label: 'Part (P:)', text: 'P:|' },
  null,
  { label: 'Chord symbol', text: '"|"' },
  { label: 'Repeat', text: '|: | :|' },
  { label: 'Lyrics (w:)', text: 'w:|' },
]

/* ----------------------------------------------------------------- editor */

export function TextEditor({ songId, fileId, onClose }: { songId: string; fileId: string; onClose: () => void }) {
  const song = useLiveQuery(() => db.songs.get(songId), [songId])
  const file = song?.files.find((f) => f.id === fileId)
  const s = useSettings((st) => st.s)
  const setIn = useSettings((st) => st.setIn)
  const fontSize = s.text.editorFontSize ?? 15

  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [kind, setKind] = useState<FileKind>('chordpro')
  const [preview, setPreview] = useState(() => window.innerWidth >= 768)
  const [chordMode, setChordMode] = useState(false)
  const [lastChord, setLastChord] = useState('C')
  const [findOpen, setFindOpen] = useState(false)
  const [transposeOpen, setTransposeOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const insertMenu = useMenu()

  // Load once.
  useEffect(() => {
    if (!file || text !== null) return
    setKind(file.kind)
    fileText(file)
      .then((t) => {
        setText(t)
        setOriginal(t)
      })
      .catch(() => {
        setText('')
        setOriginal('')
      })
  }, [file, text])

  const dirty = text !== null && (text !== original || (file && kind !== file.kind))

  const close = useCallback(async () => {
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: 'Your edits to this file have not been saved.', confirmLabel: 'Discard', danger: true }))) return
    onClose()
  }, [dirty, onClose])

  const save = useCallback(async () => {
    if (!song || !file || text === null) return
    setSaving(true)
    try {
      const next = await updateTextFile(song, fileId, text)
      if (kind !== file.kind) {
        const ext = kind === 'abc' ? 'abc' : kind === 'text' ? 'txt' : 'cho'
        await updateSong(song.id, {
          files: next.files.map((f) => (f.id === fileId ? { ...f, kind, name: f.name.replace(/\.[^.]+$/, '') + '.' + ext } : f)),
        })
      }
      setOriginal(text)
      toast('Saved', 'ok')
    } catch (e) {
      toast(`Could not save: ${String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [song, file, fileId, text, kind])

  // Keyboard: Ctrl/Cmd+S saves, Ctrl/Cmd+F finds, Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        save()
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
      } else if (e.key === 'Escape') {
        // Let menus and nested dialogs close themselves first.
        if (insertMenu.open || document.querySelectorAll('[role="dialog"]').length > 1) return
        e.stopPropagation()
        if (findOpen) setFindOpen(false)
        else close()
      } else if (!(e.target instanceof HTMLElement && e.target.closest('input, textarea, select'))) {
        e.stopPropagation() // keep viewer shortcuts (page turns…) away while the editor is open
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [save, close, findOpen, insertMenu.open])

  useEffect(() => {
    if (!dirty) return
    const onBefore = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [dirty])

  /** Replace a range keeping the browser's undo history where possible. */
  const replaceRange = useCallback((start: number, end: number, insert: string, caret?: number) => {
    const el = ta.current
    if (!el) return
    el.focus()
    el.setSelectionRange(start, end)
    const ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, insert)
    if (!ok) {
      el.setRangeText(insert, start, end, 'end')
      setText(el.value)
    }
    const c = caret ?? start + insert.length
    el.setSelectionRange(c, c)
  }, [])

  const insertTemplate = (t: Template) => {
    const el = ta.current
    if (!el) return
    const at = t.text.indexOf('|')
    const body = t.text.replace('|', '')
    const { selectionStart: a, selectionEnd: b } = el
    // Block templates go on their own line.
    const prefix = body.includes('\n') && a > 0 && el.value[a - 1] !== '\n' ? '\n' : ''
    replaceRange(a, b, prefix + body, a + prefix.length + (at < 0 ? body.length : at))
  }

  const applyAll = (next: string) => {
    if (text === null || next === text) return
    replaceRange(0, text.length, next, 0)
  }

  const onTextPointerUp = () => {
    if (!chordMode || !ta.current || !lastChord.trim()) return
    const el = ta.current
    if (el.selectionStart !== el.selectionEnd) return
    const ins = chordInsertion(el.value, el.selectionStart, lastChord.trim())
    replaceRange(ins.start, ins.end, ins.insert)
  }

  const deferred = useDeferredValue(text ?? '')
  const isAbc = kind === 'abc'
  const chordsInFile = useMemo(() => {
    if (isAbc) return []
    try {
      return songChords(parseChordPro(kind === 'text' && !looksLikeChordPro(deferred) ? textToChordPro(deferred) : deferred)).slice(0, 24)
    } catch {
      return []
    }
  }, [deferred, kind, isAbc])

  if (!song || !file) return null
  return (
    <div className="fixed inset-0 z-[45] flex flex-col bg-bg text-fg" role="dialog" aria-modal="true" aria-label={`Edit ${file.name}`}>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
        <IconButton label="Close editor" onClick={close}>
          <X className="size-5" />
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-semibold">{song.title}</div>
          <div className="truncate text-xs text-muted">
            {file.name}
            {kind !== file.kind && ' → ChordPro'}
            {dirty && <span className="ml-1 text-accent">• edited</span>}
          </div>
        </div>
        <div className="flex items-center gap-0.5 overflow-x-auto">
          <Button ref={insertMenu.ref} variant="ghost" size="sm" className="h-10" onClick={insertMenu.toggle} aria-haspopup="menu">
            <Plus className="size-4" /> <span className="hidden sm:inline">Insert</span> <ChevronDown className="size-3.5" />
          </Button>
          {!isAbc && (
            <IconButton label="Chord tap mode: tap a word to insert the selected chord" active={chordMode} onClick={() => setChordMode((v) => !v)}>
              <Music2 className="size-4.5" />
            </IconButton>
          )}
          <IconButton label="Transpose file…" onClick={() => setTransposeOpen(true)}>
            <ArrowDownUp className="size-4.5" />
          </IconButton>
          {kind === 'text' && (
            <IconButton
              label="Convert chords-over-lyrics to ChordPro"
              onClick={() => {
                if (text === null) return
                applyAll(textToChordPro(text, s.text.sourceNaming))
                setKind('chordpro')
                toast('Converted to ChordPro — save to keep it')
              }}
            >
              <Wand2 className="size-4.5" />
            </IconButton>
          )}
          <IconButton label="Find and replace (Ctrl+F)" active={findOpen} onClick={() => setFindOpen((v) => !v)}>
            <Search className="size-4.5" />
          </IconButton>
          <IconButton label="Smaller text" className="hidden sm:inline-flex" onClick={() => setIn('text', { editorFontSize: Math.max(10, fontSize - 1) })}>
            <Minus className="size-4" />
          </IconButton>
          <IconButton label="Larger text" className="hidden sm:inline-flex" onClick={() => setIn('text', { editorFontSize: Math.min(32, fontSize + 1) })}>
            <Plus className="size-4" />
          </IconButton>
          <IconButton label={preview ? 'Hide preview' : 'Show preview'} active={preview} onClick={() => setPreview((v) => !v)}>
            {preview ? <Eye className="size-4.5" /> : <EyeOff className="size-4.5" />}
          </IconButton>
        </div>
        <Button variant="primary" size="sm" className="ml-1 h-10" disabled={!dirty || saving} onClick={save}>
          Save
        </Button>
        <Menu
          anchor={insertMenu.anchor}
          open={insertMenu.open}
          onClose={insertMenu.close}
          items={(isAbc ? ABC_TEMPLATES : CHORDPRO_TEMPLATES).map((t) => (t ? { label: t.label, onSelect: () => insertTemplate(t) } : { label: '', divider: true }))}
        />
      </div>

      {chordMode && !isAbc && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-accent-soft px-3 py-2">
          <span className="shrink-0 text-xs font-medium text-muted">Tap a word to insert</span>
          <Input
            aria-label="Chord to insert"
            className="!h-9 w-24 shrink-0 font-semibold"
            value={lastChord}
            onChange={(e) => setLastChord(e.target.value.replace(/[[\]]/g, ''))}
          />
          {chordsInFile.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setLastChord(c)}
              className={cx(
                'h-9 shrink-0 rounded-lg border px-3 text-sm font-semibold transition',
                c === lastChord ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface hover:bg-surface-2',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {findOpen && text !== null && <FindBar textarea={ta} text={text} replaceRange={replaceRange} onClose={() => setFindOpen(false)} />}

      {/* Body */}
      <div className={cx('grid min-h-0 flex-1', preview ? 'grid-rows-[minmax(0,55fr)_minmax(0,45fr)] md:grid-cols-2 md:grid-rows-1' : 'grid-cols-1')}>
        {text === null ? (
          <div className="flex items-center justify-center text-sm text-muted">Loading…</div>
        ) : (
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPointerUp={onTextPointerUp}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="File text"
            className="min-h-0 w-full resize-none border-0 bg-surface p-4 font-mono text-fg outline-none"
            style={{ fontSize, lineHeight: 1.5, tabSize: 4, cursor: chordMode ? 'copy' : undefined }}
          />
        )}
        {preview && (
          <div className="min-h-0 overflow-auto border-t border-line bg-[#fdfcf9] md:border-l md:border-t-0">
            <Preview text={deferred} kind={kind} />
          </div>
        )}
      </div>

      {transposeOpen && text !== null && (
        <TransposeDialog
          text={text}
          kind={kind}
          onClose={() => setTransposeOpen(false)}
          onApply={async (semis) => {
            setTransposeOpen(false)
            const opts = { naming: s.text.sourceNaming, allowDouble: s.text.allowDouble, allowUncommon: s.text.allowUncommon }
            try {
              const next =
                kind === 'abc'
                  ? await transposeAbcText(text, semis)
                  : kind === 'text' && !looksLikeChordPro(text)
                    ? transposePlainText(text, semis, opts)
                    : transposeChordProText(text, semis, opts)
              applyAll(next)
            } catch (e) {
              toast(`Could not transpose: ${String(e)}`, 'error')
            }
          }}
        />
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- preview */

function Preview({ text, kind }: { text: string; kind: FileKind }) {
  const style = useSettings((st) => st.s.text)
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const blocks = useMemo(() => {
    if (kind === 'abc') return null
    try {
      const src = kind === 'text' && !looksLikeChordPro(text) ? textToChordPro(text, style.sourceNaming) : text
      return songBlocks(parseChordPro(src, { instrument: style.instrument }), { style: { ...style, diagrams: style.diagrams === 'bottom' ? 'bottom' : 'off' }, transpose: 0 })
    } catch (e) {
      return [{ key: 'err', node: <div className="text-sm text-red-700">{String(e)}</div> }]
    }
  }, [text, kind, style])
  return (
    <div ref={ref} className="min-h-full">
      {kind === 'abc' ? (
        <AbcView source={text} transpose={0} width={width} />
      ) : (
        <div className="p-5" style={textContainerStyle(style, Math.min(1, width / 700))}>
          {blocks?.map((b) => (
            <div key={b.key}>{b.node}</div>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- find bar */

function FindBar({
  textarea,
  text,
  replaceRange,
  onClose,
}: {
  textarea: React.RefObject<HTMLTextAreaElement | null>
  text: string
  replaceRange: (a: number, b: number, s: string, caret?: number) => void
  onClose: () => void
}) {
  const [find, setFind] = useState('')
  const [repl, setRepl] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const findRef = useRef<HTMLInputElement>(null)
  useEffect(() => findRef.current?.focus(), [])
  const norm = (s: string) => (matchCase ? s : s.toLowerCase())
  const count = find ? norm(text).split(norm(find)).length - 1 : 0

  const findNext = (from?: number) => {
    const el = textarea.current
    if (!el || !find) return false
    const hay = norm(el.value)
    const needle = norm(find)
    let i = hay.indexOf(needle, from ?? el.selectionEnd)
    if (i < 0) i = hay.indexOf(needle)
    if (i < 0) return false
    el.focus()
    el.setSelectionRange(i, i + find.length)
    // Scroll the match into view.
    const line = el.value.slice(0, i).split('\n').length - 1
    el.scrollTop = Math.max(0, line * parseFloat(getComputedStyle(el).lineHeight || '20') - el.clientHeight / 3)
    return true
  }
  const replaceOne = () => {
    const el = textarea.current
    if (!el || !find) return
    const sel = el.value.slice(el.selectionStart, el.selectionEnd)
    if (norm(sel) === norm(find)) {
      const start = el.selectionStart
      replaceRange(start, el.selectionEnd, repl)
      findNext(start + repl.length)
    } else findNext()
  }
  const replaceAll = () => {
    if (!find || !count) return
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi')
    replaceRange(0, text.length, text.replace(re, () => repl), 0)
    toast(`Replaced ${count} occurrence${count === 1 ? '' : 's'}`)
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
      <Input
        ref={findRef}
        aria-label="Find"
        placeholder="Find"
        className="!h-9 min-w-0 basis-[40%] grow sm:w-48 sm:grow-0 sm:basis-auto"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            findNext()
          }
        }}
      />
      <Input aria-label="Replace with" placeholder="Replace with" className="!h-9 min-w-0 basis-[40%] grow sm:w-48 sm:grow-0 sm:basis-auto" value={repl} onChange={(e) => setRepl(e.target.value)} />
      <IconButton label="Match case" size="md" active={matchCase} onClick={() => setMatchCase((v) => !v)}>
        <CaseSensitive className="size-5" />
      </IconButton>
      <span className="min-w-14 text-xs text-muted">{find ? `${count} found` : ''}</span>
      <Button size="sm" className="h-9" onClick={() => findNext()} disabled={!count}>
        Next
      </Button>
      <Button size="sm" className="h-9" onClick={replaceOne} disabled={!count} icon={<Replace className="size-3.5" />}>
        Replace
      </Button>
      <Button size="sm" className="h-9" onClick={replaceAll} disabled={!count}>
        All
      </Button>
      <IconButton label="Close find" size="md" onClick={onClose}>
        <X className="size-4" />
      </IconButton>
    </div>
  )
}

/* ---------------------------------------------------------- transpose dlg */

function TransposeDialog({ text, kind, onClose, onApply }: { text: string; kind: FileKind; onClose: () => void; onApply: (semis: number) => void }) {
  const [semis, setSemis] = useState(2)
  const naming = useSettings((st) => st.s.text.sourceNaming)
  const key = useMemo(() => {
    if (kind === 'abc') return /^K:\s*([A-G][#b]?m?)/m.exec(text)?.[1]
    return detectKey(text, naming)
  }, [text, kind, naming])
  const target = key ? makeTransposer({ key, semitones: semis, naming }).key : undefined
  return (
    <Dialog
      open
      onClose={onClose}
      title="Transpose file"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!semis} onClick={() => onApply(semis)}>
            Transpose
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-4 p-6">
        <p className="text-center text-sm text-muted">Rewrites every chord in the file{kind === 'abc' ? ' (notes and key signature)' : ''}.</p>
        <div className="flex items-center gap-4">
          <IconButton label="Down a semitone" size="lg" className="border border-line" onClick={() => setSemis((v) => Math.max(-11, v - 1))}>
            <Minus className="size-5" />
          </IconButton>
          <div className="min-w-32 text-center">
            <div className="text-3xl font-bold tabular-nums">{semis > 0 ? `+${semis}` : semis}</div>
            <div className="text-xs text-muted">semitones</div>
          </div>
          <IconButton label="Up a semitone" size="lg" className="border border-line" onClick={() => setSemis((v) => Math.min(11, v + 1))}>
            <Plus className="size-5" />
          </IconButton>
        </div>
        {key && (
          <div className="text-sm">
            Key <b>{key}</b> → <b className="text-accent">{target ? formatKey(target) : key}</b>
          </div>
        )}
      </div>
    </Dialog>
  )
}
