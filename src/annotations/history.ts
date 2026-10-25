/**
 * Undo/redo for one annotation session. Each command records page snapshots before and after the
 * change; items are immutable, so snapshots share objects and cost one array per page. Commands are
 * applied as item diffs (`applyChanges`), never by restoring whole arrays, so items that arrived from
 * another device in between are kept.
 */
import type { Annotation } from '../db/schema'

export interface PageChange {
  key: string
  before: Annotation[]
  after: Annotation[]
}

export type CommandKind = 'create' | 'delete' | 'update' | 'mixed'

export interface Command {
  label: string
  kind: CommandKind
  changes: PageChange[]
}

export interface ItemDiff {
  /** In `after` order. */
  created: string[]
  deleted: string[]
  updated: string[]
  /** New values of created and updated items. */
  values: Map<string, Annotation>
  /** `after`'s id order; present only when the relative order of kept items changed (z-order). */
  order?: string[]
}

const sameItem = (a: Annotation, b: Annotation) => a === b || JSON.stringify(a) === JSON.stringify(b)

export function diffItems(before: Annotation[], after: Annotation[]): ItemDiff {
  const b = new Map(before.map((i) => [i.id, i]))
  const a = new Map(after.map((i) => [i.id, i]))
  const d: ItemDiff = { created: [], deleted: [], updated: [], values: new Map() }
  for (const [id, it] of a) {
    const old = b.get(id)
    if (!old) d.created.push(id)
    else if (!sameItem(old, it)) d.updated.push(id)
    else continue
    d.values.set(id, it)
  }
  for (const id of b.keys()) if (!a.has(id)) d.deleted.push(id)
  const kept = (list: Annotation[], other: Map<string, Annotation>) => list.filter((i) => other.has(i.id)).map((i) => i.id)
  const kb = kept(before, a)
  const ka = kept(after, b)
  if (kb.some((id, i) => ka[i] !== id)) d.order = after.map((i) => i.id)
  return d
}

export const isEmptyDiff = (d: ItemDiff) => !d.created.length && !d.deleted.length && !d.updated.length && !d.order

/**
 * Apply a diff to (possibly different) current items, keeping their order: deleted items are dropped,
 * updated ones replaced in place, created ones appended in their relative order. An update to an item
 * that is gone (deleted elsewhere) is dropped. A z-order change re-sorts the items it names and keeps the
 * others right after their predecessor. Returns `items` itself when nothing changes.
 */
export function applyChanges(items: Annotation[], d: ItemDiff): Annotation[] {
  if (isEmptyDiff(d)) return items
  const del = new Set(d.deleted)
  let out: Annotation[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (del.has(it.id) || seen.has(it.id)) continue
    seen.add(it.id)
    out.push(d.values.get(it.id) ?? it)
  }
  for (const id of d.created) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(d.values.get(id)!)
  }
  if (d.order) {
    const rank = new Map(d.order.map((id, i) => [id, i]))
    let last = -1
    let sub = 0
    const keyed = out.map((it) => {
      const r = rank.get(it.id)
      if (r !== undefined) {
        last = r
        sub = 0
      }
      return { it, r: last, s: r !== undefined ? 0 : ++sub }
    })
    keyed.sort((x, y) => x.r - y.r || x.s - y.s)
    out = keyed.map((k) => k.it)
  }
  return out.length === items.length && out.every((it, i) => it === items[i]) ? items : out
}

export function commandKind(changes: PageChange[]): CommandKind {
  let c = 0
  let del = 0
  let u = 0
  for (const ch of changes) {
    const d = diffItems(ch.before, ch.after)
    c += d.created.length
    del += d.deleted.length
    u += d.updated.length
  }
  if (c && !del && !u) return 'create'
  if (del && !c && !u) return 'delete'
  if (u && !c && !del) return 'update'
  return 'mixed'
}

export function makeCommand(label: string, changes: PageChange[]): Command | null {
  const real = changes.filter((ch) => ch.before !== ch.after)
  if (!real.length) return null
  return { label, kind: commandKind(real), changes: real }
}

export class UndoStack {
  private undos: Command[] = []
  private redos: Command[] = []
  private limit: number
  constructor(limit = 300) {
    this.limit = limit
  }

  push(cmd: Command) {
    this.undos.push(cmd)
    if (this.undos.length > this.limit) this.undos.shift()
    this.redos = []
  }

  /** Pops the command to undo; apply each change's `before`. */
  undo(): Command | undefined {
    const c = this.undos.pop()
    if (c) this.redos.push(c)
    return c
  }

  /** Pops the command to redo; apply each change's `after`. */
  redo(): Command | undefined {
    const c = this.redos.pop()
    if (c) this.undos.push(c)
    return c
  }

  clear() {
    this.undos = []
    this.redos = []
  }

  get canUndo() {
    return this.undos.length > 0
  }
  get canRedo() {
    return this.redos.length > 0
  }
  get size() {
    return this.undos.length
  }
}
