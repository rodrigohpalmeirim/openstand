/**
 * In-process fake of the Dropbox API v2 subset the backend uses. Test-only.
 *
 * Enforces what real Dropbox enforces, so a wrong request fails in tests rather than in production:
 * a bearer token on every call; RPC bodies are JSON with `Content-Type: application/json`; content calls
 * carry `Dropbox-API-Arg` as **ASCII** JSON and upload bodies as `application/octet-stream`; root is `""`,
 * never `"/"`; paths are case-insensitive (stored by `path_lower`, first casing kept for `path_display`);
 * `mode`/`autorename`/`strict_conflict` semantics (an `add` of identical content succeeds silently unless
 * `strict_conflict`); `list_folder` pages (`pageSize`, default 2000) in a **shuffled** order with folder
 * entries mixed in; Range → 206; upload sessions with `incorrect_offset` + `correct_offset`, closed after
 * `finish`, expired after 7 days (by the `now` clock).
 *
 * Simulates: 409 conflict and `insufficient_space` (`quota`), 429 with `retry_after` (`rateLimit`),
 * `expired_access_token` 401 (through the harness token simulator), 5xx (`serverError`), lost sessions
 * (`loseSessions`), and listing lag (`listLag`). Generic faults go through `fail()` (harness).
 */
import { FakeServer, type FakeReply, type FakeRequest } from './harness'

const API = 'https://api.dropboxapi.com/2/'
const CONTENT = 'https://content.dropboxapi.com/2/'
const MiB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
/** Per-request body limit of the content endpoints. */
const REQUEST_MAX = 150 * MiB
const SESSION_TTL = 7 * DAY

export interface DropboxFakeOptions {
  now?: () => number
  /** Largest `list_folder` page (default 2000; the request's `limit` can only lower it). */
  pageSize?: number
  /** Seed of the listing shuffle. */
  seed?: number
  /** New or overwritten files stay invisible to `list_folder` for the next n listings (write lag). */
  listLag?: number
  /** Account allocation in bytes (default 2 GiB); writes past it answer `insufficient_space`. */
  quota?: number
  account?: { id?: string; email?: string; name?: string }
}

interface FFile {
  display: string
  data: Uint8Array
  rev: string
  id: string
  modified: number
  /** Listings left during which this file is hidden (`listLag`). */
  hidden: number
}

interface FSession {
  parts: Uint8Array[]
  length: number
  createdAt: number
  closed: boolean
}

interface Cursor {
  entries: unknown[]
  pos: number
  limit: number
}

const enc = new TextEncoder()
const isoSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** Dropbox's 409 body: the summary is padded with dots to discourage parsing it. */
export const dropbox409 = (summary: string, error: unknown): FakeReply => ({ status: 409, json: { error_summary: summary + '/..', error } })
const badRequest = (msg: string): FakeReply => ({ status: 400, text: `Error in call to API function "${msg}"` })

export class DropboxFake extends FakeServer {
  /** By `path_lower`. */
  readonly files = new Map<string, FFile>()
  /** `path_lower` → `path_display`. */
  readonly folders = new Map<string, string>()
  readonly sessions = new Map<string, FSession>()
  readonly account: { id: string; email: string; name: string }
  quota: number
  listLag: number
  private readonly pageSize: number
  private readonly cursors = new Map<string, Cursor>()
  private seed: number
  private seq = 0

  constructor(o: DropboxFakeOptions = {}) {
    super({ now: o.now, kind: 'dropbox' })
    this.pageSize = o.pageSize ?? 2000
    this.seed = (o.seed ?? 1) >>> 0
    this.listLag = o.listLag ?? 0
    this.quota = o.quota ?? 2 * 1024 * MiB
    this.account = {
      id: o.account?.id ?? 'dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc',
      email: o.account?.email ?? 'rod@example.com',
      name: o.account?.name ?? 'Rod Example',
    }

    this.rpc('files/list_folder', (a) => this.listFolder(a))
    this.rpc('files/list_folder/continue', (a) => this.listContinue(a))
    this.rpc('files/get_metadata', (a) => this.getMetadata(a))
    this.rpc('files/delete_v2', (a) => this.deleteV2(a))
    this.rpc('users/get_current_account', () => ({
      json: { account_id: this.account.id, email: this.account.email, email_verified: true, name: { display_name: this.account.name }, disabled: false },
    }))
    this.rpc('users/get_space_usage', () => ({ json: { used: this.used(), allocation: { '.tag': 'individual', allocated: this.quota } } }))
    this.contentRoute('files/download', (a, req) => this.download(a, req), { download: true })
    this.contentRoute('files/upload', (a, req) => this.upload(a, req.body))
    this.contentRoute('files/upload_session/start', (a, req) => this.sessionStart(a, req.body))
    this.contentRoute('files/upload_session/append_v2', (a, req) => this.sessionAppend(a, req.body))
    this.contentRoute('files/upload_session/finish', (a, req) => this.sessionFinish(a, req.body))
  }

