import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBackgroundServices } from '../services'
import { settings, useSettings } from '../state/settings'
import { toast } from '../ui/primitives'
import { connect, disconnect, ensureRoom, myRole, setMyRole, switchToSiteRelay, useWindowSync } from './sync'

// Transports that only record which rooms they were opened for.
const opened = vi.hoisted(() => ({ local: [] as string[], relay: [] as string[], live: 0 }))
vi.mock('./transports', async (orig) => {
  const real = await orig<typeof import('./transports')>()
  class Fake {
    status = 'open' as const
    send() {}
    close() {
      opened.live--
    }
  }
  return {
    ...real,
    LocalTransport: class extends Fake {
      readonly kind = 'local'
      constructor(room: string) {
        super()
        opened.local.push(room)
        opened.live++
      }
    },
    RelayTransport: class extends Fake {
      readonly kind = 'relay'
      constructor(_url: string, room: string) {
        super()
        opened.relay.push(room)
        opened.live++
      }
    },
  }
})
vi.mock('../ui/primitives', async (orig) => ({ ...(await orig<typeof import('../ui/primitives')>()), toast: vi.fn() }))

const setSync = (p: Partial<ReturnType<typeof settings>['sync']>) => useSettings.getState().setIn('sync', p)

describe('ensureRoom', () => {
  beforeEach(() => setSync({ room: '', relayUrl: '' }))

  it('makes and keeps a private room when there is none', () => {
    const room = ensureRoom()
    expect(room).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/)
    expect(settings().sync.room).toBe(room)
    expect(ensureRoom()).toBe(room)
  })

  it('moves users off the shared legacy room on this site’s relay, and leaves chosen rooms alone', () => {
    setSync({ room: 'band', relayUrl: '/relay' })
    expect(ensureRoom({ quiet: true })).not.toBe('band')
    setSync({ room: 'band', relayUrl: '192.168.1.20:8787' })
    expect(ensureRoom()).toBe('band')
    setSync({ room: 'our-band-2026', relayUrl: '/relay' })
    expect(ensureRoom()).toBe('our-band-2026')
  })
})

describe('per-window role', () => {
  it('overrides the saved role for this window only', () => {
    setSync({ role: 'peer' })
    expect(myRole()).toBe('peer')
    setMyRole('leader')
    expect(myRole()).toBe('leader')
    // Another window (no override of its own) starts from the last choice.
    useWindowSync.setState({ role: undefined })
    expect(myRole()).toBe('leader')
    useWindowSync.setState({ role: 'follower' })
    setSync({ role: 'peer' })
    expect(myRole()).toBe('follower')
  })
})

describe('connect', () => {
  setSync({ autoConnect: false })
  const stop = startBackgroundServices()
  afterAll(() => {
    disconnect()
    stop()
  })
  const reset = () => {
    opened.local = []
    opened.relay = []
    vi.mocked(toast).mockClear()
  }

  it('opens one transport of each kind when making a room triggers a settings change', () => {
    setSync({ room: '', relayUrl: 'ws://192.168.1.20:8787' })
    reset()
    connect()
    const room = settings().sync.room
    expect(room).not.toBe('')
    expect(opened.local).toEqual([room])
    expect(opened.relay).toEqual([room])
    expect(opened.live).toBe(2)
  })

  it('reconnects once when switching from the legacy shared room to this site’s relay, without a notice', () => {
    setSync({ room: 'band', relayUrl: 'ws://192.168.1.20:8787' })
    connect()
    reset()
    switchToSiteRelay()
    const room = settings().sync.room
    expect(room).not.toBe('band')
    expect(opened.local).toEqual([room])
    expect(opened.relay).toEqual([room])
    expect(opened.live).toBe(2)
    expect(toast).not.toHaveBeenCalled()
  })

  it('still moves off the legacy room (with a notice) when the relay changes some other way', () => {
    setSync({ room: 'band', relayUrl: 'ws://192.168.1.20:8787' })
    connect()
    reset()
    setSync({ relayUrl: '/relay' })
    const room = settings().sync.room
    expect(room).not.toBe('band')
    expect(opened.local).toEqual([room])
    expect(opened.relay).toEqual([room])
    expect(opened.live).toBe(2)
    expect(toast).toHaveBeenCalledTimes(1)
  })
})
