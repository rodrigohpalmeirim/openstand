/**
 * In-memory cache of page annotations with debounced IndexedDB persistence and the session undo
 * stack. Components subscribe per page key; drawing never touches IndexedDB until a short idle.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import { db } from '../db/db'
import type { Annotation, Point } from '../db/schema'
import { makeCommand, UndoStack, type PageChange } from './history'

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
const WRITE_DELAY = 700

function entry(key: string): Entry {
  let e = pages.get(key)
  if (!e) pages.set(key, (e = { items: EMPTY, loaded: false, subs: new Set(), version: 0 }))
  return e
}

function notify(key: string) {
  pages.get(key)?.subs.forEach((f) => f())
}

/** Load (or reload) a page from IndexedDB unless it has unsaved changes. */
export function load(key: string, force = false): Promise<void> {
  const e = entry(key)
  if (e.loading) return e.loading
  if (e.loaded && !force) return Promise.resolve()
  const v = e.version
  e.loading = db.annotations
    .get(key)
    .then((rec) => {
      if (!dirty.has(key) && e.version === v) {
        const items = rec?.items ?? EMPTY
        if (items !== e.items && (items.length || e.items.length)) {
          e.items = items
          notify(key)
        }
      }
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

/** Write all pending pages now. */
export async function flush(): Promise<void> {
  clearTimeout(writeTimer)
  const keys = [...dirty]
  dirty.clear()
  if (!keys.length) return
  try {
    await db.transaction('rw', db.annotations, async () => {
      for (const key of keys) {
        const items = getItems(key)
        if (!items.length) await db.annotations.delete(key)
        else await db.annotations.put({ id: key, ...parseKey(key), items })
      }
    })
  } catch (err) {
    console.error('annotations save failed', err)
    keys.forEach((k) => dirty.add(k))
  }
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
  e.items = items
  e.loaded = true
  e.version++
  notify(key)
  if (persist) scheduleWrite(key)
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
    for (const ch of changes) if (getItems(ch.key) !== ch.after) setItems(ch.key, ch.after)
    return
  }
  history.push(cmd)
  for (const ch of cmd.changes) setItems(ch.key, ch.after)
  syncHistory()
}

/** Convenience: commit a single-page change computed from the current items. */
export function update(key: string, label: string, fn: (items: Annotation[]) => Annotation[]) {
  const before = getItems(key)
  const after = fn(before)
  if (after !== before) commit(label, [{ key, before, after }])
}

export function undo(): string | undefined {
  const c = history.undo()
  if (!c) return
  for (const ch of c.changes) setItems(ch.key, ch.before)
  clearSelection()
  syncHistory()
  return c.label
}

export function redo(): string | undefined {
  const c = history.redo()
  if (!c) return
  for (const ch of c.changes) setItems(ch.key, ch.after)
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
      e.items = r.items
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
