// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../sync/transports'
import { deriveLibraryKeys, newSecret } from './crypto'
import { NoticeChannel } from './relay'
import { realTimers } from './timers'

const NAMES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const

/** Make the global timers behave like a browser's: "Illegal invocation" unless `this` is the global (or unset). */
function strictGlobals() {
  const g = globalThis as unknown as Record<string, (...a: unknown[]) => unknown>
  for (const n of NAMES) {
    const orig = g[n]
    vi.stubGlobal(n, function (this: unknown, ...a: unknown[]) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      return orig.apply(globalThis, a)
    })
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('realTimers', () => {
  it('can be called as methods (regression: engine/relay threw "Illegal invocation" in Chrome)', () => {
    strictGlobals()
    const t = realTimers.setTimeout(() => {}, 10)
    realTimers.clearTimeout(t)
    const i = realTimers.setInterval(() => {}, 10)
    realTimers.clearInterval(i)
  })

  it('a relay notice channel starts and stops with the default timers', async () => {
    strictGlobals()
    const keys = await deriveLibraryKeys(newSecret())
    const transport = (): Transport => ({ kind: 'relay', status: 'open', send: () => {}, close: () => {} })
    const ch = new NoticeChannel({ base: '/relay', keys, deviceId: '0123456789abcdef', onNotice: () => {}, transport })
    expect(() => ch.close()).not.toThrow()
  })
})
