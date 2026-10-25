/**
 * OneDrive through Microsoft Graph, in the app folder (`special/approot`, docs/SYNC-DRIVES.md §4.2).
 *
 * Keys map through `deep3`: the first `min(n−1, 3)` segments are real folders, deeper segments are joined
 * with `~` into the file name, so every hot prefix (`heads/`, `log/<dev>/`, `blobs/`) is one folder and a
 * poll is one `children` request. Reads go through the pre-authenticated `@microsoft.graph.downloadUrl`
 * (the `/content` 302 can't be followed by an authorised CORS request); large writes use upload sessions
 * whose URL is pre-authenticated too, so neither ever carries `Authorization`.
 *
 * Never log or put in errors: tokens, `uploadUrl`, `downloadUrl`.
 */
import { ERROR_BODY_MAX, JSON_MAX, OAuthHttp, type SendInit } from './http'
import { deep3, fromDeep3, MAX_DEPTH, prefixScope, segments } from './keymap'
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
  type ListPage,
  type ObjectInfo,
  type OneDriveConfig,
  type StorageBackend,
  type UploadState,
} from './types'
import { LIST_MAX_KEYS, tooLarge } from './util'

const MiB = 1024 * 1024
const NAME = 'OneDrive'

export const GRAPH = 'https://graph.microsoft.com/v1.0'
/** The app folder; Graph creates it on first access. */
export const APPROOT = `${GRAPH}/me/drive/special/approot`
/** Upload fragments must be multiples of this (except the last), and smaller than `FRAGMENT_MAX`. */
export const FRAGMENT_UNIT = 320 * 1024
export const FRAGMENT_MAX = 60 * MiB
/** How long a `downloadUrl` is reused for the same key (they expire within minutes). */
const DOWNLOAD_URL_TTL = 60_000
const DOWNLOAD_URL_CACHE = 256

const SELECT_ITEM = 'id,size,eTag,lastModifiedDateTime,file'
const SELECT_CHILDREN = 'id,name,size,eTag,lastModifiedDateTime,file,folder'
const SELECT_DOWNLOAD = 'id,size,file,@microsoft.graph.downloadUrl'

export interface OneDriveOptions {
  /** Upload fragment, a multiple of 327,680 B (default 10 MiB). */
  chunk?: number
  /** Largest single-request upload (default 10 MiB). */
  maxSmallPut?: number
}

/** `UploadState.session` of a Graph upload session. */
interface GraphSession {
  uploadUrl: string
  chunk: number
}

interface DriveItem {
  id?: string
  name?: string
  size?: number
  eTag?: string
  lastModifiedDateTime?: string
  file?: object
  folder?: object
  webUrl?: string
  parentReference?: { driveId?: string; id?: string; path?: string; name?: string }
  '@microsoft.graph.downloadUrl'?: string
}

// ---------------------------------------------------------------------------------------------
// Error mapping (§4.2)
// ---------------------------------------------------------------------------------------------

/** `{error:{code, message}}`; the code only (messages may echo request details). */
export function graphErrorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code
    return typeof code === 'string' && code.length <= 100 ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Maps a Graph error answer. `preauth`: the request went to a pre-authenticated `uploadUrl`/`downloadUrl`
 * without a token, so a 401 there isn't a sign-in problem and must not become the fatal `reauth`.
 */
