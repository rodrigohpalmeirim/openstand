/**
 * In-memory cache of page annotations with debounced IndexedDB persistence and the session undo
 * stack. Components subscribe per page key; drawing never touches IndexedDB until a short idle.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { db } from '../db/db'
import type { Annotation, Point } from '../db/schema'
import { applyChanges, diffItems, makeCommand, UndoStack, type PageChange } from './history'

export type { PageChange }

export interface PageMeta {
  songId: string
  fileId: string
  page: number
}

export const pageKey = (songId: string, fileId: string, page: number) => `${songId}:${fileId}:${page}`

export function parseKey(key: string): PageMeta {
  const i = key.lastIndexOf(':')
  const j = key.lastIndexOf(':', i - 1)
  return { songId: key.slice(0, j), fileId: key.slice(j + 1, i), page: Number(key.slice(i + 1)) }
}

interface Entry {
  items: Annotation[]
  /**
   * The items last read from or written to IndexedDB: what `items` was derived from. Flushing writes only
   * the base→items changes onto the stored row, so items another device added meanwhile survive.
   */
  base: Annotation[]
  /** The last non-transient items (transient = a drag preview, `setItems(…, false)`). */
  stable: Annotation[]
  /** Stable arrays replaced while a drag preview showed; a gesture "cancel" restoring one gets the new one. */
  superseded?: WeakSet<Annotation[]>
  loaded: boolean
  loading?: Promise<void>
  subs: Set<() => void>
  /** Bumped on every local change so a slow load can't clobber newer edits. */
  version: number
}

const EMPTY: Annotation[] = []
const pages = new Map<string, Entry>()
const dirty = new Set<string>()
let writeTimer: ReturnType<typeof setTimeout> | undefined
// Strokes are committed on pen-up; this only groups quick successive strokes into one write (sync batches
// further on its own), so keep it short: library sync can't send a stroke before it's written.
const WRITE_DELAY = 250

function entry(key: string): Entry {
  let e = pages.get(key)
  if (!e) pages.set(key, (e = { items: EMPTY, base: EMPTY, stable: EMPTY, loaded: false, subs: new Set(), version: 0 }))
  return e
}

function notify(key: string) {
  pages.get(key)?.subs.forEach((f) => f())
}

/** Replace the stable items. During a drag the preview stays on screen; the gesture's commit rebases. */
function setStable(key: string, e: Entry, next: Annotation[]) {
  if (next === e.stable || (!next.length && !e.stable.length)) return
  if (e.items !== e.stable) {
    ;(e.superseded ??= new WeakSet()).add(e.stable)
    e.stable = next
    return
  }
  e.items = e.stable = next
  notify(key)
}

/**
 * Take a freshly read row as the new base. Unsaved local changes (base→items) are re-applied on top, so a
 * reload never drops them and never reverts what's stored.
 */
function rebaseOnto(key: string, e: Entry, row: Annotation[]) {
  const local = dirty.has(key) || flushing.has(key)
  const next = local ? applyChanges(row, diffItems(e.base, e.stable)) : row
  e.base = row
  setStable(key, e, next)
}

/** Load (or reload) a page from IndexedDB, keeping unsaved changes. */
export function load(key: string, force = false): Promise<void> {
  const e = entry(key)
  if (e.loading) return e.loading
  if (e.loaded && !force) return Promise.resolve()
  e.loading = db.annotations
    .get(key)
    .then((rec) => {
      rebaseOnto(key, e, rec?.items ?? EMPTY)
      e.loaded = true
    })
    .catch((err) => console.warn('annotations load failed', err))
    .finally(() => {
      e.loading = undefined
    })
  return e.loading
}

export function getItems(key: string): Annotation[] {
  return pages.get(key)?.items ?? EMPTY
}

export function isLoaded(key: string) {
  return !!pages.get(key)?.loaded
}

function scheduleWrite(key: string) {
  dirty.add(key)
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => void flush(), WRITE_DELAY)
}

/** Keys whose flush transaction is running (their local changes aren't in the base yet). */
const flushing = new Set<string>()
let flushChain: Promise<void> = Promise.resolve()

