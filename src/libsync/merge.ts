/**
 * Pure register merge for library sync.
 *
 * Vocabulary:
 * - A **projection** is a row broken into registers, without hlcs (`project`).
 * - A **state** is a full-valued `RecordDelta` (registers with hlcs and values): what a snapshot line
 *   holds. `mergeDelta` is a join on states: commutative, associative and idempotent.
 * - A **shadow** (`ShadowRecord`) is a state with value hashes instead of values (`toShadow`). The row
 *   holds the values, so `fromShadow(shadow, project(row))` rebuilds the state.
 *
 * Typical engine use:
 * - capture: `diff(c, project(c, row, ctx), shadow, clock.now(dirty.at), deviceId)`, then
 *   `shadow = toShadow(mergeDelta(fromShadow(shadow, proj), delta))`.
 * - apply: `state = mergeDelta(fromShadow(shadow, project(c, row, ctx)), op)`, then
 *   `row = materialize(c, state, row, ctx)` (`null` = delete the row) and `shadow = toShadow(state)`.
 *
 * Values in states and rows produced here may share structure: treat them as immutable.
 */
import {
  fieldSpec,
  fieldTable,
  hasOrder,
  isCollection,
  isKeyed,
  isPlainObject,
  kvShape,
  numKind,
  parseAnnId,
  type FieldSpec,
  type FieldTable,
} from './fields'
import { canonicalJson, hash64, toJson, valueHash } from './hash'
import { formatHlc, HLC_ZERO, hlcWall, maxHlc } from './hlc'
import type { Collection, CollectionRows, Hlc, Json, ListDelta, RecordDelta, ShadowRecord } from './model'

type Row = Record<string, unknown>
type Obj = { [k: string]: Json }

/** Null-prototype dictionary: keys come from user data (`__proto__` is a valid tag). */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>
const own = (o: object | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k)
const isEmpty = (o: object | undefined) => !o || Object.keys(o).length === 0

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

export interface ProjList {
  /** Element keys in row order (sets: the strings; maps: object key order, which is irrelevant). */
  keys: string[]
  /** Element key -> wire value. */
  e: Record<string, Json>
}

/** A row as registers, without hlcs. Absent `f` keys are unset. */
export interface Projection {
  c: Collection
  id: string
  f: Record<string, Json>
  m: Record<string, number>
  l: Record<string, ProjList>
  /** Counter fields -> the row's value. */
  n: Record<string, number>
}

export interface ProjectCtx {
  /**
   * Content SHA-256 hex of a local blob id, `''` if unknown (an id that is already 64 hex
   * chars is the hash; otherwise `blobs.get(id).hash`).
   */
  blobHash(blobId: string): string
  /**
   * Mime of a local blob id (`BlobRecord.mime`, or the pending transfer's mime). Must be stable across
   * devices for the same blob, or file elements look changed. Falls back to a default by file kind.
   */
  blobMime?(blobId: string): string | undefined
}

export interface MaterializeCtx {
  /** Lets a local `blobId` with a matching hash be kept (legacy uuid ids). */
  blobHash?(blobId: string): string
  /** Local blob id for a wire hash. Default: the hash itself (download pending). */
  blobId?(hash: string): string
}

const HEX64 = /^[0-9a-f]{64}$/
const DEFAULT_CTX: ProjectCtx = { blobHash: (id) => (HEX64.test(id) ? id : '') }

const KIND_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  chordpro: 'text/plain',
  text: 'text/plain',
  abc: 'text/plain',
}
const mimeFor = (kind: unknown) => KIND_MIME[kind as string] ?? 'application/octet-stream'

/** The record id of a row. */
export function rowId(c: Collection, row: object): string {
  const r = row as Row
  return String(c === 'kv' ? r.key : r.id)
}

/** The object whose properties are the fields, plus its table. */
function recordObject(c: Collection, id: string, row: Row | null | undefined): { obj: Row | undefined; table: FieldTable } {
  const table = fieldTable(c, id)
  if (!table) throw new Error(c === 'kv' ? `kv key does not sync: ${id}` : `unknown collection: ${c}`)
  if (c !== 'kv' || !row) return { obj: row ?? undefined, table }
  return { obj: kvShape(id)!.object ? (isPlainObject(row.value) ? row.value : {}) : { value: row.value }, table }
}

