/**
 * Sync transports. Both just move strings around a "room":
 *  - LocalTransport: BroadcastChannel between windows/tabs of this browser (second screen, a laptop
 *    window driven by a foot pedal…). No server needed.
 *  - RelayTransport: WebSocket to a tiny relay (server/relay.mjs) that rebroadcasts to the room, for
 *    separate devices. Reconnects with backoff.
 */
export type TransportStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface Transport {
  readonly kind: 'local' | 'relay'
  status: TransportStatus
  send(data: string): void
  close(): void
  /** Drop the current connection (if any) and connect again now, skipping any backoff wait. */
  reconnect?(): void
}

export interface TransportEvents {
  onMessage: (data: string) => void
  onStatus: (s: TransportStatus, detail?: string) => void
}

export class LocalTransport implements Transport {
  readonly kind = 'local'
  status: TransportStatus = 'closed'
  private ch: BroadcastChannel | null = null

  constructor(room: string, ev: TransportEvents) {
    if (typeof BroadcastChannel === 'undefined') {
      this.status = 'error'
      queueMicrotask(() => ev.onStatus('error', 'BroadcastChannel is not supported'))
      return
    }
    this.ch = new BroadcastChannel(`openstand-sync:${room}`)
    this.ch.onmessage = (e) => typeof e.data === 'string' && ev.onMessage(e.data)
    this.status = 'open'
    queueMicrotask(() => ev.onStatus('open'))
  }

  send(data: string) {
    this.ch?.postMessage(data)
  }

  close() {
    this.ch?.close()
    this.ch = null
    this.status = 'closed'
  }
}

/** Normalise what people type: "192.168.1.5:8787", "ws://…", "https://relay.example", or "/relay" (the
 *  relay built into the Cloudflare Worker deployment, on this site) → ws(s) URL with room. */
export function relayUrl(input: string, room: string): string {
  let u = input.trim()
  const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  if (u.startsWith('/') && typeof location !== 'undefined') u = `${scheme}://${location.host}${u}`
  else if (!/^[a-z]+:\/\//i.test(u)) u = `${scheme}://${u}`
  u = u.replace(/^http(s?):\/\//i, 'ws$1://')
  const url = new URL(u)
  url.searchParams.set('room', room)
  return url.toString()
}

/** An https page can't open ws:// to anything but localhost (mixed content). */
export function mixedContentProblem(input: string): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:' || !input.trim()) return false
  try {
    const u = new URL(relayUrl(input, 'x'))
    return u.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/** Path of the relay that the Cloudflare Worker deployment serves next to the app (worker/index.ts). */
export const SAME_SITE_RELAY = '/relay'

/** One probe of the health JSON. `null`: no answer (offline, timeout); false: something else answered. */
async function probeRelay(timeoutMs: number): Promise<boolean | null> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined
  try {
    // The query makes the URL unique, so no cache (HTTP or a service worker's) can answer it; the service
    // worker also routes /relay network-only (vite.config.ts).
    const res = await fetch(`${SAME_SITE_RELAY}?probe=${Date.now().toString(36)}`, { cache: 'no-store', signal: ctl?.signal })
    if (res.status >= 500) return null
    if (!res.ok) return false
    // Parse the body rather than trusting the content type: an SPA fallback answers with index.html.
    const body = JSON.parse(await res.text()) as { service?: unknown } | null
    return body?.service === 'openstand-relay'
  } catch (e) {
    return e instanceof SyntaxError ? false : null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Whether the site OpenStand is served from also hosts a relay (true on the Cloudflare Worker deployment).
 * Retries when there's no answer (a flaky network, a 5xx), so a blip doesn't read as "no relay".
 */
export async function sameSiteRelayAvailable(o: { attempts?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const attempts = o.attempts ?? 3
  for (let i = 0; i < attempts; i++) {
    const r = await probeRelay(o.timeoutMs ?? 5000)
    if (r !== null) return r
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 500 * 2 ** i))
  }
  return false
}

const BACKOFF = [1000, 2000, 4000, 8000, 15000]

export class RelayTransport implements Transport {
  readonly kind = 'relay'
  status: TransportStatus = 'connecting'
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private url: string
  private ev: TransportEvents

  constructor(url: string, room: string, ev: TransportEvents) {
    this.ev = ev
    this.url = relayUrl(url, room)
    this.open()
  }

  private set(s: TransportStatus, detail?: string) {
    this.status = s
    this.ev.onStatus(s, detail)
  }

  private open() {
    if (this.closed) return
    this.timer = null
    this.set('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.set('error', String((e as Error).message ?? e))
      return this.retry()
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.set('open')
    }
    ws.onmessage = (e) => typeof e.data === 'string' && this.ev.onMessage(e.data)
    ws.onerror = () => {
      /* onclose follows with the details */
    }
    ws.onclose = (e) => {
      this.ws = null
      if (this.closed) return
      this.set('error', e.reason || (this.attempt ? 'Relay unreachable' : 'Connection lost'))
      this.retry()
    }
  }

  private retry() {
    if (this.closed) return
    const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]
    this.timer = setTimeout(() => this.open(), wait)
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data)
  }

  /**
   * Connect again at once: after a backoff wait (the page came back, the network returned) or when the
   * socket looks dead (no pong: mobile networks drop connections without telling either end).
   */
  reconnect() {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const old = this.ws
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close(4000, 'reconnect')
      } catch {
        /* already closed */
      }
    }
    this.ws = null
    this.attempt = 0
    this.open()
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close(1000, 'bye')
    this.ws = null
    this.status = 'closed'
  }
}