  // --- test helpers ----------------------------------------------------------------------------

  /** The stored bytes at a path (any case), or undefined. */
  read(path: string): Uint8Array | undefined {
    return this.files.get(path.toLowerCase())?.data
  }

  /** Puts a file directly (e.g. a stray file a user dropped into the app folder). */
  seedFile(path: string, data: Uint8Array | string): void {
    const err = this.write(path, typeof data === 'string' ? enc.encode(data) : data, 'overwrite', true)
    if (err) throw new Error(`seedFile ${path}: ${JSON.stringify(err.json)}`)
  }

  /** Forgets every upload session, as if they expired. */
  loseSessions(): void {
    this.sessions.clear()
  }

  /** The next `times` matching requests get 429 `too_many_requests` with `retry_after` (seconds) in the body. */
  rateLimit(o: { path?: RegExp | string; times?: number; retryAfter?: number; writes?: boolean } = {}): () => void {
    const tag = o.writes ? 'too_many_write_operations' : 'too_many_requests'
    const error: Record<string, unknown> = { reason: { '.tag': tag } }
    if (o.retryAfter !== undefined) error.retry_after = o.retryAfter
    return this.fail({ path: o.path, times: o.times, respond: { status: 429, json: { error_summary: `${tag}/..`, error } } })
  }

  /** The next `times` matching requests get a 5xx with Dropbox's plain-text body. */
  serverError(o: { path?: RegExp | string; times?: number; status?: number } = {}): () => void {
    return this.fail({ path: o.path, times: o.times, respond: { status: o.status ?? 500, text: 'Internal Server Error' } })
  }

  // --- wire ------------------------------------------------------------------------------------

  protected unauthorized(req: FakeRequest): FakeReply {
    if (!req.headers.get('authorization')) return badRequest('Must provide HTTP header "Authorization"')
    // Tokens this server issued (tok-N) that it no longer accepts have expired; anything else is garbage.
    const tag = /^tok-\d+$/.test(req.token ?? '') ? 'expired_access_token' : 'invalid_access_token'
    return { status: 401, json: { error_summary: `${tag}/..`, error: { '.tag': tag } } }
  }

  private rpc(endpoint: string, fn: (arg: Record<string, unknown>) => FakeReply) {
    this.route('POST', API + endpoint, (req) => {
      const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()
      if (ct !== 'application/json') return badRequest(`${endpoint}: Bad HTTP "Content-Type" header: "${ct}". Expecting "application/json"`)
      let arg: unknown
      try {
        arg = req.body.length ? req.json() : null
      } catch {
        return badRequest(`${endpoint}: could not decode input as JSON`)
      }
      if (arg !== null && (typeof arg !== 'object' || Array.isArray(arg))) return badRequest(`${endpoint}: expected an object`)
      return fn((arg ?? {}) as Record<string, unknown>)
    })
  }

  private contentRoute(endpoint: string, fn: (arg: Record<string, unknown>, req: FakeRequest) => FakeReply, o: { download?: boolean } = {}) {
    this.route('POST', CONTENT + endpoint, (req) => {
      const raw = req.headers.get('dropbox-api-arg')
      if (raw === null) return badRequest(`${endpoint}: Must provide HTTP header "Dropbox-API-Arg" or URL parameter "arg"`)
      if (/[^\x20-\x7e]/.test(raw)) return badRequest(`${endpoint}: HTTP header "Dropbox-API-Arg": could not decode input as JSON (non-ASCII)`)
      let arg: unknown
      try {
        arg = JSON.parse(raw)
      } catch {
        return badRequest(`${endpoint}: HTTP header "Dropbox-API-Arg": could not decode input as JSON`)
      }
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return badRequest(`${endpoint}: expected an object`)
      const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()
      if (o.download) {
        if (req.body.length) return badRequest(`${endpoint}: this endpoint takes no request body`)
        if (ct && ct !== 'text/plain' && ct !== 'application/octet-stream') return badRequest(`${endpoint}: Bad HTTP "Content-Type" header: "${ct}"`)
      } else {
        if (ct !== 'application/octet-stream') return badRequest(`${endpoint}: Bad HTTP "Content-Type" header: "${ct}". Expecting "application/octet-stream"`)
        if (req.body.length > REQUEST_MAX) return badRequest(`${endpoint}: request body too large`)
      }
      return fn(arg as Record<string, unknown>, req)
    })
  }

