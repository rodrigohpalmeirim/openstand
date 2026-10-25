/**
 * Google Drive v3, flat layout in the visible OpenStand folder (docs/SYNC-DRIVES.md §4.3).
 *
 * Every key is one file directly in `config.folder`, named with the full key, with private `appProperties`
 * `os: '1'` and `d1..d3` (the key's first 1–3 folder segments, `keymap.dirProps`), so listing a prefix is
 * one exact-match query. Drive allows duplicate names: the **canonical** file of a key is the earliest
 * `createdTime`, ties going to the lowest id. Reads use only it; every create is followed by a dedupe that
 * deletes our own copy if it lost (and throws `precondition` for `ifNoneMatch`); overwrites update the
 * canonical file in place; `delete` removes every copy. Conditional creates are therefore emulated, not
 * atomic (§4.3 "Duplicates").
 *
 * A key → file cache (filled by our own writes and by `list`) lets our own reads skip the name query, so
 * they never wait for Drive's search index. A cached id that 404s is dropped and resolved again.
 *
 * Never log or put in errors: tokens, upload session URIs.
 */
import { OAuthHttp, JSON_MAX } from './http'
import { dirProps, prefixScope, segments } from './keymap'
import { parseRetryAfter, readBody } from './s3'
import {
  BackendError,
  GET_MAX,
  type BackendCaps,
  type BackendCheck,
  type BackendCheckStep,
  type BackendContext,
  type BackendDescription,
  type ByteSource,
  type GDriveConfig,
  type ListPage,
  type ObjectInfo,
  type StorageBackend,
  type UploadState,
} from './types'
import { LIST_MAX_KEYS, tooLarge } from './util'

const KiB = 1024
const MiB = 1024 * KiB
const NAME = 'Google Drive'

export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** Fields read everywhere; the etag is `version`. */
const FIELDS = 'id,name,size,version,createdTime,modifiedTime'
/** Resumable chunks are multiples of this, except the last. */
export const CHUNK_UNIT = 256 * KiB
/** `uploadType=multipart` is for bodies of 5 MB or less ([uploads]); larger `put`s use a one-chunk resumable session. */
const MULTIPART_MAX = 5_000_000
const ROOT_DESCRIPTION = 'OpenStand library sync. End-to-end encrypted; please don’t edit these files.'

export interface GDriveOptions {
  /** Resumable chunk, a multiple of 256 KiB (default 8 MiB). */
  chunk?: number
  /** Largest single-request upload (default 5 MiB). */
  maxSmallPut?: number
  /** Largest `uploadType=multipart` body (default 5 MB); tests lower it to cover one-chunk resumable puts. */
  multipartMax?: number
}

/** What we read of a Drive file. Drive sends int64 fields (`size`, `version`) as strings. */
interface DriveFile {
  id: string
  name: string
  size?: string
  version?: string
  createdTime?: string
  modifiedTime?: string
  trashed?: boolean
}

/** `UploadState.session` for Drive. `create`: the session creates a new file (dedupe afterwards). */
interface DriveSession {
  uri: string
  chunk: number
  create: boolean
}

// ---------------------------------------------------------------------------------------------
// Errors (§4.3 table)
// ---------------------------------------------------------------------------------------------

const REAUTH = new Set(['insufficientPermissions', 'insufficientScopes', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'authError'])
const RATE = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'RATE_LIMIT_EXCEEDED', 'dailyLimitExceeded'])
const QUOTA = new Set(['storageQuotaExceeded', 'quotaExceeded'])

/** The `reason`s of a Drive error body (`error.errors[].reason`, `error.details[].reason`). */
function reasons(body: string): string[] {
  try {
    const e = (JSON.parse(body) as { error?: { errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] } }).error
    return [...(e?.errors ?? []), ...(e?.details ?? [])].map((x) => x?.reason).filter((r): r is string => typeof r === 'string')
  } catch {
    return []
  }
}

