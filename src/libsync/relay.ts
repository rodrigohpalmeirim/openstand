/**
 * Library-sync notice channel (docs/SYNC.md §4.3, §9): after every `heads/` write a device posts a sealed
 * `{d, s}` notice to its library's relay room, so the others pull at once instead of at the next poll.
 * Notices are hints only — relay traffic is untrusted and never fatal; polling remains the fallback.
 */
import { RelayTransport, type Transport, type TransportEvents, type TransportStatus } from '../sync/transports'
import { openNotice, sealNotice, type LibraryKeys } from './crypto'
import type { NoticePayload } from './model'
import { realTimers } from './timers'

export const PING_INTERVAL = 45_000
const PING = '{"ping":1}'

export type RelayState = 'off' | 'connecting' | 'open' | 'error'

/** The relay URL for a library room: `${relayBase}/lib/${roomId}`. */
export const libRelayUrl = (base: string, roomId: string) => `${base.replace(/\/+$/, '')}/lib/${roomId}`

export interface NoticeChannelOptions {
  base: string
  keys: LibraryKeys
  deviceId: string
  onNotice: (p: NoticePayload) => void
  onState?: (s: RelayState) => void
  /** Tests inject an in-process transport. */
  transport?: (url: string, room: string, ev: TransportEvents) => Transport
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval }
}

const toState = (s: TransportStatus): RelayState => (s === 'closed' ? 'off' : s)

export class NoticeChannel {
  private t: Transport
  private ping: ReturnType<typeof setInterval> | undefined
  state: RelayState = 'connecting'
  private o: NoticeChannelOptions

  constructor(o: NoticeChannelOptions) {
    this.o = o
    const make = o.transport ?? ((url, room, ev) => new RelayTransport(url, room, ev))
    this.t = make(libRelayUrl(o.base, o.keys.roomId), o.keys.roomId, {
      onMessage: (data) => void this.receive(data),
      onStatus: (s) => {
        this.state = toState(s)
        o.onState?.(this.state)
      },
    })
    const timers = o.timers ?? realTimers
    this.ping = timers.setInterval(() => this.t.status === 'open' && this.t.send(PING), PING_INTERVAL)
  }

  private async receive(data: string) {
    if (data.length > 1024 || !data.includes('"n"')) return
    const p = await openNotice(this.o.keys, data)
    if (p && p.d !== this.o.deviceId) this.o.onNotice(p)
  }

  /** Announce that this device wrote up to `seq`. */
  async post(seq: number) {
    if (this.t.status !== 'open') return
    this.t.send(await sealNotice(this.o.keys, { d: this.o.deviceId, s: seq }))
  }

  close() {
    ;(this.o.timers ?? realTimers).clearInterval(this.ping)
    this.t.close()
    this.state = 'off'
  }
}
