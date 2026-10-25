/**
 * S3-compatible `StorageBackend`: AWS, Cloudflare R2, Backblaze B2, MinIO.
 *
 * SigV4 signing is aws4fetch (`retries: 0`; retrying is the engine's job). XML is parsed with a tiny linear
 * `indexOf` scanner, so this also runs in Node tests. Every response body is read with a byte cap. Large uploads are multipart and resumable through the persisted
 * `UploadState` (resume asks the server with `ListParts`, so a part that landed before a crash isn't sent
 * again). Clock skew is corrected once per request from the server's time.
 */
import { AwsClient } from 'aws4fetch'
import { SINGLE_PUT_MAX } from '../model'
import {
  BackendError,
  GET_MAX,
  type BackendCaps,
  type BackendCheck,
  type BackendCheckStep,
  type BackendContext,
  type ByteSource,
  type ListPage,
  type ObjectInfo,
  type S3Config,
  type StorageBackend,
  type UploadState,
} from './types'
import {
  DEFAULT_PART_HEAD,
  DEFAULT_PART_SIZE,
  isAbort,
  partCount,
  partRange,
  resumableSession,
  tooLarge,
  type MultipartSession,
  type PartLayout,
} from './util'

// ---------------------------------------------------------------------------------------------
// XML (S3 responses are flat and well-formed; no DOMParser so Node can run it)
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[e] ?? m
  })
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const isTagEnd = (c: number) => c === 62 /* > */ || c === 47 /* / */ || c === 32 || c === 9 || c === 10 || c === 13

/**
 * The next `<tag …>` or `<tag …/>` at or after `from`. Linear: each `indexOf` starts past the previous
 * match, and a missing `>` ends the scan.
 */
function openTag(xml: string, tag: string, from: number): { start: number; end: number; empty: boolean } | null {
  const needle = '<' + tag
  for (let i = xml.indexOf(needle, from); i >= 0; i = xml.indexOf(needle, i + needle.length)) {
    if (!isTagEnd(xml.charCodeAt(i + needle.length))) continue
    const gt = xml.indexOf('>', i + needle.length)
    if (gt < 0) return null
    return { start: i, end: gt + 1, empty: xml.charCodeAt(gt - 1) === 47 }
  }
  return null
}

/** Calls `fn(inner)` for each `<tag>…</tag>` (first closing tag wins, like a lazy regex) until it returns false. */
function scanBlocks(xml: string, tag: string, fn: (inner: string | null) => boolean): void {
  const close = '</' + tag + '>'
  let pos = 0
  for (;;) {
    const o = openTag(xml, tag, pos)
    if (!o) return
    if (o.empty) {
      if (!fn(null)) return
      pos = o.end
      continue
    }
    const c = xml.indexOf(close, o.end)
    // No closing tag after this one means none after any later one either: stop.
    if (c < 0) return
    if (!fn(xml.slice(o.end, c))) return
    pos = c + close.length
  }
}

/** Decoded text of the first `<tag>` (`undefined` if absent; `''` for `<tag/>`). */
export function xmlText(xml: string, tag: string): string | undefined {
  let out: string | undefined
  scanBlocks(xml, tag, (inner) => {
    out = inner === null ? '' : xmlDecode(inner)
    return false
  })
  return out
}