/**
 * Write all pending pages now. Three-way: the base→items changes are applied to the row as stored, so
 * items written meanwhile by another device (sync) or tab are kept. Flushes run one at a time.
 */
export function flush(): Promise<void> {
  clearTimeout(writeTimer)
  const run = flushChain.then(flushNow)
  flushChain = run.catch(() => {})
  return run
}

async function flushNow(): Promise<void> {
  const keys = [...dirty]
  dirty.clear()
  if (!keys.length) return
  keys.forEach((k) => flushing.add(k))
  const sent = new Map<string, Annotation[]>()
  const written = new Map<string, Annotation[]>()
  try {
    await db.transaction('rw', db.annotations, async () => {
      for (const key of keys) {
        const e = entry(key)
        const items = e.stable
        sent.set(key, items)
        const row = await db.annotations.get(key)
        const stored = row?.items ?? EMPTY
        const merged = applyChanges(stored, diffItems(e.base, items))
        if (!merged.length) {
          if (row) await db.annotations.delete(key)
        } else if (merged !== stored || !row) await db.annotations.put({ id: key, ...parseKey(key), items: merged })
        written.set(key, merged.length ? merged : EMPTY)
      }
    })
  } catch (err) {
    console.error('annotations save failed', err)
    keys.forEach((k) => dirty.add(k))
    return
  } finally {
    keys.forEach((k) => flushing.delete(k))
  }
  for (const [key, merged] of written) {
    const e = entry(key)
    const items = sent.get(key)!
    e.base = merged
    // Keep edits made while the transaction ran (they're dirty again and flush next time).
    setStable(key, e, e.stable === items ? merged : applyChanges(merged, diffItems(items, e.stable)))
  }
}

/**
 * Library sync applied remote changes to these pages (keys = page ids): re-read the loaded ones. Pages
 * with unsaved local edits keep them on top of the new row.
 */
export async function remoteChanged(keys: Iterable<string>): Promise<void> {
  const loaded = [...keys].filter((k) => pages.get(k)?.loaded)
  if (!loaded.length) return
  await flushChain
  const rows = await db.annotations.bulkGet(loaded)
  loaded.forEach((key, i) => rebaseOnto(key, entry(key), rows[i]?.items ?? EMPTY))
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flush())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush())
}

/**
 * Replace a page's items. `persist: false` is for transient previews during a drag (the final
 * state is committed through `commit`).
 */
export function setItems(key: string, items: Annotation[], persist = true) {
  const e = entry(key)
  // A cancelled drag restores the items it started from; if those were replaced meanwhile, use the new ones.
  if (!persist && e.superseded?.has(items)) items = e.stable
  e.items = items
  e.loaded = true
  e.version++
  if (persist) e.stable = items
  if (items === e.stable) e.superseded = undefined
  notify(key)
  if (persist) scheduleWrite(key)
}

/** `before → after` applied to the page's current (stable) items: rebased if they changed meanwhile. */
function rebased(key: string, before: Annotation[], after: Annotation[]): Annotation[] {
  const cur = entry(key).stable
  return cur === before ? after : applyChanges(cur, diffItems(before, after))
}

/* ---------------------------------------------------------------- History */

const history = new UndoStack()

export const useAnnotHistory = create<{ canUndo: boolean; canRedo: boolean; label?: string }>(() => ({ canUndo: false, canRedo: false }))
const syncHistory = () => useAnnotHistory.setState({ canUndo: history.canUndo, canRedo: history.canRedo })

/** Apply page changes and record them as one undo step. */
export function commit(label: string, changes: PageChange[]) {
  const cmd = makeCommand(label, changes)
  if (!cmd) {
    // Still restore the final state in case a transient preview differs.
    for (const ch of changes) if (getItems(ch.key) !== entry(ch.key).stable) setItems(ch.key, entry(ch.key).stable, false)
    return
  }
  history.push(cmd)
  // Gestures compute `after` from the items when they started; items synced in meanwhile are kept.
  for (const ch of cmd.changes) setItems(ch.key, rebased(ch.key, ch.before, ch.after))
  syncHistory()
}

