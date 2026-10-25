/**
 * Per-collection field tables, the kv allow-list `syncedKv`, and op validation.
 *
 * Register naming in a `RecordDelta`:
 * - `lww`   → `f[field]`
 * - `flat`  → `f['field.sub']` (one level)
 * - `list` / `set` / `map` → `l[field]` (`set` element key = the string, value `true`)
 * - `max` / `min` → `m[field]`
 * - `pn`    → `n[field]`
 * - `const` / `local` → nothing (derived from the id / kept per device)
 * Fields missing from a table are `lww` (forward compatibility).
 */
import { GROUP_FIELDS } from '../db/schema'
import { isHlc } from './hlc'
import type { Collection, Json } from './model'

export type FieldKind = 'lww' | 'flat' | 'list' | 'map' | 'set' | 'max' | 'min' | 'pn' | 'const' | 'local'

/** Value validators. `json` accepts anything; `arr`/`obj` are refinements of it. */
export type ValidatorName = 'str' | 'num' | 'bool' | 'json' | 'arr' | 'obj'

export interface FieldSpec {
  kind: FieldKind
  /** `list`: the element property holding its key (stripped from the element value on the wire). */
  key?: string
  /** `list` element wire transform: blob ids travel as content hashes. */
  wire?: 'file' | 'audio'
  /** Validator of the `lww` value, or of each `list` / `map` element value. */
  v?: ValidatorName
  /** Value of a required field when there is neither a register nor a local row to take it from. */
  dflt?: () => unknown
}

export type FieldTable = Readonly<Record<string, FieldSpec>>

