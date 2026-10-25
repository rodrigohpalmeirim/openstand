/**
 * Library-sync capture middleware.
 *
 * A DBCore middleware installed on every OpenStandDB. While the capture flag for the database is on, every
 * write to a synced table also marks the written record dirty (`syncDirty`) inside the same IndexedDB
 * transaction, so the mark commits or rolls back with the data. The sync engine later diffs dirty rows
 * against `syncShadow` to produce ops. No diffing or hashing happens here, and no libsync imports: the kv
 * allow-list is injected with `setKvFilter`.
 */
import type { DBCore, DBCoreMutateRequest, DBCoreTable, DBCoreTransaction, Dexie, Middleware, Transaction } from 'dexie'

/** Synced tables and the sync collection their rows belong to. */
export const SYNCED_TABLES: Readonly<Record<string, 'song' | 'setlist' | 'ann' | 'kv'>> = {
  songs: 'song',
  setlists: 'setlist',
  annotations: 'ann',
  kv: 'kv',
}

const DIRTY = 'syncDirty'
const FLAG_PREFIX = 'openstand-libsync:'

// The flag lives in localStorage so the middleware can read it synchronously before the engine starts.
// Node (tests) has no localStorage: fall back to memory.
const memFlags = new Map<string, boolean>()
const storage = (): Storage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export const captureFlagKey = (dbName: string) => FLAG_PREFIX + dbName

export function isCaptureOn(dbName: string): boolean {
  const ls = storage()
  if (ls) return ls.getItem(captureFlagKey(dbName)) === '1'
  return memFlags.get(dbName) === true
}

export function setCaptureOn(dbName: string, on: boolean) {
  const ls = storage()
  if (ls) {
    if (on) ls.setItem(captureFlagKey(dbName), '1')
    else ls.removeItem(captureFlagKey(dbName))
  }
  if (on) memFlags.set(dbName, true)
  else memFlags.delete(dbName)
}

let kvFilter: (key: string) => boolean = () => true

/**
 * Only kv keys passing this filter are marked (libsync registers `syncedKv`). Until then every key is
 * marked; the engine drops unsynced keys when diffing, so over-marking is harmless.
 */
export function setKvFilter(fn: (key: string) => boolean) {
  kvFilter = fn
}

const remote = new WeakSet<object>()
/** Transactions opened while capture was on (they include `syncDirty`). */
const capturing = new WeakSet<object>()

/**
 * Mark a transaction as applying remote changes: its writes are not captured. Call it first thing inside
 * `db.transaction(...)`. Only an optimisation — apply also writes the shadow, so a recapture diffs empty.
 */
export function markRemote(tx: Transaction | null | undefined) {
  const t = (tx as unknown as { idbtrans?: object } | null | undefined)?.idbtrans
  if (t) remote.add(t)
}

function markKeys(down: DBCore, trans: DBCoreTransaction, c: string, keys: unknown[], table: string) {
  const at = Date.now()
  const seen = new Set<string>()
  const values: { id: string; at: number }[] = []
  for (const k of keys) {
    if (typeof k !== 'string') continue
    if (table === 'kv' && !kvFilter(k)) continue
    const id = `${c}/${k}`
    if (seen.has(id)) continue
    seen.add(id)
    values.push({ id, at })
  }
  if (!values.length) return Promise.resolve()
  return down
    .table(DIRTY)
    .mutate({ type: 'put', trans, values })
    .then(() => undefined)
}

function captureTable(down: DBCore, t: DBCoreTable): DBCoreTable {
  const c = SYNCED_TABLES[t.name]
  if (!c) return t
  return {
    ...t,
    mutate(req: DBCoreMutateRequest) {
      if (!capturing.has(req.trans) || remote.has(req.trans)) return t.mutate(req)
      if (req.type === 'deleteRange') {
        // clear() and range deletes: find the affected keys first (in the same transaction).
        return t
          .query({ trans: req.trans, values: false, query: { index: t.schema.primaryKey, range: req.range } })
          .then((res) => markKeys(down, req.trans, c, res.result, t.name))
          .then(() => t.mutate(req))
      }
      const keys: unknown[] =
        req.type === 'delete'
          ? req.keys
          : (req.keys ?? (req.type === 'put' ? req.updates?.keys : undefined) ?? req.values.map((v) => t.schema.primaryKey.extractKey?.(v)))
      return t.mutate(req).then((res) => markKeys(down, req.trans, c, keys, t.name).then(() => res))
    },
  }
}

/**
 * The capture middleware for one database (the name is read lazily: Dexie sets it in the constructor). The
 * flag is sampled when a transaction opens, so a transaction never writes `syncDirty` without holding it.
 */
export function captureMiddleware(db: Pick<Dexie, 'name'>): Middleware<DBCore> {
  return {
    stack: 'dbcore',
    name: 'LibSyncCapture',
    create(down) {
      return {
        ...down,
        transaction(stores, mode, options) {
          const capture = mode === 'readwrite' && isCaptureOn(db.name) && stores.some((s) => s in SYNCED_TABLES)
          if (capture && !stores.includes(DIRTY)) stores = [...stores, DIRTY]
          const trans = down.transaction(stores, mode, options)
          if (capture) capturing.add(trans)
          return trans
        },
        table(name) {
          return captureTable(down, down.table(name))
        },
      }
    },
  }
}

/** Install on a Dexie instance (from the OpenStandDB constructor, before it opens). */
export function installCapture(db: Dexie) {
  db.use(captureMiddleware(db))
}
