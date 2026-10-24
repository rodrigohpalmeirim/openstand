/**
 * Test kit for library-sync integration tests: devices are separate `OpenStandDB` instances (separate
 * fake-indexeddb databases) sharing one `MemoryBackend` store, with a controllable wall clock.
 */
import { OpenStandDB, sha256 } from '../db/db'
import { emptySong, type Annotation, type PageAnnotations, type Setlist, type Song, type SongFile } from '../db/schema'
import { MemoryBackend, type MemoryBackendOptions } from './backends/memory'
import type { BackendConfig } from './backends/types'
import type { Engine } from './engine'
import { enable, initialUpload, join, type FlowOptions } from './join'
import type { PairingPayload } from './model'
import { getConfig, registerDbHooks } from './state'

registerDbHooks()

let counter = 0
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${counter++}`

export interface World {
  bucket: string
  cfg: BackendConfig
  clock: { t: number }
  now: () => number
  backendOptions: MemoryBackendOptions
  /** A fresh backend instance on the shared store (per device: faults and call logs stay separate). */
  backend(): MemoryBackend
  opts(extra?: Partial<FlowOptions>): FlowOptions
  db(name: string): OpenStandDB
  advance(ms: number): void
}

export function world(o: { backendOptions?: MemoryBackendOptions } = {}): World {
  const bucket = uniq('bucket')
  const clock = { t: Date.now() }
  const now = () => clock.t
  const backendOptions = { now, ...o.backendOptions }
  const w: World = {
    bucket,
    cfg: { kind: 'memory', name: bucket },
    clock,
    now,
    backendOptions,
    backend: () => new MemoryBackend(bucket, backendOptions),
    opts: (extra = {}) => ({ now, isUntouchedDemo: async () => false, ...extra, backend: extra.backend ?? w.backend() }),
    db: (name) => new OpenStandDB(uniq(name)),
    advance: (ms) => void (clock.t += ms),
  }
  return w
}

export const bytes = (s: string | number, size?: number) => {
  if (typeof s === 'number') {
    const out = new Uint8Array(size ?? s)
    for (let i = 0; i < out.length; i++) out[i] = (i * 31 + s) & 0xff
    return out
  }
  return new TextEncoder().encode(s)
}

/** Store content in `db.blobs` (id = hash, like `putBlob`; `legacyId` mimics an old uuid id). */
export async function addBlob(db: OpenStandDB, data: Uint8Array, mime = 'application/pdf', legacyId?: string) {
  const hash = await sha256(data.slice().buffer as ArrayBuffer)
  const id = legacyId ?? hash
  await db.blobs.put({ id, hash, mime, size: data.length, data: new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }) })
  return { id, hash }
}

export async function addSong(db: OpenStandDB, id: string, title: string, o: { files?: { id: string; data: Uint8Array; legacy?: boolean }[]; patch?: Partial<Song> } = {}) {
  const files: SongFile[] = []
  for (const f of o.files ?? []) {
    const { id: blobId } = await addBlob(db, f.data, 'application/pdf', f.legacy ? `legacy-${f.id}` : undefined)
    files.push({ id: f.id, name: `${f.id}.pdf`, kind: 'pdf', blobId, pageCount: 1, size: f.data.length })
  }
  const song = emptySong({ id, title, files, createdAt: 1000, modifiedAt: 1000, ...o.patch })
  await db.songs.put(song)
  return song
}

export const stroke = (id: string, layer = 'default'): Annotation =>
  ({ id, type: 'pen', layer, color: '#000', opacity: 1, createdAt: 0, width: 0.003, points: [{ x: 0.1, y: 0.2 }] }) as Annotation

export const page = (songId: string, fileId: string, items: Annotation[], p = 0): PageAnnotations => ({
  id: `${songId}:${fileId}:${p}`,
  songId,
  fileId,
  page: p,
  items,
})

export const setlist = (id: string, name: string, songIds: string[]): Setlist => ({
  id,
  name,
  notes: '',
  entries: songIds.map((songId, i) => ({ key: `${id}-k${i}`, songId })),
  createdAt: 1000,
  modifiedAt: 1000,
})

export async function pairing(db: OpenStandDB): Promise<PairingPayload> {
  const c = (await getConfig(db))!
  return { v: 1, s: c.secret, n: c.name, b: c.backend, r: c.relay }
}

/** First device: enable and run the initial upload (files and the first snapshot). */
export async function enableDevice(w: World, db: OpenStandDB, extra: Partial<FlowOptions> = {}): Promise<Engine> {
  const e = await enable(db, { ...w.opts(extra), backendConfig: w.cfg, relay: null, name: 'Band library' })
  await initialUpload(e)
  return e
}

/** Join and let downloads finish. */
export async function joinDevice(w: World, db: OpenStandDB, from: OpenStandDB, mode: 'here' | 'merge' = 'here', extra: Partial<FlowOptions> = {}) {
  const e = await join(db, await pairing(from), mode, w.opts(extra))
  await settle(e)
  return e
}

/** Let an engine's transfers finish. */
export async function settle(...engines: Engine[]) {
  for (const e of engines) {
    await e.transfers.start()
    await e.transfers.idle()
  }
}

/** Sync every engine in turn until a full round brings nothing new (bounded). */
export async function converge(...engines: Engine[]) {
  for (let round = 0; round < 4; round++) {
    let ops = 0
    for (const e of engines) {
      const a = await e.sync()
      ops += a.ops
      await settle(e)
    }
    if (!ops && round > 0) return
  }
}

/** A comparable view of a device's library: rows without local-only bits, blob ids as hashes. */
export async function view(db: OpenStandDB) {
  const hashOf = new Map((await db.blobs.toArray()).map((b) => [b.id, b.hash]))
  const h = (id: string) => hashOf.get(id) ?? id
  const songs = (await db.songs.toArray())
    .map((s) => ({ ...s, files: s.files.map((f) => ({ ...f, blobId: h(f.blobId) })), audio: s.audio.map((a) => ({ ...a, blobId: a.blobId && h(a.blobId) })) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const setlists = (await db.setlists.toArray()).sort((a, b) => a.id.localeCompare(b.id))
  const annotations = (await db.annotations.toArray()).sort((a, b) => a.id.localeCompare(b.id))
  const kv = (await db.kv.toArray())
    .filter((k) => k.key.startsWith('layers:') || k.key.startsWith('library:') || k.key.startsWith('textLayout:'))
    .map((k) => (k.key.startsWith('layers:') ? { key: k.key, value: { ...(k.value as object), current: undefined } } : k))
    .sort((a, b) => a.key.localeCompare(b.key))
  const blobs = (await db.blobs.toArray()).map((b) => b.hash).sort()
  return { songs, setlists, annotations, kv, blobs }
}

export async function outgoing(db: OpenStandDB) {
  return { dirty: await db.syncDirty.count(), outbox: await db.syncOutbox.count() }
}
