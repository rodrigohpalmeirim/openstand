// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { Transport, TransportEvents } from '../sync/transports'
import { deriveLibraryKeys, newSecret, sealNotice } from './crypto'
import type { EngineTimers } from './engine'
import { libRelayUrl, NoticeChannel } from './relay'
import { addSong, enableDevice, joinDevice, world } from './sync.test-helper'

/** An in-process relay: rebroadcasts text frames to the room's other clients (like server/relay.mjs). */
class Hub {
  rooms = new Map<string, Set<{ ev: TransportEvents; t: Transport }>>()
  urls: string[] = []
  transport = (url: string, room: string, ev: TransportEvents): Transport => {
    this.urls.push(url)
    const peers = this.rooms.get(url) ?? new Set()
    this.rooms.set(url, peers)
    const self = {
      ev,
      t: {
        kind: 'relay' as const,
        status: 'open' as Transport['status'],
        send: (data: string) => {
          for (const p of peers) if (p !== self) queueMicrotask(() => p.ev.onMessage(data))
        },
        close: () => {
          peers.delete(self)
          self.t.status = 'closed'
        },
      },
    }
    peers.add(self)
    queueMicrotask(() => ev.onStatus('open'))
    void room
    return self.t
  }
}

/** Timers the test fires by hand. */
function manualTimers() {
  let id = 0
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const timers = {
    setTimeout: ((fn: () => void, ms = 0) => (pending.set(++id, { fn, ms }), id)) as unknown as typeof setTimeout,
    clearTimeout: ((h: number) => void pending.delete(h)) as unknown as typeof clearTimeout,
    setInterval: (() => 0) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
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
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

describe('relay notices (§4.3, §9)', () => {
  it('delivers sealed notices to the other devices of the room only', async () => {
    const hub = new Hub()
    const keys = await deriveLibraryKeys(newSecret())
    const other = await deriveLibraryKeys(newSecret())
    const got: { d: string; s: number }[][] = [[], [], []]
    const mk = (i: number, k = keys, dev = `${i}`.padStart(16, 'a')) =>
      new NoticeChannel({ base: '/relay', keys: k, deviceId: dev, transport: hub.transport, onNotice: (p) => got[i].push(p) })
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
    const peer = [...hub.rooms.get(hub.urls[0])!][1]
    peer.ev.onMessage('{"pong":1}')
    peer.ev.onMessage('not json')
    peer.ev.onMessage(await sealNotice(other, { d: 'bbbbbbbbbbbbbbbb', s: 1 }))
    await tick()
    expect(got[1]).toHaveLength(1)
  })

  it('engine: a local edit is captured after the debounce, pushed, and the notice makes the other device pull', async () => {
    const w = world()
    const hub = new Hub()
    const A = w.db('A')
    await addSong(A, 's1', 'One')
    const ta = manualTimers()
    const tb = manualTimers()
    const eA = await enableDevice(w, A, { relayTransport: hub.transport, timers: ta.timers })
    const B = w.db('B')
    const eB = await joinDevice(w, B, A, 'here', { relayTransport: hub.transport, timers: tb.timers })
    for (const e of [eA, eB]) e.core.config = { ...e.core.config, relay: '/relay' }
    await eA.start()
    await eB.start()
    await tick(50)
    await ta.fire()
    await tb.fire()
    expect(eA.status.relay).toBe('open')

    await A.table('songs').update('s1', { title: 'Edited on A' })
    await tick(50) // liveQuery sees the dirty mark
    expect(ta.pending()).toContain(1500) // CAPTURE_DEBOUNCE
    await ta.fire(1500) // capture + push + notice
    await tick(50)
    expect(tb.pending()).toContain(300) // notice debounce
    await tb.fire(300)
    await tb.fire(0) // runSoon → sync
    await tick(100)
    expect((await B.songs.get('s1'))?.title).toBe('Edited on A')
    eA.stop()
    eB.stop()
  })
})
