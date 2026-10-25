/**
 * In-process fake of the Microsoft Graph subset the OneDrive backend uses (docs/SYNC-DRIVES.md §9.1):
 * the app folder (`/me/drive/special/approot`) addressed by path, `children` paging with
 * `@odata.nextLink`, simple uploads with `@microsoft.graph.conflictBehavior`, folder creation, upload
 * sessions, `@microsoft.graph.downloadUrl` with Range, `permanentDelete`, DELETE and `/me`.
 *
 * It enforces what Graph enforces, so a wrong request fails here rather than in production: a bearer token on
 * Graph URLs and **no** `Authorization` on `uploadUrl`/`downloadUrl` (401); fragments in order, with a
 * `Content-Range` matching the body, a multiple of 327,680 B except the last, under 60 MiB (400); a
 * repeated fragment gets 416; paths are case-insensitive. Test-only.
 */
import { FakeServer, type FakeReply, type FakeRequest } from './harness'

const BASE = 'https://graph.microsoft.com/v1.0/me/drive/special/approot'
const ROUTE = /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/special\/approot(?=[:/?]|$)/
const UPLOAD = 'https://fake.up.1drv.com/up/'
const DOWNLOAD = 'https://fake.files.1drv.com/dl/'
const UNIT = 320 * 1024
const FRAGMENT_MAX = 60 * 1024 * 1024
const SIMPLE_MAX = 250 * 1000 * 1000
const SESSION_TTL = 15 * 60_000

export interface GraphFakeOptions {
  now?: () => number
  /** `children` page size (Graph's default is 200). */
  pageSize?: number
  /** Path PUTs and createUploadSession create missing parent folders (default true; verify (e2e)). */
  autoCreateParents?: boolean
  /** `permanentDelete`: true works (default); false answers 403; a number answers that status. */
  permanentDelete?: boolean | number
  /** A `downloadUrl` works this many times, then answers 401 (default unlimited). */
  downloadUrlUses?: number
  /** Total bytes the drive holds; a write past it gets 507 `quotaLimitReached`. */
  quota?: number
  driveId?: string
  /** The app folder's name (the app registration's name). */
  appName?: string
}

interface Node {
  id: string
  name: string
  parent: Node | null
  /** Folders only; keyed by lower-case name. */
  children?: Map<string, Node>
  /** Files only. */
  data?: Uint8Array
  version: number
  created: number
  modified: number
}

interface Session {
  id: string
  /** Parent segments and file name inside approot. */
  parent: string[]
  name: string
  size?: number
  received: number
  parts: Uint8Array[]
  expiresAt: number
}

const graphErr = (status: number, code: string, message = code, headers?: Record<string, string>): FakeReply => ({
  status,
  json: { error: { code, message } },
  headers,
})

export class GraphFake extends FakeServer {
  readonly opts: Required<Omit<GraphFakeOptions, 'now' | 'quota'>> & { quota?: number }
  readonly root: Node
  private readonly byId = new Map<string, Node>()
  readonly sessions = new Map<string, Session>()
  private readonly downloads = new Map<string, { id: string; left: number }>()
  private seq = 0
  /** Items sent to the recycle bin by plain DELETE. */
  recycled = 0
  /** Successful `permanentDelete` calls. */
  permanentDeletes = 0

  constructor(o: GraphFakeOptions = {}) {
    super({ now: o.now, kind: 'onedrive' })
    this.opts = {
      pageSize: o.pageSize ?? 200,
      autoCreateParents: o.autoCreateParents ?? true,
      permanentDelete: o.permanentDelete ?? true,
      downloadUrlUses: o.downloadUrlUses ?? Infinity,
      driveId: o.driveId ?? 'drive-0123456789abcdef',
      appName: o.appName ?? 'OpenStand',
      quota: o.quota,
    }
    this.root = this.node(this.opts.appName, null, true)

    this.route('GET', 'https://graph.microsoft.com/v1.0/me', () => ({
      json: { id: 'user-1', displayName: 'Rod Example', mail: 'rod@example.com', userPrincipalName: 'rod@example.com' },
    }))
    for (const m of ['GET', 'PUT', 'POST', 'DELETE']) this.route(m, ROUTE, (req) => this.graph(req))
    const upload = new RegExp('^' + UPLOAD.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '([A-Za-z0-9-]+)$')
    this.route('PUT', upload, (req) => this.preauth(req) ?? this.fragment(req), { auth: false })
    this.route('GET', upload, (req) => this.preauth(req) ?? this.sessionStatus(req.params[0]), { auth: false })
    this.route('DELETE', upload, (req) => this.preauth(req) ?? this.cancelSession(req.params[0]), { auth: false })
    const dl = new RegExp('^' + DOWNLOAD.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '([A-Za-z0-9-]+)$')
    this.route('GET', dl, (req) => this.preauth(req) ?? this.download(req), { auth: false })
  }

