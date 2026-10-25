/** Fake provider endpoints for the OAuth tests: a `fetch` routing on "METHOD url-without-query". */
import { b64url } from './pkce'

export const ORIGIN = 'http://localhost:5317'

export interface FakeCall {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export type Route = (call: FakeCall) => Response | Promise<Response>

export function fakeFetch(routes: Record<string, Route>) {
  const calls: FakeCall[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const call: FakeCall = { method: req.method, url: req.url, headers: Object.fromEntries(req.headers), body: await req.text() }
    calls.push(call)
    const u = new URL(req.url)
    const route = routes[`${req.method} ${u.origin}${u.pathname}`]
    if (!route) throw new Error(`no fake route for ${req.method} ${u.origin}${u.pathname}`)
    return route(call)
  }) as typeof fetch
  return { fetch: fn, calls, count: (path: string) => calls.filter((c) => c.url.includes(path)).length }
}

export const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers })

export const form = (body: string) => Object.fromEntries(new URLSearchParams(body))

/** An unsigned JWT with these claims (display-only id_token). */
export function jwt(claims: Record<string, unknown>) {
  const b = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))
  return `${b({ alg: 'none' })}.${b(claims)}.sig`
}

export const DROPBOX_TOKEN = 'POST https://api.dropboxapi.com/oauth2/token'
export const DROPBOX_ME = 'POST https://api.dropboxapi.com/2/users/get_current_account'
export const DROPBOX_REVOKE = 'POST https://api.dropboxapi.com/2/auth/token/revoke'
export const GDRIVE_TOKEN = `POST ${ORIGIN}/api/oauth/gdrive/token`
export const GDRIVE_ABOUT = 'GET https://www.googleapis.com/drive/v3/about'
export const ONEDRIVE_TOKEN = `POST ${ORIGIN}/api/oauth/onedrive/token`
export const ONEDRIVE_APPROOT = 'GET https://graph.microsoft.com/v1.0/me/drive/special/approot'
export const PROVIDERS_ROUTE = `GET ${ORIGIN}/api/oauth/providers`
