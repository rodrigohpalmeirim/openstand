import { describe, expect, it } from 'vitest'
import { relayUrl } from './transports'

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
