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

/** Normalise what people type: "192.168.1.5:8787", "ws://…", "https://relay.example" → ws(s) URL with room. */
export function relayUrl(input: string, room: string): string {
  let u = input.trim()
  if (!/^[a-z]+:\/\//i.test(u)) u = `${typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'}://${u}`
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

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close(1000, 'bye')
    this.ws = null
    this.status = 'closed'
  }
}
