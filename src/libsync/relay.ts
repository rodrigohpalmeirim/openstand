/**
 * Library-sync notice channel: after every `heads/` write a device posts a sealed
 * `{d, s}` notice to its library's relay room, so the others pull at once instead of at the next poll.
 * Notices are hints only — relay traffic is untrusted and never fatal; polling remains the fallback.
 *
 * Delivery is best effort, so the channel works around what drops notices in practice:
 * - Notices are coalesced (only the latest seq matters) and spaced SEND_GAP apart, under the room's 5 msg/s.
 * - A notice posted while the socket is down is sent once it opens; every (re)open re-announces the latest
 *   seq (a socket that died silently may have swallowed it).
 * - Keep-alive pings expect the relay's pong: no frame within PONG_TIMEOUT means the socket is dead
 *   (mobile networks drop connections without telling either end), so it reconnects.
 * - A sealed ping from another device of the library is answered with a sealed pong addressed to it (older
 *   builds had a "Test instant sync" button that sends them; this build only answers).
 * - A `devices` notice (a rename) makes the others re-read the device list; older builds drop it.
 */
import { RelayTransport, type Transport, type TransportEvents, type TransportStatus } from '../sync/transports'
import { openNotice, sealNotice, type LibraryKeys } from './crypto'
import type { NoticePayload } from './model'
import { realTimers, type Timers } from './timers'

export const PING_INTERVAL = 30_000
/** No frame at all this long after a keep-alive ping: the socket is dead. */
export const PONG_TIMEOUT = 10_000
/** After a wake (page shown, network back) the check is quicker. */
export const WAKE_PONG_TIMEOUT = 5_000
/** A handshake pending this long when woken is abandoned and retried. */
const STUCK_CONNECTING = 5_000
/** Minimum gap between our sealed frames (lib rooms drop a client's frames past 5 per second). */
export const SEND_GAP = 250
const PING = '{"ping":1}'

export type RelayState = 'off' | 'connecting' | 'open' | 'error'

/** The relay URL for a library room: `${relayBase}/lib/${roomId}`. */
export const libRelayUrl = (base: string, roomId: string) => `${base.replace(/\/+$/, '')}/lib/${roomId}`

export interface NoticeChannelOptions {
  base: string
  keys: LibraryKeys
  deviceId: string
  /** A verified notice from another device of the library (plain, ping or pong: all carry its head). */
  onNotice: (p: NoticePayload) => void
  onState?: (s: RelayState) => void
  /** A plain notice for `seq` actually went out. */
  onSent?: (seq: number) => void
  /** This device's last pushed seq, carried by pongs. */
  head?: () => number | Promise<number>
  log?: (msg: string) => void
  /** Tests inject an in-process transport. */
  transport?: (url: string, room: string, ev: TransportEvents) => Transport
  timers?: Partial<Timers>
  now?: () => number
}

const toState = (s: TransportStatus): RelayState => (s === 'closed' ? 'off' : s)

export class NoticeChannel {
  private t: Transport
  private ping: ReturnType<typeof setInterval> | undefined
  state: RelayState = 'connecting'
  private stateAt: number
  private o: NoticeChannelOptions
  private timers: Timers
  private now: () => number
  private closed = false
  /** Last frame of any kind received: proves the socket is alive. */
  private lastRx = 0
  /** This relay answers keep-alive pings (older self-hosted relays might not; they aren't judged). */
  private pongSeen = false
  private pongTimer?: ReturnType<typeof setTimeout>
  /** Highest seq asked to announce, and the highest actually sent on the current socket. */
  private pendingSeq = 0
  private sentSeq = 0
  /** Sealed pong frames waiting for the send gap. */
  private queue: string[] = []
  private lastSend = -Infinity
  private sealing = false
  private pumpTimer?: ReturnType<typeof setTimeout>

  constructor(o: NoticeChannelOptions) {
    this.o = o
    this.timers = { ...realTimers, ...o.timers }
    this.now = o.now ?? Date.now
    this.stateAt = this.now()
    const make = o.transport ?? ((url, room, ev) => new RelayTransport(url, room, ev))
    this.t = make(libRelayUrl(o.base, o.keys.roomId), o.keys.roomId, {
      onMessage: (data) => void this.receive(data),
      onStatus: (s) => this.onStatus(toState(s)),
    })
    this.ping = this.timers.setInterval(() => this.keepAlive(PONG_TIMEOUT), PING_INTERVAL)
  }

