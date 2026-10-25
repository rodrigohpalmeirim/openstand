/**
 * Base for the in-process provider fakes (docs/SYNC-DRIVES.md §9.1): a `fetch`-compatible router passed
 * through `BackendContext.fetch`, a call log, per-route fault injection and a token simulator. No sockets,
 * deterministic. Test-only: nothing in the app imports it.
 *
 *   class DropboxFake extends FakeServer {
 *     constructor() {
 *       super()
 *       this.route('POST', 'https://api.dropboxapi.com/2/files/get_metadata', (req) => ({ json: … }))
 *     }
 *   }
 *   const fake = new DropboxFake()
 *   const backend = new DropboxBackend(cfg, { fetch: fake.fetch, auth: fake.auth() })
 *   afterEach(() => fake.verify())
 *
 * Matching (routes and faults alike): a string matches the URL's `origin + pathname` or its `pathname`
 * exactly; a RegExp is tested against the whole URL (query included).
 */
import { BackendError, type AccessTokenSource, type OAuthKind } from '../types'

export interface FakeCall {
  method: string
  url: string
  /** Lower-case names. */
  headers: Record<string, string>
}

export interface FakeReply {
  status?: number
  json?: unknown
  text?: string
  body?: Uint8Array
  headers?: Record<string, string>
}

export interface FakeRequest {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array
  /** RegExp route captures (`match[1..]`); empty for string routes. */
  params: string[]
  /** The bearer token sent, if any. */
  token?: string
  text(): string
  json<T = unknown>(): T
}

export type FakeHandler = (req: FakeRequest) => FakeReply | Response | Promise<FakeReply | Response>

export interface FakeFault {
  method?: string
  path?: RegExp | string
  /** How many matching requests it affects (default 1; `Infinity` for all). */
  times?: number
  /** The request takes effect, then its response is lost (replaced by `respond` or a network error). */
  after?: boolean
  respond?: FakeReply
  /** Throw like a dropped connection (the default when `respond` is absent). */
  network?: boolean
}

/** `AccessTokenSource` backed by the fake's token simulator. */
export interface FakeAuth extends AccessTokenSource {
  /** The current token gets 401 next time (the next refresh issues a new one). */
  expireNow(): void
  /** The grant is gone: the current token gets 401 and refreshing throws `BackendError('reauth')`. */
  revoke(): void
  /** Refreshes done so far. */
  refreshes: number
  /** The token the client holds now. */
  readonly current: string
}

interface Route {
  method: string
  path: RegExp | string
  handler: FakeHandler
  auth: boolean
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function matches(path: RegExp | string, url: URL): string[] | null {
  if (typeof path === 'string') return path === url.origin + url.pathname || path === url.pathname ? [] : null
  path.lastIndex = 0
  const m = path.exec(url.href)
  return m ? m.slice(1) : null
}

export function reply(r: FakeReply): Response {
  const headers = new Headers(r.headers)
  let body: Uint8Array | null = null
  if (r.body !== undefined) body = r.body
  else if (r.json !== undefined) {
    body = enc.encode(JSON.stringify(r.json))
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  } else if (r.text !== undefined) {
    body = enc.encode(r.text)
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
  }
  const status = r.status ?? 200
  const nullBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200)
  if (body && !nullBody && !headers.has('content-length')) headers.set('content-length', String(body.length))
  // Response refuses statuses outside 200–599; the fakes never need them.
  return new Response(nullBody ? null : (body as Uint8Array<ArrayBuffer> | null), { status, headers })
}

export class FakeServer {
  readonly calls: FakeCall[] = []
  /** Requests no route matched (answered 404); `verify()` fails the test if there are any. */
  readonly unmatched: string[] = []
  readonly fetch: typeof fetch
  protected readonly now: () => number
  /** `AccessTokenSource.kind` of the token sources `auth()` hands out. */
  protected readonly kind: OAuthKind
  private readonly routes: Route[] = []
  private readonly faults: (FakeFault & { left: number })[] = []
  /** Bearer tokens the server accepts right now. */
  private readonly accepted = new Set<string>()
  private tokenSeq = 0