  protected unauthorized(): FakeReply {
    return graphErr(401, 'InvalidAuthenticationToken', 'Access token has expired or is not yet valid.', { 'www-authenticate': 'Bearer' })
  }

  // --- test helpers ----------------------------------------------------------------------------

  /** File at a path inside approot (`a/b/c~d`), case-insensitive. */
  file(path: string): Uint8Array | undefined {
    return this.resolve(path.split('/').filter(Boolean))?.data
  }

  /** Every file path inside approot, sorted. */
  paths(): string[] {
    const out: string[] = []
    const walk = (n: Node, p: string[]) => {
      for (const c of n.children?.values() ?? []) {
        if (c.children) walk(c, [...p, c.name])
        else out.push([...p, c.name].join('/'))
      }
    }
    walk(this.root, [])
    return out.sort()
  }

  /** Every folder path inside approot, sorted. */
  folders(): string[] {
    const out: string[] = []
    const walk = (n: Node, p: string[]) => {
      for (const c of n.children?.values() ?? []) {
        if (!c.children) continue
        out.push([...p, c.name].join('/'))
        walk(c, [...p, c.name])
      }
    }
    walk(this.root, [])
    return out.sort()
  }

  /** Puts a file directly (e.g. a stray file someone created by hand). */
  seed(path: string, data: Uint8Array): void {
    const segs = path.split('/').filter(Boolean)
    const parent = this.mkdirs(segs.slice(0, -1))!
    this.write(parent, segs[segs.length - 1], data)
  }

  expireUploadSessions(): void {
    for (const s of this.sessions.values()) s.expiresAt = -Infinity
  }

  expireDownloadUrls(): void {
    for (const d of this.downloads.values()) d.left = 0
  }

  // --- tree ------------------------------------------------------------------------------------

  private node(name: string, parent: Node | null, folder: boolean): Node {
    const t = this.now()
    const n: Node = { id: `item-${++this.seq}`, name, parent, version: 1, created: t, modified: t }
    if (folder) n.children = new Map()
    this.byId.set(n.id, n)
    return n
  }

  private resolve(segs: string[]): Node | undefined {
    let n: Node | undefined = this.root
    for (const s of segs) {
      n = n?.children?.get(s.toLowerCase())
      if (!n) return undefined
    }
    return n
  }

  /** Creates missing folders; undefined if a path component is a file. */
  private mkdirs(segs: string[]): Node | undefined {
    let n = this.root
    for (const s of segs) {
      let c = n.children!.get(s.toLowerCase())
      if (!c) {
        c = this.node(s, n, true)
        n.children!.set(s.toLowerCase(), c)
      }
      if (!c.children) return undefined
      n = c
    }
    return n
  }

  private used(): number {
    let total = 0
    for (const n of this.byId.values()) total += n.data?.length ?? 0
    return total
  }

  private write(parent: Node, name: string, data: Uint8Array): { node: Node; created: boolean } {
    const existing = parent.children!.get(name.toLowerCase())
    if (existing) {
      existing.data = data
      existing.version++
      existing.modified = this.now()
      return { node: existing, created: false }
    }
    const n = this.node(name, parent, false)
    n.data = data
    parent.children!.set(name.toLowerCase(), n)
    return { node: n, created: true }
  }

  private remove(n: Node): void {
    n.parent?.children!.delete(n.name.toLowerCase())
    const drop = (x: Node) => {
      this.byId.delete(x.id)
      for (const c of x.children?.values() ?? []) drop(c)
    }
    drop(n)
  }

  private pathOf(n: Node): string[] {
    const out: string[] = []
    for (let x: Node | null = n; x && x !== this.root; x = x.parent) out.unshift(x.name)
    return out
  }

