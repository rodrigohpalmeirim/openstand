import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayTransport, relayUrl, sameSiteRelayAvailable } from './transports'

describe('relayUrl', () => {
  it('adds a scheme and the room to bare addresses', () => {
    expect(relayUrl('192.168.1.20:8787', 'band')).toBe('ws://192.168.1.20:8787/?room=band')
  })

  it('turns http(s) into ws(s)', () => {
    expect(relayUrl('https://relay.example', 'a b')).toBe('wss://relay.example/?room=a+b')
  })

  it('resolves a path against this site (the Worker deployment relay)', () => {
    expect(relayUrl('/relay', 'band')).toBe(`ws://${location.host}/relay?room=band`)
  })
})

describe('sameSiteRelayAvailable', () => {
  afterEach(() => vi.unstubAllGlobals())
  const json = (body: unknown, status = 200, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } })
  const stub = (...answers: (Response | Error)[]) => {
    const urls: string[] = []
    const inits: RequestInit[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      urls.push(url)
      inits.push(init)
      const a = answers.shift() ?? new TypeError('Failed to fetch')
      if (a instanceof Error) throw a
      return a
    })
    return { urls, inits }
  }

  it('recognises the relay health JSON, with a URL no cache can answer', async () => {
    const f = stub(json({ service: 'openstand-relay', features: ['lib'] }))
    expect(await sameSiteRelayAvailable()).toBe(true)
    expect(f.urls[0]).toMatch(/^\/relay\?probe=/)
    expect(f.inits[0].cache).toBe('no-store')
  })

  it('judges by the body, not the content type', async () => {
    stub(json({ service: 'openstand-relay' }, 200, 'text/plain'))
    expect(await sameSiteRelayAvailable()).toBe(true)
  })

  it('is false, without retrying, when the site answers with something else (an SPA fallback, a 404)', async () => {
    const f = stub(new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }))
    expect(await sameSiteRelayAvailable()).toBe(false)
    expect(f.urls).toHaveLength(1)
    const g = stub(json({ error: 'nope' }, 404))
    expect(await sameSiteRelayAvailable()).toBe(false)
    expect(g.urls).toHaveLength(1)
  })

  it('retries when there is no answer (network error, 5xx) and gives up after the attempts', async () => {
    const f = stub(new TypeError('Failed to fetch'), json({}, 502), json({ service: 'openstand-relay' }))
    expect(await sameSiteRelayAvailable({ attempts: 3 })).toBe(true)
    expect(f.urls).toHaveLength(3)
    const g = stub()
    expect(await sameSiteRelayAvailable({ attempts: 2 })).toBe(false)
    expect(g.urls).toHaveLength(2)
  })
})

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  drop(reason = '') {
    this.readyState = 3
    this.onclose?.({ reason })
  }
}

describe('RelayTransport', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    FakeSocket.all = []
  })
  const make = () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    const statuses: [string, string | undefined][] = []
    const got: string[] = []
    const t = new RelayTransport('ws://relay.test', 'r', { onMessage: (d) => got.push(d), onStatus: (s, d) => statuses.push([s, d]) })
    return { t, statuses, got, sock: () => FakeSocket.all.at(-1)! }
  }

  it('calls a relay it never reached unreachable, and a dropped one lost', () => {
    const { statuses, sock } = make()
    sock().drop()
    expect(statuses.at(-1)).toEqual(['error', 'Relay unreachable'])
    vi.advanceTimersByTime(1000)
    sock().open()
    sock().drop()
    expect(statuses.at(-1)).toEqual(['error', 'Connection lost'])
  })

  it('pings, keeps pongs from the app, and reconnects when the relay stops answering', () => {
    const { t, got, sock } = make()
    const first = sock()
    first.open()
    vi.advanceTimersByTime(25_000)
    expect(first.sent).toEqual(['{"ping":1}'])
    first.onmessage?.({ data: '{"pong":1}' })
    first.onmessage?.({ data: 'hello' })
    expect(got).toEqual(['hello'])
    // Next ping goes unanswered: a new socket replaces the dead one.
    vi.advanceTimersByTime(25_000 + 10_000)
    expect(FakeSocket.all.length).toBe(2)
    expect(t.status).toBe('connecting')
    t.close()
  })

  it('retries at once when the page comes back during a backoff wait', () => {
    const { t, sock } = make()
    sock().drop() // now waiting out the backoff
    t.wake()
    expect(FakeSocket.all.length).toBe(2)
    t.close()
  })
})
