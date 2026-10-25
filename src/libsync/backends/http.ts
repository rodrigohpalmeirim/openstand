/**
 * Authorised HTTP for the cloud-drive backends (docs/SYNC-DRIVES.md §2.5).
 *
 * `send` adds `Authorization: Bearer <token>` from `ctx.auth`; on a 401 it refreshes once
 * (`auth.refreshAfter401`) and retries, and a second 401 is `reauth`. A fetch that throws becomes `network`
 * (or the abort error). Other non-2xx answers, unless listed in `expect`, are read (64 KiB, truncated) and
 * mapped by the backend's `mapError`. Nothing else is retried: retrying is the engine's job, as for S3.
 *
 * Never log or put in errors: tokens, upload session URLs (Graph's are pre-authenticated), download URLs.
 */
import { readBody } from './s3'
import { BackendError, type AccessTokenSource, type BackendContext } from './types'
import { abortError, isAbort } from './util'

/** JSON answers (a 2000-entry Dropbox list page is well under 1 MiB). */
export const JSON_MAX = 8 * 1024 * 1024
/** Error bodies are only parsed for their code and message. */
export const ERROR_BODY_MAX = 64 * 1024

export interface OAuthHttpOptions {
  /** Maps a non-2xx answer (body = its first 64 KiB as text) to the error to throw. */
  mapError(res: Response, body: string): BackendError
  /** For messages, e.g. "Dropbox". Never a URL. */
  label: string
}

export type SendInit = RequestInit & {
  /** Send `Authorization: Bearer` (default true). False for Graph `uploadUrl`/`downloadUrl` and the like. */
  auth?: boolean
  /** Non-2xx statuses returned to the caller instead of thrown. */
  expect?: number[]
  /**
   * Body cap for `json()` (default `JSON_MAX`); `send` doesn't read the body, so it ignores it.
   * (Spec ambiguity: §2.5 lists it on `send`'s init; it only matters where a body is read.)
   */
  maxBody?: number
}

const dec = new TextDecoder()

export class OAuthHttp {
  private readonly fetchFn: typeof fetch
  private readonly auth?: AccessTokenSource
  private readonly o: OAuthHttpOptions

  constructor(ctx: BackendContext, o: OAuthHttpOptions) {
    this.fetchFn = ctx.fetch ?? ((input, init) => fetch(input, init))
    this.auth = ctx.auth
    this.o = o
  }

  /**
   * One request (plus one retry after a 401 with a refreshed token). `init.body` must be re-sendable
   * (bytes or a string, not a stream).
   */
  async send(url: string, init: SendInit = {}): Promise<Response> {
    const { auth: useAuth = true, expect, maxBody: _maxBody, ...req } = init
    const signal = req.signal ?? undefined
    let token: string | undefined
    if (useAuth) {
      if (!this.auth) throw new BackendError('reauth', `Not signed in to ${this.o.label}`, { providerCode: 'NoTokens' })
      token = await this.auth.token({ signal })
    }
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(req.headers)
      if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
      let res: Response
      try {
        signal?.throwIfAborted()
        res = await this.fetchFn(url, { ...req, headers })
      } catch (e) {
        throw this.fetchFailure(e, signal)
      }
      if (res.ok || expect?.includes(res.status)) return res
      const body = await this.errorBody(res)
      if (res.status === 401 && token !== undefined) {
        if (attempt === 0) {
          token = await this.auth!.refreshAfter401(token, { signal })
          continue
        }
        const e = this.o.mapError(res, body)
        if (e.code === 'reauth') throw e
        throw new BackendError('reauth', `${this.o.label} refused the sign-in`, { status: 401, providerCode: e.providerCode })
      }
      throw this.o.mapError(res, body)
    }
  }

  /** `send`, then the body as JSON (capped at `maxBody ?? JSON_MAX`). An empty body gives `null`. */
  async json<T>(url: string, init: SendInit = {}): Promise<T> {
    const res = await this.send(url, init)
    const max = init.maxBody ?? JSON_MAX
    let bytes: Uint8Array
    try {
      bytes = await readBody(res, max, () => new BackendError('unknown', `${this.o.label} sent an answer larger than ${max} bytes`, { providerCode: 'TooLarge', status: res.status }))
    } catch (e) {
      throw e instanceof BackendError ? e : this.fetchFailure(e, init.signal ?? undefined)
    }
    if (!bytes.length) return null as T
    try {
      return JSON.parse(dec.decode(bytes)) as T
    } catch {
      throw new BackendError('unknown', `${this.o.label} sent an answer that isn't JSON`, { providerCode: 'BadJson', status: res.status })
    }
  }

  private async errorBody(res: Response): Promise<string> {
    try {
      return dec.decode(await readBody(res, ERROR_BODY_MAX, 'truncate'))
    } catch {
      return ''
    }
  }

  /** A fetch that threw (no response): aborted or offline. Drives allow our origin, so no CORS probe. */
  private fetchFailure(e: unknown, signal?: AbortSignal): unknown {
    if (e instanceof BackendError) return e
    if (isAbort(e, signal)) return signal?.aborted ? abortError(signal) : e
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return new BackendError('network', 'This device is offline', { cause: e })
    return new BackendError('network', `Can't reach ${this.o.label}`, { cause: e })
  }
}
