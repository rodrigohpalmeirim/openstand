/**
 * OpenStand on Cloudflare Workers.
 *
 * Static assets (the PWA in dist/) are served by the asset store; the Worker only runs for /relay
 * (see run_worker_first in wrangler.jsonc). Two kinds of room, both one Durable Object each:
 *
 * - perf: /relay?room=NAME (performance sync, src/sync/), up to 64 clients, 256 KiB messages.
 * - lib:  /relay/lib/<roomId> (library sync notices, docs/SYNC.md §9), up to 32 clients, 1 KiB, 5 msg/s.
 *   The DO is named `lib:<roomId>`; perf rooms may not use that prefix, so the two never meet.
 *
 * Each room rebroadcasts every text message to its other clients: the same contract as
 * server/relay.mjs, so the app can't tell them apart. Messages are never parsed or stored.
 * `{"ping":1}` is answered with `{"pong":1}` by the runtime without waking the room. The Hibernation
 * API keeps idle rooms from being billed for wall-clock time. Same class and namespace as before, so no
 * migration is needed.
 */
import { DurableObject } from 'cloudflare:workers'

type RoomKind = 'perf' | 'lib'

const LIMITS: Record<RoomKind, { maxMessage: number; maxRoom: number; perSecond: number }> = {
  perf: { maxMessage: 256 * 1024, maxRoom: 64, perSecond: 60 },
  lib: { maxMessage: 1024, maxRoom: 32, perSecond: 5 },
}

const LIB = /^\/relay\/lib\/([a-z2-7]{26})$/

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  })

const encoder = new TextEncoder()

/** UTF-8 size, computed only when the UTF-16 length alone can't decide it. */
function tooBig(message: string, max: number): boolean {
  if (message.length > max) return true
  if (message.length * 3 <= max) return false
  return encoder.encode(message).length > max
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/relay' && !url.pathname.startsWith('/relay/')) return env.ASSETS.fetch(request)

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ service: 'openstand-relay', features: ['lib'] })

    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    const origin = request.headers.get('origin')
    if (allowed.length && origin && origin !== url.origin && !allowed.includes(origin)) return new Response('Forbidden', { status: 403 })

    const lib = url.pathname.match(LIB)
    let name: string
    let kind: RoomKind
    if (lib) {
      name = `lib:${lib[1]}`
      kind = 'lib'
    } else {
      if (url.pathname.startsWith('/relay/lib/')) return new Response('Bad room id', { status: 400 })
      name = (url.searchParams.get('room') || url.pathname.slice('/relay/'.length) || 'default').slice(0, 64)
      if (name.startsWith('lib:')) return new Response('Reserved room name', { status: 400 })
      kind = 'perf'
    }
    // Always set (never trust a client-sent value) so the room knows its limits.
    const headers = new Headers(request.headers)
    headers.set('x-room-kind', kind)
    return env.RELAY.get(env.RELAY.idFromName(name)).fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>

export class RelayRoom extends DurableObject<Env> {
  /** Per-socket flood window. In memory only: it resets when the room hibernates, which is fine. */
  private windows = new WeakMap<WebSocket, { start: number; count: number }>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"ping":1}', '{"pong":1}'))
  }

  async fetch(request: Request): Promise<Response> {
    const kind: RoomKind = request.headers.get('x-room-kind') === 'lib' ? 'lib' : 'perf'
    if (this.ctx.getWebSockets().length >= LIMITS[kind].maxRoom) return new Response('Room Full', { status: 503 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, [kind])
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return // the app only speaks JSON text
    const limits = LIMITS[this.ctx.getTags(ws)[0] === 'lib' ? 'lib' : 'perf']
    if (tooBig(message, limits.maxMessage)) return ws.close(1009, 'Message too big')
    const now = Date.now()
    let w = this.windows.get(ws)
    if (!w || now - w.start > 1000) this.windows.set(ws, (w = { start: now, count: 0 }))
    if (++w.count > limits.perSecond) return
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
