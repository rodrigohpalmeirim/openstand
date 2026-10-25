/**
 * In-memory `StorageBackend` for tests. Instances created with the same `name` share one
 * store, like devices sharing a bucket, while fault injection and the call log stay per instance.
 *
 * It mimics S3 where behaviour matters: strong read-after-write, keys listed in order, `If-None-Match`
 * 412s, multipart parts that the "server" keeps before the client records them (so resume must ask the
 * store, like `ListParts`), and `notFound` for a vanished upload session.
 */
import { SINGLE_PUT_MAX } from '../model'
import {
  BackendError,
  GET_MAX,
  type BackendCaps,
  type BackendCheck,
  type BackendCheckStep,
  type ByteSource,
  type ListPage,
  type ObjectInfo,
  type StorageBackend,
  type UploadState,
} from './types'
import {
  DEFAULT_PART_HEAD,
  DEFAULT_PART_SIZE,
  partCount,
  partRange,
  resumableSession,
  tooLarge,
  type MultipartSession,
  type PartLayout,
} from './util'

interface StoredObject {
  data: Uint8Array
  etag: string
  lastModified: number
}

interface PendingUpload {
  key: string
  parts: Map<number, { data: Uint8Array; etag: string }>
}

interface Store {
  objects: Map<string, StoredObject>
  uploads: Map<string, PendingUpload>
  seq: number
}

const stores = new Map<string, Store>()

function storeFor(name: string): Store {
  let s = stores.get(name)
  if (!s) stores.set(name, (s = { objects: new Map(), uploads: new Map(), seq: 0 }))
  return s
}

export type MemoryOp =
  | 'list'
  | 'head'
  | 'get'
  | 'put'
  | 'delete'
  | 'uploadCreate'
  | 'uploadPart'
  | 'uploadList'
  | 'uploadComplete'
  | 'uploadAbort'

export interface MemoryFault {
  /** Ops to fail; omitted = every op. */
  op?: MemoryOp | MemoryOp[]
  /** Exact key, or a pattern. Omitted = any key. */
  key?: string | RegExp
  /** How many matching calls fail before the fault disarms (default 1; `Infinity` = until removed). */
  times?: number
  /** Thrown error (default `BackendError('network')`). */
  error?: Error | (() => Error)
  /** Fail after the op took effect (e.g. a PUT that landed but whose response was lost). Default: before. */
  after?: boolean
}

export interface MemoryBackendOptions {
  caps?: Partial<BackendCaps>
  /** Multipart layout (defaults to the S3 one). Tests use small values. */
  partSize?: number
  partHead?: number
  /** Largest list page (default 1000, like S3). */
  maxPage?: number
  /** Wall clock for `lastModified` / `createdAt`. */
  now?: () => number
  /** Awaited before every op (fault injection, latency, call-order checks). Throw to fail the op. */
  hook?: (op: MemoryOp, key: string) => void | Promise<void>
}

const etagOf = (data: Uint8Array, seq: number) => {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i += Math.max(1, data.length >> 12)) h = Math.imul(h ^ data[i], 0x01000193)
  return `"${(h >>> 0).toString(16)}-${data.length}-${seq}"`
}

export class MemoryBackend implements StorageBackend {
  readonly kind = 'memory' as const
  readonly label: string
  readonly name: string
  caps: BackendCaps
  /** Every op this instance ran, in order (successful or not). */
  readonly calls: { op: MemoryOp; key: string }[] = []
  hook?: MemoryBackendOptions['hook']
  private faults: (MemoryFault & { left: number })[] = []
  private readonly layout: PartLayout
  private readonly maxPage: number
  private readonly now: () => number
  private readonly id: string