const elementKey = (x: Row, prop: string): string => {
  const k = x[prop]
  return typeof k === 'string' && k ? k : `~${hash64(canonicalJson(x))}`
}

function toWire(spec: FieldSpec, x: Row, ctx: ProjectCtx): Obj {
  const rest: Row = { ...x }
  delete rest[spec.key!]
  if (!spec.wire) return toJson(rest) as Obj
  const blobId = rest.blobId as string | undefined
  delete rest.blobId
  const v = toJson(rest) as Obj
  if (spec.wire === 'file' || blobId !== undefined) {
    v.blob = blobId ? ctx.blobHash(blobId) : ''
    v.mime = (blobId && ctx.blobMime?.(blobId)) || mimeFor(x.kind)
  }
  return v
}

/** Break a row into registers. Throws for a kv key that doesn't sync. */
export function project<C extends Collection>(c: C, row: CollectionRows[C], ctx: ProjectCtx = DEFAULT_CTX): Projection {
  const id = rowId(c, row)
  const { obj, table } = recordObject(c, id, row as unknown as Row)
  const p: Projection = { c, id, f: dict(), m: dict(), l: dict(), n: dict() }
  for (const [k, raw] of Object.entries(obj ?? {})) {
    if (raw === undefined || (c !== 'kv' && k === 'id')) continue
    const spec = fieldSpec(table, k)
    switch (spec.kind) {
      case 'lww': {
        const j = toJson(raw)
        if (j !== undefined) p.f[k] = j
        break
      }
      case 'flat':
        if (isPlainObject(raw)) {
          for (const [s, x] of Object.entries(raw)) {
            const j = toJson(x)
            if (j !== undefined) p.f[`${k}.${s}`] = j
          }
        }
        break
      case 'max':
      case 'min':
        if (typeof raw === 'number' && Number.isFinite(raw)) p.m[k] = raw
        break
      case 'pn':
        if (typeof raw === 'number' && Number.isFinite(raw)) p.n[k] = Math.max(0, Math.round(raw))
        break
      case 'set': {
        const pl: ProjList = { keys: [], e: dict() }
        if (Array.isArray(raw)) {
          for (const x of raw) {
            if (typeof x === 'string' && !own(pl.e, x)) {
              pl.keys.push(x)
              pl.e[x] = true
            }
          }
        }
        p.l[k] = pl
        break
      }
      case 'list': {
        const pl: ProjList = { keys: [], e: dict() }
        if (Array.isArray(raw)) {
          for (const x of raw) {
            if (!isPlainObject(x)) continue
            const key = elementKey(x, spec.key!)
            if (own(pl.e, key)) continue // duplicate key: first one kept
            pl.keys.push(key)
            pl.e[key] = toWire(spec, x, ctx)
          }
        }
        p.l[k] = pl
        break
      }
      case 'map': {
        const pl: ProjList = { keys: [], e: dict() }
        if (isPlainObject(raw)) {
          for (const [mk, mv] of Object.entries(raw)) {
            const j = toJson(mv)
            if (j === undefined) continue
            pl.keys.push(mk)
            pl.e[mk] = j
          }
        }
        p.l[k] = pl
        break
      }
      default: // const, local
        break
    }
  }
  return p
}

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