/** Raw inner XML of every `<tag>…</tag>` block (self-closing `<tag/>` is skipped). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = []
  scanBlocks(xml, tag, (inner) => {
    if (inner !== null) out.push(inner)
    return true
  })
  return out
}

export interface ListObjectsResult {
  items: ObjectInfo[]
  truncated: boolean
  next?: string
}

export function parseListObjects(xml: string): ListObjectsResult {
  const items = xmlBlocks(xml, 'Contents').map((b) => {
    const lm = xmlText(b, 'LastModified')
    const info: ObjectInfo = { key: xmlText(b, 'Key') ?? '', size: Number(xmlText(b, 'Size') ?? 0) }
    const etag = xmlText(b, 'ETag')
    if (etag) info.etag = etag
    if (lm && Number.isFinite(Date.parse(lm))) info.lastModified = Date.parse(lm)
    return info
  })
  const truncated = xmlText(xml, 'IsTruncated') === 'true'
  const next = xmlText(xml, 'NextContinuationToken')
  return next ? { items, truncated, next } : { items, truncated }
}

export interface ListPartsResult {
  parts: { n: number; etag: string; size: number }[]
  truncated: boolean
  next?: string
}

export function parseListParts(xml: string): ListPartsResult {
  const parts = xmlBlocks(xml, 'Part').map((b) => ({
    n: Number(xmlText(b, 'PartNumber')),
    etag: xmlText(b, 'ETag') ?? '',
    size: Number(xmlText(b, 'Size') ?? -1),
  }))
  const truncated = xmlText(xml, 'IsTruncated') === 'true'
  const next = xmlText(xml, 'NextPartNumberMarker')
  return next ? { parts, truncated, next } : { parts, truncated }
}

export function parseS3ErrorBody(xml: string): { code?: string; message?: string; serverTime?: string } {
  const err = xmlBlocks(xml, 'Error')[0] ?? ''
  return { code: xmlText(err, 'Code'), message: xmlText(err, 'Message'), serverTime: xmlText(err, 'ServerTime') }
}

// ---------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------

const AUTH_CODES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'TokenRefreshRequired',
  'AuthorizationHeaderMalformed',
  'InvalidSecurity',
  'Unauthorized',
])
const QUOTA_CODES = new Set(['QuotaExceeded', 'StorageQuotaExceeded', 'XMinioStorageFull', 'XMinioAdminBucketQuotaExceeded'])
const NOT_FOUND_CODES = new Set(['NoSuchKey', 'NoSuchBucket', 'NoSuchUpload'])

export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined
}

/** Maps an S3 error response (status, XML body, headers) to a `BackendError`. */
export function s3Error(status: number, body: string, headers?: Headers): BackendError {
  const { code, message } = parseS3ErrorBody(body)
  const retryAfterMs = parseRetryAfter(headers?.get('retry-after'))
  const o = { status, providerCode: code, retryAfterMs }
  const msg = [code, message].filter(Boolean).join(': ') || `HTTP ${status}`
  if (status === 412 || code === 'PreconditionFailed' || code === 'ConditionalRequestConflict')
    return new BackendError('precondition', msg, o)
  if (code === 'RequestTimeTooSkewed') return new BackendError('clock', msg, o)
  if (code && AUTH_CODES.has(code)) return new BackendError('auth', msg, o)
  // B2 answers 403 AccessDenied "… cap exceeded" when a storage or transaction cap is hit.
  if ((code && QUOTA_CODES.has(code)) || /cap exceeded|quota exceeded|storage full/i.test(message ?? ''))
    return new BackendError('quota', msg, o)
  if (status === 429 || code === 'SlowDown' || code === 'TooManyRequests') return new BackendError('rateLimited', msg, o)
  if (status === 401) return new BackendError('auth', msg, o)
  if (status === 403 || code === 'AccessDenied') return new BackendError('forbidden', msg, o)
  if (status === 404 || (code && NOT_FOUND_CODES.has(code))) return new BackendError('notFound', msg, o)
  if (status >= 500) return new BackendError('server', msg, o)
  return new BackendError('unknown', msg, o)
}

/** Server time from an error response: `<ServerTime>` in the body, else the `Date` header. */
export function serverTime(body: string, headers?: Headers): number | null {
  const t = parseS3ErrorBody(body).serverTime
  const fromBody = t ? Date.parse(t) : NaN
  if (Number.isFinite(fromBody)) return fromBody
  const d = headers?.get('date')
  const fromHeader = d ? Date.parse(d) : NaN
  return Number.isFinite(fromHeader) ? fromHeader : null
}

// ---------------------------------------------------------------------------------------------
// Bounded bodies
// ---------------------------------------------------------------------------------------------

/** XML answers (LIST pages of ≤ 1000 keys are a few hundred KiB). */
export const XML_MAX = 8 * 1024 * 1024
/** Error bodies are only parsed for their code and message. */
const ERROR_BODY_MAX = 64 * 1024

/**
 * Reads at most `max` bytes of a response body. `Content-Length` above `max` is refused before reading;
 * otherwise the stream is cancelled as soon as it passes `max`. Then `onOver` decides: throw, or (with
 * `truncate`) keep the first `max` bytes.
 */
export async function readBody(res: Response, max: number, onOver: (() => Error) | 'truncate'): Promise<Uint8Array> {
  const cl = res.headers.get('content-length')
  if (onOver !== 'truncate' && cl !== null && /^\d+$/.test(cl.trim()) && Number(cl) > max) {
    await res.body?.cancel().catch(() => {})
    throw onOver()
  }
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (n + value.length > max) {
      await reader.cancel().catch(() => {})
      if (onOver !== 'truncate') throw onOver()
      parts.push(value.subarray(0, max - n))
      n = max
      break
    }
    parts.push(value)
    n += value.length
  }
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const dec = new TextDecoder()

