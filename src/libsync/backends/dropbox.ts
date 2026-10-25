/**
 * Dropbox API v2 in the app folder.
 *
 * Keys are real paths under `/<root>/` in the app folder (`root` is '' in practice). RPC calls go to
 * `api.dropboxapi.com` with a JSON body; content calls go to `content.dropboxapi.com` with their arguments
 * as ASCII JSON in `Dropbox-API-Arg`. Dropbox answers endpoint errors with 409 and `{error_summary, error}`;
 * `dropboxError` maps those (and 400/401/403/429/5xx) to `BackendError`. Rate limits carry `retry_after`
 * in the body because the browser can't read Dropbox's `Retry-After` header.
 *
 * Large uploads use upload sessions in 8 MiB chunks. The session is started with an empty body and saved
 * through `onState` before the first read. Resume asks the server for its offset with an empty append at
 * `state.done` (a wrong offset answers 409 `incorrect_offset` with `correct_offset`), so a chunk that landed
 * before a crash is never read again. There is no `abortUpload`: Dropbox can't cancel sessions, which
 * expire after 7 days by themselves.
 */
import { DROPBOX_APP_FOLDER } from '../oauth/config'
import { ERROR_BODY_MAX, JSON_MAX, OAuthHttp } from './http'
import { prefixScope, segments } from './keymap'
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
  type DropboxConfig,
  type ListPage,
  type ObjectInfo,
  type StorageBackend,
  type UploadState,
} from './types'
import { LIST_MAX_KEYS, tooLarge } from './util'

const MiB = 1024 * 1024
const NAME = 'Dropbox'

export const DROPBOX_API = 'https://api.dropboxapi.com/2/'
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2/'

/** Default upload-session chunk. Sequential sessions have no alignment rule; a request carries ≤ 150 MiB. */
export const DROPBOX_CHUNK = 8 * MiB
/** Largest body sent as one `files/upload` (the API allows 150 MiB). */
export const DROPBOX_MAX_SMALL_PUT = 16 * MiB
/** `retryAfterMs` when a rate-limit answer carries no `retry_after`. */
const DEFAULT_RETRY_MS = 1000
/** `list_folder` page size (the API maximum). */
const LIST_LIMIT = 2000

export interface DropboxOptions {
  /** Upload session chunk (default 8 MiB). */
  chunk?: number
  /** Largest single-request upload (default 16 MiB). */
  maxSmallPut?: number
}

// ---------------------------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------------------------

/**
 * `Dropbox-API-Arg` value: JSON with every non-ASCII (and DEL) character escaped as `\uXXXX`, since HTTP
 * header values must be ASCII. Keys are ASCII already; this keeps a future root or key safe.
 */
export function apiArg(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

interface DropboxErrorBody {
  error_summary?: string
  error?: Record<string, unknown> & { '.tag'?: string; retry_after?: number; reason?: { '.tag'?: string } }
}

const dec = new TextDecoder()

function parseErrorBody(text: string): DropboxErrorBody {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as DropboxErrorBody) : {}
  } catch {
    return {}
  }
}

/** `"path/not_found/.."` → `"path/not_found"` (Dropbox pads summaries with dots to discourage parsing them). */
function summaryOf(b: DropboxErrorBody): string {
  return typeof b.error_summary === 'string' ? b.error_summary.trim().replace(/\/\.*$/, '') : ''
}

const hasTag = (summary: string, tag: string) => new RegExp(`(^|/)${tag}(/|$)`).test(summary)

