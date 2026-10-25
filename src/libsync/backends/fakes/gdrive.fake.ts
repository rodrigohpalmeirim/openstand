/**
 * In-process fake of the Google Drive v3 API subset the Drive backend uses (docs/SYNC-DRIVES.md §4.3, §9.1).
 * Test-only. It enforces Drive's rules so a wrong request fails in tests rather than in production:
 *
 * - Bearer auth on every call (the harness token simulator), Google-style error bodies.
 * - `files.list`: the `q` grammar subset (`'<id>' in parents`, `name =`, `mimeType =`, `trashed =`,
 *   `appProperties has { key='…' and value='…' }`, `and`, `\'` / `\\` escapes; anything else is a 400),
 *   `pageToken` paging in a non-key order, `fields` projection (a field not asked for isn't returned).
 * - Uploads: `multipart/related` (exactly metadata + media), `media`, and resumable sessions (`Location` +
 *   `X-GUploader-UploadID`, chunks in order and multiples of 256 KiB except the last, `Content-Range`,
 *   308 + `Range`, `bytes *\/size` status queries, 404 for expired sessions).
 * - Duplicate names are allowed, as on real Drive; `version` increments on every change.
 *
 * Simulations: query index lag (`indexLag`), a storage quota (`storageQuotaExceeded`), a hidden `Location`
 * header, short chunk writes (the server keeps fewer bytes than sent), expired sessions, injected copies
 * from "another client", and a barrier that forces a create race between clients (`raceCreates`). Rate
 * limits, 5xx and lost responses come from the harness' `fail()` with `GDriveFake.error(…)`.
 */
import { FakeServer, type FakeReply, type FakeRequest } from './harness'

export const DRIVE = 'https://www.googleapis.com/drive/v3'
export const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** Resumable chunks must be multiples of this, except the last. */
export const CHUNK_UNIT = 256 * 1024

export interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  appProperties: Record<string, string>
  description?: string
  data: Uint8Array
  version: number
  createdTime: number
  modifiedTime: number
  trashed: boolean
  /** Queries see the file once `listCalls` passes this. */
  indexedAt: number
}

interface Ghost {
  file: FakeFile
  /** Queries still see the deleted file while `listCalls` ≤ this. */
  goneAt: number
}

interface Session {
  id: string
  /** Metadata from the initiation request (create), or the target id (update). */
  meta: Record<string, unknown>
  target?: string
  size: number
  offset: number
  chunks: Uint8Array[]
  fields: string | null
  expired: boolean
  fileId?: string
}

export interface GDriveFakeOptions {
  now?: () => number
  /** New and deleted files stay invisible to queries for the next n `files.list` calls (default 0). */
  indexLag?: number
  /** Largest page the server returns, whatever `pageSize` asks for (default 1000). */
  pageSize?: number
  /** Leave `Location` out of resumable initiation answers (CORS not exposing it); `X-GUploader-UploadID` stays. */
  hideLocation?: boolean
  /** Storage limit in bytes; writes beyond it get 403 `storageQuotaExceeded`. */
  quotaBytes?: number
  /** Seed for file ids (deterministic). */
  seed?: number
  user?: { displayName: string; emailAddress: string; permissionId: string }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// ---------------------------------------------------------------------------------------------
// `q` grammar subset
// ---------------------------------------------------------------------------------------------

type Pred = (f: FakeFile) => boolean

class QueryError extends Error {}

type Tok = { t: 'str'; v: string } | { t: 'word'; v: string } | { t: 'op'; v: string }

function tokenize(q: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < q.length) {
    const c = q[i]
    if (c === ' ') {
      i++
    } else if (c === "'") {
      let v = ''
      i++
      for (;;) {
        if (i >= q.length) throw new QueryError('unterminated string')
        const d = q[i]
        if (d === '\\') {
          const e = q[i + 1]
          if (e !== "'" && e !== '\\') throw new QueryError('bad escape')
          v += e
          i += 2
        } else if (d === "'") {
          i++
          break
        } else {
          v += d
          i++
        }
      }
      out.push({ t: 'str', v })
    } else if (c === '=' || c === '{' || c === '}') {
      out.push({ t: 'op', v: c })
      i++
    } else if (c === '!' && q[i + 1] === '=') {
      out.push({ t: 'op', v: '!=' })
      i += 2
    } else if (/[A-Za-z]/.test(c)) {
      let v = ''
      while (i < q.length && /[A-Za-z]/.test(q[i])) v += q[i++]
      out.push({ t: 'word', v })
    } else throw new QueryError(`unexpected ${JSON.stringify(c)}`)
  }
  return out
}

