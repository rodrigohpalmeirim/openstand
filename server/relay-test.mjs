/**
 * Tests for the sync relay. Run: node --test server/relay-test.mjs   (Node 22+, uses the built-in
 * WebSocket client). Not picked up by vitest on purpose (it needs real sockets).
 */
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { after, before, test } from 'node:test'
import { createRelay, encodeFrame } from './relay.mjs'

let relay
let base

before(async () => {
  relay = createRelay({ maxMessage: 200_000, maxRoom: 3, heartbeatMs: 200, log: null })
  await new Promise((r) => relay.server.listen(0, '127.0.0.1', r))
  base = `ws://127.0.0.1:${relay.server.address().port}`
})
after(() => {
  relay.closeAll()
  relay.server.close()
})

function open(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/?room=${encodeURIComponent(room)}`)
    ws.inbox = []
    ws.waiters = []
    ws.onmessage = (e) => {
      ws.inbox.push(e.data)
      ws.waiters.splice(0).forEach((w) => w())
    }
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('connect failed'))
  })
}

async function next(ws, ms = 1000) {
  if (ws.inbox.length) return ws.inbox.shift()
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms)
    ws.waiters.push(() => (clearTimeout(t), resolve()))
  })
  return ws.inbox.shift()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('broadcasts within a room, not to the sender or other rooms', async () => {
  const a = await open('band')
  const b = await open('band')
  const c = await open('other')
  a.send('{"hello":1}')
  assert.equal(await next(b), '{"hello":1}')
  await sleep(100)
  assert.equal(a.inbox.length, 0)
  assert.equal(c.inbox.length, 0)
  c.send('x')
  await sleep(100)
  assert.equal(a.inbox.length + b.inbox.length, 0)
  for (const ws of [a, b, c]) ws.close()
})

test('handles 16- and 64-bit payload lengths and unicode', async () => {
  const a = await open('big')
  const b = await open('big')
  const mid = 'ü'.repeat(40_000) // 80 KB as UTF-8 → 64-bit length frame
  const small = 'x'.repeat(300) // 16-bit length frame
  a.send(small)
  a.send(mid)
  assert.equal(await next(b), small)
  assert.equal(await next(b), mid)
  a.close()
  b.close()
})

test('closes connections that send oversized messages', async () => {
  const a = await open('limits')
  const closed = new Promise((r) => (a.onclose = (e) => r(e.code)))
  a.send('y'.repeat(250_000))
  assert.equal(await closed, 1009)
})

test('keeps healthy clients through heartbeats (client answers pings)', async () => {
  const a = await open('hb')
  const b = await open('hb')
  await sleep(700) // several heartbeat rounds
  a.send('still here')
  assert.equal(await next(b), 'still here')
  a.close()
  b.close()
})

test('enforces the room size limit', async () => {
  const xs = [await open('full'), await open('full'), await open('full')]
  await assert.rejects(open('full'))
  xs.forEach((x) => x.close())
})

test('completes the RFC 6455 handshake and rejects unmasked client frames', async () => {
  const port = relay.server.address().port
  const sock = connect(port, '127.0.0.1')
  await new Promise((r) => sock.once('connect', r))
  sock.write(
    'GET /?room=raw HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  )
  const chunks = []
  sock.on('data', (d) => chunks.push(d))
  await sleep(100)
  const head = Buffer.concat(chunks).toString()
  assert.match(head, /101 Switching Protocols/)
  assert.match(head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/) // RFC 6455 example
  sock.write(encodeFrame(0x1, Buffer.from('unmasked'))) // server frames are unmasked = invalid from a client
  await new Promise((r) => sock.once('close', r))
  const all = Buffer.concat(chunks)
  const closeAt = all.indexOf(Buffer.from([0x88]))
  assert.ok(closeAt > 0, 'got a close frame')
  assert.equal(all.readUInt16BE(closeAt + 2), 1002)
})

test('answers plain HTTP with a health summary', async () => {
  const port = relay.server.address().port
  const res = await fetch(`http://127.0.0.1:${port}/`)
  const body = await res.json()
  assert.equal(body.service, 'openstand-relay')
  assert.equal(typeof body.clients, 'number')
})