  /** Validates a path argument: `''` (root, only where allowed) or `/a/b` without empty segments. */
  private checkPath(p: unknown, o: { root?: boolean; summary: string }): { lower: string; display: string } | { reply: FakeReply } {
    if (typeof p !== 'string') return { reply: badRequest('path: expected a string') }
    if (p === '') return o.root ? { lower: '', display: '' } : { reply: badRequest('path: The root folder is unsupported.') }
    if (p === '/') return { reply: badRequest('path: Specify the root folder as an empty string rather than as "/".') }
    const control = [...p].some((c) => c.charCodeAt(0) < 0x20 || c === '\\')
    if (!p.startsWith('/') || p.endsWith('/') || p.includes('//') || control)
      return { reply: dropbox409(`${o.summary}/malformed_path`, { '.tag': o.summary, [o.summary]: { '.tag': 'malformed_path' } }) }
    return { lower: p.toLowerCase(), display: p }
  }

  private nextRev(): string {
    return (++this.seq).toString(16).padStart(9, '0') + '0000000001'
  }

  private used(): number {
    let n = 0
    for (const f of this.files.values()) n += f.data.length
    return n
  }

  private fileMeta(lower: string, f: FFile) {
    return {
      '.tag': 'file',
      name: nameOf(f.display),
      id: f.id,
      client_modified: isoSecond(f.modified),
      server_modified: isoSecond(f.modified),
      rev: f.rev,
      size: f.data.length,
      path_lower: lower,
      path_display: f.display,
      is_downloadable: true,
    }
  }

  private folderMeta(lower: string) {
    const display = this.folders.get(lower) ?? lower
    return { '.tag': 'folder', name: nameOf(display), id: 'id:folder' + lower, path_lower: lower, path_display: display }
  }

  /** Writes a file, creating parent folders. Returns an error reply or null. */
  private write(display: string, data: Uint8Array, mode: 'add' | 'overwrite' | { update: string }, strict: boolean): FakeReply | null {
    const lower = display.toLowerCase()
    if (this.folders.has(lower)) return dropbox409('path/conflict/folder', { '.tag': 'path', reason: { '.tag': 'conflict', conflict: { '.tag': 'folder' } } })
    for (let p = parent(lower); p; p = parent(p))
      if (this.files.has(p)) return dropbox409('path/conflict/file_ancestor', { '.tag': 'path', reason: { '.tag': 'conflict', conflict: { '.tag': 'file_ancestor' } } })
    const old = this.files.get(lower)
    if (old) {
      const conflict = () => dropbox409('path/conflict/file', { '.tag': 'path', reason: { '.tag': 'conflict', conflict: { '.tag': 'file' } } })
      if (mode === 'add') {
        // Without strict_conflict, an add of identical content is a silent no-op success.
        if (!strict && sameBytes(old.data, data)) return null
        return conflict()
      }
      if (typeof mode === 'object' && mode.update !== old.rev) return conflict()
    } else if (typeof mode === 'object' && strict) {
      // strict_conflict: an update of a file that no longer exists conflicts too.
      return dropbox409('path/conflict/file', { '.tag': 'path', reason: { '.tag': 'conflict', conflict: { '.tag': 'file' } } })
    }
    if (this.used() - (old?.data.length ?? 0) + data.length > this.quota)
      return dropbox409('path/insufficient_space', { '.tag': 'path', reason: { '.tag': 'insufficient_space' } })
    const segs = display.split('/')
    for (let i = 2; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/')
      if (!this.folders.has(d.toLowerCase())) this.folders.set(d.toLowerCase(), d)
    }
    this.files.set(lower, {
      display: old?.display ?? display,
      data: data.slice(),
      rev: this.nextRev(),
      id: old?.id ?? `id:f${this.seq}`,
      modified: this.now(),
      hidden: this.listLag,
    })
    return null
  }