async function readXml(res: Response): Promise<string> {
  return dec.decode(await readBody(res, XML_MAX, () => new BackendError('unknown', `The storage sent an XML answer larger than ${XML_MAX} bytes`, { providerCode: 'TooLarge' })))
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

const PROVIDER_LABEL: Record<S3Config['provider'], string> = {
  r2: 'Cloudflare R2',
  b2: 'Backblaze B2',
  aws: 'Amazon S3',
  minio: 'MinIO',
  other: 'S3',
}

/** RFC 3986 encoding of one path segment or query component. */
const enc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '')

/** Measured clock offsets (server − local, ms) per endpoint, shared by all instances in this tab. */
const skews = new Map<string, number>()

export interface S3Options {
  /** Multipart layout; defaults to 8 chunks per part, part 1 + 16 B header. S3 needs parts ≥ 5 MiB. */
  partSize?: number
  partHead?: number
  /**
   * Tell CORS failures apart from offline with a `mode: 'no-cors'` probe when fetch throws. Default: only
   * in browsers (Node has no CORS).
   */
  corsProbe?: boolean
}

type Query = Record<string, string | undefined>

interface SendOptions {
  query?: Query
  headers?: Record<string, string>
  body?: Uint8Array
  signal?: AbortSignal
  /** Non-2xx statuses returned to the caller instead of thrown. */
  expect?: number[]
}

/** Normalises the user prefix: no leading slash, exactly one trailing slash (or empty). */
export function normalizePrefix(p: string): string {
  const t = p.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return t ? t + '/' : ''
}

export class S3Backend implements StorageBackend {
  readonly kind = 's3' as const
  readonly label: string
  caps: BackendCaps = { rangeGet: true, conditionalPut: true, maxSmallPut: SINGLE_PUT_MAX }
  /** `UploadState.backend`: sessions only resume on the same endpoint, bucket and prefix. */
  readonly id: string
  private readonly cfg: S3Config
  private readonly client: AwsClient
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly prefix: string
  private readonly endpoint: URL
  private readonly layout: PartLayout
  private readonly corsProbe: boolean