export const VALIDATORS: Record<ValidatorName, (v: unknown) => boolean> = {
  str: (v) => typeof v === 'string',
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  bool: (v) => typeof v === 'boolean',
  json: () => true,
  arr: (v) => Array.isArray(v),
  obj: (v) => isPlainObject(v),
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const LWW_STR: FieldSpec = { kind: 'lww', v: 'str' }
const lww = (v: ValidatorName, dflt?: () => unknown): FieldSpec => ({ kind: 'lww', v, dflt })
const list = (key: string, o: Partial<FieldSpec> = {}): FieldSpec => ({ kind: 'list', key, v: 'obj', ...o })
const SET: FieldSpec = { kind: 'set', dflt: () => [] }
const FLAT: FieldSpec = { kind: 'flat' }

/** Songs. */
export const SONG_FIELDS: FieldTable = {
  title: lww('str', () => ''),
  sortTitle: LWW_STR,
  rating: lww('num', () => 0),
  difficulty: lww('num', () => 0),
  duration: lww('num', () => 0),
  notes: lww('str', () => ''),
  keywords: lww('str', () => ''),
  sourcePage: lww('num'),
  songNumber: lww('num'),
  favorite: lww('bool', () => false),
  ...Object.fromEntries(GROUP_FIELDS.map((g) => [g, SET])),
  tempos: lww('arr'),
  files: list('id', { wire: 'file', dflt: () => [] }),
  pageOrder: lww('arr'),
  pageSettings: { kind: 'map', v: 'obj', dflt: () => ({}) },
  display: FLAT,
  text: FLAT,
  metronome: FLAT,
  autoScroll: FLAT,
  midiOnLoad: lww('arr', () => []),
  midiRecall: lww('obj'),
  bookmarks: list('id', { dflt: () => [] }),
  links: list('id', { dflt: () => [] }),
  smartButtons: list('id'),
  audio: list('id', { wire: 'audio', dflt: () => [] }),
  // No default for min registers: a default 0 would be published and win every min.
  createdAt: { kind: 'min' },
  modifiedAt: { kind: 'max', dflt: () => 0 },
  lastPlayedAt: { kind: 'max' },
  playCount: { kind: 'pn', dflt: () => 0 },
}

/** Setlists. */
export const SETLIST_FIELDS: FieldTable = {
  name: lww('str', () => ''),
  notes: lww('str', () => ''),
  date: LWW_STR,
  venue: LWW_STR,
  entries: list('key', { dflt: () => [] }),
  createdAt: { kind: 'min' },
  modifiedAt: { kind: 'max', dflt: () => 0 },
  lastPlayedAt: { kind: 'max' },
}

/** Annotation pages. The record is never tombstoned; the row goes away when no item is alive. */
export const ANN_FIELDS: FieldTable = {
  songId: { kind: 'const' },
  fileId: { kind: 'const' },
  page: { kind: 'const' },
  items: list('id', { dflt: () => [] }),
}

/** Kv `layers:<songId>`: fields of the `SongLayers` value. `current` stays per device. */
export const LAYERS_FIELDS: FieldTable = {
  layers: list('id', { dflt: () => [] }),
  current: { kind: 'local' },
}

interface KvRule {
  match: (key: string) => boolean
  /** `true`: the kv value itself is the record object (its properties are the fields). `false`: one field `value`. */
  object: boolean
  table: FieldTable
}

const KV_RULES: KvRule[] = [
  { match: (k) => k.startsWith('layers:') && k.length > 7, object: true, table: LAYERS_FIELDS },
  { match: (k) => k.startsWith('textLayout:') && k.length > 11, object: false, table: { value: { kind: 'lww' } } },
  { match: (k) => k === 'library:emptyCollections', object: false, table: { value: { kind: 'set', dflt: () => [] } } },
  { match: (k) => k === 'library:savedFilters', object: false, table: { value: list('name', { dflt: () => [] }) } },
  { match: (k) => k === 'library:recentClearedAt', object: false, table: { value: { kind: 'max', dflt: () => 0 } } },
]

const kvRule = (key: string) => KV_RULES.find((r) => r.match(key))

/** The kv allow-list. Anything not listed (e.g. `backup.*`) never syncs. */
export function syncedKv(key: string): boolean {
  return typeof key === 'string' && !!kvRule(key)
}

/** How a kv row maps to fields: `object` = the value's properties are the fields; else one field `value`. */
export function kvShape(key: string): { object: boolean; table: FieldTable } | null {
  const r = kvRule(key)
  return r ? { object: r.object, table: r.table } : null
}

const COLLECTIONS: readonly Collection[] = ['song', 'setlist', 'ann', 'kv']
export const isCollection = (c: unknown): c is Collection => COLLECTIONS.includes(c as Collection)

/** The field table of a record, or `null` for an unknown collection or a kv key that doesn't sync. */
export function fieldTable(c: Collection, id: string): FieldTable | null {
  switch (c) {
    case 'song':
      return SONG_FIELDS
    case 'setlist':
      return SETLIST_FIELDS
    case 'ann':
      return ANN_FIELDS
    case 'kv':
      return kvShape(id)?.table ?? null
    default:
      return null
  }
}

const LWW: FieldSpec = { kind: 'lww' }

/** Spec of one field; unknown fields (and unknown collections) are `lww`. */
export function fieldSpec(table: FieldTable | null, field: string): FieldSpec {
  return (table && Object.hasOwn(table, field) ? table[field] : undefined) ?? LWW
}

/** Max/min kind of an `m` register. Unknown fields default to `max`. */
export function numKind(table: FieldTable | null, field: string): 'max' | 'min' {
  return fieldSpec(table, field).kind === 'min' ? 'min' : 'max'
}

export const hasOrder = (k: FieldKind) => k === 'list' || k === 'set'
export const isKeyed = (k: FieldKind) => k === 'list' || k === 'set' || k === 'map'

/** `${songId}:${fileId}:${page}` */
export const annId = (songId: string, fileId: string, page: number) => `${songId}:${fileId}:${page}`

export function parseAnnId(id: string): { songId: string; fileId: string; page: number } | null {
  const a = id.indexOf(':')
  const b = id.lastIndexOf(':')
  if (a <= 0 || b <= a + 1) return null
  const page = Number(id.slice(b + 1))
  if (!Number.isInteger(page) || page < 0 || String(page) !== id.slice(b + 1)) return null
  return { songId: id.slice(0, a), fileId: id.slice(a + 1, b), page }
}

const isJson = (v: unknown, depth = 0): v is Json => {
  if (depth > 64) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1))
  if (isPlainObject(v)) return Object.values(v).every((x) => isJson(x, depth + 1))
  return false
}

const nonNeg = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0

/**
 * Validate one incoming op. Returns `null` when it may be merged, else the reason; the engine
 * skips and logs failing ops and never writes them. Unknown collections are checked structurally only
 * (the engine keeps them opaquely in `syncShadow.x`).
 */