/** Maps a Dropbox error answer (status, body text, headers) to a `BackendError`. */
export function dropboxError(status: number, text: string, headers?: Headers): BackendError {
  const body = parseErrorBody(text)
  const summary = summaryOf(body)
  const tag = typeof body.error?.['.tag'] === 'string' ? body.error['.tag'] : undefined
  const providerCode = summary || tag || undefined
  const msg = `${NAME}: ${providerCode ?? `HTTP ${status}`}`
  const o = { status, providerCode }
  const rateLimited = () => {
    const ra = body.error?.retry_after
    const retryAfterMs =
      typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? ra * 1000 : (parseRetryAfter(headers?.get('retry-after')) ?? DEFAULT_RETRY_MS)
    return new BackendError('rateLimited', msg, { ...o, retryAfterMs })
  }
  // 400 is a plain-text "Error in call to API function …": a bug in our request.
  if (status === 400) return new BackendError('unknown', `${NAME} refused the request (HTTP 400)`, { status, providerCode: 'BadRequest' })
  if (status === 401) return new BackendError('reauth', `${NAME} refused the sign-in: ${tag || summary || 'HTTP 401'}`, { status, providerCode: tag || summary || undefined })
  if (status === 403) return new BackendError('forbidden', msg, o)
  if (status === 429) return rateLimited()
  if (status === 409) {
    if (hasTag(summary, 'too_many_write_operations') || hasTag(summary, 'too_many_requests')) return rateLimited()
    if (hasTag(summary, 'insufficient_space') || hasTag(summary, 'insufficient_quota')) return new BackendError('quota', msg, o)
    if (hasTag(summary, 'conflict')) return new BackendError('precondition', msg, o)
    if (hasTag(summary, 'not_found')) return new BackendError('notFound', msg, o)
    return new BackendError('unknown', msg, o)
  }
  if (status >= 500) return new BackendError('server', msg, o)
  return new BackendError('unknown', msg, o)
}