/** Maps a Drive error answer to a `BackendError`. Messages carry the status and the provider code only. */
export function gdriveError(res: Response, body: string): BackendError {
  const status = res.status
  const rs = reasons(body)
  const reason = rs.find((r) => REAUTH.has(r) || RATE.has(r) || QUOTA.has(r)) ?? rs[0]
  const o = { status, providerCode: reason }
  const msg = `${NAME} answered ${status}${reason ? ` (${reason})` : ''}`
  if (status === 401 || rs.some((r) => REAUTH.has(r))) return new BackendError('reauth', msg, o)
  if (status === 429 || rs.some((r) => RATE.has(r)))
    // Drive doesn't expose Retry-After to scripts [probe]; use it if a proxy or a future API makes it readable.
    return new BackendError('rateLimited', msg, { ...o, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) })
  if (rs.some((r) => QUOTA.has(r))) return new BackendError('quota', msg, o)
  if (status === 403) return new BackendError('forbidden', msg, o)
  if (status === 404) return new BackendError('notFound', msg, o)
  if (status === 412) return new BackendError('precondition', msg, o)
  if (status === 503 && res.headers.get('retry-after'))
    return new BackendError('rateLimited', msg, { ...o, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) })
  if (status >= 500) return new BackendError('server', msg, o)
  return new BackendError('unknown', msg, o)
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Escapes a value for a single-quoted `q` string. */
export const qstr = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const time = (s?: string) => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : Infinity
}