export function validateDelta(d: unknown): string | null {
  if (!isPlainObject(d)) return 'op is not an object'
  const { c, id } = d
  if (typeof c !== 'string' || !c) return 'bad c'
  if (typeof id !== 'string' || !id) return 'bad id'
  const known = isCollection(c)
  if (c === 'kv' && !syncedKv(id)) return `kv key does not sync: ${id}`
  if (c === 'ann' && !parseAnnId(id)) return `bad annotation page id: ${id}`
  const table = known ? fieldTable(c, id) : null

  if (d.a !== undefined) {
    if (!Array.isArray(d.a) || d.a.length !== 2 || !isHlc(d.a[0]) || typeof d.a[1] !== 'boolean') return 'bad a'
  }
  if (d.f !== undefined) {
    if (!isPlainObject(d.f)) return 'bad f'
    for (const [k, r] of Object.entries(d.f)) {
      if (!Array.isArray(r) || (r.length !== 1 && r.length !== 2) || !isHlc(r[0])) return `bad f.${k}`
      if (r.length === 1) continue
      if (!isJson(r[1])) return `f.${k}: not JSON`
      if (!known) continue
      const dot = k.indexOf('.')
      if (dot > 0) {
        const head = k.slice(0, dot)
        if (Object.hasOwn(table ?? {}, head) && fieldSpec(table, head).kind !== 'flat') return `f.${k}: ${head} is not flat`
        continue
      }
      const spec = fieldSpec(table, k)
      if (spec.kind !== 'lww') return `f.${k}: field is ${spec.kind}`
      if (spec.v && !VALIDATORS[spec.v](r[1])) return `f.${k}: expected ${spec.v}`
    }
  }
  if (d.m !== undefined) {
    if (!isPlainObject(d.m)) return 'bad m'
    for (const [k, v] of Object.entries(d.m)) {
      if (!VALIDATORS.num(v)) return `m.${k}: expected num`
      if (known && Object.hasOwn(table ?? {}, k) && !['max', 'min'].includes(fieldSpec(table, k).kind)) return `m.${k}: not max/min`
    }
  }
  if (d.l !== undefined) {
    if (!isPlainObject(d.l)) return 'bad l'
    for (const [k, ld] of Object.entries(d.l)) {
      if (!isPlainObject(ld)) return `bad l.${k}`
      const spec = fieldSpec(table, k)
      const keyed = known && Object.hasOwn(table ?? {}, k)
      if (keyed && !isKeyed(spec.kind)) return `l.${k}: field is ${spec.kind}`
      if (ld.o !== undefined) {
        const o = ld.o
        if (!Array.isArray(o) || o.length !== 2 || !isHlc(o[0]) || !Array.isArray(o[1]) || !o[1].every((x) => typeof x === 'string')) return `bad l.${k}.o`
        if (keyed && spec.kind === 'map') return `l.${k}: a map has no order`
      }
      if (ld.e !== undefined) {
        if (!isPlainObject(ld.e)) return `bad l.${k}.e`
        for (const [ek, er] of Object.entries(ld.e)) {
          if (!ek) return `l.${k}: empty element key`
          if (!Array.isArray(er) || er.length !== 3 || !isHlc(er[0]) || !isHlc(er[2])) return `bad l.${k}.e.${ek}`
          const v = er[1]
          if (v === null) continue
          if (!isJson(v)) return `l.${k}.e.${ek}: not JSON`
          if (!keyed) continue
          if (spec.kind === 'set' && v !== true) return `l.${k}.e.${ek}: set element must be true`
          if (spec.kind !== 'set' && spec.v && !VALIDATORS[spec.v](v)) return `l.${k}.e.${ek}: expected ${spec.v}`
          if (spec.wire === 'file' && (typeof (v as Record<string, unknown>).blob !== 'string' || typeof (v as Record<string, unknown>).kind !== 'string')) return `l.${k}.e.${ek}: bad file ref`
        }
      }
    }
  }
  if (d.n !== undefined) {
    if (!isPlainObject(d.n)) return 'bad n'
    for (const [k, per] of Object.entries(d.n)) {
      if (!isPlainObject(per)) return `bad n.${k}`
      if (known && Object.hasOwn(table ?? {}, k) && fieldSpec(table, k).kind !== 'pn') return `n.${k}: not a counter`
      for (const [dev, r] of Object.entries(per)) {
        if (!Array.isArray(r) || r.length !== 2 || !nonNeg(r[0]) || !nonNeg(r[1])) return `bad n.${k}.${dev}`
      }
    }
  }
  return null
}
