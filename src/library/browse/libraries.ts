/**
 * Multiple libraries (spec 7.9): each library is its own IndexedDB database (see openLibrary).
 * The registry (names) and the active library id live in localStorage so they're known before the DB opens.
 */
import Dexie from 'dexie'
import { create } from 'zustand'
import { openLibrary } from '../../db/db'
import { useNav } from '../../state/nav'
import { useViewer } from '../../state/viewer'

export interface LibraryInfo {
  id: string
  name: string
  createdAt: number
}

const LIST_KEY = 'openstand-libraries'
const ACTIVE_KEY = 'openstand-active-library'
const DEFAULT: LibraryInfo = { id: 'default', name: 'My Library', createdAt: 0 }

function read(): LibraryInfo[] {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]') as LibraryInfo[]
    if (Array.isArray(list) && list.some((l) => l.id === 'default')) return list
    return [DEFAULT, ...(Array.isArray(list) ? list : [])]
  } catch {
    return [DEFAULT]
  }
}

function readActive(list: LibraryInfo[]): string {
  const a = localStorage.getItem(ACTIVE_KEY) ?? 'default'
  return list.some((l) => l.id === a) ? a : 'default'
}

/** IndexedDB name used by openLibrary() for a library id. */
export const dbNameFor = (id: string) => (id === 'default' ? 'openstand' : `openstand-${id}`)

interface LibrariesState {
  list: LibraryInfo[]
  active: string
}

export const useLibraries = create<LibrariesState>(() => {
  const list = read()
  return { list, active: readActive(list) }
})

function save(list: LibraryInfo[]) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list))
  useLibraries.setState({ list })
}

// Open the active library before anything renders/queries.
{
  const { active } = useLibraries.getState()
  if (active !== 'default') openLibrary(active)
}

export function activeLibraryName(): string {
  const { list, active } = useLibraries.getState()
  return list.find((l) => l.id === active)?.name ?? DEFAULT.name
}

export function switchLibrary(id: string) {
  if (id === useLibraries.getState().active) return
  useViewer.getState().close()
  openLibrary(id)
  localStorage.setItem(ACTIVE_KEY, id)
  useLibraries.setState({ active: id })
  useNav.getState().bumpLibrary()
}

function slug(name: string) {
  const base = name
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  return `${base || 'library'}-${Math.random().toString(36).slice(2, 7)}`
}

export function createLibrary(name: string): string {
  const id = slug(name)
  save([...useLibraries.getState().list, { id, name: name.trim(), createdAt: Date.now() }])
  return id
}

export function renameLibrary(id: string, name: string) {
  save(useLibraries.getState().list.map((l) => (l.id === id ? { ...l, name: name.trim() } : l)))
}

/** Delete a library and all its data. The default library can only be emptied, not removed. */
export async function deleteLibrary(id: string) {
  if (id === 'default') return
  if (useLibraries.getState().active === id) switchLibrary('default')
  save(useLibraries.getState().list.filter((l) => l.id !== id))
  // Library sync: retire this device from the synced library (best effort) and clear the capture flag.
  await import('../../libsync/service').then((m) => m.beforeLibraryDelete(dbNameFor(id))).catch(() => {})
  await Dexie.delete(dbNameFor(id))
}