/** `o` filtered to alive keys, then the alive keys not in `o`, sorted by (born, key). */
export function orderKeys(o: string[] | undefined, alive: Map<string, Hlc>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of o ?? []) {
    if (alive.has(k) && !seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  const rest = [...alive.keys()].filter((k) => !seen.has(k))
  rest.sort((a, b) => {
    const ba = alive.get(a)!
    const bb = alive.get(b)!
    return ba < bb ? -1 : ba > bb ? 1 : a < b ? -1 : a > b ? 1 : 0
  })
  return out.concat(rest)
}

const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

/**
 * Registers that changed between the row (`proj`, `null` = row missing) and what the network knows
 * (`shadow`), stamped with `hlc`. `dev` owns the counter entries this device writes. `null` = no change.
 *
 * - Missing row with a shadow: `a = [hlc, false]`, plus every set field unset and every alive element
 *   tombstoned (`ann`: only the tombstones; pages are never record-tombstoned).
 * - New record, or a row put over a dead id (undelete): `a = [hlc, true]` and every register is
 *   (re-)registered.
 * - Lists: new or changed elements `[hlc, value, born ?? hlc]`, removed ones `[hlc, null, born]`, and an
 *   `o` register only when materialising without it would give a different order.
 */
export function diff(c: Collection, proj: Projection | null, shadow: ShadowRecord | undefined, hlc: Hlc, dev: string): RecordDelta | null {
  const id = proj?.id ?? shadow?.id
  if (id === undefined) return null
  const table = fieldTable(c, id)
  if (!table) throw new Error(`no field table for ${c}/${id}`)
  const d: RecordDelta = { c, id }

  const dead = !!shadow?.a && !shadow.a[1]
  // A record "exists" once its creation (an `a` register) is known; `ann` pages have no `a`.
  const seen = c === 'ann' ? !!shadow : !!shadow?.a

  if (!proj) {
    if (!shadow || (c !== 'ann' && (!seen || dead))) return null
    // A delete also unsets every field and tombstones every element it knows. The deleting device
    // captures after its row is gone, so it can't keep those values; without this, a later undelete
    // from a device that knew less would leave them alive elsewhere but missing here.
    const empty: Projection = { c, id, f: dict(), m: dict(), l: dict(), n: dict() }
    const cleared = diff(c, empty, shadow, hlc, dev)
    if (c === 'ann') return cleared
    return { ...(cleared ?? d), a: [hlc, false] }
  }

  const revive = !seen || dead
  if (dead || (revive && c !== 'ann')) d.a = [hlc, true]

  const f = dict<[Hlc] | [Hlc, Json]>()
  for (const [k, v] of Object.entries(proj.f)) {
    const s = shadow?.f[k]
    if (revive || !s || s[1] !== valueHash(v)) f[k] = [hlc, v]
  }
  if (shadow) {
    for (const [k, s] of Object.entries(shadow.f)) {
      if (s[1] !== '' && !own(proj.f, k)) f[k] = [hlc]
    }
  }
  if (!isEmpty(f)) d.f = f

  const m = dict<number>()
  for (const [k, v] of Object.entries(proj.m)) {
    const s = shadow?.m[k]
    if (revive || s === undefined || (numKind(table, k) === 'min' ? v < s : v > s)) m[k] = v
  }
  if (!isEmpty(m)) d.m = m

  const n = dict<Record<string, [number, number]>>()
  for (const [k, v] of Object.entries(proj.n)) {
    const per = shadow?.n[k] ?? {}
    let raw = 0
    for (const [inc, dec] of Object.values(per)) raw += inc - dec
    if (v === Math.max(0, raw)) continue
    const need = v - raw
    const [inc, dec] = per[dev] ?? [0, 0]
    n[k] = { [dev]: need > 0 ? [inc + need, dec] : [inc, dec - need] }
  }
  if (!isEmpty(n)) d.n = n

  const l = dict<ListDelta>()
  const listKeys = new Set(Object.keys(proj.l))
  for (const k of Object.keys(shadow?.l ?? {})) if (isKeyed(fieldSpec(table, k).kind)) listKeys.add(k)
  for (const k of listKeys) {
    const pl = proj.l[k] ?? { keys: [], e: {} }
    const sl = shadow?.l[k]
    const e = dict<[Hlc, Json | null, Hlc]>()
    const alive = new Map<string, Hlc>()
    for (const [key, [, h, born]] of Object.entries(sl?.e ?? {})) if (h !== '') alive.set(key, born)
    for (const key of pl.keys) {
      const v = pl.e[key]
      const se = sl?.e[key]
      const wasAlive = !!se && se[1] !== ''
      if (revive || !se || se[1] !== valueHash(v)) {
        const born = wasAlive ? se[2] : hlc
        e[key] = [hlc, v, born]
        alive.set(key, born)
      }
    }
    for (const [key, [, h, born]] of Object.entries(sl?.e ?? {})) {
      if (h !== '' && !own(pl.e, key)) {
        e[key] = [hlc, null, born]
        alive.delete(key)
      }
    }
    const ld: ListDelta = {}
    if (!isEmpty(e)) ld.e = e
    if (hasOrder(fieldSpec(table, k).kind) && !arrEq(orderKeys(sl?.o?.[1], alive), pl.keys)) ld.o = [hlc, [...pl.keys]]
    if (ld.e || ld.o) l[k] = ld
  }
  if (!isEmpty(l)) d.l = l

  return d.a || d.f || d.m || d.n || d.l ? d : null
}

// ---------------------------------------------------------------------------------------------
// Merge (the join)
// ---------------------------------------------------------------------------------------------

/** Total order on registers: hlc first, then the canonical JSON of the whole register (ties are rare). */
function newer<T extends [Hlc, ...unknown[]]>(x: T, y: T): T {
  if (x[0] !== y[0]) return x[0] > y[0] ? x : y
  return canonicalJson(x) >= canonicalJson(y) ? x : y
}

function pick<T extends [Hlc, ...unknown[]]>(x: T | undefined, y: T | undefined): T | undefined {
  return !x ? y : !y ? x : newer(x, y)
}

function mergeRegs<T extends [Hlc, ...unknown[]]>(x: Record<string, T> | undefined, y: Record<string, T> | undefined): Record<string, T> | undefined {
  if (isEmpty(x) && isEmpty(y)) return undefined
  const out = dict<T>()
  for (const [k, r] of Object.entries(x ?? {})) out[k] = r
  for (const [k, r] of Object.entries(y ?? {})) out[k] = own(out, k) ? newer(out[k], r) : r
  return out
}

/**
 * Join `delta` into `state` (either may be a batch op or a full snapshot line). Pure: returns a new
 * state and never mutates its inputs. Per register: LWW on hlc (`a`, `f`, list `o` and elements),
 * max/min (`m`, kind from the field table; unknown fields max), and per-device max of the [inc, dec]
 * totals (`n`). A delete wins over concurrent edits because edits never touch `a`.
 */
export function mergeDelta(state: RecordDelta | undefined, delta: RecordDelta): RecordDelta {
  if (state && (state.c !== delta.c || state.id !== delta.id)) throw new Error(`mergeDelta: ${state.c}/${state.id} vs ${delta.c}/${delta.id}`)
  const table = isCollection(delta.c) ? fieldTable(delta.c, delta.id) : null
  const out: RecordDelta = { c: delta.c, id: delta.id }

  const a = pick(state?.a, delta.a)
  if (a) out.a = a

  const f = mergeRegs(state?.f, delta.f)
  if (f) out.f = f

  if (!isEmpty(state?.m) || !isEmpty(delta.m)) {
    const m = dict<number>()
    for (const src of [state?.m, delta.m]) {
      for (const [k, v] of Object.entries(src ?? {})) {
        m[k] = !own(m, k) ? v : numKind(table, k) === 'min' ? Math.min(m[k], v) : Math.max(m[k], v)
      }
    }
    out.m = m
  }

  if (!isEmpty(state?.l) || !isEmpty(delta.l)) {
    const l = dict<ListDelta>()
    for (const k of new Set([...Object.keys(state?.l ?? {}), ...Object.keys(delta.l ?? {})])) {
      const x = state?.l?.[k]
      const y = delta.l?.[k]
      const ld: ListDelta = {}
      const o = pick(x?.o, y?.o)
      if (o) ld.o = o
      const e = mergeRegs(x?.e, y?.e)
      if (e) ld.e = e
      if (ld.o || ld.e) l[k] = ld
    }
    if (!isEmpty(l)) out.l = l
  }

  if (!isEmpty(state?.n) || !isEmpty(delta.n)) {
    const n = dict<Record<string, [number, number]>>()
    for (const src of [state?.n, delta.n]) {
      for (const [k, per] of Object.entries(src ?? {})) {
        const acc = (n[k] ??= dict())
        for (const [dev, [inc, dec]] of Object.entries(per)) {
          const cur = acc[dev]
          acc[dev] = cur ? [Math.max(cur[0], inc), Math.max(cur[1], dec)] : [inc, dec]
        }
      }
    }
    out.n = n
  }
  return out
}

/** Largest hlc in a delta (for `Batch.hlcMax` and `clock.receive`). */
export function deltaHlcMax(d: RecordDelta): Hlc {
  let h = d.a?.[0] ?? HLC_ZERO
  for (const r of Object.values(d.f ?? {})) h = maxHlc(h, r[0])
  for (const ld of Object.values(d.l ?? {})) {
    if (ld.o) h = maxHlc(h, ld.o[0])
    for (const r of Object.values(ld.e ?? {})) h = maxHlc(maxHlc(h, r[0]), r[2])
  }
  return h
}

/** A record's alive register says it is deleted. */
export const isDead = (s: { a?: [Hlc, boolean] } | undefined) => !!s?.a && !s.a[1]

// ---------------------------------------------------------------------------------------------
// Shadow
// ---------------------------------------------------------------------------------------------

/** A known record that has no row to hold its values: not created yet (no `a`) or deleted. */
const rowless = (s: RecordDelta) => s.c !== 'ann' && (!s.a || !s.a[1])

/**
 * State -> shadow (values replaced by hashes). The whole state is also kept in `x` when there is no row
 * to hold the values: an unknown collection, a record whose creation hasn't arrived yet (edits
 * from another device's log can come first), and a deleted record (until `compact` drops its values).
 * `fromShadow` returns `x` as is.
 */
export function toShadow(state: RecordDelta): ShadowRecord {
  const s: ShadowRecord = { id: state.id, c: state.c, f: dict(), m: dict(), l: dict(), n: dict() }
  if (!isCollection(state.c)) {
    s.x = state
    return s
  }
  if (rowless(state)) s.x = state
  if (state.a) s.a = state.a
  for (const [k, r] of Object.entries(state.f ?? {})) s.f[k] = [r[0], r.length === 2 ? valueHash(r[1]) : '']
  for (const [k, v] of Object.entries(state.m ?? {})) s.m[k] = v
  for (const [k, ld] of Object.entries(state.l ?? {})) {
    const sl: ShadowRecord['l'][string] = { e: dict() }
    if (ld.o) sl.o = ld.o
    for (const [key, [h, v, born]] of Object.entries(ld.e ?? {})) sl.e[key] = [h, v === null ? '' : valueHash(v), born]
    s.l[k] = sl
  }
  for (const [k, per] of Object.entries(state.n ?? {})) s.n[k] = { ...per }
  return s
}

/**
 * Rebuild the state from a shadow and the row's projection (`null` = no row): shadow hlcs joined with
 * row values (as snapshots do), or the kept `x` state. A register whose value the row lacks is
 * left out. Snapshot lines are `fromShadow(shadow, row ? project(c, row, ctx) : null)`.
 */
export function fromShadow(shadow: ShadowRecord, proj: Projection | null): RecordDelta {
  if (shadow.x) return shadow.x as RecordDelta
  if (!isCollection(shadow.c)) return { c: shadow.c, id: shadow.id }
  const s: RecordDelta = { c: shadow.c, id: shadow.id }
  if (shadow.a) s.a = shadow.a
  const f = dict<[Hlc] | [Hlc, Json]>()
  for (const [k, [h, vh]] of Object.entries(shadow.f)) {
    if (vh === '') f[k] = [h]
    else if (proj && own(proj.f, k)) f[k] = [h, proj.f[k]]
  }
  if (!isEmpty(f)) s.f = f
  if (!isEmpty(shadow.m)) s.m = { ...shadow.m }
  const l = dict<ListDelta>()
  for (const [k, sl] of Object.entries(shadow.l)) {
    const ld: ListDelta = {}
    if (sl.o) ld.o = sl.o
    const e = dict<[Hlc, Json | null, Hlc]>()
    const pe = proj?.l[k]?.e
    for (const [key, [h, vh, born]] of Object.entries(sl.e)) {
      if (vh === '') e[key] = [h, null, born]
      else if (pe && own(pe, key)) e[key] = [h, pe[key], born]
    }
    if (!isEmpty(e)) ld.e = e
    if (ld.o || ld.e) l[k] = ld
  }
  if (!isEmpty(l)) s.l = l
  if (!isEmpty(shadow.n)) {
    const n = dict<Record<string, [number, number]>>()
    for (const [k, per] of Object.entries(shadow.n)) n[k] = { ...per }
    s.n = n
  }
  return s
}

// ---------------------------------------------------------------------------------------------
// Materialise
// ---------------------------------------------------------------------------------------------

function fromWire(spec: FieldSpec, key: string, v: Json, localEl: Row | undefined, ctx: MaterializeCtx): Row {
  const out: Row = { [spec.key!]: key, ...(v as Obj) }
  if (!spec.wire) return out
  const blob = out.blob as string | undefined
  delete out.blob
  delete out.mime
  if (blob === undefined) return out
  const lb = localEl?.blobId
  if (typeof lb === 'string' && lb && (blob === '' || lb === blob || ctx.blobHash?.(lb) === blob)) out.blobId = lb
  else out.blobId = blob === '' ? '' : (ctx.blobId?.(blob) ?? blob)
  return out
}

function materializeField(spec: FieldSpec, k: string, state: RecordDelta, local: Row | undefined, ctx: MaterializeCtx): { has: boolean; v?: unknown } {
  switch (spec.kind) {
    case 'lww': {
      const r = state.f?.[k]
      return r ? { has: true, v: r.length === 2 ? r[1] : undefined } : { has: false }
    }
    case 'flat': {
      const prefix = k + '.'
      let has = false
      const o: Row = {}
      for (const [rk, r] of Object.entries(state.f ?? {})) {
        if (!rk.startsWith(prefix)) continue
        has = true
        if (r.length === 2) o[rk.slice(prefix.length)] = r[1]
      }
      return has ? { has, v: isEmpty(o) ? undefined : o } : { has: false }
    }
    case 'max':
    case 'min': {
      const v = state.m?.[k]
      return v === undefined ? { has: false } : { has: true, v }
    }
    case 'pn': {
      const per = state.n?.[k]
      if (!per) return { has: false }
      let raw = 0
      for (const [inc, dec] of Object.values(per)) raw += inc - dec
      return { has: true, v: Math.max(0, raw) }
    }
    case 'list':
    case 'set':
    case 'map': {
      const ld = state.l?.[k]
      if (!ld) return { has: false }
      const alive = new Map<string, Hlc>()
      for (const [key, [, v, born]] of Object.entries(ld.e ?? {})) if (v !== null) alive.set(key, born)
      const keys = orderKeys(spec.kind === 'map' ? undefined : ld.o?.[1], alive)
      if (spec.kind === 'set') return { has: true, v: keys }
      if (spec.kind === 'map') {
        const o: Row = {}
        for (const key of keys) o[key] = ld.e![key][1]
        return { has: true, v: o }
      }
      const localList = Array.isArray(local?.[k]) ? (local[k] as unknown[]) : []
      const byKey = new Map<string, Row>()
      for (const x of localList) if (isPlainObject(x) && typeof x[spec.key!] === 'string') byKey.set(x[spec.key!] as string, x)
      return { has: true, v: keys.map((key) => fromWire(spec, key, ld.e![key][1] as Json, byKey.get(key), ctx)) }
    }
    default:
      return { has: false }
  }
}

function materializeObject(table: FieldTable, state: RecordDelta, local: Row | undefined, ctx: MaterializeCtx, skip: string): Row {
  const out: Row = {}
  // Local-only fields and unknown fields without a register are kept as they are.
  for (const [k, v] of Object.entries(local ?? {})) {
    if (k !== skip && (!own(table, k) || table[k].kind === 'local')) out[k] = v
  }
  for (const [k, spec] of Object.entries(table)) {
    if (spec.kind === 'const' || spec.kind === 'local') continue
    const r = materializeField(spec, k, state, local, ctx)
    if (r.has) {
      if (r.v === undefined) delete out[k]
      else out[k] = r.v
    } else if (local && own(local, k)) out[k] = local[k]
    else if (spec.dflt) out[k] = spec.dflt()
  }
  for (const [k, r] of Object.entries(state.f ?? {})) {
    if (own(table, k)) continue
    const dot = k.indexOf('.')
    if (dot > 0 && own(table, k.slice(0, dot))) continue // sub-register of a known flat field
    if (k === skip) continue
    if (r.length === 2) out[k] = r[1]
    else delete out[k]
  }
  return out
}

/**
 * State -> row. `null` means the row must not exist: a dead record, a record whose
 * creation (`a` register) hasn't arrived yet, or an annotation page with no alive item. `local` is the
 * current row, if any: it supplies local-only fields (layers `current`), local blob ids, and the value
 * of any field the state has no register for. Without it, required fields get their defaults.
 */
export function materialize<C extends Collection>(c: C, state: RecordDelta, local?: CollectionRows[C] | null, ctx: MaterializeCtx = {}): CollectionRows[C] | null {
  if (isDead(state) || (c !== 'ann' && !state.a)) return null
  const id = state.id
  const lrow = (local ?? undefined) as Row | undefined
  const { obj, table } = recordObject(c, id, lrow)
  const o = materializeObject(table, state, obj, ctx, c === 'kv' ? '' : 'id')
  let row: Row
  switch (c) {
    case 'ann': {
      const p = parseAnnId(id)
      if (!p) throw new Error(`bad annotation page id: ${id}`)
      if (!Array.isArray(o.items) || o.items.length === 0) return null
      row = { ...o, id, songId: p.songId, fileId: p.fileId, page: p.page }
      break
    }
    case 'kv': {
      if (kvShape(id)!.object) {
        if (table.current?.kind === 'local') {
          const layers = Array.isArray(o.layers) ? (o.layers as Row[]) : []
          if (!layers.some((x) => x.id === o.current)) o.current = layers[0]?.id ?? 'default'
        }
        row = { key: id, value: o }
      } else row = { key: id, value: o.value }
      break
    }
    default:
      row = { ...o, id }
  }
  return row as unknown as CollectionRows[C]
}

// ---------------------------------------------------------------------------------------------
// Engine steps as pure functions
// ---------------------------------------------------------------------------------------------

export type SyncCtx = ProjectCtx & MaterializeCtx

/**
 * One capture: diff the row (`null` = missing) against the shadow. Returns the op to
 * publish (if any) and the new shadow. `row` is set only when the local row must be rewritten: it holds
 * a max/min value that loses to the merged register (e.g. `modifiedAt` stamped by a clock that is
 * behind), which no op can publish; or it is an annotation page with no items left (`null`: delete
 * it). Write it back without recapturing (`markRemote`).
 */
export function captureRecord<C extends Collection>(
  c: C,
  row: CollectionRows[C] | null,
  shadow: ShadowRecord | undefined,
  hlc: Hlc,
  dev: string,
  ctx?: SyncCtx,
): { delta: RecordDelta | null; shadow: ShadowRecord | undefined; row?: CollectionRows[C] | null } {
  const proj = row ? project(c, row, ctx) : null
  const delta = diff(c, proj, shadow, hlc, dev)
  const base = shadow ? fromShadow(shadow, proj) : undefined
  const state = delta ? mergeDelta(base, delta) : base
  const out: { delta: RecordDelta | null; shadow: ShadowRecord | undefined; row?: CollectionRows[C] | null } = {
    delta,
    shadow: delta ? toShadow(state!) : shadow,
  }
  if (!proj) return out
  if (c === 'ann') {
    if (!proj.l.items?.keys.length) out.row = null // no alive item, no row
  } else if (state?.m) {
    for (const [k, v] of Object.entries(proj.m)) {
      if (state.m[k] !== undefined && state.m[k] !== v) {
        out.row = materialize(c, state, row, ctx)
        break
      }
    }
  }
  return out
}

/**
 * Apply one remote op to a row that has no uncaptured changes (capture it first).
 * Returns the new row (`null` = delete it; also for a record whose creation hasn't arrived) and shadow.
 */
export function applyRecord<C extends Collection>(
  c: C,
  row: CollectionRows[C] | null,
  shadow: ShadowRecord | undefined,
  op: RecordDelta,
  ctx?: SyncCtx,
): { row: CollectionRows[C] | null; shadow: ShadowRecord; state: RecordDelta } {
  const base = shadow ? fromShadow(shadow, row ? project(c, row, ctx) : null) : undefined
  const state = mergeDelta(base, op)
  return { row: isCollection(c) ? materialize(c, state, row, ctx) : null, shadow: toShadow(state), state }
}

// ---------------------------------------------------------------------------------------------
// Horizons
// ---------------------------------------------------------------------------------------------

/**
 * What a snapshot drops: `f` and `l` of dead records whose `a` hlc is older than
 * `horizon.deadFields`, and element tombstones older than `horizon.elementTombs` (both wall ms).
 * `a`, `m` and `n` stay: counters must keep their per-device totals or an undelete would double them.
 */
export function compact(state: RecordDelta, horizon: { deadFields: number; elementTombs: number }): RecordDelta {
  if (state.a && !state.a[1] && hlcWall(state.a[0]) < horizon.deadFields) {
    const { f: _f, l: _l, ...rest } = state
    return rest
  }
  if (!state.l) return state
  const l = dict<ListDelta>()
  for (const [k, ld] of Object.entries(state.l)) {
    const out: ListDelta = {}
    if (ld.o) out.o = ld.o
    const e = dict<[Hlc, Json | null, Hlc]>()
    for (const [key, r] of Object.entries(ld.e ?? {})) {
      if (r[1] === null && hlcWall(r[0]) < horizon.elementTombs) continue
      e[key] = r
    }
    if (!isEmpty(e)) out.e = e
    if (out.o || out.e) l[k] = out
  }
  const { l: _l, ...rest } = state
  return isEmpty(l) ? rest : { ...rest, l }
}

/**
 * Stale-device catch-up: after applying a snapshot newer than our `lastSync`, alive records and
 * elements born at or before `lastSync` that the snapshot doesn't mention were deleted (and their
 * tombstones discarded) while we were away. Returns the local state without them, or `null` when the
 * whole record must be deleted locally. Nothing here is published.
 */
export function dropStale(local: RecordDelta, snap: RecordDelta | undefined, lastSync: Hlc): RecordDelta | null {
  if (!snap) {
    if (local.a?.[1] && local.a[0] <= lastSync) return null
  }
  if (!local.l) return local
  const l = dict<ListDelta>()
  for (const [k, ld] of Object.entries(local.l)) {
    const se = snap?.l?.[k]?.e
    const e = dict<[Hlc, Json | null, Hlc]>()
    for (const [key, r] of Object.entries(ld.e ?? {})) {
      if (r[1] !== null && r[2] <= lastSync && !own(se, key)) continue
      e[key] = r
    }
    const out: ListDelta = {}
    if (ld.o) out.o = ld.o
    if (!isEmpty(e)) out.e = e
    if (out.o || out.e) l[k] = out
  }
  const { l: _l, ...rest } = local
  return isEmpty(l) ? rest : { ...rest, l }
}

// ---------------------------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------------------------

const DEV0 = '0'.repeat(16)
const H_BASE = formatHlc(1, 0, DEV0)
const H_EDIT = formatHlc(2, 0, DEV0)
/** Within one device blob ids are stable, so they can stand in for hashes. */
const IDENTITY_CTX: ProjectCtx = { blobHash: (id) => id, blobMime: () => '' }

/**
 * Apply the user's `base` → `edited` changes onto `latest` at register granularity (field, sub-field, element,
 * order, counter delta), so fields and elements the user didn't touch keep `latest`'s values. Where both
 * changed the same register, `edited` wins. Local-only fields come from `edited`.
 */
export function rebase<C extends Collection>(c: C, base: CollectionRows[C], edited: CollectionRows[C], latest: CollectionRows[C]): CollectionRows[C] {
  const id = rowId(c, latest)
  const withId = (r: CollectionRows[C]) => (c === 'kv' ? { ...r, key: id } : { ...r, id }) as CollectionRows[C]
  const full = (r: CollectionRows[C]) => diff(c, project(c, withId(r), IDENTITY_CTX), undefined, H_BASE, 'base')!
  const baseState = full(base)
  const latestState = full(latest)
  const changes = diff(c, project(c, withId(edited), IDENTITY_CTX), toShadow(baseState), H_EDIT, 'edit')
  if (!changes) return latest
  const out = materialize(c, mergeDelta(latestState, changes), latest, { blobId: (h) => h })
  // Only an annotation page can come out empty (every item erased); the row type has no "deleted".
  if (!out) return { ...latest, items: [] } as CollectionRows[C]
  if (c === 'kv') {
    const shape = kvShape(id)!
    const ev = (edited as unknown as Row).value
    if (shape.object && isPlainObject(ev)) {
      const v = (out as unknown as Row).value as Row
      for (const [k, spec] of Object.entries(shape.table)) if (spec.kind === 'local' && own(ev, k)) v[k] = ev[k]
    }
  }
  return out
}