  constructor(name = 'default', o: MemoryBackendOptions = {}) {
    this.name = name
    this.label = `Memory · ${name}`
    this.id = `memory:${name}`
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: SINGLE_PUT_MAX, ...o.caps }
    this.layout = { partSize: o.partSize ?? DEFAULT_PART_SIZE, head: o.partHead ?? DEFAULT_PART_HEAD }
    this.maxPage = o.maxPage ?? 1000
    this.now = o.now ?? Date.now
    this.hook = o.hook
  }

  /** Forgets the shared store `name` (all of them when omitted). */
  static reset(name?: string): void {
    if (name === undefined) stores.clear()
    else stores.delete(name)
  }

  private get store(): Store {
    return storeFor(this.name)
  }

  /** Arms a fault. Returns a function that disarms it. */
  fail(f: MemoryFault = {}): () => void {
    const armed = { ...f, left: f.times ?? 1 }
    this.faults.push(armed)
    return () => {
      this.faults = this.faults.filter((x) => x !== armed)
    }
  }

  /** Shorthand: fail the next `times` calls of `op` (on `key`, if given). */
  failNext(op: MemoryOp, o: Omit<MemoryFault, 'op'> = {}): () => void {
    return this.fail({ ...o, op })
  }

  /** Raw view of the stored objects (tests). */
  objects(): Map<string, Uint8Array> {
    return new Map([...this.store.objects].map(([k, v]) => [k, v.data]))
  }

  /** Open multipart sessions (tests). */
  pendingUploads(): number {
    return this.store.uploads.size
  }

  private match(op: MemoryOp, key: string, after: boolean): Error | null {
    for (const f of this.faults) {
      if (!!f.after !== after || f.left <= 0) continue
      if (f.op && !(Array.isArray(f.op) ? f.op.includes(op) : f.op === op)) continue
      if (f.key !== undefined && !(typeof f.key === 'string' ? f.key === key : f.key.test(key))) continue
      f.left--
      if (f.left <= 0) this.faults = this.faults.filter((x) => x !== f)
      const e = f.error
      return typeof e === 'function' ? e() : (e ?? new BackendError('network', `injected failure: ${op} ${key}`))
    }
    return null
  }

  private async run<T>(op: MemoryOp, key: string, signal: AbortSignal | undefined, fn: () => T): Promise<T> {
    signal?.throwIfAborted()
    this.calls.push({ op, key })
    await this.hook?.(op, key)
    // A microtask boundary, so concurrent callers interleave as they would over a network.
    await Promise.resolve()
    signal?.throwIfAborted()
    const before = this.match(op, key, false)
    if (before) throw before
    const out = fn()
    const after = this.match(op, key, true)
    if (after) throw after
    return out
  }

  async list(prefix: string, o: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ListPage> {
    return this.run('list', prefix, o.signal, () => {
      const limit = Math.max(1, Math.min(this.maxPage, o.limit ?? this.maxPage))
      const from = o.cursor ?? o.startAfter ?? ''
      const keys = [...this.store.objects.keys()].filter((k) => k.startsWith(prefix) && k > from).sort()
      const page = keys.slice(0, limit)
      const items = page.map((k) => this.info(k, this.store.objects.get(k)!))
      return keys.length > limit ? { items, cursor: page[page.length - 1] } : { items }
    })
  }

  private info(key: string, o: StoredObject): ObjectInfo {
    return { key, size: o.data.length, etag: o.etag, lastModified: o.lastModified }
  }

  async head(key: string, o: { signal?: AbortSignal } = {}): Promise<ObjectInfo | null> {
    return this.run('head', key, o.signal, () => {
      const obj = this.store.objects.get(key)
      return obj ? this.info(key, obj) : null
    })
  }

  async get(key: string, o: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number } = {}): Promise<Uint8Array | null> {
    return this.run('get', key, o.signal, () => {
      const obj = this.store.objects.get(key)
      if (!obj) return null
      if (!o.range) {
        const max = o.maxBytes ?? GET_MAX
        if (obj.data.length > max) throw tooLarge(key, max)
        return obj.data.slice()
      }
      const [s, e] = o.range
      if (!(Number.isInteger(s) && Number.isInteger(e) && 0 <= s && s <= e)) throw new BackendError('unknown', 'bad range')
      // Without range support, behave like a server that ignores Range: the whole object, if it fits.
      if (!this.caps.rangeGet) {
        if (obj.data.length > e - s + 1) throw tooLarge(key, e - s + 1, 'RangeIgnored', 200)
        return obj.data.slice(s, e + 1)
      }
      return obj.data.slice(s, e + 1)
    })
  }

  private write(key: string, data: Uint8Array) {
    const seq = ++this.store.seq
    this.store.objects.set(key, { data: data.slice(), etag: etagOf(data, seq), lastModified: this.now() })
  }

  async put(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    return this.run('put', key, o.signal, () => {
      if (o.ifNoneMatch && this.caps.conditionalPut && this.store.objects.has(key))
        throw new BackendError('precondition', `${key} already exists`, { status: 412, providerCode: 'PreconditionFailed' })
      this.write(key, body)
    })
  }

  async delete(key: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    return this.run('delete', key, o.signal, () => {
      this.store.objects.delete(key)
    })
  }

  async upload(
    key: string,
    src: ByteSource,
    o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    const { signal } = o
    if (src.size <= this.caps.maxSmallPut) {
      signal?.throwIfAborted()
      await this.put(key, await src.read(0, src.size), { signal })
      o.onProgress?.(src.size)
      return
    }
    const l = this.layout
    let session = resumableSession(o.state, this.id, key, src.size, l)
    let server: Map<number, { data: Uint8Array; etag: string }> | null = null
    if (session) {
      const id = session.uploadId
      server = await this.run('uploadList', key, signal, () => {
        const up = this.store.uploads.get(id)
        return up && up.key === key ? up.parts : null
      })
      if (!server) {
        // Session gone (aborted, expired or already completed). If the object is complete, we're done.
        const done = await this.head(key, { signal })
        if (done && done.size === src.size) {
          o.onProgress?.(src.size)
          return
        }
        session = null
      }
    }
    let state: UploadState
    if (!session || !server) {
      const uploadId = await this.run('uploadCreate', key, signal, () => {
        const id = `up${++this.store.seq}`
        this.store.uploads.set(id, { key, parts: new Map() })
        return id
      })
      server = this.store.uploads.get(uploadId)!.parts
      session = { uploadId, partSize: l.partSize, head: l.head, parts: [] }
      state = { v: 1, backend: this.id, key, size: src.size, createdAt: this.now(), done: 0, session }
      await o.onState?.(structuredClone(state))
    } else {
      state = { ...o.state!, session }
    }
    const sess: MultipartSession = session
    const n = partCount(src.size, l)
    const done = new Map<number, string>()
    let bytes = 0
    for (let i = 1; i <= n; i++) {
      const [s, e] = partRange(i, src.size, l)
      const have = server.get(i)
      if (have && have.data.length === e - s) {
        done.set(i, have.etag)
        bytes += e - s
      }
    }
    for (let i = 1; i <= n; i++) {
      if (done.has(i)) continue
      signal?.throwIfAborted()
      const [s, e] = partRange(i, src.size, l)
      const data = await src.read(s, e)
      if (data.length !== e - s) throw new Error('ByteSource returned a short read')
      const id = sess.uploadId
      const etag = await this.run('uploadPart', key, signal, () => {
        const up = this.store.uploads.get(id)
        if (!up) throw new BackendError('notFound', 'NoSuchUpload', { status: 404, providerCode: 'NoSuchUpload' })
        const tag = etagOf(data, ++this.store.seq)
        up.parts.set(i, { data: data.slice(), etag: tag })
        return tag
      })
      done.set(i, etag)
      bytes += e - s
      sess.parts = [...done].sort((a, b) => a[0] - b[0]).map(([pn, et]) => ({ n: pn, etag: et }))
      state = { ...state, done: bytes, session: sess }
      await o.onState?.(structuredClone(state))
      o.onProgress?.(bytes)
    }
    const id = sess.uploadId
    await this.run('uploadComplete', key, signal, () => {
      const up = this.store.uploads.get(id)
      if (!up) throw new BackendError('notFound', 'NoSuchUpload', { status: 404, providerCode: 'NoSuchUpload' })
      const parts: Uint8Array[] = []
      for (let i = 1; i <= n; i++) {
        const p = up.parts.get(i)
        if (!p || p.etag !== done.get(i)) throw new BackendError('unknown', `InvalidPart ${i}`, { status: 400, providerCode: 'InvalidPart' })
        parts.push(p.data)
      }
      const all = new Uint8Array(src.size)
      let off = 0
      for (const p of parts) {
        all.set(p, off)
        off += p.length
      }
      this.write(key, all)
      this.store.uploads.delete(id)
    })
  }

  async abortUpload(state: UploadState, o: { signal?: AbortSignal } = {}): Promise<void> {
    const s = state.session as Partial<MultipartSession> | null
    if (!s || typeof s.uploadId !== 'string') return
    const id = s.uploadId
    await this.run('uploadAbort', state.key, o.signal, () => {
      this.store.uploads.delete(id)
    })
  }

  async check(): Promise<BackendCheck> {
    const steps: BackendCheckStep[] = []
    const key = `os1/.check-${Math.random().toString(36).slice(2, 10)}`
    const step = async (id: BackendCheckStep['id'], fn: () => Promise<boolean | string>) => {
      try {
        const r = await fn()
        steps.push(r === true ? { id, ok: true } : { id, ok: false, detail: r || undefined })
        return r === true
      } catch (e) {
        const err = e instanceof BackendError ? e : new BackendError('unknown', String(e), { cause: e })
        steps.push({ id, ok: false, detail: err.message })
        throw err
      }
    }
    try {
      await step('list', async () => {
        await this.list('os1/', { limit: 1 })
        return true
      })
      await step('write', async () => {
        await this.put(key, new Uint8Array([111, 107]))
        return true
      })
      await step('read', async () => (await this.get(key))?.length === 2 || 'read back mismatch')
      await step('range', async () => (await this.get(key, { range: [0, 0] }))?.length === 1 || 'range ignored')
      await step('etag', async () => !!(await this.head(key))?.etag || 'no ETag')
      await step('conditional', async () => {
        try {
          await this.put(key, new Uint8Array([1]), { ifNoneMatch: true })
          this.caps.conditionalPut = false
        } catch (e) {
          if (!(e instanceof BackendError && e.code === 'precondition')) throw e
          this.caps.conditionalPut = true
        }
        return true
      })
      await step('delete', async () => {
        await this.delete(key)
        return true
      })
      return { ok: steps.every((s) => s.ok), steps }
    } catch (e) {
      return { ok: false, steps, error: e as BackendError }
    }
  }
}