  constructor(cfg: S3Config, ctx: BackendContext = {}, o: S3Options = {}) {
    this.cfg = cfg
    this.endpoint = new URL(cfg.endpoint)
    if (!/^https?:$/.test(this.endpoint.protocol)) throw new BackendError('unknown', 'Endpoint must be an http(s) URL')
    this.prefix = normalizePrefix(cfg.prefix)
    this.label = `${PROVIDER_LABEL[cfg.provider] ?? 'S3'} · ${cfg.bucket}${this.prefix ? '/' + this.prefix.slice(0, -1) : ''}`
    this.id = `s3:${this.endpoint.origin}${this.endpoint.pathname.replace(/\/+$/, '')}/${cfg.bucket}/${this.prefix}`
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: cfg.region || (cfg.provider === 'r2' ? 'auto' : 'us-east-1'),
      retries: 0,
    })
    this.fetchFn = ctx.fetch ?? ((input, init) => fetch(input, init))
    this.now = ctx.now ?? Date.now
    this.layout = { partSize: o.partSize ?? DEFAULT_PART_SIZE, head: o.partHead ?? DEFAULT_PART_HEAD }
    this.corsProbe = o.corsProbe ?? typeof document !== 'undefined'
  }

  /** Forgets measured clock offsets (tests). */
  static resetClockSkew(): void {
    skews.clear()
  }

  private get skewKey() {
    return this.endpoint.origin
  }

  /** `key === null` addresses the bucket itself. */
  url(key: string | null, query?: Query): string {
    const base = this.endpoint.pathname.replace(/\/+$/, '')
    const host = this.cfg.pathStyle ? this.endpoint.host : `${this.cfg.bucket}.${this.endpoint.host}`
    let path = this.cfg.pathStyle ? `${base}/${enc3986(this.cfg.bucket)}` : base
    if (key !== null) path += '/' + (this.prefix + key).split('/').map(enc3986).join('/')
    else if (!path) path = '/'
    const qs = Object.entries(query ?? {})
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([k, v]) => `${enc3986(k)}=${enc3986(v)}`)
      .join('&')
    return `${this.endpoint.protocol}//${host}${path}${qs ? '?' + qs : ''}`
  }

  private async send(method: string, key: string | null, o: SendOptions = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        o.signal?.throwIfAborted()
        const req = await this.client.sign(this.url(key, o.query), {
          method,
          headers: o.headers,
          body: o.body as Uint8Array<ArrayBuffer> | undefined,
          signal: o.signal,
          aws: { datetime: amzDate(this.now() + (skews.get(this.skewKey) ?? 0)) },
        })
        res = await this.fetchFn(req)
      } catch (e) {
        throw await this.fetchFailure(e, o.signal)
      }
      if (res.ok || o.expect?.includes(res.status)) return res
      const text = method === 'HEAD' ? '' : await readBody(res, ERROR_BODY_MAX, 'truncate').then((b) => dec.decode(b), () => '')
      const err = s3Error(res.status, text, res.headers)
      if (err.code === 'clock' && attempt === 0) {
        const t = serverTime(text, res.headers)
        if (t !== null) {
          skews.set(this.skewKey, t - this.now())
          continue
        }
      }
      throw err
    }
  }

  /** A fetch that threw (no response): aborted, offline, or blocked by CORS. */
  private async fetchFailure(e: unknown, signal?: AbortSignal): Promise<unknown> {
    if (isAbort(e, signal) || e instanceof BackendError) return e
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return new BackendError('network', 'This device is offline', { cause: e })
    if (this.corsProbe) {
      try {
        await this.fetchFn(this.endpoint.origin + '/', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) })
        return new BackendError('cors', "The storage didn't allow this site (CORS)", { cause: e })
      } catch {
        /* the endpoint is unreachable too: a network problem */
      }
    }
    return new BackendError('network', `Can't reach ${this.endpoint.host}`, { cause: e })
  }

  private stripPrefix(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key
  }

  async list(prefix: string, o: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ListPage> {
    const res = await this.send('GET', null, {
      signal: o.signal,
      query: {
        'list-type': '2',
        prefix: this.prefix + prefix,
        'max-keys': String(Math.max(1, Math.min(1000, o.limit ?? 1000))),
        'continuation-token': o.cursor,
        'start-after': o.cursor === undefined && o.startAfter ? this.prefix + o.startAfter : undefined,
      },
    })
    const xml = await readXml(res)
    // A web page answering 200 (a wrong endpoint, a captive portal) must not read as an empty bucket.
    if (!/<ListBucketResult[\s>]/.test(xml)) throw new BackendError('unknown', 'This address doesn’t look like S3 storage', { providerCode: 'NotS3' })
    const r = parseListObjects(xml)
    const items = r.items
      .filter((i) => i.key.startsWith(this.prefix + prefix))
      .map((i) => ({ ...i, key: this.stripPrefix(i.key) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return r.truncated && r.next ? { items, cursor: r.next } : { items }
  }

  private info(key: string, res: Response): ObjectInfo {
    const out: ObjectInfo = { key, size: Number(res.headers.get('content-length') ?? 0) }
    const etag = res.headers.get('etag')
    const lm = res.headers.get('last-modified')
    if (etag) out.etag = etag
    if (lm && Number.isFinite(Date.parse(lm))) out.lastModified = Date.parse(lm)
    return out
  }

  async head(key: string, o: { signal?: AbortSignal } = {}): Promise<ObjectInfo | null> {
    let res = await this.send('HEAD', key, { signal: o.signal, expect: [404, 400, 403] })
    if (res.status === 400 || res.status === 403) {
      // HEAD errors carry no body, so the code (auth? clock skew?) is unknown. A 1-byte GET reveals it
      // (and corrects skew); then HEAD once more.
      const probe = await this.send('GET', key, { signal: o.signal, headers: { range: 'bytes=0-0' }, expect: [404, 416] })
      await probe.body?.cancel().catch(() => {})
      res = await this.send('HEAD', key, { signal: o.signal, expect: [404] })
    }
    return res.status === 404 ? null : this.info(key, res)
  }

  async get(key: string, o: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number } = {}): Promise<Uint8Array | null> {
    const r = o.range
    if (r && !(Number.isInteger(r[0]) && Number.isInteger(r[1]) && 0 <= r[0] && r[0] <= r[1]))
      throw new BackendError('unknown', 'bad range')
    const res = await this.send('GET', key, { signal: o.signal, headers: r ? { range: `bytes=${r[0]}-${r[1]}` } : undefined, expect: [404, 416] })
    if (res.status === 404 || res.status === 416) {
      await res.body?.cancel().catch(() => {})
      return res.status === 404 ? null : new Uint8Array(0)
    }
    if (!r) {
      const max = o.maxBytes ?? GET_MAX
      return readBody(res, max, () => tooLarge(key, max, 'TooLarge', res.status))
    }
    // At most the range's length. A server that ignores Range answers 200 with the whole object: fine
    // when that fits in the range (a small object), aborted otherwise rather than downloaded.
    const len = r[1] - r[0] + 1
    const data = await readBody(res, len, () => tooLarge(key, len, res.status === 200 ? 'RangeIgnored' : 'TooLarge', res.status))
    return res.status === 200 ? data.slice(r[0], r[1] + 1) : data
  }

  async put(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    await this.putRaw(key, body, o)
  }

  private async putRaw(key: string, body: Uint8Array, o: { ifNoneMatch?: boolean; signal?: AbortSignal }): Promise<Response> {
    const conditional = !!o.ifNoneMatch && this.caps.conditionalPut
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
    if (conditional) headers['if-none-match'] = '*'
    try {
      return await this.send('PUT', key, { body, headers, signal: o.signal })
    } catch (e) {
      // Providers without conditional writes answer 501 NotImplemented: stop asking, write plainly.
      if (conditional && e instanceof BackendError && (e.status === 501 || e.providerCode === 'NotImplemented')) {
        this.caps.conditionalPut = false
        return this.send('PUT', key, { body, headers: { 'content-type': 'application/octet-stream' }, signal: o.signal })
      }
      throw e
    }
  }

  async delete(key: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    await this.send('DELETE', key, { signal: o.signal, expect: [404] })
  }

  // --- multipart -------------------------------------------------------------------------------

  private async createMultipart(key: string, signal?: AbortSignal): Promise<string> {
    const res = await this.send('POST', key, { query: { uploads: '' }, headers: { 'content-type': 'application/octet-stream' }, signal })
    const id = xmlText(await readXml(res), 'UploadId')
    if (!id) throw new BackendError('unknown', 'CreateMultipartUpload returned no UploadId')
    return id
  }

  private async listParts(key: string, uploadId: string, signal?: AbortSignal): Promise<Map<number, { etag: string; size: number }>> {
    const out = new Map<number, { etag: string; size: number }>()
    let marker: string | undefined
    for (;;) {
      const res = await this.send('GET', key, { query: { uploadId, 'part-number-marker': marker }, signal })
      const r = parseListParts(await readXml(res))
      for (const p of r.parts) out.set(p.n, { etag: p.etag, size: p.size })
      if (!r.truncated || !r.next || r.next === marker) return out
      marker = r.next
    }
  }

  private async uploadPart(key: string, uploadId: string, n: number, body: Uint8Array, signal?: AbortSignal): Promise<string> {
    const res = await this.send('PUT', key, { query: { partNumber: String(n), uploadId }, body, signal })
    const etag = res.headers.get('etag')
    if (!etag) throw new BackendError('cors', 'The ETag header is not readable: add "ETag" to ExposeHeaders in the CORS rule')
    return etag
  }

  private async completeMultipart(key: string, uploadId: string, parts: { n: number; etag: string }[], signal?: AbortSignal) {
    const xml =
      '<CompleteMultipartUpload>' +
      parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>'
    const res = await this.send('POST', key, {
      query: { uploadId },
      body: new TextEncoder().encode(xml),
      headers: { 'content-type': 'application/xml' },
      signal,
    })
    // S3 can answer 200 and still fail: the error is in the body.
    const text = await readXml(res)
    if (text.includes('<Error>')) throw s3Error(res.status === 200 ? 500 : res.status, text, res.headers)
  }

  async abortUpload(state: UploadState, o: { signal?: AbortSignal } = {}): Promise<void> {
    const s = state.session as Partial<MultipartSession> | null
    if (!s || typeof s.uploadId !== 'string' || !state.key) return
    await this.send('DELETE', state.key, { query: { uploadId: s.uploadId }, signal: o.signal, expect: [404] })
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
    let server = new Map<number, { etag: string; size: number }>()
    if (session) {
      try {
        server = await this.listParts(key, session.uploadId, signal)
      } catch (e) {
        if (!(e instanceof BackendError && e.code === 'notFound')) throw e
        // NoSuchUpload: aborted, expired, or completed just before a crash. Done if the object is whole.
        const h = await this.head(key, { signal })
        if (h && h.size === src.size) {
          o.onProgress?.(src.size)
          return
        }
        session = null
      }
    }
    let state: UploadState
    if (!session) {
      session = { uploadId: await this.createMultipart(key, signal), partSize: l.partSize, head: l.head, parts: [] }
      server = new Map()
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
      if (have && have.size === e - s && have.etag) {
        done.set(i, have.etag)
        bytes += e - s
      }
    }
    if (bytes) o.onProgress?.(bytes)
    for (let i = 1; i <= n; i++) {
      if (done.has(i)) continue
      signal?.throwIfAborted()
      const [s, e] = partRange(i, src.size, l)
      const body = await src.read(s, e)
      if (body.length !== e - s) throw new Error('ByteSource returned a short read')
      done.set(i, await this.uploadPart(key, sess.uploadId, i, body, signal))
      bytes += e - s
      sess.parts = [...done].sort((a, b) => a[0] - b[0]).map(([pn, etag]) => ({ n: pn, etag }))
      state = { ...state, done: bytes, session: sess }
      await o.onState?.(structuredClone(state))
      o.onProgress?.(bytes)
    }
    const parts = [...done].sort((a, b) => a[0] - b[0]).map(([pn, etag]) => ({ n: pn, etag }))
    await this.completeMultipart(key, sess.uploadId, parts, signal)
  }

  // --- check ----------------------------------------------------------------------------

  async check(): Promise<BackendCheck> {
    const steps: BackendCheckStep[] = []
    const ok = (id: BackendCheckStep['id'], detail?: string) => steps.push(detail ? { id, ok: true, detail } : { id, ok: true })
    const bad = (id: BackendCheckStep['id'], detail: string) => steps.push({ id, ok: false, detail })
    const fail = (e: unknown): BackendError => (e instanceof BackendError ? e : new BackendError('unknown', String((e as Error)?.message ?? e), { cause: e }))
    const key = `os1/.check-${Math.random().toString(36).slice(2, 12)}`
    let firstError: BackendError | undefined
    const note = (e: BackendError) => (firstError ??= e)

    // 1. LIST: reachability, CORS and credentials in one request.
    try {
      await this.list('os1/', { limit: 1 })
      ok('reach')
      ok('cors')
      ok('auth')
      ok('list')
    } catch (e) {
      const err = fail(e)
      if (err.code === 'network') bad('reach', err.message)
      else {
        ok('reach')
        if (err.code === 'cors') bad('cors', err.message)
        else {
          ok('cors')
          if (err.code === 'auth' || err.code === 'clock') bad('auth', err.message)
          else {
            ok('auth')
            bad('list', err.code === 'notFound' ? `Bucket "${this.cfg.bucket}" not found` : err.message)
          }
        }
      }
      return { ok: false, steps, error: err }
    }

    // 2–5. PUT, GET, range GET, ETag.
    const body = new TextEncoder().encode('openstand check')
    let etag: string | null = null
    try {
      etag = (await this.putRaw(key, body, {})).headers.get('etag')
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
      const res = await this.send('GET', key, { headers: { range: 'bytes=0-0' } })
      const data = await readBody(res, 1024, 'truncate')
      this.caps.rangeGet = res.status === 206 && data.length === 1
      if (this.caps.rangeGet) ok('range')
      else {
        bad('range', 'Range requests are ignored')
        note(new BackendError('unknown', 'Range requests are not supported'))
      }
    } catch (e) {
      bad('range', fail(e).message)
      note(fail(e))
    }
    if (etag) ok('etag')
    else {
      bad('etag', 'The ETag header is not readable: add "ETag" to ExposeHeaders in the CORS rule')
      note(new BackendError('cors', 'ETag header not exposed'))
    }

    // 6. Conditional PUT: a 412 means `If-None-Match: *` works.
    try {
      const res = await this.send('PUT', key, { body, headers: { 'if-none-match': '*' }, expect: [412, 501] })
      this.caps.conditionalPut = res.status === 412
      ok('conditional', this.caps.conditionalPut ? undefined : 'Not supported; writes are unconditional')
    } catch (e) {
      const err = fail(e)
      if (err.code === 'precondition') {
        this.caps.conditionalPut = true
        ok('conditional')
      } else if (err.status === 400 || err.providerCode === 'NotImplemented') {
        this.caps.conditionalPut = false
        ok('conditional', 'Not supported; writes are unconditional')
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
}