export function parseQuery(q: string): Pred {
  const toks = tokenize(q)
  let p = 0
  const peek = () => toks[p]
  const word = (v?: string) => {
    const t = toks[p++]
    if (!t || t.t !== 'word' || (v !== undefined && t.v !== v)) throw new QueryError(`expected ${v ?? 'a word'}`)
    return t.v
  }
  const op = (v: string) => {
    const t = toks[p++]
    if (!t || t.t !== 'op' || t.v !== v) throw new QueryError(`expected ${v}`)
  }
  const str = () => {
    const t = toks[p++]
    if (!t || t.t !== 'str') throw new QueryError('expected a string')
    return t.v
  }
  const term = (): Pred => {
    const t = peek()
    if (!t) throw new QueryError('empty term')
    if (t.t === 'str') {
      const v = str()
      word('in')
      word('parents')
      return (f) => f.parents.includes(v)
    }
    const field = word()
    if (field === 'name') {
      op('=')
      const v = str()
      return (f) => f.name === v
    }
    if (field === 'mimeType') {
      const o = toks[p++]
      if (!o || o.t !== 'op' || (o.v !== '=' && o.v !== '!=')) throw new QueryError('expected = or !=')
      const v = str()
      return o.v === '=' ? (f) => f.mimeType === v : (f) => f.mimeType !== v
    }
    if (field === 'trashed') {
      op('=')
      const v = word()
      if (v !== 'true' && v !== 'false') throw new QueryError('trashed needs true or false')
      return (f) => f.trashed === (v === 'true')
    }
    if (field === 'appProperties') {
      word('has')
      op('{')
      word('key')
      op('=')
      const k = str()
      word('and')
      word('value')
      op('=')
      const v = str()
      op('}')
      return (f) => Object.hasOwn(f.appProperties, k) && f.appProperties[k] === v
    }
    throw new QueryError(`unsupported field ${field}`)
  }
  const preds = [term()]
  while (p < toks.length) {
    word('and')
    preds.push(term())
  }
  return (f) => preds.every((x) => x(f))
}

// ---------------------------------------------------------------------------------------------
// `fields` projection
// ---------------------------------------------------------------------------------------------

type FieldTree = { [k: string]: FieldTree | true }

export function parseFields(s: string): FieldTree {
  let i = 0
  const parse = (): FieldTree => {
    const out: FieldTree = {}
    let name = ''
    const flush = () => {
      if (name) out[name.trim()] = true
      name = ''
    }
    while (i < s.length) {
      const c = s[i++]
      if (c === ',') flush()
      else if (c === '(') {
        out[name.trim()] = parse()
        name = ''
      } else if (c === ')') {
        flush()
        return out
      } else name += c
    }
    flush()
    return out
  }
  return parse()
}

