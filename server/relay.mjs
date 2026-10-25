#!/usr/bin/env node
/**
 * OpenStand sync relay — a tiny, dependency-free WebSocket broadcast server.
 *
 * Devices connect to ws://HOST:PORT/?room=NAME and every text message is forwarded to the other
 * clients in the same room. Library sync uses ws://HOST:PORT/lib/<roomId> (or
 * /relay/lib/<roomId>): room `lib:<roomId>` with tighter limits (1 KiB messages, 5 msg/s, 32 clients);
 * perf rooms can't use the `lib:` prefix. `{"ping":1}` is answered with `{"pong":1}` and not forwarded. The relay doesn't parse or store messages (the app protocol lives in
 * src/sync/protocol.ts), so it is safe to run anywhere: a laptop on the gig's Wi-Fi, a Raspberry Pi,
 * or a small VPS behind a TLS proxy (needed when OpenStand itself is served over https: use wss://).
 *
 * Run:   node server/relay.mjs                 (listens on 0.0.0.0:8787)
 *        PORT=9000 HOST=127.0.0.1 node server/relay.mjs
 * Env:   PORT, HOST, MAX_MESSAGE (bytes, default 262144), MAX_ROOM (clients per room, default 64),
 *        ALLOWED_ORIGINS (comma-separated list of OpenStand sites; empty = any origin). Library rooms
 *        always require an Origin header (browsers send one), so set this to the site(s) you use.
 * Then in OpenStand: Settings › Devices & sync › Relay address = <this machine's IP>:8787.
 * Health check: GET http://HOST:PORT/ returns a JSON summary.
 *
 * Implements RFC 6455 server side: handshake, masked client frames, fragmentation, ping/pong,
 * close, plus a 30 s heartbeat that drops dead connections.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const LIB_PATH = /^\/(?:relay\/)?lib\/([a-z2-7]{26})$/
const LIB_LIKE = /^\/(?:relay\/)?lib\//
const PING = '{"ping":1}'
const PONG = Buffer.from('{"pong":1}')
const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

/** Encode one unmasked server frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

const closePayload = (code, reason = '') => {
  const r = Buffer.from(reason.slice(0, 120))
  const b = Buffer.alloc(2 + r.length)
  b.writeUInt16BE(code, 0)
  r.copy(b, 2)
  return b
}

class Client {
  constructor(socket, room, relay, limits) {
    this.socket = socket
    this.room = room
    this.relay = relay
    this.limits = limits
    this.buf = Buffer.alloc(0)
    this.fragments = null
    this.fragOpcode = 0
    this.alive = true
    this.closed = false
    this.window = { start: Date.now(), count: 0 }
    socket.setNoDelay(true)
    socket.on('data', (d) => this.onData(d))
    socket.on('error', () => this.destroy())
    socket.on('close', () => this.destroy())
  }

  send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(encodeFrame(opcode, payload))
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.send(OP.close, closePayload(code, reason))
    this.closed = true
    this.relay.leave(this)
    this.socket.end()
    setTimeout(() => this.socket.destroy(), 1000).unref()
  }

  destroy() {
    if (!this.closed) {
      this.closed = true
      this.relay.leave(this)
    }
    this.socket.destroy()
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    while (!this.closed) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const opcode = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (b.length < 10) return
        const big = b.readBigUInt64BE(2)
        if (big > BigInt(this.limits.maxMessage)) return this.close(1009, 'Message too big')
        len = Number(big)
        off = 10
      }
      if (b[0] & 0x70) return this.close(1002, 'Reserved bits set')
      if (!masked) return this.close(1002, 'Client frames must be masked')
      if (len > this.limits.maxMessage) return this.close(1009, 'Message too big')
      if (b.length < off + 4 + len) return
      const mask = b.subarray(off, off + 4)
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.buf = b.subarray(off + 4 + len)
      this.onFrame(fin, opcode, payload)
    }
  }

  onFrame(fin, opcode, payload) {
    this.alive = true
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this.close(1002, 'Bad control frame')
      if (opcode === OP.ping) this.send(OP.pong, payload)
      else if (opcode === OP.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        this.close(code === 1005 || code < 1000 ? 1000 : code)
      }
      return
    }
    if (opcode === OP.cont) {
      if (!this.fragments) return this.close(1002, 'Unexpected continuation')
      this.fragments.push(payload)
      const size = this.fragments.reduce((n, f) => n + f.length, 0)
      if (size > this.limits.maxMessage) return this.close(1009, 'Message too big')
      if (!fin) return
      const whole = Buffer.concat(this.fragments)
      const op = this.fragOpcode
      this.fragments = null
      return this.onMessage(op, whole)
    }
    if (opcode !== OP.text && opcode !== OP.binary) return this.close(1003, 'Unsupported opcode')
    if (this.fragments) return this.close(1002, 'Expected continuation')
    if (!fin) {
      this.fragments = [payload]
      this.fragOpcode = opcode
      return
    }
    this.onMessage(opcode, payload)
  }

  onMessage(opcode, payload) {
    if (opcode !== OP.text) return // the app only speaks JSON text
    if (payload.length === PING.length && payload.toString() === PING) return this.send(OP.text, PONG)
    // Simple flood protection: perSecond messages per second per client (60 perf, 5 lib).
    const now = Date.now()
    if (now - this.window.start > 1000) this.window = { start: now, count: 0 }
    if (++this.window.count > this.limits.perSecond) return
    this.relay.broadcast(this, payload)
  }
}

/**
 * `maxMessage`, `maxRoom` and `perSecond` are the perf-room limits; `lib` overrides the library-sync ones
 * (default 1 KiB, 32 clients, 5 msg/s, as in worker/index.ts).
 */