  private parseMode(v: unknown): 'add' | 'overwrite' | { update: string } | null {
    const tag = typeof v === 'string' ? v : (v as { '.tag'?: unknown } | undefined)?.['.tag']
    if (v === undefined || tag === 'add') return 'add'
    if (tag === 'overwrite') return 'overwrite'
    if (tag === 'update' && typeof (v as { update?: unknown }).update === 'string') return { update: (v as { update: string }).update }
    return null
  }

  private commit(commitArg: Record<string, unknown>, data: Uint8Array): FakeReply {
    const p = this.checkPath(commitArg.path, { summary: 'path' })
    if ('reply' in p) return p.reply
    const mode = this.parseMode(commitArg.mode)
    if (!mode) return badRequest('mode: unknown')
    // The fake models autorename=false only; a request asking for renames is a backend bug here.
    if (commitArg.autorename !== false && commitArg.autorename !== undefined) return badRequest('fake: autorename is not supported')
    const err = this.write(p.display, data, mode, commitArg.strict_conflict === true)
    if (err) return err
    return { json: this.fileMeta(p.lower, this.files.get(p.lower)!) }
  }

  // --- files -----------------------------------------------------------------------------------

  private random(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0
    let t = this.seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private page(c: Cursor): FakeReply {
    const entries = c.entries.slice(c.pos, c.pos + c.limit)
    const next = { ...c, pos: c.pos + entries.length }
    const id = `cur-${++this.seq}`
    this.cursors.set(id, next)
    return { json: { entries, cursor: id, has_more: next.pos < c.entries.length } }
  }

  private listFolder(a: Record<string, unknown>): FakeReply {
    const p = this.checkPath(a.path, { root: true, summary: 'path' })
    if ('reply' in p) return p.reply
    const limit = a.limit === undefined ? this.pageSize : Number(a.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return badRequest('limit: must be 1..2000')
    if (p.lower && !this.folders.has(p.lower)) {
      if (this.files.has(p.lower)) return dropbox409('path/not_folder', { '.tag': 'path', path: { '.tag': 'not_folder' } })
      return dropbox409('path/not_found', { '.tag': 'path', path: { '.tag': 'not_found' } })
    }
    const recursive = a.recursive === true
    const base = p.lower + '/'
    const under = (x: string) => x.startsWith(base) && (recursive || !x.slice(base.length).includes('/'))
    const entries: unknown[] = []
    if (p.lower && recursive) entries.push(this.folderMeta(p.lower))
    for (const f of this.folders.keys()) if (under(f)) entries.push(this.folderMeta(f))
    for (const [lower, f] of this.files) {
      if (!under(lower)) continue
      if (f.hidden > 0) {
        f.hidden--
        continue
      }
      entries.push(this.fileMeta(lower, f))
    }
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1))
      ;[entries[i], entries[j]] = [entries[j], entries[i]]
    }
    return this.page({ entries, pos: 0, limit: Math.min(limit, this.pageSize) })
  }

  private listContinue(a: Record<string, unknown>): FakeReply {
    const c = typeof a.cursor === 'string' ? this.cursors.get(a.cursor) : undefined
    if (!c) return badRequest('cursor: invalid')
    return this.page(c)
  }

  private getMetadata(a: Record<string, unknown>): FakeReply {
    const p = this.checkPath(a.path, { summary: 'path' })
    if ('reply' in p) return p.reply
    const f = this.files.get(p.lower)
    if (f) return { json: this.fileMeta(p.lower, f) }
    if (this.folders.has(p.lower)) return { json: this.folderMeta(p.lower) }
    return dropbox409('path/not_found', { '.tag': 'path', path: { '.tag': 'not_found' } })
  }

  private deleteV2(a: Record<string, unknown>): FakeReply {
    const p = this.checkPath(a.path, { summary: 'path_lookup' })
    if ('reply' in p) return p.reply
    const f = this.files.get(p.lower)
    if (f) {
      const meta = this.fileMeta(p.lower, f)
      this.files.delete(p.lower)
      return { json: { metadata: meta } }
    }
    if (this.folders.has(p.lower)) {
      const meta = this.folderMeta(p.lower)
      for (const k of [...this.files.keys()]) if (k.startsWith(p.lower + '/')) this.files.delete(k)
      for (const k of [...this.folders.keys()]) if (k === p.lower || k.startsWith(p.lower + '/')) this.folders.delete(k)
      return { json: { metadata: meta } }
    }
    return dropbox409('path_lookup/not_found', { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } })
  }

  private download(a: Record<string, unknown>, req: FakeRequest): FakeReply {
    const p = this.checkPath(a.path, { summary: 'path' })
    if ('reply' in p) return p.reply
    const f = this.files.get(p.lower)
    if (!f) {
      if (this.folders.has(p.lower)) return dropbox409('path/not_file', { '.tag': 'path', path: { '.tag': 'not_file' } })
      return dropbox409('path/not_found', { '.tag': 'path', path: { '.tag': 'not_found' } })
    }
    const headers: Record<string, string> = {
      'dropbox-api-result': JSON.stringify(this.fileMeta(p.lower, f)).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
      'content-type': 'application/octet-stream',
    }
    const range = req.headers.get('range')
    if (!range) return { body: f.data, headers }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!m || (m[1] === '' && m[2] === '')) return badRequest('Range: malformed')
    const size = f.data.length
    let start: number
    let end: number
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]))
      end = size - 1
    } else {
      start = Number(m[1])
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    }
    if (start >= size || start > end) return { status: 416, text: '', headers: { 'content-range': `bytes */${size}` } }
    return { status: 206, body: f.data.slice(start, end + 1), headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` } }
  }

  private upload(a: Record<string, unknown>, body: Uint8Array): FakeReply {
    return this.commit(a, body)
  }

  // --- upload sessions -------------------------------------------------------------------------

  /** The session for a cursor, or the lookup error reply (`lookup_failed` wrapper on finish). */
  private lookup(cursor: unknown, wrap: boolean): { s: FSession; offset: number } | { reply: FakeReply } {
    const c = cursor as { session_id?: unknown; offset?: unknown } | undefined
    if (!c || typeof c.session_id !== 'string' || !Number.isInteger(c.offset)) return { reply: badRequest('cursor: expected {session_id, offset}') }
    const err = (tag: string, extra: Record<string, unknown> = {}) => {
      const inner = { '.tag': tag, ...extra }
      return { reply: wrap ? dropbox409(`lookup_failed/${tag}`, { '.tag': 'lookup_failed', lookup_failed: inner }) : dropbox409(tag, inner) }
    }
    const s = this.sessions.get(c.session_id)
    if (s && this.now() - s.createdAt > SESSION_TTL) this.sessions.delete(c.session_id)
    const live = this.sessions.get(c.session_id)
    if (!live) return err('not_found')
    if (live.closed) return err('closed')
    if (c.offset !== live.length) return err('incorrect_offset', { correct_offset: live.length })
    return { s: live, offset: c.offset as number }
  }

  private sessionStart(a: Record<string, unknown>, body: Uint8Array): FakeReply {
    if (a.session_type !== undefined && a.session_type !== 'sequential' && (a.session_type as { '.tag'?: string })?.['.tag'] !== 'sequential')
      return badRequest('fake: only sequential sessions')
    const id = `sess-${++this.seq}`
    this.sessions.set(id, { parts: body.length ? [body.slice()] : [], length: body.length, createdAt: this.now(), closed: a.close === true })
    return { json: { session_id: id } }
  }

  private sessionAppend(a: Record<string, unknown>, body: Uint8Array): FakeReply {
    const l = this.lookup(a.cursor, false)
    if ('reply' in l) return l.reply
    if (body.length) l.s.parts.push(body.slice())
    l.s.length += body.length
    if (a.close === true) l.s.closed = true
    return { json: null }
  }

  private sessionFinish(a: Record<string, unknown>, body: Uint8Array): FakeReply {
    const c = a.cursor as { offset?: number } | undefined
    const l = this.lookup(c && { ...c, offset: (c.offset ?? 0) as number }, true)
    if ('reply' in l) return l.reply
    const commit = a.commit as Record<string, unknown> | undefined
    if (!commit || typeof commit !== 'object') return badRequest('commit: expected an object')
    const data = new Uint8Array(l.s.length + body.length)
    let o = 0
    for (const part of [...l.s.parts, body]) {
      data.set(part, o)
      o += part.length
    }
    const r = this.commit(commit, data)
    // Dropbox closes the session once it is committed; an error leaves it open for another finish.
    if ((r.status ?? 200) === 200) l.s.closed = true
    return r
  }
}