export function graphError(status: number, body: string, headers?: Headers, o: { preauth?: boolean; now?: number } = {}): BackendError {
  const code = graphErrorCode(body)
  const retryAfterMs = parseRetryAfter(headers?.get('retry-after'), o.now)
  const opts = { status, providerCode: code, retryAfterMs }
  const msg = `${NAME} answered ${status}${code ? ` ${code}` : ''}`
  if (status === 401) return new BackendError(o.preauth ? 'unknown' : 'reauth', msg, opts)
  if (status === 507 || code === 'insufficientStorage' || code === 'quotaLimitReached') return new BackendError('quota', msg, opts)
  if (status === 429) return new BackendError('rateLimited', msg, opts)
  // §3: a 503 with a retry hint is throttling; without one it is an outage.
  if (status === 503) return new BackendError(retryAfterMs !== undefined ? 'rateLimited' : 'server', msg, opts)
  if (status === 409 || status === 412) return new BackendError('precondition', msg, opts)
  if (status === 403) return new BackendError('forbidden', msg, opts)
  if (status === 404 || status === 410) return new BackendError('notFound', msg, opts)
  if (status === 423 || status >= 500) return new BackendError('server', msg, opts)
  return new BackendError('unknown', msg, opts)
}

const dec = new TextDecoder()

async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {})
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

/** Start of the first `nextExpectedRanges` entry (`"a-b"` or `"a-"`); `null` when there is none. */
export function nextExpected(ranges: unknown): number | null {
  if (!Array.isArray(ranges) || !ranges.length || typeof ranges[0] !== 'string') return null
  const m = /^(\d+)-(\d*)$/.exec(ranges[0].trim())
  return m ? Number(m[1]) : null
}