function project(obj: Record<string, unknown>, tree: FieldTree): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, sub] of Object.entries(tree)) {
    const v = obj[k]
    if (v === undefined) continue
    if (sub === true) out[k] = v
    else if (Array.isArray(v)) out[k] = v.map((x) => project(x as Record<string, unknown>, sub))
    else if (v && typeof v === 'object') out[k] = project(v as Record<string, unknown>, sub)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Multipart
// ---------------------------------------------------------------------------------------------

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function parseMultipart(body: Uint8Array, boundary: string): { type: string; body: Uint8Array }[] | null {
  const delim = enc.encode('--' + boundary)
  const starts: number[] = []
  for (let i = indexOf(body, delim, 0); i >= 0; i = indexOf(body, delim, i + delim.length)) starts.push(i)
  if (starts.length < 2 || starts[0] !== 0) return null
  const last = starts[starts.length - 1]
  if (dec.decode(body.subarray(last + delim.length, last + delim.length + 2)) !== '--') return null
  const parts: { type: string; body: Uint8Array }[] = []
  for (let n = 0; n + 1 < starts.length; n++) {
    const raw = body.subarray(starts[n] + delim.length, starts[n + 1])
    // Each part is "\r\n<headers>\r\n\r\n<body>\r\n".
    if (raw[0] !== 13 || raw[1] !== 10 || raw[raw.length - 2] !== 13 || raw[raw.length - 1] !== 10) return null
    const sep = indexOf(raw, enc.encode('\r\n\r\n'), 2)
    if (sep < 0) return null
    const headers = dec.decode(raw.subarray(2, sep)).split('\r\n')
    const type = headers.find((h) => /^content-type:/i.test(h))?.replace(/^content-type:\s*/i, '') ?? ''
    parts.push({ type, body: raw.subarray(sep + 4, raw.length - 2) })
  }
  return parts
}

// ---------------------------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------------------------

const FILE_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([A-Za-z0-9_-]+)(?:\?.*)?$/
const UPLOAD_FILE_RE = /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\/([A-Za-z0-9_-]+)(?:\?.*)?$/
const DEFAULT_FILE_FIELDS = 'kind,id,name,mimeType'

export class GDriveFake extends FakeServer {
  readonly files = new Map<string, FakeFile>()
  readonly sessions = new Map<string, Session>()
  /** Every file ever created, in order (deleted ones included). */
  readonly created: FakeFile[] = []
  /** Ids of deleted files, in order. */
  readonly deleted: string[] = []
  /** `files.list` calls so far (the clock of the index-lag simulation). */
  listCalls = 0
  indexLag: number
  hideLocation: boolean
  quotaBytes?: number
  readonly user: { displayName: string; emailAddress: string; permissionId: string }
  private readonly ghosts: Ghost[] = []
  private readonly maxPage: number
  private seed: number
  private shortWrites = 0
  private readonly races = new Map<string, { need: number; waiting: (() => void)[] }>()

  /** A Google-style error answer, for `fail({ respond })` and the routes. */
  static error(status: number, reason: string, message = reason): FakeReply {
    return { status, json: { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } } }
  }

  constructor(o: GDriveFakeOptions = {}) {
    super({ now: o.now, kind: 'gdrive' })
    this.indexLag = o.indexLag ?? 0
    this.maxPage = o.pageSize ?? 1000
    this.hideLocation = !!o.hideLocation
    this.quotaBytes = o.quotaBytes
    this.seed = o.seed ?? 42
    this.user = o.user ?? { displayName: 'Rod Example', emailAddress: 'rod@example.com', permissionId: '01234567890123456789' }

    this.route('GET', `${DRIVE}/about`, (r) => this.about(r))
    this.route('GET', `${DRIVE}/files`, (r) => this.list(r))
    this.route('POST', `${DRIVE}/files`, (r) => this.createMetadata(r))
    this.route('GET', FILE_RE, (r) => this.getFile(r))
    this.route('DELETE', FILE_RE, (r) => this.deleteFile(r))
    this.route('POST', `${UPLOAD}/files`, (r) => this.uploadCreate(r))
    this.route('PATCH', UPLOAD_FILE_RE, (r) => this.uploadUpdate(r))
    this.route('PUT', `${UPLOAD}/files`, (r) => this.sessionPut(r))
    this.route('PUT', UPLOAD_FILE_RE, (r) => this.sessionPut(r))
  }

  protected unauthorized(): FakeReply {
    const r = GDriveFake.error(401, 'authError', 'Invalid Credentials')
    return { ...r, headers: { 'www-authenticate': 'Bearer realm="https://accounts.google.com/"' } }
  }

  // --- test helpers ----------------------------------------------------------------------------

  /** A folder, created directly (as if by another client or by `ensureRootFolder`). */
  createFolder(o: { name?: string; parent?: string; appProperties?: Record<string, string>; createdTime?: number } = {}): string {
    return this.insert({ name: o.name ?? 'OpenStand', mimeType: FOLDER_MIME, parents: [o.parent ?? 'root'], appProperties: o.appProperties ?? {}, data: new Uint8Array(0), createdTime: o.createdTime }).id
  }

  /** Another client's file (e.g. a duplicate copy), visible to queries at once unless `lag` says otherwise. */
  addFile(o: { name: string; parent: string; data?: Uint8Array; appProperties?: Record<string, string>; createdTime?: number; lag?: number }): FakeFile {
    return this.insert({ name: o.name, mimeType: 'application/octet-stream', parents: [o.parent], appProperties: o.appProperties ?? {}, data: o.data ?? new Uint8Array(0), createdTime: o.createdTime }, o.lag)
  }

  /** Live (non-deleted) files with this name, oldest first. */
  named(name: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.name === name).sort((a, b) => a.createdTime - b.createdTime || (a.id < b.id ? -1 : 1))
  }

  /** Removes a file as another client would (queries may still see it while lagging). */
  remove(id: string): void {
    const f = this.files.get(id)
    if (!f) return
    this.files.delete(id)
    this.deleted.push(id)
    this.ghosts.push({ file: f, goneAt: this.listCalls + this.indexLag })
  }

  /** The next `n` creates named `name` wait until all `n` have arrived, then run in arrival order. */
  raceCreates(name: string, n = 2): void {
    this.races.set(name, { need: n, waiting: [] })
  }

  /** The next `n` chunk PUTs persist only about half their bytes (rounded down to 256 KiB). */
  shortenWrites(n = 1): void {
    this.shortWrites = n
  }

  /** Every open resumable session answers 404 from now on (expired after a week). */
  expireSessions(): void {
    for (const s of this.sessions.values()) s.expired = true
  }

  usage(): number {
    let n = 0
    for (const f of this.files.values()) n += f.data.length
    return n
  }

  // --- internals -------------------------------------------------------------------------------

  private newId(): string {
    let a = (this.seed = (this.seed + 0x6d2b79f5) >>> 0)
    let s = ''
    for (let i = 0; i < 33; i++) {
      a = Math.imul(a ^ (a >>> 15), a | 1) >>> 0
      a = (a ^ (a + Math.imul(a ^ (a >>> 7), a | 61))) >>> 0
      s += ID_ALPHABET[a & 63]
    }
    return s
  }

  private insert(o: { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; data: Uint8Array; description?: string; createdTime?: number }, lag = this.indexLag): FakeFile {
    const t = o.createdTime ?? this.now()
    const f: FakeFile = {
      id: this.newId(),
      name: o.name,
      mimeType: o.mimeType,
      parents: o.parents,
      appProperties: o.appProperties,
      description: o.description,
      data: o.data,
      version: 1,
      createdTime: t,
      modifiedTime: t,
      trashed: false,
      indexedAt: this.listCalls + lag,
    }
    this.files.set(f.id, f)
    this.created.push(f)
    return f
  }

  private resource(f: FakeFile): Record<string, unknown> {
    const folder = f.mimeType === FOLDER_MIME
    const out: Record<string, unknown> = {
      kind: 'drive#file',
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      appProperties: f.appProperties,
      version: String(f.version),
      createdTime: new Date(f.createdTime).toISOString(),
      modifiedTime: new Date(f.modifiedTime).toISOString(),
      trashed: f.trashed,
      webViewLink: folder ? `https://drive.google.com/drive/folders/${f.id}` : `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
    }
    if (f.description !== undefined) out.description = f.description
    if (!folder) out.size = String(f.data.length)
    return out
  }

  private fileReply(f: FakeFile, fields: string | null): FakeReply {
    return { json: project(this.resource(f), parseFields(fields ?? DEFAULT_FILE_FIELDS)) }
  }

  private parentOk(parents: unknown): parents is string[] {
    return Array.isArray(parents) && parents.length === 1 && typeof parents[0] === 'string' && (parents[0] === 'root' || this.files.get(parents[0])?.mimeType === FOLDER_MIME)
  }

  private overQuota(extra: number): boolean {
    return this.quotaBytes !== undefined && this.usage() + extra > this.quotaBytes
  }

  private quotaError(): FakeReply {
    return GDriveFake.error(403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota')
  }

  private async raceGate(name: string): Promise<void> {
    const race = this.races.get(name)
    if (!race) return
    await new Promise<void>((resolve) => {
      race.waiting.push(resolve)
      if (race.waiting.length >= race.need) {
        this.races.delete(name)
        for (const w of race.waiting) w()
      }
    })
  }

  /** Validates create metadata; returns an error reply or the fields for `insert`. */
  private createMeta(meta: Record<string, unknown>): { error: FakeReply } | { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; description?: string } {
    if (typeof meta.name !== 'string' || !meta.name) return { error: GDriveFake.error(400, 'required', 'name is required (fake)') }
    const parents = meta.parents ?? ['root']
    if (!this.parentOk(parents)) return { error: GDriveFake.error(404, 'notFound', 'File not found: parent') }
    const ap = (meta.appProperties ?? {}) as Record<string, unknown>
    const appProperties: Record<string, string> = {}
    for (const [k, v] of Object.entries(ap)) {
      if (typeof v !== 'string') return { error: GDriveFake.error(400, 'invalid', 'appProperties values are strings') }
      if (enc.encode(k + v).length > 124) return { error: GDriveFake.error(400, 'invalid', 'appProperty too long') }
      appProperties[k] = v
    }
    if (Object.keys(appProperties).length > 30) return { error: GDriveFake.error(400, 'invalid', 'too many appProperties') }
    const known = new Set(['name', 'parents', 'appProperties', 'mimeType', 'description'])
    const extra = Object.keys(meta).filter((k) => !known.has(k))
    if (extra.length) return { error: GDriveFake.error(400, 'invalid', `unexpected metadata ${extra.join(',')} (fake)`) }
    return {
      name: meta.name,
      mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
      parents: parents as string[],
      appProperties,
      description: typeof meta.description === 'string' ? meta.description : undefined,
    }
  }

  private visible(): FakeFile[] {
    const c = this.listCalls
    const live = [...this.files.values()].filter((f) => c > f.indexedAt)
    const ghosts = this.ghosts.filter((g) => c <= g.goneAt).map((g) => g.file)
    return [...live, ...ghosts]
  }

  // --- routes ----------------------------------------------------------------------------------

  private about(r: FakeRequest): FakeReply {
    const fields = r.url.searchParams.get('fields')
    if (!fields) return GDriveFake.error(400, 'required', 'The fields parameter is required for this method.')
    const storageQuota: Record<string, string> = { usage: String(this.usage()) }
    if (this.quotaBytes !== undefined) storageQuota.limit = String(this.quotaBytes)
    return { json: project({ kind: 'drive#about', user: { kind: 'drive#user', ...this.user }, storageQuota }, parseFields(fields)) }
  }

  private list(r: FakeRequest): FakeReply {
    this.listCalls++
    const sp = r.url.searchParams
    const spaces = sp.get('spaces')
    if (spaces !== null && spaces !== 'drive') return GDriveFake.error(400, 'invalid', 'spaces')
    let pred: Pred = () => true
    const q = sp.get('q')
    if (q !== null) {
      try {
        pred = parseQuery(q)
      } catch (e) {
        return GDriveFake.error(400, 'invalid', `Invalid Value: q (${(e as Error).message})`)
      }
    }
    const pageSize = Math.min(Number(sp.get('pageSize') ?? 100), 1000, this.maxPage)
    if (!Number.isInteger(pageSize) || pageSize < 1) return GDriveFake.error(400, 'invalid', 'pageSize')
    // Not in name order: callers must sort.
    const all = this.visible()
      .filter(pred)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const token = sp.get('pageToken')
    const start = token === null ? 0 : Number(/^p(\d+)$/.exec(token)?.[1] ?? NaN)
    if (!Number.isInteger(start)) return GDriveFake.error(400, 'invalid', 'Invalid Value: pageToken')
    const page = all.slice(start, start + pageSize)
    const out: Record<string, unknown> = { kind: 'drive#fileList', incompleteSearch: false, files: page.map((f) => this.resource(f)) }
    if (start + pageSize < all.length) out.nextPageToken = `p${start + pageSize}`
    const fields = sp.get('fields') ?? `kind,nextPageToken,incompleteSearch,files(${DEFAULT_FILE_FIELDS})`
    return { json: project(out, parseFields(fields)) }
  }

  private createMetadata(r: FakeRequest): FakeReply {
    if (!/^application\/json/.test(r.headers.get('content-type') ?? '')) return GDriveFake.error(400, 'badContent', 'JSON body expected (fake)')
    const m = this.createMeta(r.json<Record<string, unknown>>())
    if ('error' in m) return m.error
    if (m.mimeType !== FOLDER_MIME) return GDriveFake.error(400, 'invalid', 'metadata-only creates are folders here (fake)')
    return this.fileReply(this.insert({ ...m, data: new Uint8Array(0) }), r.url.searchParams.get('fields'))
  }

  private getFile(r: FakeRequest): FakeReply {
    const f = this.files.get(r.params[0])
    if (!f) return GDriveFake.error(404, 'notFound', `File not found: ${r.params[0]}.`)
    const alt = r.url.searchParams.get('alt')
    if (alt === null) return this.fileReply(f, r.url.searchParams.get('fields'))
    if (alt !== 'media') return GDriveFake.error(400, 'invalid', 'alt')
    if (f.mimeType === FOLDER_MIME) return GDriveFake.error(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.')
    const range = r.headers.get('range')
    if (range === null) return { body: f.data, headers: { 'content-type': 'application/octet-stream' } }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!m) return { body: f.data, headers: { 'content-type': 'application/octet-stream' } }
    const a = Number(m[1])
    const b = m[2] === '' ? f.data.length - 1 : Math.min(Number(m[2]), f.data.length - 1)
    if (a >= f.data.length || a > b) return { status: 416, text: 'Request range not satisfiable', headers: { 'content-range': `bytes */${f.data.length}` } }
    return { status: 206, body: f.data.slice(a, b + 1), headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${f.data.length}` } }
  }

  private deleteFile(r: FakeRequest): FakeReply {
    if (!this.files.has(r.params[0])) return GDriveFake.error(404, 'notFound', `File not found: ${r.params[0]}.`)
    this.remove(r.params[0])
    return { status: 204 }
  }

  private async uploadCreate(r: FakeRequest): Promise<FakeReply> {
    const type = r.url.searchParams.get('uploadType')
    if (type === 'resumable') return this.initiate(r)
    if (type !== 'multipart') return GDriveFake.error(400, 'invalid', `uploadType ${type} isn't used for creates (fake)`)
    const ct = r.headers.get('content-type') ?? ''
    const boundary = /^multipart\/related;\s*boundary=("?)([^";]+)\1$/i.exec(ct)?.[2]
    if (!boundary) return GDriveFake.error(400, 'badContent', 'multipart/related with a boundary expected')
    const parts = parseMultipart(r.body, boundary)
    if (!parts || parts.length !== 2 || !/^application\/json/i.test(parts[0].type) || !parts[1].type)
      return GDriveFake.error(400, 'badContent', 'Malformed multipart body.')
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(dec.decode(parts[0].body)) as Record<string, unknown>
    } catch {
      return GDriveFake.error(400, 'parseError', 'Parse Error')
    }
    const m = this.createMeta(meta)
    if ('error' in m) return m.error
    await this.raceGate(m.name)
    if (this.overQuota(parts[1].body.length)) return this.quotaError()
    // Re-check the parent: it may have gone while the create was held.
    if (!this.parentOk(m.parents)) return GDriveFake.error(404, 'notFound', 'File not found: parent')
    return this.fileReply(this.insert({ ...m, data: parts[1].body.slice() }), r.url.searchParams.get('fields'))
  }

  private uploadUpdate(r: FakeRequest): FakeReply {
    const f = this.files.get(r.params[0])
    if (!f) return GDriveFake.error(404, 'notFound', `File not found: ${r.params[0]}.`)
    const type = r.url.searchParams.get('uploadType')
    if (type === 'resumable') return this.initiate(r, f)
    if (type !== 'media') return GDriveFake.error(400, 'invalid', `uploadType ${type} isn't used for updates (fake)`)
    if (!r.headers.get('content-type')) return GDriveFake.error(400, 'badContent', 'Content-Type required')
    if (this.overQuota(r.body.length - f.data.length)) return this.quotaError()
    this.write(f, r.body.slice())
    return this.fileReply(f, r.url.searchParams.get('fields'))
  }

  private write(f: FakeFile, data: Uint8Array): void {
    f.data = data
    f.version++
    f.modifiedTime = Math.max(this.now(), f.modifiedTime)
  }

  private initiate(r: FakeRequest, target?: FakeFile): FakeReply {
    const len = r.headers.get('x-upload-content-length')
    if (len === null || !/^\d+$/.test(len)) return GDriveFake.error(400, 'badRequest', 'X-Upload-Content-Length expected (fake)')
    if (!r.headers.get('x-upload-content-type')) return GDriveFake.error(400, 'badRequest', 'X-Upload-Content-Type expected (fake)')
    let meta: Record<string, unknown> = {}
    if (r.body.length) {
      if (!/^application\/json/.test(r.headers.get('content-type') ?? '')) return GDriveFake.error(400, 'badContent', 'JSON metadata expected')
      meta = r.json<Record<string, unknown>>()
    }
    if (target) {
      if (Object.keys(meta).length) return GDriveFake.error(400, 'invalid', 'metadata changes on update are not used (fake)')
    } else {
      const m = this.createMeta(meta)
      if ('error' in m) return m.error
    }
    if (this.overQuota(Number(len) - (target?.data.length ?? 0))) return this.quotaError()
    const id = 'up' + this.newId()
    this.sessions.set(id, { id, meta, target: target?.id, size: Number(len), offset: 0, chunks: [], fields: r.url.searchParams.get('fields'), expired: false })
    const uri = new URL(r.url.href)
    uri.searchParams.set('upload_id', id)
    const headers: Record<string, string> = { 'x-guploader-uploadid': id }
    if (!this.hideLocation) headers.location = uri.href
    return { status: 200, headers, text: '' }
  }

  private async sessionPut(r: FakeRequest): Promise<FakeReply> {
    const id = r.url.searchParams.get('upload_id')
    if (r.url.searchParams.get('uploadType') !== 'resumable' || !id) return GDriveFake.error(400, 'invalid', 'not a session URI (fake)')
    const s = this.sessions.get(id)
    if (!s || s.expired) return { status: 404, text: 'Not Found' }
    const cr = r.headers.get('content-range') ?? ''
    const done = () => {
      const f = this.files.get(s.fileId!)
      return f ? this.fileReply(f, s.fields) : GDriveFake.error(404, 'notFound', 'File not found.')
    }
    const progress = (): FakeReply => ({ status: 308, headers: s.offset > 0 ? { range: `bytes=0-${s.offset - 1}` } : {}, text: '' })
    const status = /^bytes \*\/(\d+)$/.exec(cr)
    if (status) {
      if (Number(status[1]) !== s.size || r.body.length) return GDriveFake.error(400, 'badRequest', 'Bad status query')
      return s.fileId ? done() : progress()
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr)
    if (!m) return GDriveFake.error(400, 'badRequest', 'Content-Range required')
    if (s.fileId) return done()
    const [a, b, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (total !== s.size) return GDriveFake.error(400, 'badRequest', 'Content-Range total does not match the session')
    if (a !== s.offset) return GDriveFake.error(400, 'badRequest', `Chunk must start at ${s.offset} (fake)`)
    if (b < a || b >= total || r.body.length !== b - a + 1) return GDriveFake.error(400, 'badRequest', 'Content-Range does not match the body')
    const last = b + 1 === total
    if (!last && r.body.length % CHUNK_UNIT !== 0) return GDriveFake.error(400, 'badRequest', 'Chunks must be multiples of 256 KiB except the last')
    let keep = r.body.length
    if (!last && this.shortWrites > 0) {
      this.shortWrites--
      keep = Math.floor(r.body.length / 2 / CHUNK_UNIT) * CHUNK_UNIT
    }
    s.chunks.push(r.body.slice(0, keep))
    s.offset += keep
    if (s.offset < s.size) return progress()
    const data = new Uint8Array(s.size)
    let o = 0
    for (const c of s.chunks) {
      data.set(c, o)
      o += c.length
    }
    if (s.target) {
      const f = this.files.get(s.target)
      if (!f) return GDriveFake.error(404, 'notFound', `File not found: ${s.target}.`)
      if (this.overQuota(data.length - f.data.length)) return this.quotaError()
      this.write(f, data)
      s.fileId = f.id
    } else {
      const meta = this.createMeta(s.meta)
      if ('error' in meta) return meta.error
      await this.raceGate(meta.name)
      if (this.overQuota(data.length)) return this.quotaError()
      s.fileId = this.insert({ ...meta, data }).id
    }
    return done()
  }
}

/** A `Request`-less view for assertions: the decoded `q` of a recorded `files.list` call. */
export function queryOf(url: string): string | null {
  return new URL(url).searchParams.get('q')
}

export function isList(c: { method: string; url: string }): boolean {
  return c.method === 'GET' && new URL(c.url).pathname === '/drive/v3/files'
}

