// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { Transport, TransportEvents } from '../sync/transports'
import { deriveLibraryKeys, newSecret, openNotice, sealNotice } from './crypto'
import type { Engine, EngineEnv, EngineTimers } from './engine'
import type { NoticePayload } from './model'
import { libRelayUrl, NoticeChannel, PING_INTERVAL, PONG_TIMEOUT } from './relay'
import { adoptSiteRelay } from './join'
import { getConfig } from './state'
import { addSong, enableDevice, joinDevice, pairing, world } from './sync.test-helper'

interface Peer {
  ev: TransportEvents
  t: Transport & { reconnects: number }
  /** Frames this client sent (pings included). */
  sent: string[]
  /** Up and in the room. */
  up: boolean
  /** Half-open: frames vanish both ways while the client still thinks it's open. */
  dead: boolean
}

/** An in-process relay: rebroadcasts text frames to the room's other clients (like server/relay.mjs). */
class Hub {
  rooms = new Map<string, Set<Peer>>()
  urls: string[] = []
  /** Answer `{"ping":1}` like the real relays. */
  pong = true
  /** Reconnects fail while set. */
  down = false
  transport = (url: string, room: string, ev: TransportEvents): Transport => {
    this.urls.push(url)
    const peers = this.rooms.get(url) ?? new Set()
    this.rooms.set(url, peers)
    const self: Peer = {
      ev,
      sent: [],
      up: false,
      dead: false,
      t: {
        kind: 'relay' as const,
        status: 'connecting' as Transport['status'],
        reconnects: 0,
        send: (data: string) => {
          if (self.t.status !== 'open') return
          self.sent.push(data)
          if (self.dead) return
          if (data === '{"ping":1}') return void (this.pong && queueMicrotask(() => self.ev.onMessage('{"pong":1}')))
          for (const p of peers) if (p !== self && p.up && !p.dead) queueMicrotask(() => p.ev.onMessage(data))
        },
        close: () => {
          peers.delete(self)
          self.up = false
          self.t.status = 'closed'
        },
        reconnect: () => {
          self.t.reconnects++
          this.connect(self, peers)
        },
      },
    }
    peers.add(self)
    this.connect(self, peers)
    void room
    return self.t
  }

  private connect(self: Peer, peers: Set<Peer>) {
    self.dead = false
    self.t.status = 'connecting'
    queueMicrotask(() => {
      if (!peers.has(self)) return
      if (this.down) {
        self.t.status = 'error'
        return self.ev.onStatus('error')
      }
      self.up = true
      self.t.status = 'open'
      self.ev.onStatus('open')
    })
  }

  /** The connection drops (the client sees it and starts its backoff). */
  drop(p: Peer) {
    p.up = false
    p.t.status = 'error'
    p.ev.onStatus('error')
  }

  peers(i = 0) {
    return [...this.rooms.get(this.urls[i])!]
  }
}