export function createRelay({
  maxMessage = 256 * 1024,
  maxRoom = 64,
  perSecond = 60,
  lib = {},
  allowedOrigins = [],
  heartbeatMs = 30_000,
  log = console.log,
} = {}) {
  const limits = {
    perf: { maxMessage, maxRoom, perSecond },
    lib: { maxMessage: 1024, maxRoom: 32, perSecond: 5, ...lib },
  }
  /** @type {Map<string, Set<Client>>} */
  const rooms = new Map()
  const relay = {
    maxMessage,
    rooms,
    leave(c) {
      const set = rooms.get(c.room)
      if (!set) return
      set.delete(c)
      if (!set.size) rooms.delete(c.room)
    },
    broadcast(from, payload) {
      const frame = encodeFrame(OP.text, payload)
      for (const c of rooms.get(from.room) ?? []) if (c !== from && !c.closed && !c.socket.destroyed) c.socket.write(frame)
    },
  }

  const server = createServer((req, res) => {
    const clients = [...rooms.values()].reduce((n, s) => n + s.size, 0)
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ service: 'openstand-relay', features: ['lib'], rooms: rooms.size, clients }))
  })

  server.on('upgrade', (req, socket) => {
    const reject = (code, msg) => {
      socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const key = req.headers['sec-websocket-key']
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) return reject(400, 'Bad Request')
    if (req.headers['sec-websocket-version'] !== '13') return reject(426, 'Upgrade Required')
    const origin = req.headers.origin
    const url = new URL(req.url ?? '/', 'http://relay')
    const libMatch = LIB_PATH.exec(url.pathname)
    // Browsers always send Origin on WebSocket upgrades. Library rooms require it (and an allowed one when
    // ALLOWED_ORIGINS is set); perf rooms keep accepting origin-less clients as before.
    if (!origin) {
      if (libMatch) return reject(403, 'Forbidden')
    } else if (allowedOrigins.length && !allowedOrigins.includes(origin)) return reject(403, 'Forbidden')
    let room, kind
    if (libMatch) {
      room = `lib:${libMatch[1]}`
      kind = 'lib'
    } else {
      if (LIB_LIKE.test(url.pathname)) return reject(400, 'Bad Request')
      room = (url.searchParams.get('room') || url.pathname.replace(/^\/+/, '') || 'default').slice(0, 64)
      if (room.startsWith('lib:')) return reject(400, 'Bad Request')
      kind = 'perf'
    }
    const set = rooms.get(room) ?? new Set()
    // Someone who knows a room id can fill its slots. Accepted: lib room ids derive from the library secret,
    // and a client that can't connect still syncs by polling storage; it only loses instant notices.
    if (set.size >= limits[kind].maxRoom) return reject(503, 'Room Full')
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const client = new Client(socket, room, relay, limits[kind])
    set.add(client)
    rooms.set(room, set)
    log?.(`+ ${req.socket.remoteAddress} room="${room}" (${set.size} in room)`)
    socket.on('close', () => log?.(`- ${req.socket.remoteAddress} room="${room}"`))
  })

  const beat = setInterval(() => {
    for (const set of rooms.values())
      for (const c of set) {
        if (!c.alive) {
          c.destroy()
          continue
        }
        c.alive = false
        c.send(OP.ping, Buffer.alloc(0))
      }
  }, heartbeatMs)
  beat.unref()
  server.on('close', () => clearInterval(beat))

  const closeAll = () => {
    for (const set of rooms.values()) for (const c of set) c.close(1001, 'Server shutting down')
  }
  return { server, rooms, closeAll }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787)
  const host = process.env.HOST ?? '0.0.0.0'
  const { server, closeAll } = createRelay({
    maxMessage: Number(process.env.MAX_MESSAGE ?? 256 * 1024),
    maxRoom: Number(process.env.MAX_ROOM ?? 64),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  })
  server.listen(port, host, () => console.log(`OpenStand relay listening on ws://${host}:${port}/?room=<name>`))
  const stop = () => {
    closeAll()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