  private json(n: Node, select: string | null): Record<string, unknown> {
    const parentPath = n.parent ? ['/drive/root:/Apps', ...this.pathOf(n.parent).map(encodeURIComponent)].join('/').replace(/\/$/, '') : '/drive/root:/Apps'
    const full: Record<string, unknown> = {
      id: n.id,
      name: n.name,
      size: n.data ? n.data.length : 0,
      eTag: `"{${n.id}},${n.version}"`,
      cTag: `"c:{${n.id}},${n.version}"`,
      createdDateTime: new Date(n.created).toISOString(),
      lastModifiedDateTime: new Date(n.modified).toISOString(),
      webUrl: `https://onedrive.live.com/?id=${n.id}`,
      parentReference: { driveId: this.opts.driveId, driveType: 'personal', id: n.parent?.id ?? 'root-id', path: parentPath },
    }
    if (n.children) full.folder = { childCount: n.children.size }
    else {
      full.file = { mimeType: 'application/octet-stream' }
      full['@microsoft.graph.downloadUrl'] = this.downloadUrl(n)
    }
    if (!select) return full
    const want = new Set(select.split(','))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(full)) if (want.has(k)) out[k] = full[k]
    // Graph only mints a download link when it is asked for (or nothing is selected).
    if (!want.has('@microsoft.graph.downloadUrl')) delete out['@microsoft.graph.downloadUrl']
    return out
  }

  private downloadUrl(n: Node): string {
    const token = `d${++this.seq}`
    this.downloads.set(token, { id: n.id, left: this.opts.downloadUrlUses })
    return DOWNLOAD + token
  }

  // --- Graph (bearer) --------------------------------------------------------------------------

  private graph(req: FakeRequest): FakeReply {
    const rest = req.url.pathname.slice('/v1.0/me/drive/special/approot'.length)
    let segs: string[]
    let action: string | undefined
    if (rest === '' || rest === '/children') {
      segs = []
      action = rest ? 'children' : undefined
    } else if (rest.startsWith(':/')) {
      const parts = rest.slice(2).split(':')
      if (parts.length > 2 || (parts.length === 2 && parts[1] !== '' && !parts[1].startsWith('/'))) return this.unknown(req)
      action = parts[1] ? parts[1].slice(1) : undefined
      try {
        segs = parts[0].split('/').map(decodeURIComponent)
      } catch {
        return graphErr(400, 'invalidRequest', 'bad path encoding')
      }
      if (segs.some((s) => !s || /["*:<>?\\|]/.test(s) || s.endsWith('.')))
        return graphErr(400, 'invalidRequest', 'invalid name')
    } else return this.unknown(req)

    const select = req.url.searchParams.get('$select')
    const m = req.method
    if (m === 'GET' && action === undefined) {
      const n = this.resolve(segs)
      return n ? { json: this.json(n, select) } : graphErr(404, 'itemNotFound')
    }
    if (m === 'GET' && action === 'children') return this.children(req, segs, select)
    if (m === 'PUT' && action === 'content') return this.simpleUpload(req, segs)
    if (m === 'POST' && action === 'children') return this.createFolder(req, segs)
    if (m === 'POST' && action === 'createUploadSession') return this.createSession(req, segs)
    if (m === 'POST' && action === 'permanentDelete') return this.deleteItem(segs, true)
    if (m === 'DELETE' && action === undefined) return this.deleteItem(segs, false)
    return this.unknown(req)
  }

  private unknown(req: FakeRequest): FakeReply {
    this.unmatched.push(`${req.method} ${req.url.href}`)
    return graphErr(400, 'invalidRequest', 'fake: unsupported request')
  }

  private children(req: FakeRequest, segs: string[], select: string | null): FakeReply {
    const n = this.resolve(segs)
    if (!n) return graphErr(404, 'itemNotFound')
    if (!n.children) return graphErr(400, 'invalidRequest', 'not a folder')
    // An order that isn't by name, so clients must sort.
    const all = [...n.children.values()].sort((a, b) => hash(a.name) - hash(b.name) || (a.name < b.name ? -1 : 1))
    const skip = Number(req.url.searchParams.get('$skiptoken') ?? 0)
    const page = all.slice(skip, skip + this.opts.pageSize)
    const out: Record<string, unknown> = { value: page.map((c) => this.json(c, select)) }
    if (skip + this.opts.pageSize < all.length) {
      const next = new URL(req.url.href)
      next.searchParams.set('$skiptoken', String(skip + this.opts.pageSize))
      out['@odata.nextLink'] = next.href
    }
    return { json: out }
  }

  private conflict(req: FakeRequest, fromBody?: unknown): string | FakeReply {
    const v = fromBody ?? req.url.searchParams.get('@microsoft.graph.conflictBehavior') ?? 'replace'
    if (v !== 'fail' && v !== 'replace' && v !== 'rename') return graphErr(400, 'invalidRequest', 'bad conflictBehavior')
    if (v === 'rename') return graphErr(400, 'invalidRequest', 'fake: rename not supported')
    return v
  }

  private parentFor(segs: string[]): Node | FakeReply {
    const parentSegs = segs.slice(0, -1)
    const existing = this.resolve(parentSegs)
    if (existing) return existing.children ? existing : graphErr(409, 'nameAlreadyExists', 'a parent is a file')
    if (!this.opts.autoCreateParents) return graphErr(404, 'itemNotFound', 'parent not found')
    return this.mkdirs(parentSegs) ?? graphErr(409, 'nameAlreadyExists', 'a parent is a file')
  }

  private overQuota(extra: number): boolean {
    return this.opts.quota !== undefined && this.used() + extra > this.opts.quota
  }

  private simpleUpload(req: FakeRequest, segs: string[]): FakeReply {
    if (!segs.length) return graphErr(400, 'invalidRequest')
    const behavior = this.conflict(req)
    if (typeof behavior !== 'string') return behavior
    if (req.body.length > SIMPLE_MAX) return graphErr(413, 'requestTooLarge')
    const parent = this.parentFor(segs)
    if (!('id' in parent)) return parent
    const name = segs[segs.length - 1]
    const existing = parent.children!.get(name.toLowerCase())
    if (existing && behavior === 'fail') return graphErr(409, 'nameAlreadyExists', 'The specified item name already exists.')
    if (existing?.children) return graphErr(409, 'nameAlreadyExists', 'a folder has that name')
    if (this.overQuota(req.body.length)) return graphErr(507, 'quotaLimitReached', 'Insufficient Storage')
    const { node, created } = this.write(parent, name, req.body.slice())
    return { status: created ? 201 : 200, json: this.json(node, null) }
  }

  private createFolder(req: FakeRequest, segs: string[]): FakeReply {
    const parent = this.resolve(segs)
    if (!parent) return graphErr(404, 'itemNotFound')
    if (!parent.children) return graphErr(400, 'invalidRequest', 'not a folder')
    let b: { name?: unknown; folder?: unknown; '@microsoft.graph.conflictBehavior'?: unknown }
    try {
      b = req.json()
    } catch {
      return graphErr(400, 'invalidRequest', 'bad JSON')
    }
    if (typeof b.name !== 'string' || !b.name || typeof b.folder !== 'object') return graphErr(400, 'invalidRequest')
    const behavior = this.conflict(req, b['@microsoft.graph.conflictBehavior'] ?? 'fail')
    if (typeof behavior !== 'string') return behavior
    const existing = parent.children.get(b.name.toLowerCase())
    if (existing) {
      if (behavior === 'fail' || !existing.children) return graphErr(409, 'nameAlreadyExists')
      return { json: this.json(existing, null) }
    }
    const n = this.node(b.name, parent, true)
    parent.children.set(b.name.toLowerCase(), n)
    return { status: 201, json: this.json(n, null) }
  }

  private createSession(req: FakeRequest, segs: string[]): FakeReply {
    if (!segs.length) return graphErr(400, 'invalidRequest')
    let b: { item?: { '@microsoft.graph.conflictBehavior'?: unknown } }
    try {
      b = req.body.length ? req.json() : {}
    } catch {
      return graphErr(400, 'invalidRequest', 'bad JSON')
    }
    const behavior = this.conflict(req, b.item?.['@microsoft.graph.conflictBehavior'] ?? 'replace')
    if (typeof behavior !== 'string') return behavior
    const parent = this.parentFor(segs)
    if (!('id' in parent)) return parent
    if (behavior === 'fail' && parent.children!.has(segs[segs.length - 1].toLowerCase())) return graphErr(409, 'nameAlreadyExists')
    const id = `s${++this.seq}-${Math.random().toString(36).slice(2, 10)}`
    const s: Session = { id, parent: segs.slice(0, -1), name: segs[segs.length - 1], received: 0, parts: [], expiresAt: this.now() + SESSION_TTL }
    this.sessions.set(id, s)
    return { json: { uploadUrl: UPLOAD + id, expirationDateTime: new Date(s.expiresAt).toISOString(), nextExpectedRanges: ['0-'] } }
  }

  private deleteItem(segs: string[], permanent: boolean): FakeReply {
    if (!segs.length) return graphErr(403, 'accessDenied', 'cannot delete the app folder')
    if (permanent && this.opts.permanentDelete !== true) {
      const status = this.opts.permanentDelete === false ? 403 : this.opts.permanentDelete
      return graphErr(status, status === 403 ? 'accessDenied' : 'notSupported')
    }
    const n = this.resolve(segs)
    if (!n) return graphErr(404, 'itemNotFound')
    this.remove(n)
    if (permanent) this.permanentDeletes++
    else this.recycled++
    return { status: 204 }
  }

  // --- pre-authenticated URLs ------------------------------------------------------------------

  /** Upload and download URLs carry their own credentials; Graph answers 401 to a bearer token there. */
  private preauth(req: FakeRequest): FakeReply | null {
    return req.headers.has('authorization') ? graphErr(401, 'unauthenticated', 'Authorization is not allowed on this URL') : null
  }

  private live(id: string): Session | null {
    const s = this.sessions.get(id)
    if (!s) return null
    if (this.now() > s.expiresAt) {
      this.sessions.delete(id)
      return null
    }
    return s
  }

  private status(s: Session): Record<string, unknown> {
    return { expirationDateTime: new Date(s.expiresAt).toISOString(), nextExpectedRanges: [`${s.received}-${s.size !== undefined ? s.size - 1 : ''}`] }
  }

  private sessionStatus(id: string): FakeReply {
    const s = this.live(id)
    return s ? { json: this.status(s) } : graphErr(404, 'itemNotFound', 'The upload session was not found')
  }

  private cancelSession(id: string): FakeReply {
    if (!this.live(id)) return graphErr(404, 'itemNotFound')
    this.sessions.delete(id)
    return { status: 204 }
  }

  private fragment(req: FakeRequest): FakeReply {
    const s = this.live(req.params[0])
    if (!s) return graphErr(404, 'itemNotFound', 'The upload session was not found')
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers.get('content-range') ?? '')
    if (!m) return graphErr(400, 'invalidRequest', 'Content-Range is required')
    const [a, b, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const len = b - a + 1
    if (b < a || len !== req.body.length) return graphErr(400, 'invalidRequest', 'Content-Range does not match the body')
    if (s.size !== undefined && total !== s.size) return graphErr(400, 'invalidRequest', 'the total size changed')
    if (b >= total) return graphErr(400, 'invalidRequest', 'range past the end')
    const last = b + 1 === total
    if ((!last && len % UNIT !== 0) || len >= FRAGMENT_MAX) return graphErr(400, 'invalidRequest', `fragment of ${len} bytes is not a multiple of ${UNIT}`)
    if (a !== s.received) return graphErr(416, 'invalidRange', `expected ${s.received}`)
    s.size = total
    s.parts.push(req.body.slice())
    s.received += len
    s.expiresAt = this.now() + SESSION_TTL
    if (s.received < total) return { status: 202, json: this.status(s) }
    const data = new Uint8Array(total)
    let o = 0
    for (const p of s.parts) {
      data.set(p, o)
      o += p.length
    }
    this.sessions.delete(s.id)
    const parent = this.parentFor([...s.parent, s.name])
    if (!('id' in parent)) return parent
    if (this.overQuota(total)) return graphErr(507, 'quotaLimitReached', 'Insufficient Storage')
    const { node, created } = this.write(parent, s.name, data)
    return { status: created ? 201 : 200, json: this.json(node, null) }
  }

  private download(req: FakeRequest): FakeReply {
    const d = this.downloads.get(req.params[0])
    if (!d || d.left <= 0) return graphErr(401, 'unauthenticated', 'expired link')
    d.left--
    const n = this.byId.get(d.id)
    if (!n?.data) return graphErr(404, 'itemNotFound')
    const data = n.data
    const range = req.headers.get('range')
    if (!range) return { body: data.slice(), headers: { 'content-type': 'application/octet-stream' } }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!m) return { body: data.slice() }
    const a = Number(m[1])
    const b = Math.min(m[2] ? Number(m[2]) : data.length - 1, data.length - 1)
    if (a >= data.length || b < a) return { status: 416, headers: { 'content-range': `bytes */${data.length}` } }
    return { status: 206, body: data.slice(a, b + 1), headers: { 'content-range': `bytes ${a}-${b}/${data.length}` } }
  }
}

/** Deterministic, name-independent-looking order for `children`. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export { BASE as GRAPH_APPROOT, UPLOAD as GRAPH_UPLOAD_PREFIX, DOWNLOAD as GRAPH_DOWNLOAD_PREFIX }