/** Timers the test fires by hand. */
function manualTimers() {
  let id = 0
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const intervals = new Map<number, () => void>()
  const timers = {
    setTimeout: ((fn: () => void, ms = 0) => (pending.set(++id, { fn, ms }), id)) as unknown as typeof setTimeout,
    clearTimeout: ((h: number) => void pending.delete(h)) as unknown as typeof clearTimeout,
    setInterval: ((fn: () => void) => (intervals.set(++id, fn), id)) as unknown as typeof setInterval,
    clearInterval: ((h: number) => void intervals.delete(h)) as unknown as typeof clearInterval,
  } satisfies EngineTimers
  return {
    timers,
    pending: () => [...pending.values()].map((p) => p.ms),
    /** Run due callbacks (all of them, or those with delay ≤ maxMs). */
    async fire(maxMs = Infinity) {
      const due = [...pending].filter(([, p]) => p.ms <= maxMs)
      for (const [k] of due) pending.delete(k)
      for (const [, p] of due) p.fn()
      await new Promise((r) => setTimeout(r, 20))
    },
    /** Run the interval callbacks (the keep-alive ping). */
    async tickIntervals() {
      for (const fn of intervals.values()) fn()
      await new Promise((r) => setTimeout(r, 20))
    },
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const dev = (i: number) => `${i}`.padStart(16, 'a')

async function notices(keys: Awaited<ReturnType<typeof deriveLibraryKeys>>, frames: string[]) {
  const out: NoticePayload[] = []
  for (const f of frames) {
    const p = await openNotice(keys, f)
    if (p) out.push(p)
  }
  return out
}

describe('relay notices', () => {
  it('delivers sealed notices to the other devices of the room only', async () => {
    const hub = new Hub()
    const keys = await deriveLibraryKeys(newSecret())
    const other = await deriveLibraryKeys(newSecret())
    const got: { d: string; s: number }[][] = [[], [], []]
    const mk = (i: number, k = keys) => new NoticeChannel({ base: '/relay', keys: k, deviceId: dev(i), transport: hub.transport, onNotice: (p) => got[i].push(p) })
    const a = mk(0)
    mk(1)
    mk(2, other)
    await tick()
    await a.post(7)
    await tick()
    expect(got[1]).toEqual([{ d: 'aaaaaaaaaaaaaaa0', s: 7 }])
    expect(got[0]).toEqual([]) // own notice ignored
    expect(got[2]).toEqual([]) // another library's room
    expect(hub.urls[0]).toBe(libRelayUrl('/relay', keys.roomId))
    expect(hub.urls[0]).toMatch(/^\/relay\/lib\/[a-z2-7]{26}$/)
    // Garbage, pongs and wrong-key frames are ignored, never fatal.
    const peer = hub.peers()[1]
    peer.ev.onMessage('{"pong":1}')
    peer.ev.onMessage('not json')
    peer.ev.onMessage(await sealNotice(other, { d: 'bbbbbbbbbbbbbbbb', s: 1 }))
    await tick()
    expect(got[1]).toHaveLength(1)
  })

  it('coalesces notices under the room rate limit, and sends what was posted while disconnected once open', async () => {
    const hub = new Hub()
    const keys = await deriveLibraryKeys(newSecret())
    const tm = manualTimers()
    const sentSeqs: number[] = []
    let t = 1_000_000
    const later = () => (t += 1000)
    const a = new NoticeChannel({ base: '/relay', keys, deviceId: dev(0), transport: hub.transport, timers: tm.timers, now: () => t, onNotice: () => {}, onSent: (s) => sentSeqs.push(s) })
    await tick()
    const pa = hub.peers()[0]
    const seqs = async () => (await notices(keys, pa.sent)).map((p) => p.s)
    // A burst: the first goes at once, the rest collapse into the latest one after the send gap.
    await a.post(1)
    await a.post(2)
    await a.post(3)
    await tick()
    expect(await seqs()).toEqual([1])
    expect(tm.pending()).toContain(250) // SEND_GAP
    later()
    await tm.fire()
    expect(await seqs()).toEqual([1, 3])
    expect(sentSeqs).toEqual([1, 3])

    // Posted while the socket is down: nothing is lost, it goes out on the next open.
    hub.drop(pa)
    await a.post(4)
    later()
    await tm.fire()
    expect(await seqs()).toEqual([1, 3])
    pa.t.reconnect!()
    await tick()
    later()
    await tm.fire()
    expect(await seqs()).toEqual([1, 3, 4])

    // Every reopen re-announces the latest seq (what went into a dead socket may never have arrived).
    hub.drop(pa)
    pa.t.reconnect!()
    later()
    await tick()
    await tm.fire()
    expect(await seqs()).toEqual([1, 3, 4, 4])
    a.close()
  })

  it('reconnects a socket that stopped answering pings (half-open), and wakes up a waiting one at once', async () => {
    const hub = new Hub()
    const keys = await deriveLibraryKeys(newSecret())
    const tm = manualTimers()
    const a = new NoticeChannel({ base: '/relay', keys, deviceId: dev(0), transport: hub.transport, timers: tm.timers, onNotice: () => {} })
    await tick() // open → ping → pong: this relay answers pings
    const pa = hub.peers()[0]
    expect(pa.sent).toContain('{"ping":1}')
    await tm.fire() // the open-time check passed
    expect(pa.t.reconnects).toBe(0)

    // Alive: the keep-alive ping is answered, nothing happens.
    await tm.tickIntervals()
    expect(tm.pending()).toContain(PONG_TIMEOUT)
    await tm.fire()
    expect(pa.t.reconnects).toBe(0)

    // Half-open: frames vanish, the browser still says open. The missing pong forces a reconnect.
    pa.dead = true
    await tm.tickIntervals()
    await tm.fire()
    expect(pa.t.reconnects).toBe(1)
    expect(a.state).toBe('open')

    // Waiting out a backoff when the page comes back: reconnect now.
    hub.down = true
    hub.drop(pa)
    expect(a.state).toBe('error')
    hub.down = false
    a.wake()
    await tick()
    expect(pa.t.reconnects).toBe(2)
    expect(a.state).toBe('open')
    // Open and alive: wake only checks with a ping.
    const pings = pa.sent.length
    a.wake()
    expect(pa.sent.length).toBe(pings + 1)
    expect(PING_INTERVAL).toBeLessThanOrEqual(30_000)
    a.close()
  })

  it('does not judge a relay that never answers pings', async () => {
    const hub = new Hub()
    hub.pong = false
    const keys = await deriveLibraryKeys(newSecret())
    const tm = manualTimers()
    const a = new NoticeChannel({ base: '/relay', keys, deviceId: dev(0), transport: hub.transport, timers: tm.timers, onNotice: () => {} })
    await tick()
    await tm.tickIntervals()
    await tm.fire()
    expect(hub.peers()[0].t.reconnects).toBe(0)
    a.close()
  })

  it('answers a sealed ping from another device of the library with a sealed pong addressed to it', async () => {
    const hub = new Hub()
    const keys = await deriveLibraryKeys(newSecret())
    const other = await deriveLibraryKeys(newSecret())
    const gotA: NoticePayload[] = []
    const gotB: NoticePayload[] = []
    const a = new NoticeChannel({ base: '/relay', keys, deviceId: dev(0), transport: hub.transport, onNotice: (p) => gotA.push(p) })
    const b = new NoticeChannel({ base: '/relay', keys, deviceId: dev(1), transport: hub.transport, onNotice: (p) => gotB.push(p), head: () => 12 })
    await tick()
    // Older builds still send pings ("Test instant sync"); another library's ping goes unanswered.
    const pa = hub.peers()[0]
    pa.t.send(await sealNotice(other, { d: dev(7), s: 0, k: 'ping', p: 'nonce-other-000' }))
    pa.t.send(await sealNotice(keys, { d: dev(0), s: 0, k: 'ping', p: 'nonce-1234567' }))
    await tick(50)
    // The receiver saw the ping as a notice too (it carries the pinger's head) and answered once, within limits.
    expect(gotB.some((p) => p.k === 'ping' && p.d === dev(0))).toBe(true)
    const pb = hub.peers()[1]
    const pongs = (await notices(keys, pb.sent)).filter((p) => p.k === 'pong')
    expect(pongs).toEqual([{ d: dev(1), s: 12, k: 'pong', p: 'nonce-1234567', to: dev(0) }])
    expect(pb.sent.every((f) => f.length <= 1024)).toBe(true)
    expect(gotA.some((p) => p.k === 'pong' && p.d === dev(1))).toBe(true)
    a.close()
    b.close()
  })
})

describe('engine scheduling with the relay', () => {
  async function pair(o: { env?: EngineEnv } = {}) {
    const w = world()
    const hub = new Hub()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const ta = manualTimers()
    const tb = manualTimers()
    const eA = await enableDevice(w, A, { relayTransport: hub.transport, timers: ta.timers, env: o.env })
    const B = w.db('B')
    const eB = await joinDevice(w, B, A, 'here', { relayTransport: hub.transport, timers: tb.timers, env: o.env })
    for (const e of [eA, eB]) e.core.config = { ...e.core.config, relay: '/relay' }
    await eA.start()
    await eB.start()
    await tick(50)
    await ta.fire()
    await tb.fire()
    await tick(50)
    const [pA, pB] = hub.peers()
    return { w, hub, A, B, eA, eB, ta, tb, pA, pB }
  }
  /** Fire B's timers until `fn` holds (each round: notice debounce, runSoon, sync). */
  async function until(t: ReturnType<typeof manualTimers>, fn: () => Promise<boolean>, maxMs = Infinity) {
    for (let i = 0; i < 6 && !(await fn()); i++) {
      await t.fire(maxMs)
      await tick(50)
    }
    return fn()
  }
  const stop = (...e: Engine[]) => e.forEach((x) => x.stop())
  /** Wait (no timers fired) until `fn` holds. */
  async function eventually(fn: () => Promise<boolean>, ms = 1500) {
    for (let t = 0; t < ms && !(await fn()); t += 25) await tick(25)
    return fn()
  }

  it('a local edit is captured quickly, pushed, and the notice makes the other device pull', async () => {
    const { A, B, eA, eB, ta } = await pair()
    expect(eA.status.relay).toBe('open')
    await A.table('songs').update('s1', { title: 'Edited on A' })
    await tick(50) // liveQuery sees the dirty mark
    expect(ta.pending()).toContain(300) // the first change after a quiet spell: CAPTURE_FAST
    await ta.fire(300) // capture + push + notice
    await tick(50)
    await ta.fire(250) // (the notice waits out the send gap after the one announced at open)
    const cursors = (await eA.core.db.syncState.get('cursors'))?.value as Record<string, number>
    expect(eA.status.diag.noticeSent?.seq).toBe(cursors[eA.config.deviceId])
    // B pulls straight from the socket's message handler: none of its timers is involved.
    expect(await eventually(async () => (await B.songs.get('s1'))?.title === 'Edited on A')).toBe(true)
    // (Under load B's start-up pull may still be running: the notice then queues one more pull after it.)
    expect(await eventually(async () => eB.status.diag.lastPull?.trigger === 'notice')).toBe(true)
    expect(eB.status.diag.noticeReceived?.device).toBe(eA.config.deviceId)
    // A second edit soon after batches for the full debounce.
    await A.table('songs').update('s1', { title: 'Again' })
    await tick(50)
    expect(ta.pending()).toContain(1500)
    stop(eA, eB)
  })

  it('receiver: a notice missed while its socket was down is caught up when the relay reopens', async () => {
    const { hub, A, B, eA, eB, ta, tb, pB } = await pair()
    hub.down = true
    hub.drop(pB)
    await tick()
    await A.table('songs').update('s1', { title: 'While B was away' })
    await tick(50)
    await ta.fire(1500) // A pushes; its notice reaches nobody
    await tick(50)
    expect((await B.songs.get('s1'))?.title).toBe('One')
    hub.down = false
    pB.t.reconnect!() // the transport's backoff retry
    await tick(20)
    expect(eB.status.relay).toBe('open')
    // Reopen → pull without waiting for the poll (the poll is the only timer that's ≥ 30 s).
    expect(await until(tb, async () => (await B.songs.get('s1'))?.title === 'While B was away', 2000)).toBe(true)
    expect(eB.status.diag.lastPull?.trigger).toBe('relay')
    stop(eA, eB)
  })

  it('sender: a notice posted while its own socket was reconnecting goes out when it reopens', async () => {
    const { hub, A, B, eA, eB, ta, tb, pA } = await pair()
    await tb.fire(2000) // B's start-up pulls are done; only its poll is left
    hub.down = true
    hub.drop(pA)
    await A.table('songs').update('s1', { title: 'Posted offline' })
    await tick(50)
    await ta.fire(1500)
    await tick(50)
    expect(tb.pending().every((ms) => ms >= 30_000)).toBe(true) // B heard nothing
    hub.down = false
    pA.t.reconnect!()
    await tick(50)
    await ta.fire(2000)
    // A re-announced its head: B gets a notice and pulls (no timer of B's fired).
    expect(await eventually(async () => (await B.songs.get('s1'))?.title === 'Posted offline')).toBe(true)
    expect(eB.status.diag.lastPull?.trigger).toBe('notice')
    stop(eA, eB)
  })

  it('a hidden but alive window (covered, minimised, background tab) still gets notices and pulls with its timers frozen', async () => {
    let bVisible = true
    const envB: EngineEnv = { visible: () => bVisible, online: () => true, performing: () => false, idle: () => false }
    const w = world()
    const hub = new Hub()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const ta = manualTimers()
    const tb = manualTimers()
    const eA = await enableDevice(w, A, { relayTransport: hub.transport, timers: ta.timers })
    const B = w.db('B')
    const eB = await joinDevice(w, B, A, 'here', { relayTransport: hub.transport, timers: tb.timers, env: envB })
    for (const e of [eA, eB]) e.core.config = { ...e.core.config, relay: '/relay' }
    await eA.start()
    await eB.start()
    await tick(50)
    await ta.fire()
    await tb.fire()
    await tick(50)
    // B goes hidden: it keeps its relay, and from now on none of its timers fire (intensive throttling).
    bVisible = false
    eB.onVisibility(false)
    await tick(50)
    expect(eB.status.relay).toBe('open')
    await A.table('songs').update('s1', { title: 'Seen while hidden' })
    await tick(50)
    await ta.fire(300)
    await tick(50)
    await ta.fire(250)
    expect(await eventually(async () => (await B.songs.get('s1'))?.title === 'Seen while hidden')).toBe(true)
    expect(eB.status.diag.noticeReceived?.hidden).toBe(true)
    expect(eB.status.diag.lastPull).toMatchObject({ trigger: 'notice', hidden: true, ok: true })
    stop(eA, eB)
  })

  it('wake: shown again pulls at once; focus with a live relay and a recent pull does not; hiding pushes at once', async () => {
    let visible = true
    const env: EngineEnv = { visible: () => visible, online: () => true, performing: () => false, idle: () => false }
    const { w, A, B, eA, eB, ta, tb } = await pair({ env })
    await tb.fire(2000)
    await ta.fire(2000)
    await tick(50)
    const last = () => eA.status.diag.lastPull?.at
    // Focus right after a pull with the relay up: no request.
    w.advance(1000)
    const before = last()
    eA.wake('focus')
    await tick(50)
    expect(last()).toBe(before)
    // Long after the last pull, focus pulls at once (no timer).
    w.advance(31_000)
    eA.wake('focus')
    await tick(100)
    expect(last()).toBe(w.now())
    expect(eA.status.diag.lastPull?.trigger).toBe('focus')

    // Hidden: the pending edit is pushed at once (no debounce timer) and the relay stays up.
    await A.table('songs').update('s1', { title: 'Before hiding' })
    await tick(50)
    visible = false
    eA.onVisibility(false)
    expect(await eventually(async () => (await B.songs.get('s1'))?.title === 'Before hiding')).toBe(true)
    expect(eA.status.relay).toBe('open')
    // Shown again: a pull at once.
    w.advance(5000)
    visible = true
    eA.onVisibility(true)
    await tick(100)
    expect(last()).toBe(w.now())
    stop(eA, eB)
  })
})

describe('a library set up without a relay', () => {
  it('adopts the site relay once it answers: saved, connected, and carried by new pairing codes', async () => {
    const w = world()
    const hub = new Hub()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const eA = await enableDevice(w, A, { relayTransport: hub.transport, timers: manualTimers().timers })
    await eA.start()
    await tick(50)
    expect(eA.status).toMatchObject({ relay: 'off', relayConfigured: false })
    expect(hub.urls).toEqual([])
    // A joiner takes the missing relay from the pairing code.
    const B = w.db('B')
    const eB = await joinDevice(w, B, A, 'here', { relayTransport: hub.transport, timers: manualTimers().timers })
    expect(eB.config.relay).toBeNull()

    // This site has no relay: nothing changes.
    expect(await adoptSiteRelay(eA, '/relay', async () => false)).toBe(false)
    expect((await getConfig(A))!.relay).toBeNull()
    // It has one: saved and connected at once.
    expect(await adoptSiteRelay(eA, '/relay', async () => true)).toBe(true)
    await tick(50)
    expect((await getConfig(A))!.relay).toBe('/relay')
    expect(eA.status).toMatchObject({ relay: 'open', relayConfigured: true })
    expect(hub.urls[0]).toBe(libRelayUrl('/relay', eA.core.keys.roomId))
    expect((await pairing(A)).r).toBe('/relay')
    // A configured relay is never replaced.
    expect(await adoptSiteRelay(eA, '/other', async () => true)).toBe(false)
    expect(eA.config.relay).toBe('/relay')

    // The joiner heals the same way, and both meet in the library's room.
    await eB.start()
    expect(await adoptSiteRelay(eB, '/relay', async () => true)).toBe(true)
    await tick(50)
    expect(eB.status).toMatchObject({ relay: 'open', relayConfigured: true })
    expect(hub.peers()).toHaveLength(2)
    eA.stop()
    eB.stop()
  })
})