  private onStatus(s: RelayState) {
    if (this.closed) return
    if (s !== this.state) this.stateAt = this.now()
    this.state = s
    if (s === 'open') {
      // Re-announce on every (re)open: what we sent on a socket that then died may never have arrived.
      this.pendingSeq = Math.max(this.pendingSeq, this.sentSeq)
      this.sentSeq = 0
      this.keepAlive(PONG_TIMEOUT)
      this.pump()
    }
    this.o.onState?.(s)
  }

  private async receive(data: string) {
    this.lastRx = this.now()
    if (data.startsWith('{"pong"')) {
      this.pongSeen = true
      return
    }
    if (data.length > 1024 || !data.includes('"n"')) return
    const p = await openNotice(this.o.keys, data)
    if (!p || p.d === this.o.deviceId || this.closed) return
    if (p.k === 'ping') void this.answer(p)
    this.o.onNotice(p)
  }

  private async answer(ping: NoticePayload) {
    const head = Math.max(0, (await this.o.head?.()) ?? 0)
    this.queue.push(await sealNotice(this.o.keys, { d: this.o.deviceId, s: head, k: 'pong', p: ping.p, to: ping.d }))
    this.pump()
  }

  /** Send what's waiting (the latest notice first), at most one sealed frame per SEND_GAP. */
  private pump(): void {
    if (this.closed || this.sealing || this.pumpTimer || this.t.status !== 'open') return
    const notice = this.pendingSeq > this.sentSeq
    if (!notice && !this.queue.length) return
    const wait = this.lastSend + SEND_GAP - this.now()
    if (wait > 0) {
      this.pumpTimer = this.timers.setTimeout(() => {
        this.pumpTimer = undefined
        this.pump()
      }, wait)
      return
    }
    this.lastSend = this.now()
    if (!notice) {
      this.t.send(this.queue.shift()!)
      return this.pump()
    }
    const seq = this.pendingSeq
    this.sealing = true
    void sealNotice(this.o.keys, { d: this.o.deviceId, s: seq })
      .then((frame) => {
        if (this.closed || this.t.status !== 'open') return // still pending: sent on the next open
        this.t.send(frame)
        this.sentSeq = Math.max(this.sentSeq, seq)
        this.o.onSent?.(seq)
      })
      .catch(() => {})
      .finally(() => {
        this.sealing = false
        this.pump()
      })
  }

  /** Ping the relay; if pongs come back from it but nothing arrives within `timeout`, the socket is dead. */
  private keepAlive(timeout: number) {
    if (this.closed || this.t.status !== 'open') return
    const sent = this.now()
    this.t.send(PING)
    if (!this.pongSeen || this.pongTimer) return
    this.pongTimer = this.timers.setTimeout(() => {
      this.pongTimer = undefined
      if (this.closed || this.t.status !== 'open' || this.lastRx >= sent) return
      this.o.log?.('relay: no pong, reconnecting')
      this.t.reconnect?.()
    }, timeout)
  }

  /** Announce that this device wrote up to `seq`. Sent now, or as soon as the socket is open. */
  async post(seq: number) {
    if (this.closed) return
    this.pendingSeq = Math.max(this.pendingSeq, seq)
    this.pump()
  }

  /** Ask the other devices to re-read the device list (this device changed its record). */
  async postDevices() {
    if (this.closed) return
    const head = Math.max(0, (await this.o.head?.()) ?? 0)
    this.queue.push(await sealNotice(this.o.keys, { d: this.o.deviceId, s: head, k: 'devices' }))
    this.pump()
  }

  /**
   * The page came back or the network returned: reconnect now instead of waiting out the backoff, or check
   * an open socket is still alive.
   */
  wake() {
    if (this.closed) return
    if (this.t.status === 'open') this.keepAlive(WAKE_PONG_TIMEOUT)
    else if (this.t.status === 'error' || this.now() - this.stateAt > STUCK_CONNECTING) this.t.reconnect?.()
  }

  /** When the current state began (wall ms). */
  get since() {
    return this.stateAt
  }

  close() {
    this.closed = true
    this.timers.clearInterval(this.ping)
    for (const t of [this.pongTimer, this.pumpTimer]) if (t) this.timers.clearTimeout(t)
    this.t.close()
    this.state = 'off'
  }
}