async function errorText(res: Response): Promise<string> {
  try {
    return dec.decode(await readBody(res, ERROR_BODY_MAX, 'truncate'))
  } catch {
    return ''
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const bytes = await readBody(res, JSON_MAX, () => new BackendError('unknown', `${NAME} sent an answer larger than ${JSON_MAX} bytes`, { providerCode: 'TooLarge', status: res.status }))
  try {
    return JSON.parse(dec.decode(bytes)) as T
  } catch {
    throw new BackendError('unknown', `${NAME} sent an answer that isn't JSON`, { providerCode: 'BadJson', status: res.status })
  }
}

/** Adds the key to an error's message (messages carry the key and the provider's code only). */
function withKey(e: unknown, key: string): unknown {
  if (e instanceof BackendError && !e.message.includes(key)) e.message = `${e.message} (${key})`
  return e
}

interface FileMetadata {
  '.tag': 'file' | 'folder' | 'deleted'
  path_lower?: string
  size?: number
  rev?: string
  server_modified?: string
}

interface ListFolderResult {
  entries: FileMetadata[]
  cursor: string
  has_more: boolean
}

/** The session-lookup part of an upload-session error (`append_v2` puts it at the top, `finish` under `lookup_failed`). */
function lookupError(body: DropboxErrorBody): { tag?: string; correctOffset?: number } {
  const e = body.error
  const l = e?.['.tag'] === 'lookup_failed' ? (e.lookup_failed as { '.tag'?: string; correct_offset?: unknown } | undefined) : e
  const tag = typeof l?.['.tag'] === 'string' ? l['.tag'] : undefined
  const co = (l as { correct_offset?: unknown } | undefined)?.correct_offset
  return { tag, correctOffset: typeof co === 'number' && Number.isInteger(co) ? co : undefined }
}

/** What the server says about a session at an offset: accepted, the offset it wants instead, or gone. */
type SessionAnswer = { ok: true } | { offset: number } | { gone: true }

interface DropboxSession {
  sessionId: string
  chunk: number
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

export class DropboxBackend implements StorageBackend {
  readonly kind = 'dropbox' as const
  readonly label: string
  caps: BackendCaps
  /** `UploadState.backend`: sessions resume only for the same account and root. */
  readonly id: string
  protected readonly cfg: DropboxConfig
  protected readonly ctx: BackendContext
  protected readonly opts: DropboxOptions
  private readonly http: OAuthHttp
  private readonly now: () => number
  /** `''` or `'a/b'`: no leading or trailing slash. */
  private readonly root: string
  private readonly chunk: number
  /** Set when Dropbox refuses an empty append (the resume probe); resume then trusts `state.done`. */
  private noEmptyAppend = false

  constructor(cfg: DropboxConfig, ctx: BackendContext = {}, opts: DropboxOptions = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.opts = opts
    this.root = (cfg.root ?? '').replace(/^\/+|\/+$/g, '')
    this.label = cfg.account ? `${NAME} · ${cfg.account}` : NAME
    this.id = `dropbox:${cfg.accountId ?? ''}:${this.root}`
    this.chunk = Math.max(1, Math.floor(opts.chunk ?? DROPBOX_CHUNK))
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: opts.maxSmallPut ?? DROPBOX_MAX_SMALL_PUT }
    this.now = ctx.now ?? Date.now
    this.http = new OAuthHttp(ctx, { label: NAME, mapError: (res, body) => dropboxError(res.status, body, res.headers) })
  }

  /** `/<root>/<key>`; validates the key (lowercase ASCII segments, keymap.ts). */
  private path(key: string): string {
    segments(key)
    return '/' + (this.root ? this.root + '/' : '') + key
  }

  /** The key of a `path_lower`, or null when it isn't under the root. */
  private keyOf(pathLower: string): string | null {
    const base = ('/' + (this.root ? this.root + '/' : '')).toLowerCase()
    return pathLower.startsWith(base) && pathLower.length > base.length ? pathLower.slice(base.length) : null
  }

  private info(key: string, m: FileMetadata): ObjectInfo {
    const out: ObjectInfo = { key, size: Number(m.size ?? 0) }
    if (m.rev) out.etag = m.rev
    const t = m.server_modified ? Date.parse(m.server_modified) : NaN
    if (Number.isFinite(t)) out.lastModified = t
    return out
  }

  /** RPC call (JSON in, JSON out). 409s are returned (as their parsed body) when `allow409`, else thrown. */
  private async rpc<T>(endpoint: string, args: unknown, o: { signal?: AbortSignal; allow409?: boolean } = {}): Promise<{ ok: T } | { err: DropboxErrorBody; status: number; text: string }> {
    const res = await this.http.send(DROPBOX_API + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: args === null ? 'null' : JSON.stringify(args),
      signal: o.signal,
      expect: o.allow409 ? [409] : undefined,
    })
    if (res.status === 409) {
      const text = await errorText(res)
      return { err: parseErrorBody(text), status: 409, text }
    }
    return { ok: await readJson<T>(res) }
  }

  /** Content call (`Dropbox-API-Arg`). Returns the response; statuses in `expect` aren't thrown. */
  private content(endpoint: string, arg: unknown, o: { body?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal; expect?: number[] }): Promise<Response> {
    const headers: Record<string, string> = { 'dropbox-api-arg': apiArg(arg), ...o.headers }
    if (o.body) headers['content-type'] = 'application/octet-stream'
    return this.http.send(DROPBOX_CONTENT + endpoint, {
      method: 'POST',
      headers,
      body: o.body as Uint8Array<ArrayBuffer> | undefined,
      signal: o.signal,
      expect: o.expect,
    })
  }

  // --- list ------------------------------------------------------------------------------------

  async list(prefix: string, o: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ListPage> {
    prefixScope(prefix) // validates
    // The deepest complete folder of the prefix (not capped: Dropbox lists any folder recursively).
    const folder = prefix.slice(0, prefix.lastIndexOf('/') + 1).replace(/\/$/, '')
    const rel = [this.root, folder].filter(Boolean).join('/')
    const path = rel ? '/' + rel : ''
    const items: ObjectInfo[] = []
    const seenCursors = new Set<string>()
    let r = await this.rpc<ListFolderResult>('files/list_folder', { path, recursive: true, limit: LIST_LIMIT, include_deleted: false }, { signal: o.signal, allow409: true })
    for (;;) {
      if ('err' in r) {
        if (hasTag(summaryOf(r.err), 'not_found')) return { items: [] }
        throw withKey(dropboxError(r.status, r.text), prefix || '/')
      }
      const page = r.ok
      for (const m of Array.isArray(page.entries) ? page.entries : []) {
        if (m?.['.tag'] !== 'file' || typeof m.path_lower !== 'string') continue
        const key = this.keyOf(m.path_lower)
        if (key === null || !key.startsWith(prefix)) continue
        items.push(this.info(key, m))
        if (items.length > LIST_MAX_KEYS)
          throw new BackendError('unknown', `More than ${LIST_MAX_KEYS} objects under "${prefix}" in storage`, { providerCode: 'TooManyKeys' })
      }
      if (!page.has_more) break
      if (typeof page.cursor !== 'string' || seenCursors.has(page.cursor))
        throw new BackendError('unknown', `The storage listing of "${prefix}" doesn't advance`, { providerCode: 'ListLoop' })
      seenCursors.add(page.cursor)
      r = await this.rpc<ListFolderResult>('files/list_folder/continue', { cursor: page.cursor }, { signal: o.signal, allow409: true })
    }
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    // One page without a cursor: `limit` is a hint, `startAfter` filters.
    const after = o.startAfter
    return { items: after ? items.filter((i) => i.key > after) : items }
  }

  // --- objects ---------------------------------------------------------------------------------

  async head(key: string, o: { signal?: AbortSignal } = {}): Promise<ObjectInfo | null> {
    const path = this.path(key)
    try {
      const r = await this.rpc<FileMetadata>('files/get_metadata', { path }, { signal: o.signal, allow409: true })
      if ('err' in r) {
        if (hasTag(summaryOf(r.err), 'not_found')) return null
        throw dropboxError(r.status, r.text)
      }
      return r.ok?.['.tag'] === 'file' ? this.info(key, r.ok) : null
    } catch (e) {
      throw withKey(e, key)
    }
  }

  async get(key: string, o: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number } = {}): Promise<Uint8Array | null> {
    const path = this.path(key)
    const r = o.range
    if (r && !(Number.isInteger(r[0]) && Number.isInteger(r[1]) && 0 <= r[0] && r[0] <= r[1])) throw new BackendError('unknown', 'bad range')
    try {
      const res = await this.content('files/download', { path }, { signal: o.signal, headers: r ? { range: `bytes=${r[0]}-${r[1]}` } : undefined, expect: [409, 416] })
      if (res.status === 409) {
        const text = await errorText(res)
        if (hasTag(summaryOf(parseErrorBody(text)), 'not_found')) return null
        throw dropboxError(409, text, res.headers)
      }
      if (res.status === 416) {
        await res.body?.cancel().catch(() => {})
        return new Uint8Array(0)
      }
      if (!r) {
        const max = o.maxBytes ?? GET_MAX
        return await readBody(res, max, () => tooLarge(key, max, 'TooLarge', res.status))
      }
      const len = r[1] - r[0] + 1
      const data = await readBody(res, len, () => tooLarge(key, len, res.status === 200 ? 'RangeIgnored' : 'TooLarge', res.status))
      return res.status === 200 ? data.slice(r[0], r[1] + 1) : data
    } catch (e) {
      throw withKey(e, key)
    }
  }

  async put(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    await this.putRaw(key, body, o)
  }

  private async putRaw(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal }): Promise<FileMetadata> {
    const path = this.path(key)
    // `strict_conflict`: without it, `add` silently succeeds when the existing file has identical content.
    const arg = { path, mode: o.ifNoneMatch && this.caps.conditionalPut ? 'add' : 'overwrite', autorename: false, mute: true, strict_conflict: true }
    try {
      return await readJson<FileMetadata>(await this.content('files/upload', arg, { body, signal: o.signal }))
    } catch (e) {
      throw withKey(e, key)
    }
  }

  async delete(key: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    const path = this.path(key)
    try {
      const r = await this.rpc('files/delete_v2', { path }, { signal: o.signal, allow409: true })
      if ('err' in r && !hasTag(summaryOf(r.err), 'not_found')) throw dropboxError(r.status, r.text)
    } catch (e) {
      throw withKey(e, key)
    }
  }

  // --- upload sessions -------------------------------------------------------------------------

  private async startSession(signal?: AbortSignal): Promise<string> {
    // Empty body: the session exists (and is saved) before the first chunk is read.
    const res = await this.content('files/upload_session/start', { close: false }, { body: new Uint8Array(0), signal })
    const j = await readJson<{ session_id?: unknown }>(res)
    if (typeof j?.session_id !== 'string' || !j.session_id) throw new BackendError('unknown', `${NAME} returned no upload session`, { providerCode: 'NoSession' })
    return j.session_id
  }

  /** Interprets a 409 from append/finish: a wrong offset, a lost session, or a real error. */
  private sessionAnswer(status: number, text: string, size: number): SessionAnswer {
    const body = parseErrorBody(text)
    const { tag, correctOffset } = lookupError(body)
    if (tag === 'incorrect_offset' && correctOffset !== undefined && correctOffset >= 0 && correctOffset <= size) return { offset: correctOffset }
    if (tag === 'not_found' || tag === 'closed' || tag === 'incorrect_offset') return { gone: true }
    throw dropboxError(status, text)
  }

  private async append(sessionId: string, offset: number, body: Uint8Array, size: number, signal?: AbortSignal): Promise<SessionAnswer> {
    const res = await this.content('files/upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, { body, signal, expect: [409] })
    if (res.status === 409) return this.sessionAnswer(409, await errorText(res), size)
    await res.body?.cancel().catch(() => {})
    return { ok: true }
  }

  /**
   * The server's offset for a saved session, without reading the source: an empty append at `done` is a
   * no-op when `done` is right and a 409 `incorrect_offset` (with `correct_offset`) when it isn't.
   */
  private async probe(sessionId: string, done: number, size: number, signal?: AbortSignal): Promise<SessionAnswer> {
    if (this.noEmptyAppend) return { ok: true }
    try {
      return await this.append(sessionId, done, new Uint8Array(0), size, signal)
    } catch (e) {
      if (e instanceof BackendError && e.status === 400) {
        // Not accepted: carry on at `done`; an `incorrect_offset` on the next chunk still corrects it.
        this.noEmptyAppend = true
        return { ok: true }
      }
      throw e
    }
  }

  private async finish(sessionId: string, size: number, path: string, signal?: AbortSignal): Promise<SessionAnswer> {
    const arg = { cursor: { session_id: sessionId, offset: size }, commit: { path, mode: 'overwrite', autorename: false, mute: true } }
    const res = await this.content('files/upload_session/finish', arg, { body: new Uint8Array(0), signal, expect: [409] })
    if (res.status === 409) return this.sessionAnswer(409, await errorText(res), size)
    await res.body?.cancel().catch(() => {})
    return { ok: true }
  }

  /** The saved state if it belongs to this backend, key and size; otherwise null (start over). */
  private resumable(s: UploadState | undefined, key: string, size: number): (UploadState & { session: DropboxSession }) | null {
    if (!s || s.v !== 1 || s.backend !== this.id || s.key !== key || s.size !== size) return null
    if (!Number.isInteger(s.done) || s.done < 0 || s.done > size) return null
    const sess = s.session as Partial<DropboxSession> | null
    if (!sess || typeof sess !== 'object' || typeof sess.sessionId !== 'string' || !sess.sessionId) return null
    return { ...s, session: { sessionId: sess.sessionId, chunk: typeof sess.chunk === 'number' ? sess.chunk : this.chunk } }
  }

  async upload(
    key: string,
    src: ByteSource,
    o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    const { signal } = o
    const path = this.path(key)
    const size = src.size
    if (size <= this.caps.maxSmallPut) {
      signal?.throwIfAborted()
      const body = await src.read(0, size)
      if (body.length !== size) throw new Error('ByteSource returned a short read')
      await this.put(key, body, { signal })
      o.onProgress?.(size)
      return
    }
    try {
      await this.uploadSession(key, path, src, o)
    } catch (e) {
      throw withKey(e, key)
    }
  }

  private async uploadSession(
    key: string,
    path: string,
    src: ByteSource,
    o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    const { signal } = o
    const size = src.size
    const save = async (s: UploadState) => o.onState?.(structuredClone(s))
    const isWhole = async () => (await this.head(key, { signal }))?.size === size
    let state: (UploadState & { session: DropboxSession }) | null = null
    let offset = 0

    const resumed = this.resumable(o.state, key, size)
    if (resumed) {
      // The server's offset wins: a chunk that landed before a crash isn't read again.
      const a = await this.probe(resumed.session.sessionId, resumed.done, size, signal)
      if ('gone' in a) {
        // Expired, or finished just before a crash: done if the file is whole.
        if (await isWhole()) {
          o.onProgress?.(size)
          return
        }
      } else {
        state = resumed
        offset = 'offset' in a ? a.offset : resumed.done
      }
    }

    let restarts = 0
    let finishes = 0
    for (;;) {
      if (!state) {
        const sessionId = await this.startSession(signal)
        state = { v: 1, backend: this.id, key, size, createdAt: this.now(), done: 0, session: { sessionId, chunk: this.chunk } }
        offset = 0
        await save(state)
      } else if (state.done !== offset) {
        state = { ...state, done: offset }
        await save(state)
      }
      if (offset) o.onProgress?.(offset)
      const { sessionId } = state.session
      let gone = false
      let stuck = 0
      while (offset < size) {
        signal?.throwIfAborted()
        const end = Math.min(size, offset + this.chunk)
        const body = await src.read(offset, end)
        if (body.length !== end - offset) throw new Error('ByteSource returned a short read')
        const a = await this.append(sessionId, offset, body, size, signal)
        if ('gone' in a) {
          gone = true
          break
        }
        const next = 'ok' in a ? end : a.offset
        // A server that keeps asking for an offset we can't make progress from: stop rather than loop.
        if (next <= offset && ++stuck > 2) throw new BackendError('unknown', `${NAME} keeps refusing the upload offset`, { providerCode: 'incorrect_offset' })
        offset = next
        state = { ...state, done: offset }
        await save(state)
        o.onProgress?.(offset)
      }
      if (!gone) {
        const f = await this.finish(sessionId, size, path, signal)
        if ('ok' in f) return
        if ('offset' in f && f.offset < size && ++finishes <= 2) {
          offset = f.offset
          continue
        }
        if (await isWhole()) return
      }
      // The session vanished mid-upload (expired or lost): start one new session, once.
      if (++restarts > 1) throw new BackendError('unknown', `${NAME} lost the upload session`, { providerCode: 'SessionLost' })
      state = null
    }
  }

  // --- check and describe ----------------------------------------------------------------------

  async check(): Promise<BackendCheck> {
    const steps: BackendCheckStep[] = []
    const ok = (id: BackendCheckStep['id'], detail?: string) => steps.push(detail ? { id, ok: true, detail } : { id, ok: true })
    const bad = (id: BackendCheckStep['id'], detail: string) => steps.push({ id, ok: false, detail })
    const fail = (e: unknown): BackendError => (e instanceof BackendError ? e : new BackendError('unknown', String((e as Error)?.message ?? e), { cause: e }))
    const key = `os1/.check-${Math.random().toString(36).slice(2, 12)}`
    let firstError: BackendError | undefined
    const note = (e: BackendError) => (firstError ??= e)

    // 1. LIST: reachability and sign-in in one request.
    try {
      await this.list('os1/', { limit: 1 })
      ok('reach')
      ok('auth')
      ok('list')
    } catch (e) {
      const err = fail(e)
      if (err.code === 'network') bad('reach', err.message)
      else {
        ok('reach')
        if (err.code === 'reauth' || err.code === 'auth' || err.code === 'forbidden') bad('auth', err.message)
        else {
          ok('auth')
          bad('list', err.message)
        }
      }
      return { ok: false, steps, error: err }
    }

    // 2. PUT.
    const body = new TextEncoder().encode('openstand check')
    try {
      await this.putRaw(key, body, {})
      ok('write')
    } catch (e) {
      const err = fail(e)
      bad('write', err.message)
      return { ok: false, steps, error: err }
    }
    // 3. GET; 4. range GET; 5. a revision to use as the etag.
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
      const got = await this.get(key, { range: [0, 0] })
      this.caps.rangeGet = got?.length === 1 && got[0] === body[0]
      if (this.caps.rangeGet) ok('range')
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
        bad('etag', 'No file revision')
        note(new BackendError('unknown', 'No file revision'))
      }
    } catch (e) {
      bad('etag', fail(e).message)
      note(fail(e))
    }
    // 6. Conditional create of the same, identical content: must conflict (`strict_conflict`).
    try {
      await this.putRaw(key, body, { ifNoneMatch: true })
      this.caps.conditionalPut = false
      ok('conditional', 'Not supported; writes are unconditional')
    } catch (e) {
      const err = fail(e)
      if (err.code === 'precondition') {
        this.caps.conditionalPut = true
        ok('conditional')
      } else {
        bad('conditional', err.message)
        note(err)
      }
    }
    // 7. DELETE.
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
    const [acct, space] = await Promise.all([
      this.http.json<{ account_id?: string; email?: string; name?: { display_name?: string } }>(DROPBOX_API + 'users/get_current_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
        signal: o.signal,
      }),
      this.http
        .json<SpaceUsage>(DROPBOX_API + 'users/get_space_usage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null', signal: o.signal })
        .catch((e: unknown) => {
          // Free space is a nicety; a refused sign-in is not.
          if (e instanceof BackendError && e.code !== 'reauth' && e.code !== 'network') return null
          throw e
        }),
    ])
    if (!acct || typeof acct.account_id !== 'string') throw new BackendError('unknown', `${NAME} didn't say who is signed in`, { providerCode: 'NoAccount' })
    const account: BackendDescription['account'] = { id: acct.account_id }
    if (typeof acct.email === 'string' && acct.email) account.email = acct.email
    if (typeof acct.name?.display_name === 'string' && acct.name.display_name) account.name = acct.name.display_name
    const rootParts = this.root ? this.root.split('/') : []
    const out: BackendDescription = {
      account,
      location: [NAME, 'Apps', DROPBOX_APP_FOLDER, ...rootParts].join(' › '),
      openUrl: 'https://www.dropbox.com/home/Apps/' + [DROPBOX_APP_FOLDER, ...rootParts].map(encodeURIComponent).join('/'),
    }
    const free = space ? freeBytes(space) : undefined
    if (free !== undefined) out.freeBytes = free
    return out
  }
}

interface SpaceUsage {
  used?: number
  allocation?: { '.tag'?: string; allocated?: number; used?: number; user_within_team_space_allocated?: number }
}

/** Free bytes from `users/get_space_usage`: individual = allocated − used; team = the tighter of the team and the per-user limit. */
export function freeBytes(s: SpaceUsage): number | undefined {
  const a = s.allocation
  const used = Number(s.used)
  if (!a || !Number.isFinite(used) || typeof a.allocated !== 'number') return undefined
  let free: number
  if (a['.tag'] === 'team') {
    free = a.allocated - Number(a.used ?? used)
    if (typeof a.user_within_team_space_allocated === 'number' && a.user_within_team_space_allocated > 0)
      free = Math.min(free, a.user_within_team_space_allocated - used)
  } else free = a.allocated - used
  return Number.isFinite(free) ? Math.max(0, free) : undefined
}