/** Convenience: commit a single-page change computed from the current items. */
export function update(key: string, label: string, fn: (items: Annotation[]) => Annotation[]) {
  const before = getItems(key)
  const after = fn(before)
  if (after !== before) commit(label, [{ key, before, after }])
}

/** Apply a recorded change (or its inverse) as a diff on the current items. */
function replay(ch: PageChange, inverse: boolean) {
  const next = inverse ? rebased(ch.key, ch.after, ch.before) : rebased(ch.key, ch.before, ch.after)
  if (next !== entry(ch.key).stable) setItems(ch.key, next)
}

export function undo(): string | undefined {
  const c = history.undo()
  if (!c) return
  for (const ch of c.changes) replay(ch, true)
  clearSelection()
  syncHistory()
  return c.label
}

export function redo(): string | undefined {
  const c = history.redo()
  if (!c) return
  for (const ch of c.changes) replay(ch, false)
  clearSelection()
  syncHistory()
  return c.label
}

export function resetHistory() {
  history.clear()
  syncHistory()
}

export function historySize() {
  return history.size
}

/* ------------------------------------------------------------------ Hooks */

/** Placeholder key for "no page" subscriptions (never loaded). */
export const NO_PAGE = '::-1'

/** Subscribe to one page's items; loads from IndexedDB on first use and on remount. */
export function usePageItems(key: string): Annotation[] {
  const items = useSyncExternalStore(
    (cb) => {
      const e = entry(key)
      e.subs.add(cb)
      return () => e.subs.delete(cb)
    },
    () => getItems(key),
  )
  useEffect(() => {
    // Re-read on mount so changes made elsewhere (sync, import) show up.
    if (key !== NO_PAGE) void load(key, !dirty.has(key))
  }, [key])
  return items
}

/** Ensure every annotated page of a song is cached; returns their keys. */
export async function loadSong(songId: string): Promise<string[]> {
  const recs = await db.annotations.where('songId').equals(songId).toArray()
  for (const r of recs) {
    const e = entry(r.id)
    if (!dirty.has(r.id) && !e.loaded) {
      e.items = e.base = e.stable = r.items
      e.loaded = true
    }
  }
  const keys = new Set(recs.map((r) => r.id))
  for (const k of pages.keys()) if (k.startsWith(songId + ':') && getItems(k).length) keys.add(k)
  return [...keys]
}

/* ------------------------------------------------------------- UI state */

export interface TextEdit {
  key: string
  /** Existing item being edited, or undefined for a new one. */
  id?: string
  at: Point
}

interface AnnotUI {
  selection: { key: string; ids: string[] } | null
  editing: TextEdit | null
  /** Page that last received input (paste target, keyboard nudges). */
  activeKey: string | null
  /** Temporary tool (stylus eraser end / barrel button). */
  tempEraser: boolean
}

export const useAnnotUI = create<AnnotUI>(() => ({ selection: null, editing: null, activeKey: null, tempEraser: false }))

export function setSelection(key: string, ids: string[]) {
  useAnnotUI.setState({ selection: ids.length ? { key, ids } : null, activeKey: key })
}
export function clearSelection() {
  if (useAnnotUI.getState().selection) useAnnotUI.setState({ selection: null })
}

export function selectedItems(): { key: string; items: Annotation[] } | null {
  const sel = useAnnotUI.getState().selection
  if (!sel) return null
  const ids = new Set(sel.ids)
  const items = getItems(sel.key).filter((i) => ids.has(i.id))
  return items.length ? { key: sel.key, items } : null
}

/* --------------------------------------------------- Mounted editable pages */

const mounted = new Map<string, HTMLElement>()
export function registerEditable(key: string, el: HTMLElement) {
  mounted.set(key, el)
  return () => {
    if (mounted.get(key) === el) mounted.delete(key)
  }
}

/** Editable pages currently on screen (at least 30 % visible), most visible first. */
export function visibleKeys(): string[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const scored: [string, number][] = []
  for (const [k, el] of mounted) {
    const r = el.getBoundingClientRect()
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    const frac = (w * h) / Math.max(1, Math.min(r.width * r.height, vw * vh))
    if (frac > 0.3) scored.push([k, frac])
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

export function mountedElement(key: string) {
  return mounted.get(key)
}