/** Canonical first: earliest `createdTime`, then the lowest id. */
export function canonicalOrder(a: { id: string; createdTime?: string }, b: { id: string; createdTime?: string }): number {
  const d = time(a.createdTime) - time(b.createdTime)
  if (d !== 0 && Number.isFinite(d)) return d < 0 ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const dec = new TextDecoder()
const enc = new TextEncoder()

async function readJson<T>(res: Response): Promise<T> {
  const bytes = await readBody(res, JSON_MAX, () => new BackendError('unknown', `${NAME} sent an answer larger than ${JSON_MAX} bytes`, { providerCode: 'TooLarge', status: res.status }))
  try {
    return JSON.parse(dec.decode(bytes)) as T
  } catch {
    throw new BackendError('unknown', `${NAME} sent an answer that isn't JSON`, { providerCode: 'BadJson', status: res.status })
  }
}

const drain = (res: Response) => res.body?.cancel().catch(() => {})

const isCode = (e: unknown, code: BackendError['code']) => e instanceof BackendError && e.code === code

/** `Range: bytes=0-N` of a 308 → N + 1; none → 0. */
function nextOffset(res: Response): number {
  const m = /^bytes=0-(\d+)$/.exec(res.headers.get('range')?.trim() ?? '')
  return m ? Number(m[1]) + 1 : 0
}

const asBody = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>

function listUrl(q: string, fields: string, pageToken?: string): string {
  const p = new URLSearchParams({ q, fields, pageSize: '1000', spaces: 'drive' })
  if (pageToken) p.set('pageToken', pageToken)
  return `${DRIVE_API}/files?${p}`
}

/** Every file matching `q`, following `pageToken`, bounded by `max`. */
async function queryAll(http: OAuthHttp, q: string, fields: string, o: { signal?: AbortSignal; max?: number } = {}): Promise<DriveFile[]> {
  const max = o.max ?? LIST_MAX_KEYS
  const out: DriveFile[] = []
  const seen = new Set<string>()
  let token: string | undefined
  do {
    const page = await http.json<{ files?: DriveFile[]; nextPageToken?: string } | null>(listUrl(q, `nextPageToken,files(${fields})`, token), { signal: o.signal })
    const files = page?.files ?? []
    if (out.length + files.length > max) throw new BackendError('unknown', `More than ${max} objects in ${NAME}`, { providerCode: 'TooManyKeys' })
    out.push(...files)
    token = page?.nextPageToken || undefined
    if (token !== undefined) {
      if (seen.has(token)) throw new BackendError('unknown', `The ${NAME} listing doesn't advance`, { providerCode: 'ListLoop' })
      seen.add(token)
    }
  } while (token)
  return out
}

const httpFor = (ctx: BackendContext) => new OAuthHttp(ctx, { mapError: gdriveError, label: NAME })

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

/** Most cached key → file entries before the cache starts over (it is only an optimisation). */
const CACHE_MAX = 100_000

export class GDriveBackend implements StorageBackend {
  readonly kind = 'gdrive' as const
  readonly label: string
  caps: BackendCaps
  /** `UploadState.backend`: sessions only resume for the same account and folder. */
  readonly id: string
  protected readonly cfg: GDriveConfig
  protected readonly ctx: BackendContext
  protected readonly opts: GDriveOptions
  private readonly http: OAuthHttp
  private readonly now: () => number
  private readonly chunk: number
  private readonly multipartMax: number
  /** key → its canonical file, as last seen by us. */
  private readonly cache = new Map<string, DriveFile>()

  constructor(cfg: GDriveConfig, ctx: BackendContext = {}, opts: GDriveOptions = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.opts = opts
    this.label = cfg.account ? `${NAME} · ${cfg.account}` : NAME
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: opts.maxSmallPut ?? 5 * MiB }
    this.id = `gdrive:${cfg.accountId ?? ''}:${cfg.folder}`
    this.http = httpFor(ctx)
    this.now = ctx.now ?? Date.now
    const chunk = opts.chunk ?? 8 * MiB
    if (!(chunk > 0 && chunk % CHUNK_UNIT === 0)) throw new BackendError('unknown', 'The Drive upload chunk must be a multiple of 256 KiB')
    this.chunk = chunk
    this.multipartMax = opts.multipartMax ?? MULTIPART_MAX
  }

  private get folder(): string {
    if (!this.cfg.folder) throw new BackendError('notFound', `No ${NAME} folder is configured`, { providerCode: 'FolderGone' })
    return this.cfg.folder
  }

  private remember(key: string, f: DriveFile): void {
    if (this.cache.size >= CACHE_MAX && !this.cache.has(key)) this.cache.clear()
    this.cache.set(key, f)
  }

  private forget(key: string, id?: string): void {
    if (id === undefined || this.cache.get(key)?.id === id) this.cache.delete(key)
  }

  private info(f: DriveFile): ObjectInfo {
    const out: ObjectInfo = { key: f.name, size: Number(f.size ?? 0) }
    if (f.version) out.etag = f.version
    const lm = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN
    if (Number.isFinite(lm)) out.lastModified = lm
    return out
  }

  /** Every live file named `key`, canonical first (a fresh query: subject to index lag). */
  private async copies(key: string, signal?: AbortSignal): Promise<DriveFile[]> {
    const q = `${qstr(this.folder)} in parents and name = ${qstr(key)} and trashed = false`
    const files = await queryAll(this.http, q, FIELDS, { signal, max: 10_000 })
    return files.filter((f) => f.name === key).sort(canonicalOrder)
  }

  /** The canonical file of `key`: the cache, else a name query (filling the cache). */
  private async resolve(key: string, signal?: AbortSignal): Promise<DriveFile | null> {
    const c = this.cache.get(key)
    if (c) return c
    const [f] = await this.copies(key, signal)
    if (f) this.remember(key, f)
    return f ?? null
  }

  async list(prefix: string, o: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ListPage> {
    // `limit` is a hint and `cursor` never issued: the whole listing is one page (§3 "Listing").
    const { folder, depth } = prefixScope(prefix)
    const scope = depth >= 1 ? `appProperties has { key='d${depth}' and value=${qstr(folder.join('/'))} }` : `appProperties has { key='os' and value='1' }`
    const files = await queryAll(this.http, `${qstr(this.folder)} in parents and ${scope} and trashed = false`, FIELDS, { signal: o.signal })
    const best = new Map<string, DriveFile>()
    for (const f of files) {
      if (typeof f.name !== 'string' || !f.name.startsWith(prefix)) continue
      const cur = best.get(f.name)
      if (!cur || canonicalOrder(f, cur) < 0) best.set(f.name, f)
    }
    const items: ObjectInfo[] = []
    for (const [key, f] of best) {
      this.remember(key, f)
      if (o.startAfter === undefined || key > o.startAfter) items.push(this.info(f))
    }
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return { items }
  }

  async head(key: string, o: { signal?: AbortSignal } = {}): Promise<ObjectInfo | null> {
    segments(key)
    const c = this.cache.get(key)
    if (c) {
      // Fresh metadata by id: one request, and no index lag.
      const res = await this.http.send(`${DRIVE_API}/files/${encodeURIComponent(c.id)}?fields=${FIELDS},trashed`, { signal: o.signal, expect: [404] })
      if (res.status !== 404) {
        const f = await readJson<DriveFile>(res)
        if (!f.trashed && f.name === key) {
          this.remember(key, f)
          return this.info(f)
        }
      } else await drain(res)
      this.forget(key, c.id)
    }
    const f = await this.resolve(key, o.signal)
    return f ? this.info(f) : null
  }

  async get(key: string, o: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number } = {}): Promise<Uint8Array | null> {
    segments(key)
    const r = o.range
    if (r && !(Number.isInteger(r[0]) && Number.isInteger(r[1]) && 0 <= r[0] && r[0] <= r[1])) throw new BackendError('unknown', 'bad range')
    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = this.cache.has(key)
      const f = await this.resolve(key, o.signal)
      if (!f) return null
      const res = await this.http.send(`${DRIVE_API}/files/${encodeURIComponent(f.id)}?alt=media`, {
        signal: o.signal,
        headers: r ? { range: `bytes=${r[0]}-${r[1]}` } : undefined,
        expect: [404, 416],
      })
      if (res.status === 404) {
        // Deleted elsewhere (or a stale index entry): resolve once more if the id came from the cache.
        await drain(res)
        this.forget(key, f.id)
        if (cached) continue
        return null
      }
      if (res.status === 416) {
        await drain(res)
        return new Uint8Array(0)
      }
      if (!r) {
        const max = o.maxBytes ?? GET_MAX
        return readBody(res, max, () => tooLarge(key, max, 'TooLarge', res.status))
      }
      const len = r[1] - r[0] + 1
      const data = await readBody(res, len, () => tooLarge(key, len, res.status === 200 ? 'RangeIgnored' : 'TooLarge', res.status))
      return res.status === 200 ? data.slice(r[0], r[1] + 1) : data
    }
    return null
  }

  private newMetadata(key: string) {
    return { name: key, parents: [this.folder], mimeType: 'application/octet-stream', appProperties: { os: '1', ...dirProps(key) } }
  }

  /** Maps a 404 while writing into the folder to `FolderGone`. */
  private folderGone(e: unknown): unknown {
    if (isCode(e, 'notFound')) return new BackendError('notFound', `The ${NAME} folder is gone`, { status: 404, providerCode: 'FolderGone', cause: e })
    return e
  }

  /** Creates a new file named `key` (no dedupe). */
  private async create(key: string, body: Uint8Array, signal?: AbortSignal): Promise<DriveFile> {
    try {
      if (body.length > this.multipartMax) return await this.oneShot(key, null, body, signal)
      const boundary = 'openstand-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
      const head = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(this.newMetadata(key))}\r\n` +
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      )
      const tail = enc.encode(`\r\n--${boundary}--`)
      const all = new Uint8Array(head.length + body.length + tail.length)
      all.set(head, 0)
      all.set(body, head.length)
      all.set(tail, head.length + body.length)
      return await this.http.json<DriveFile>(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body: asBody(all),
        signal,
      })
    } catch (e) {
      throw this.folderGone(e)
    }
  }

  /** Replaces the content of file `id` in place. */
  private async update(key: string, id: string, body: Uint8Array, signal?: AbortSignal): Promise<DriveFile> {
    if (body.length > this.multipartMax) return this.oneShot(key, id, body, signal)
    return this.http.json<DriveFile>(`${DRIVE_UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=${FIELDS}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/octet-stream' },
      body: asBody(body),
      signal,
    })
  }

  /** A body above the multipart limit: a resumable session sent as one chunk. */
  private async oneShot(key: string, id: string | null, body: Uint8Array, signal?: AbortSignal): Promise<DriveFile> {
    const uri = await this.initiate(key, id, body.length, signal)
    const src: ByteSource = { size: body.length, read: async (s, e) => body.subarray(s, e) }
    return this.sendChunks(uri, src, 0, Number.MAX_SAFE_INTEGER, key, { signal })
  }

  /**
   * After creating `ours`: if a copy that sorts before it exists, delete ours (and for `ifNoneMatch`
   * throw `precondition`). The winner leaves the others alone: each writer deletes only its own copy.
   */
  private async dedupe(key: string, ours: DriveFile, ifNoneMatch: boolean, signal?: AbortSignal): Promise<void> {
    const all = await this.copies(key, signal)
    const cands = all.some((f) => f.id === ours.id) ? all : [...all, ours].sort(canonicalOrder)
    const winner = cands[0]
    if (winner.id === ours.id) {
      this.remember(key, ours)
      return
    }
    await this.deleteId(ours.id, signal)
    this.remember(key, winner)
    if (ifNoneMatch) throw new BackendError('precondition', `${key} already exists in ${NAME}`, { providerCode: 'Duplicate' })
  }

  async put(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    segments(key)
    const { signal } = o
    for (let attempt = 0; ; attempt++) {
      const f = await this.resolve(key, signal)
      if (f && o.ifNoneMatch) throw new BackendError('precondition', `${key} already exists in ${NAME}`, { status: 412, providerCode: 'Exists' })
      if (f) {
        try {
          this.remember(key, await this.update(key, f.id, body, signal))
          return
        } catch (e) {
          // Deleted elsewhere since we resolved it: resolve again (once).
          if (attempt === 0 && isCode(e, 'notFound')) {
            this.forget(key, f.id)
            continue
          }
          throw e
        }
      }
      await this.dedupe(key, await this.create(key, body, signal), !!o.ifNoneMatch, signal)
      return
    }
  }

  private async deleteId(id: string, signal?: AbortSignal): Promise<void> {
    const res = await this.http.send(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: 'DELETE', signal, expect: [404] })
    await drain(res)
  }

  async delete(key: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    segments(key)
    const ids = new Set((await this.copies(key, o.signal)).map((f) => f.id))
    // Our own recent write may not be indexed yet.
    const c = this.cache.get(key)
    if (c) ids.add(c.id)
    this.forget(key)
    for (const id of ids) await this.deleteId(id, o.signal)
  }

  // --- resumable uploads -----------------------------------------------------------------------

  /** Starts a session (create, or update `id` in place); returns its URI. */
  private async initiate(key: string, id: string | null, size: number, signal?: AbortSignal): Promise<string> {
    const url = id ? `${DRIVE_UPLOAD}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=${FIELDS}` : `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`
    let res: Response
    try {
      res = await this.http.send(url, {
        method: id ? 'PATCH' : 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/octet-stream',
          'x-upload-content-length': String(size),
        },
        body: JSON.stringify(id ? {} : this.newMetadata(key)),
        signal,
      })
    } catch (e) {
      throw id ? e : this.folderGone(e)
    }
    await drain(res)
    const loc = res.headers.get('location')
    const uploadId = res.headers.get('x-guploader-uploadid')
    // Without a readable Location (CORS), the session URI is the initiation URL plus `upload_id` [probe].
    const uri = loc || (uploadId ? `${url}&upload_id=${encodeURIComponent(uploadId)}` : null)
    if (!uri || !uri.startsWith(DRIVE_UPLOAD + '/files'))
      throw new BackendError('cors', `${NAME} didn't return a readable upload session for ${key}`, { providerCode: 'NoUploadSession' })
    return uri
  }

  /** A new session for `key`: updates the canonical file in place if there is one, else creates. */
  private async startSession(key: string, size: number, signal?: AbortSignal): Promise<DriveSession> {
    for (let attempt = 0; ; attempt++) {
      const f = await this.resolve(key, signal)
      try {
        return { uri: await this.initiate(key, f?.id ?? null, size, signal), chunk: this.chunk, create: !f }
      } catch (e) {
        if (f && attempt === 0 && isCode(e, 'notFound')) {
          this.forget(key, f.id)
          continue
        }
        throw e
      }
    }
  }

  /** The session in `state` if it belongs to this backend, key and size; otherwise `null`. */
  private resumable(state: UploadState | undefined, key: string, size: number): DriveSession | null {
    if (!state || state.v !== 1 || state.backend !== this.id || state.key !== key || state.size !== size) return null
    const s = state.session as Partial<DriveSession> | null
    if (!s || typeof s !== 'object' || typeof s.uri !== 'string' || typeof s.create !== 'boolean') return null
    // Our bearer token goes to this URI: only ever to Drive's upload endpoint.
    if (!s.uri.startsWith(DRIVE_UPLOAD + '/files')) return null
    return { uri: s.uri, chunk: this.chunk, create: s.create }
  }

  /** Asks a session where it stands: the next offset, the finished file, or `null` when it is gone. */
  private async status(uri: string, size: number, signal?: AbortSignal): Promise<{ next: number } | { file: DriveFile } | null> {
    let res: Response
    try {
      res = await this.http.send(uri, { method: 'PUT', headers: { 'content-range': `bytes */${size}` }, body: asBody(new Uint8Array(0)), signal, expect: [308, 404, 410] })
    } catch (e) {
      // Any other 4xx means the session is unusable: start again (§4.3).
      if (e instanceof BackendError && e.status !== undefined && e.status >= 400 && e.status < 500 && !['reauth', 'rateLimited', 'quota'].includes(e.code)) return null
      throw e
    }
    if (res.status === 404 || res.status === 410) {
      await drain(res)
      return null
    }
    if (res.status === 308) {
      await drain(res)
      return { next: nextOffset(res) }
    }
    return { file: await readJson<DriveFile>(res) }
  }

  /** Sends `[from, size)` in chunks; `onAck(next)` after each acknowledged chunk. Returns the file. */
  private async sendChunks(
    uri: string,
    src: ByteSource,
    from: number,
    chunk: number,
    key: string,
    o: { signal?: AbortSignal; onAck?: (next: number) => Promise<void> },
  ): Promise<DriveFile> {
    const size = src.size
    let off = from
    while (off < size) {
      o.signal?.throwIfAborted()
      const end = Math.min(size, off + chunk)
      const body = await src.read(off, end)
      if (body.length !== end - off) throw new Error('ByteSource returned a short read')
      const res = await this.http.send(uri, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${off}-${end - 1}/${size}` },
        body: asBody(body),
        signal: o.signal,
        expect: [308],
      })
      if (res.status !== 308) return readJson<DriveFile>(res)
      await drain(res)
      const next = nextOffset(res)
      // The server keeps what it keeps; its offset wins. No progress at all would loop forever.
      if (next <= off || next > size) throw new BackendError('server', `${NAME} stopped accepting the upload of ${key}`, { providerCode: 'UploadStalled' })
      off = next
      await o.onAck?.(off)
    }
    // Everything is acknowledged but no file came back: ask the session.
    const s = await this.status(uri, size, o.signal)
    if (s && 'file' in s) return s.file
    throw new BackendError('server', `${NAME} didn't finish the upload of ${key}`, { providerCode: 'UploadStalled' })
  }

  async upload(
    key: string,
    src: ByteSource,
    o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    segments(key)
    const { signal } = o
    const size = src.size
    if (size <= this.caps.maxSmallPut) {
      signal?.throwIfAborted()
      await this.put(key, await src.read(0, size), { signal })
      o.onProgress?.(size)
      return
    }
    let session = this.resumable(o.state, key, size)
    let next = 0
    let state: UploadState | undefined
    if (session) {
      const s = await this.status(session.uri, size, signal)
      if (s && 'file' in s) {
        // Completed before a crash: nothing to read.
        if (session.create) await this.dedupe(key, s.file, false, signal)
        else this.remember(key, s.file)
        o.onProgress?.(size)
        return
      }
      if (s) {
        next = s.next
        state = { ...o.state!, done: next, session: { ...session } }
      } else session = null
    }
    for (let restarts = 0; ; restarts++) {
      if (!session || !state) {
        session = await this.startSession(key, size, signal)
        next = 0
        state = { v: 1, backend: this.id, key, size, createdAt: this.now(), done: 0, session: { ...session } }
        // Persist the live session before the first read (§3 "Uploads").
        await o.onState?.(structuredClone(state))
      }
      if (next) o.onProgress?.(next)
      const sess: DriveSession = session
      let file: DriveFile
      try {
        file = await this.sendChunks(sess.uri, src, next, this.chunk, key, {
          signal,
          onAck: async (n) => {
            state = { ...state!, done: n }
            await o.onState?.(structuredClone(state))
            o.onProgress?.(n)
          },
        })
      } catch (e) {
        // A lost session (404/410) or another 4xx the session refuses: start again, once per call.
        const lost = e instanceof BackendError && (e.status === 404 || e.status === 410 || e.status === 400)
        if (lost && restarts === 0) {
          session = null
          continue
        }
        throw e
      }
      if (sess.create) await this.dedupe(key, file, false, signal)
      else this.remember(key, file)
      o.onProgress?.(size)
      return
    }
  }

  // --- check and describe ------------------------------------------------------------------------

  async check(): Promise<BackendCheck> {
    const steps: BackendCheckStep[] = []
    const ok = (id: BackendCheckStep['id'], detail?: string) => steps.push(detail ? { id, ok: true, detail } : { id, ok: true })
    const bad = (id: BackendCheckStep['id'], detail: string) => steps.push({ id, ok: false, detail })
    const fail = (e: unknown): BackendError => (e instanceof BackendError ? e : new BackendError('unknown', String((e as Error)?.message ?? e), { cause: e }))
    const key = `os1/.check-${Math.random().toString(36).slice(2, 12)}`
    let firstError: BackendError | undefined
    const note = (e: BackendError) => (firstError ??= e)

    // 1. The folder: reachability and the sign-in, then a listing.
    try {
      const res = await this.http.send(`${DRIVE_API}/files/${encodeURIComponent(this.folder)}?fields=id,mimeType,trashed`, { expect: [404] })
      ok('reach')
      ok('auth')
      const f = res.status === 404 ? (await drain(res), null) : await readJson<{ mimeType?: string; trashed?: boolean }>(res)
      if (!f || f.trashed || f.mimeType !== FOLDER_MIME) {
        const err = new BackendError('notFound', `The ${NAME} folder is gone`, { status: 404, providerCode: 'FolderGone' })
        bad('list', err.message)
        return { ok: false, steps, error: err }
      }
      await this.list('os1/', { limit: 1 })
      ok('list')
    } catch (e) {
      const err = fail(e)
      if (steps.length) bad('list', err.message)
      else if (err.code === 'network') bad('reach', err.message)
      else if (err.code === 'reauth' || err.code === 'auth' || err.code === 'forbidden') {
        ok('reach')
        bad('auth', err.message)
      } else {
        ok('reach')
        ok('auth')
        bad('list', err.message)
      }
      return { ok: false, steps, error: err }
    }

    // 2. Write, read, range, etag.
    const body = enc.encode('openstand check')
    try {
      await this.put(key, body)
      ok('write')
    } catch (e) {
      const err = fail(e)
      bad('write', err.message)
      return { ok: false, steps, error: err }
    }
    try {
      const got = await this.get(key)
      if (got && got.length === body.length && got.every((b, i) => b === body[i])) ok('read')
      else {
        bad('read', 'Read back different data')
        note(new BackendError('unknown', 'Read back different data'))
      }
    } catch (e) {
      bad('read', fail(e).message)
      note(fail(e))
    }
    try {
      const got = await this.get(key, { range: [1, 1] })
      if (got && got.length === 1 && got[0] === body[1]) ok('range')
      else {
        bad('range', 'Range requests are ignored')
        note(new BackendError('unknown', 'Range requests are not supported'))
      }
    } catch (e) {
      bad('range', fail(e).message)
      note(fail(e))
    }
    try {
      const h = await this.head(key)
      if (h?.etag) ok('etag')
      else {
        bad('etag', 'No file version')
        note(new BackendError('unknown', 'No file version'))
      }
    } catch (e) {
      bad('etag', fail(e).message)
      note(fail(e))
    }

    // 3. Conditional create: emulated (query, create, dedupe), so it can't be atomic.
    try {
      await this.put(key, body, { ifNoneMatch: true })
      bad('conditional', 'A second create succeeded')
      note(new BackendError('unknown', 'Conditional create not honoured'))
    } catch (e) {
      if (isCode(e, 'precondition')) ok('conditional', 'emulated (not atomic)')
      else {
        bad('conditional', fail(e).message)
        note(fail(e))
      }
    }

    // 4. Delete.
    try {
      await this.delete(key)
      ok('delete')
    } catch (e) {
      bad('delete', fail(e).message)
      note(fail(e))
    }
    return firstError ? { ok: false, steps, error: firstError } : { ok: steps.every((s) => s.ok), steps }
  }

  async describe(o: { signal?: AbortSignal } = {}): Promise<BackendDescription> {
    const about = await this.http.json<{
      user?: { displayName?: string; emailAddress?: string; permissionId?: string }
      storageQuota?: { limit?: string; usage?: string }
    }>(`${DRIVE_API}/about?fields=${encodeURIComponent('user(displayName,emailAddress,permissionId),storageQuota(limit,usage)')}`, { signal: o.signal })
    const res = await this.http.send(`${DRIVE_API}/files/${encodeURIComponent(this.folder)}?fields=name,webViewLink,trashed`, { signal: o.signal, expect: [404] })
    const folder = res.status === 404 ? (await drain(res), null) : await readJson<{ name?: string; webViewLink?: string; trashed?: boolean }>(res)
    if (!folder || folder.trashed) throw new BackendError('notFound', `The ${NAME} folder is gone`, { status: 404, providerCode: 'FolderGone' })
    const u = about?.user ?? {}
    if (!u.permissionId) throw new BackendError('unknown', `${NAME} didn't say who is signed in`, { providerCode: 'NoAccount' })
    const out: BackendDescription = {
      account: { id: u.permissionId, ...(u.emailAddress ? { email: u.emailAddress } : {}), ...(u.displayName ? { name: u.displayName } : {}) },
      location: `${NAME} › ${folder.name || 'OpenStand'}`,
    }
    if (folder.webViewLink) out.openUrl = folder.webViewLink
    // No `limit` means unlimited storage.
    const limit = Number(about?.storageQuota?.limit)
    const usage = Number(about?.storageQuota?.usage ?? 0)
    if (about?.storageQuota?.limit && Number.isFinite(limit) && Number.isFinite(usage)) out.freeBytes = Math.max(0, limit - usage)
    return out
  }
}

/**
 * Finds the OpenStand root folder by its `appProperties` marker, or creates it in My Drive (§4.3 "Root
 * folder"); returns its file id for `BackendConfig.folder`. Used only by `driveBackendConfig` at setup.
 * Several marked folders (two first-time setups at once) → the earliest. A folder the user made by hand
 * is invisible to `drive.file`, so only our own can match.
 */
export async function ensureRootFolder(ctx: BackendContext, o: { signal?: AbortSignal } = {}): Promise<string> {
  const http = httpFor(ctx)
  const q = `mimeType = ${qstr(FOLDER_MIME)} and appProperties has { key='openstand' and value='root' } and trashed = false`
  const found = (await queryAll(http, q, 'id,createdTime', { signal: o.signal, max: 1000 })).sort(canonicalOrder)
  if (found[0]) return found[0].id
  const f = await http.json<{ id?: string }>(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: 'OpenStand', mimeType: FOLDER_MIME, parents: ['root'], appProperties: { openstand: 'root' }, description: ROOT_DESCRIPTION }),
    signal: o.signal,
  })
  if (!f?.id) throw new BackendError('unknown', `${NAME} didn't return the new folder`, { providerCode: 'NoFolderId' })
  return f.id
}