  constructor(o: { now?: () => number; kind?: OAuthKind } = {}) {
    this.now = o.now ?? Date.now
    this.kind = o.kind ?? 'dropbox'
    this.fetch = (input, init) => this.handle(input, init)
  }

  /** Registers a route; earlier routes win. `auth` (default true) requires a currently valid bearer token. */
  protected route(method: string, path: RegExp | string, handler: FakeHandler, o: { auth?: boolean } = {}): void {
    this.routes.push({ method: method.toUpperCase(), path, handler, auth: o.auth ?? true })
  }

  /** What a request with a missing or invalid token gets. Providers override it with their own error body. */
  protected unauthorized(_req: FakeRequest): FakeReply {
    return { status: 401, json: { error: 'invalid_token' } }
  }

  /** Injects a fault; returns a function that removes it. Faults apply in the order they were added. */
  fail(f: FakeFault): () => void {
    const entry = { ...f, left: f.times ?? 1 }
    this.faults.push(entry)
    return () => {
      const i = this.faults.indexOf(entry)
      if (i >= 0) this.faults.splice(i, 1)
    }
  }

  /** A token source for one client of this server: issues `tok-1`, `tok-2`, …; the server accepts only current ones. */
  auth(): FakeAuth {
    const issue = () => {
      const t = `tok-${++this.tokenSeq}`
      this.accepted.add(t)
      return t
    }
    let current = issue()
    let revoked = false
    const pending = new Map<string, Promise<string>>()
    const accepted = this.accepted
    const source: FakeAuth = {
      kind: this.kind,
      refreshes: 0,
      get current() {
        return current
      },
      async token(o) {
        o?.signal?.throwIfAborted()
        return current
      },
      refreshAfter401(rejected, o) {
        o?.signal?.throwIfAborted()
        if (rejected !== current && accepted.has(current)) return Promise.resolve(current)
        const inflight = pending.get(rejected)
        if (inflight) return inflight
        const p = (async () => {
          await Promise.resolve()
          if (revoked) throw new BackendError('reauth', 'Sign-in revoked (fake)', { providerCode: 'invalid_grant' })
          source.refreshes++
          accepted.delete(current)
          current = issue()
          return current
        })()
        pending.set(rejected, p)
        void p.finally(() => pending.delete(rejected)).catch(() => {})
        return p
      },
      expireNow() {
        accepted.delete(current)
      },
      revoke() {
        revoked = true
        accepted.delete(current)
      },
    }
    return source
  }

  /** Fails the test if any request hit no route. Call it in `afterEach`. */
  verify(): void {
    if (this.unmatched.length) throw new Error(`Fake server: no route for ${this.unmatched.join(', ')}`)
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    const headers: Record<string, string> = {}
    request.headers.forEach((v, k) => (headers[k] = v))
    this.calls.push({ method, url: url.href, headers })
    const body = method === 'GET' || method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer())

    const fault = this.faults.find((f) => f.left > 0 && (!f.method || f.method.toUpperCase() === method) && (!f.path || matches(f.path, url)))
    if (fault) {
      fault.left--
      if (fault.left <= 0) this.faults.splice(this.faults.indexOf(fault), 1)
      if (fault.after) await this.dispatch(method, url, request.headers, body)
      if (fault.respond && !fault.network) return reply(fault.respond)
      throw new TypeError('Failed to fetch (injected)')
    }
    return this.dispatch(method, url, request.headers, body)
  }

  private async dispatch(method: string, url: URL, headers: Headers, body: Uint8Array): Promise<Response> {
    for (const r of this.routes) {
      if (r.method !== method) continue
      const params = matches(r.path, url)
      if (!params) continue
      const auth = headers.get('authorization')
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
      const req: FakeRequest = {
        method,
        url,
        headers,
        body,
        params,
        token,
        text: () => dec.decode(body),
        json: <T>() => JSON.parse(dec.decode(body)) as T,
      }
      if (r.auth && (!token || !this.accepted.has(token))) return reply(this.unauthorized(req))
      const out = await r.handler(req)
      return out instanceof Response ? out : reply(out)
    }
    this.unmatched.push(`${method} ${url.origin}${url.pathname}`)
    return reply({ status: 404, json: { error: 'fake: no route' } })
  }
}