const isHttps = (u: unknown): u is string => {
  if (typeof u !== 'string') return false
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

/** A name OneDrive and SharePoint accept for `cfg.folder` segments (keys are checked by keymap). */
function checkFolderName(seg: string, folder: string): void {
  if (!seg || /["*:<>?\\|]/.test(seg) || seg.startsWith('~$') || seg.endsWith('.') || seg.trim() !== seg)
    throw new BackendError('unknown', `Invalid OneDrive folder ${JSON.stringify(folder)}`, { providerCode: 'BadKey' })
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

export class OneDriveBackend implements StorageBackend {
  readonly kind = 'onedrive' as const
  readonly label: string
  caps: BackendCaps
  /** `UploadState.backend`: sessions only resume for the same account and folder. */
  readonly id: string
  protected readonly cfg: OneDriveConfig
  protected readonly ctx: BackendContext
  protected readonly opts: OneDriveOptions
  private readonly api: OAuthHttp
  private readonly pre: OAuthHttp
  private readonly now: () => number
  private readonly chunk: number
  /** `cfg.folder` as segments inside approot. */
  private readonly base: string[]
  /** key → a recent downloadUrl. */
  private readonly downloads = new Map<string, { url: string; at: number }>()
  /** `undefined` until a plain DELETE had to stand in for a failed `permanentDelete`. */
  private permanentDelete: boolean | undefined
  private readonly creating = new Map<string, Promise<void>>()

  constructor(cfg: OneDriveConfig, ctx: BackendContext = {}, opts: OneDriveOptions = {}) {
    this.cfg = cfg
    this.ctx = ctx
    this.opts = opts
    this.now = ctx.now ?? Date.now
    this.label = cfg.account ? `${NAME} · ${cfg.account}` : NAME
    this.caps = { rangeGet: true, conditionalPut: true, maxSmallPut: opts.maxSmallPut ?? 10 * MiB }
    this.chunk = opts.chunk ?? 32 * FRAGMENT_UNIT
    if (!Number.isInteger(this.chunk) || this.chunk <= 0 || this.chunk % FRAGMENT_UNIT !== 0 || this.chunk >= FRAGMENT_MAX)
      throw new BackendError('unknown', `OneDrive upload fragments must be a multiple of ${FRAGMENT_UNIT} bytes, less than ${FRAGMENT_MAX}`, { providerCode: 'BadOption' })
    const folder = cfg.folder ?? ''
    this.base = folder.split('/').filter(Boolean)
    for (const s of this.base) checkFolderName(s, folder)
    this.id = `onedrive:${cfg.accountId ?? ''}:${this.base.join('/')}`
    this.api = new OAuthHttp(ctx, { label: NAME, mapError: (res, body) => graphError(res.status, body, res.headers, { now: this.now() }) })
    this.pre = new OAuthHttp(ctx, { label: NAME, mapError: (res, body) => graphError(res.status, body, res.headers, { preauth: true, now: this.now() }) })
  }

  // --- addressing ------------------------------------------------------------------------------

  /** Graph URL of the item at `full` (segments inside approot), or of one of its actions. */
  private url(full: string[], action?: string): string {
    if (!full.length) return action ? `${APPROOT}/${action}` : APPROOT
    const p = `${APPROOT}:/${full.map(encodeURIComponent).join('/')}`
    return action ? `${p}:/${action}` : p
  }

  /** Item segments inside approot for a key (validates it). */
  private itemPath(key: string): string[] {
    const { folder, leaf } = deep3(key)
    return [...this.base, ...folder, leaf]
  }

  /** Graph calls with the bearer token. */
  private send(url: string, init: SendInit = {}): Promise<Response> {
    return this.api.send(url, init)
  }

  /** Pre-authenticated URLs (`uploadUrl`, `downloadUrl`): never with `Authorization`. */
  private sendPre(url: string, init: SendInit = {}): Promise<Response> {
    return this.pre.send(url, { ...init, auth: false })
  }

  private async fail(res: Response, o: { preauth?: boolean } = {}): Promise<BackendError> {
    return graphError(res.status, await errorText(res), res.headers, { preauth: o.preauth, now: this.now() })
  }

  private info(key: string, it: DriveItem): ObjectInfo {
    const out: ObjectInfo = { key, size: typeof it.size === 'number' ? it.size : 0 }
    if (it.eTag) out.etag = it.eTag
    const lm = it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : NaN
    if (Number.isFinite(lm)) out.lastModified = lm
    return out
  }

  // --- list ------------------------------------------------------------------------------------

  async list(prefix: string, o: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ListPage> {
    const { signal } = o
    const items: ObjectInfo[] = []
    const queue: string[][] = [prefixScope(prefix).folder]
    while (queue.length) {
      const folder = queue.shift()!
      const seen = new Set<string>()
      let url: string | undefined = `${this.url([...this.base, ...folder], 'children')}?$select=${SELECT_CHILDREN}`
      while (url) {
        const res = await this.send(url, { signal, expect: [404] })
        if (res.status === 404) {
          await drain(res)
          break
        }
        const page = await readJson<{ value?: DriveItem[]; '@odata.nextLink'?: unknown }>(res)
        for (const it of Array.isArray(page?.value) ? page.value : []) {
          if (typeof it?.name !== 'string') continue
          if (it.folder) {
            // Only the first three levels are real folders; anything deeper is not ours.
            if (folder.length >= MAX_DEPTH) continue
            const sub = [...folder, it.name]
            const p = sub.join('/') + '/'
            try {
              segments(sub.join('/'))
            } catch {
              continue
            }
            if (p.startsWith(prefix) || prefix.startsWith(p)) queue.push(sub)
            continue
          }
          if (!it.file) continue
          let key: string
          try {
            key = fromDeep3(folder, it.name)
          } catch {
            continue // a file deep3 can't have produced (someone else's, or renamed by hand)
          }
          if (!key.startsWith(prefix)) continue
          if (items.length >= LIST_MAX_KEYS)
            throw new BackendError('unknown', `More than ${LIST_MAX_KEYS} objects under "${prefix}" in storage`, { providerCode: 'TooManyKeys' })
          items.push(this.info(key, it))
        }
        const next = page?.['@odata.nextLink']
        if (next === undefined || next === null) break
        // The bearer token only ever goes to Graph.
        if (typeof next !== 'string' || !next.startsWith(GRAPH + '/'))
          throw new BackendError('unknown', `${NAME} sent an unexpected next page link`, { providerCode: 'BadNextLink' })
        if (seen.has(next)) throw new BackendError('unknown', `The storage listing of "${prefix}" doesn't advance`, { providerCode: 'ListLoop' })
        seen.add(next)
        url = next
      }
    }
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const after = o.startAfter
    return { items: after ? items.filter((i) => i.key > after) : items }
  }

  // --- head / get ------------------------------------------------------------------------------

  async head(key: string, o: { signal?: AbortSignal } = {}): Promise<ObjectInfo | null> {
    const res = await this.send(`${this.url(this.itemPath(key))}?$select=${SELECT_ITEM}`, { signal: o.signal, expect: [404] })
    if (res.status === 404) {
      await drain(res)
      return null
    }
    const it = await readJson<DriveItem>(res)
    return it?.file ? this.info(key, it) : null
  }

  /** A fresh `downloadUrl` for `key`, or null when it is missing or a folder. */
  private async downloadUrl(key: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.send(`${this.url(this.itemPath(key))}?$select=${SELECT_DOWNLOAD}`, { signal, expect: [404] })
    if (res.status === 404) {
      await drain(res)
      return null
    }
    const it = await readJson<DriveItem>(res)
    if (!it?.file) return null
    const url = it['@microsoft.graph.downloadUrl']
    if (!isHttps(url)) throw new BackendError('unknown', `${NAME} sent no download link for ${key}`, { providerCode: 'NoDownloadUrl' })
    if (this.downloads.size >= DOWNLOAD_URL_CACHE) this.downloads.delete(this.downloads.keys().next().value!)
    this.downloads.set(key, { url, at: this.now() })
    return url
  }

  private cachedDownloadUrl(key: string): string | null {
    const d = this.downloads.get(key)
    if (!d) return null
    if (this.now() - d.at > DOWNLOAD_URL_TTL || this.now() < d.at) {
      this.downloads.delete(key)
      return null
    }
    return d.url
  }

  async get(key: string, o: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number } = {}): Promise<Uint8Array | null> {
    const r = o.range
    if (r && !(Number.isInteger(r[0]) && Number.isInteger(r[1]) && 0 <= r[0] && r[0] <= r[1])) throw new BackendError('unknown', 'bad range')
    this.itemPath(key)
    const { signal } = o
    for (let attempt = 0; ; attempt++) {
      const url = (attempt === 0 ? this.cachedDownloadUrl(key) : null) ?? (await this.downloadUrl(key, signal))
      if (url === null) return null
      const res = await this.sendPre(url, { signal, headers: r ? { range: `bytes=${r[0]}-${r[1]}` } : {}, expect: [401, 403, 404, 410, 416] })
      if (res.status === 416) {
        await drain(res)
        return new Uint8Array(0)
      }
      if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
        // Expired link, or the item changed or went away: ask for a new link once.
        this.downloads.delete(key)
        if (attempt === 0) {
          await drain(res)
          continue
        }
        if (res.status === 404 || res.status === 410) {
          await drain(res)
          return null
        }
        throw await this.fail(res, { preauth: true })
      }
      if (!r) {
        const max = o.maxBytes ?? GET_MAX
        return readBody(res, max, () => tooLarge(key, max, 'TooLarge', res.status))
      }
      const len = r[1] - r[0] + 1
      const data = await readBody(res, len, () => tooLarge(key, len, res.status === 200 ? 'RangeIgnored' : 'TooLarge', res.status))
      return res.status === 200 ? data.slice(r[0], r[1] + 1) : data
    }
  }

  // --- put / delete ----------------------------------------------------------------------------

  async put(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const full = this.itemPath(key)
    const behavior = o.ifNoneMatch ? 'fail' : 'replace'
    const url = `${this.url(full, 'content')}?@microsoft.graph.conflictBehavior=${behavior}`
    for (let attempt = 0; ; attempt++) {
      this.downloads.delete(key)
      const res = await this.send(url, {
        method: 'PUT',
        body: body as Uint8Array<ArrayBuffer>,
        headers: { 'content-type': 'application/octet-stream' },
        signal: o.signal,
        expect: [404, 409],
      })
      if (res.ok) {
        await drain(res)
        return
      }
      const err = await this.fail(res)
      if (res.status === 409 && behavior === 'fail' && err.providerCode === 'nameAlreadyExists') throw err
      // A missing parent folder (if Graph doesn't create parents for path PUTs): create them, retry once.
      if (attempt === 0) {
        await this.ensureFolders(full.slice(0, -1), o.signal)
        continue
      }
      throw err
    }
  }

  /** Creates each folder of `full` from the top; 409 (exists) is fine. */
  private async ensureFolders(full: string[], signal?: AbortSignal): Promise<void> {
    for (let i = 1; i <= full.length; i++) {
      const path = full.slice(0, i)
      const id = path.join('/')
      let p = this.creating.get(id)
      if (!p) {
        p = (async () => {
          const res = await this.send(this.url(path.slice(0, -1), 'children'), {
            method: 'POST',
            body: JSON.stringify({ name: path[path.length - 1], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
            headers: { 'content-type': 'application/json' },
            signal,
            expect: [409],
          })
          await drain(res)
        })()
        this.creating.set(id, p)
        void p.finally(() => this.creating.delete(id)).catch(() => {})
      }
      await p
    }
  }

  async delete(key: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    const full = this.itemPath(key)
    this.downloads.delete(key)
    if (this.permanentDelete !== false) {
      // Plain DELETE goes to the recycle bin, which counts against quota on personal OneDrive.
      const res = await this.send(this.url(full, 'permanentDelete'), { method: 'POST', signal: o.signal, expect: [400, 403, 404, 501] })
      await drain(res)
      if (res.ok) {
        this.permanentDelete = true
        return
      }
    }
    const res = await this.send(this.url(full), { method: 'DELETE', signal: o.signal, expect: [404] })
    await drain(res)
    // Remember the fallback only when the item existed: a 404 from both just means it was gone.
    if (res.ok && this.permanentDelete === undefined) this.permanentDelete = false
  }

  // --- upload sessions -------------------------------------------------------------------------

  private resumable(state: UploadState | undefined, key: string, size: number): (UploadState & { session: GraphSession }) | null {
    if (!state || state.v !== 1 || state.backend !== this.id || state.key !== key || state.size !== size) return null
    const s = state.session as Partial<GraphSession> | null
    if (!s || typeof s !== 'object' || !isHttps(s.uploadUrl) || typeof state.done !== 'number') return null
    return { ...state, session: { uploadUrl: s.uploadUrl, chunk: typeof s.chunk === 'number' ? s.chunk : this.chunk } }
  }

  /** The server's next expected offset, or null when the session is gone (completed, expired, aborted). */
  private async sessionOffset(uploadUrl: string, size: number, signal?: AbortSignal): Promise<number | null> {
    const res = await this.sendPre(uploadUrl, { signal, expect: [404] })
    if (res.status === 404) {
      await drain(res)
      return null
    }
    const j = await readJson<{ nextExpectedRanges?: unknown }>(res)
    const n = nextExpected(j?.nextExpectedRanges)
    if (n === null) return size
    if (n > size) throw new BackendError('unknown', `${NAME} expects bytes past the end of the upload`, { providerCode: 'BadRange' })
    return n
  }

  private async createSession(key: string, full: string[], size: number, signal?: AbortSignal): Promise<UploadState & { session: GraphSession }> {
    const url = this.url(full, 'createUploadSession')
    const body = JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } })
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(url, { method: 'POST', body, headers: { 'content-type': 'application/json' }, signal, expect: [404, 409] })
      if (res.ok) {
        const j = await readJson<{ uploadUrl?: unknown }>(res)
        if (!isHttps(j?.uploadUrl)) throw new BackendError('unknown', `${NAME} sent no upload link for ${key}`, { providerCode: 'NoUploadUrl' })
        return { v: 1, backend: this.id, key, size, createdAt: this.now(), done: 0, session: { uploadUrl: j.uploadUrl, chunk: this.chunk } }
      }
      const err = await this.fail(res)
      if (attempt > 0) throw err
      await this.ensureFolders(full.slice(0, -1), signal)
    }
  }

  async upload(
    key: string,
    src: ByteSource,
    o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    const { signal } = o
    const full = this.itemPath(key)
    const size = src.size
    if (size <= this.caps.maxSmallPut) {
      signal?.throwIfAborted()
      await this.put(key, await src.read(0, size), { signal })
      o.onProgress?.(size)
      return
    }
    const whole = async () => {
      const h = await this.head(key, { signal })
      if (h && h.size === size) {
        o.onProgress?.(size)
        return true
      }
      return false
    }

    let state = this.resumable(o.state, key, size)
    let offset = 0
    if (state) {
      // A completed session no longer exists; the object is then whole (contract: no reads).
      const n = state.done >= size ? null : await this.sessionOffset(state.session.uploadUrl, size, signal)
      if (n === null) {
        if (await whole()) return
        state = null
      } else offset = n // the server wins over `state.done`
    }

    for (let restarts = 0; ; restarts++) {
      if (!state) {
        state = await this.createSession(key, full, size, signal)
        offset = 0
        await o.onState?.(structuredClone(state))
      }
      if (offset > 0) o.onProgress?.(offset)
      const r = await this.sendFragments(key, src, state, offset, o)
      if (r === 'done') return
      // The session expired or vanished under us: done if the object is whole, else one fresh session.
      if (await whole()) return
      if (restarts >= 1) throw new BackendError('server', `${NAME} lost the upload session for ${key} twice`, { providerCode: 'SessionLost' })
      state = null
    }
  }

  /** PUTs fragments from `offset` until the session completes ('done') or disappears ('gone'). */
  private async sendFragments(
    key: string,
    src: ByteSource,
    state: UploadState & { session: GraphSession },
    offset: number,
    o: { onState?: (s: UploadState) => Promise<void>; onProgress?: (bytes: number) => void; signal?: AbortSignal },
  ): Promise<'done' | 'gone'> {
    const { signal } = o
    const size = src.size
    const { uploadUrl } = state.session
    let stalls = 0
    const ack = async (done: number) => {
      state.done = done
      await o.onState?.(structuredClone(state))
      o.onProgress?.(done)
    }
    while (offset < size) {
      signal?.throwIfAborted()
      const end = Math.min(offset + this.chunk, size)
      const body = await src.read(offset, end)
      if (body.length !== end - offset) throw new Error('ByteSource returned a short read')
      const res = await this.sendPre(uploadUrl, {
        method: 'PUT',
        body: body as Uint8Array<ArrayBuffer>,
        headers: { 'content-range': `bytes ${offset}-${end - 1}/${size}` },
        signal,
        expect: [404, 416],
      })
      if (res.status === 404) {
        await drain(res)
        return 'gone'
      }
      let next: number | null
      if (res.status === 416) {
        // Usually a fragment that landed before its response was lost: ask where the server is.
        await drain(res)
        next = await this.sessionOffset(uploadUrl, size, signal)
        if (next === null) return 'gone'
      } else if (res.status === 200 || res.status === 201) {
        await drain(res)
        this.downloads.delete(key)
        await ack(size)
        return 'done'
      } else {
        const j = await readJson<{ nextExpectedRanges?: unknown }>(res)
        next = nextExpected(j?.nextExpectedRanges) ?? end
        if (next > size) throw new BackendError('unknown', `${NAME} expects bytes past the end of the upload`, { providerCode: 'BadRange' })
      }
      if (next <= offset) {
        if (++stalls > 3) throw new BackendError('server', `${NAME} doesn't accept the upload of ${key}`, { providerCode: 'NoProgress' })
      } else stalls = 0
      offset = next
      if (next > 0) await ack(next)
    }
    // Every byte is acknowledged but no 200/201 came back (a lost final response): the session is over.
    return 'gone'
  }

  async abortUpload(state: UploadState, o: { signal?: AbortSignal } = {}): Promise<void> {
    const s = state?.session as Partial<GraphSession> | null
    if (!s || typeof s !== 'object' || !isHttps(s.uploadUrl)) return
    const res = await this.sendPre(s.uploadUrl, { method: 'DELETE', signal: o.signal, expect: [404] })
    await drain(res)
  }

  // --- check / describe ------------------------------------------------------------------------

  async check(): Promise<BackendCheck> {
    const steps: BackendCheckStep[] = []
    const ok = (id: BackendCheckStep['id'], detail?: string) => steps.push(detail ? { id, ok: true, detail } : { id, ok: true })
    const bad = (id: BackendCheckStep['id'], detail: string) => steps.push({ id, ok: false, detail })
    const fail = (e: unknown): BackendError => (e instanceof BackendError ? e : new BackendError('unknown', String((e as Error)?.message ?? e), { cause: e }))
    const key = `os1/.check-${Math.random().toString(36).slice(2, 12)}`
    let firstError: BackendError | undefined
    const note = (e: BackendError) => (firstError ??= e)

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

    const body = new TextEncoder().encode('openstand check')
    try {
      await this.put(key, body)
      ok('write')
    } catch (e) {
      const err = fail(e)
      bad('write', err.message)
      return { ok: false, steps, error: err }
    }
    const step = async (id: BackendCheckStep['id'], run: () => Promise<string | null>) => {
      try {
        const problem = await run()
        if (problem === null) ok(id)
        else {
          bad(id, problem)
          note(new BackendError('unknown', problem))
        }
      } catch (e) {
        bad(id, fail(e).message)
        note(fail(e))
      }
    }
    await step('read', async () => {
      const got = await this.get(key)
      return got && got.length === body.length && got.every((b, i) => b === body[i]) ? null : 'Read back different data'
    })
    await step('range', async () => {
      const got = await this.get(key, { range: [1, 1] })
      return got && got.length === 1 && got[0] === body[1] ? null : 'Range requests are ignored'
    })
    await step('etag', async () => ((await this.head(key))?.etag ? null : `${NAME} sent no eTag`))
    await step('conditional', async () => {
      const err = await this.put(key, body, { ifNoneMatch: true }).then(() => null, (e: unknown) => e)
      if (err instanceof BackendError && err.code === 'precondition') return null
      if (err) throw err
      return 'A conditional write replaced an existing file'
    })
    await step('delete', async () => {
      await this.delete(key)
      return null
    })
    return firstError ? { ok: false, steps, error: firstError } : { ok: steps.every((s) => s.ok), steps }
  }

  async describe(o: { signal?: AbortSignal } = {}): Promise<BackendDescription> {
    // Also creates approot on first use.
    const res = await this.send(`${APPROOT}?$select=id,name,webUrl,parentReference`, { signal: o.signal })
    const it = await readJson<DriveItem>(res)
    const parentPath = it?.parentReference?.path
    const parent = it?.parentReference?.name || (typeof parentPath === 'string' ? decodeURIComponent(parentPath.split('/').pop() ?? '') : '') || 'Apps'
    const location = [NAME, parent.replace(/^root:/, '') || 'Apps', it?.name || 'OpenStand', ...this.base].join(' › ')
    const account = { id: it?.parentReference?.driveId || this.cfg.accountId || '', ...(this.cfg.account ? { email: this.cfg.account } : {}) }
    return isHttps(it?.webUrl) ? { account, location, openUrl: it.webUrl } : { account, location }
  }
}
