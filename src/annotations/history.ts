/**
 * Undo/redo for one annotation session. Each command records page snapshots before and after the
 * change; items are immutable, so snapshots share objects and cost one array per page.
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
  created: string[]
  deleted: string[]
  updated: string[]
}

export function diffItems(before: Annotation[], after: Annotation[]): ItemDiff {
  const b = new Map(before.map((i) => [i.id, i]))
  const a = new Map(after.map((i) => [i.id, i]))
  const d: ItemDiff = { created: [], deleted: [], updated: [] }
  for (const [id, it] of a) {
    const old = b.get(id)
    if (!old) d.created.push(id)
    else if (old !== it) d.updated.push(id)
  }
  for (const id of b.keys()) if (!a.has(id)) d.deleted.push(id)
  return d
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
