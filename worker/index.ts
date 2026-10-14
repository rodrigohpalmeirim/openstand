/**
 * OpenStand on Cloudflare Workers.
 *
 * Static assets (the PWA in dist/) are served by the asset store; the Worker only runs for /relay
 * (see run_worker_first in wrangler.jsonc). /relay?room=NAME upgrades to a WebSocket that joins one
 * Durable Object per room, which rebroadcasts every text message to the room's other clients: the
 * same contract as server/relay.mjs, so the app can't tell them apart. Messages are never parsed or
 * stored. The Hibernation API keeps idle rooms from being billed for wall-clock time.
 */
import { DurableObject } from 'cloudflare:workers'

const MAX_MESSAGE = 256 * 1024
const MAX_ROOM = 64
const MAX_PER_SECOND = 60

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  })

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/relay' && !url.pathname.startsWith('/relay/')) return env.ASSETS.fetch(request)

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ service: 'openstand-relay' })

    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    const origin = request.headers.get('origin')
    if (allowed.length && origin && origin !== url.origin && !allowed.includes(origin)) return new Response('Forbidden', { status: 403 })

    const room = (url.searchParams.get('room') || url.pathname.slice('/relay/'.length) || 'default').slice(0, 64)
    return env.RELAY.get(env.RELAY.idFromName(room)).fetch(request)
  },
} satisfies ExportedHandler<Env>

export class RelayRoom extends DurableObject<Env> {
  /** Per-socket flood window. In memory only: it resets when the room hibernates, which is fine. */
  private windows = new WeakMap<WebSocket, { start: number; count: number }>()

  async fetch(): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_ROOM) return new Response('Room Full', { status: 503 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return // the app only speaks JSON text
    if (message.length > MAX_MESSAGE) return ws.close(1009, 'Message too big')
    const now = Date.now()
    let w = this.windows.get(ws)
    if (!w || now - w.start > 1000) this.windows.set(ws, (w = { start: now, count: 0 }))
    if (++w.count > MAX_PER_SECOND) return
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue
      try {
        peer.send(message)
      } catch {
        /* closing socket; the runtime cleans it up */
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code < 1000 ? 1000 : code)
    } catch {
      /* already closed */
    }
  }
}
