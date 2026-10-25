import { beforeEach, describe, expect, it } from 'vitest'
import { useNav } from '../../state/nav'
import { signInReturnPending as fromApi } from '../api'
import { CALLBACK_PATH, PENDING_KEY, PENDING_TTL, clearPending, handleOAuthCallback, readPending, signInReturnPending, writePending } from './callback'
import type { PendingSignIn } from './types'

const T0 = 1_800_000_000_000

const pending = (over: Partial<PendingSignIn> = {}): PendingSignIn => ({
  v: 1,
  kind: 'dropbox',
  state: 'st4te',
  verifier: 'v'.repeat(43),
  redirectUri: 'http://localhost:3000/oauth/callback',
  db: 'openstand',
  intent: { type: 'setup' },
  createdAt: T0,
  ...over,
})

function arrive(query: string) {
  history.replaceState(null, '', CALLBACK_PATH + query)
  expect(location.pathname).toBe(CALLBACK_PATH)
}

beforeEach(() => {
  localStorage.clear()
  useNav.getState().go({ name: 'library', section: 'songs' })
})

describe('OAuth callback', () => {
  it('records the code, removes it from the URL and opens Settings › Library sync', () => {
    writePending(pending())
    expect(signInReturnPending()).toBe(false)
    arrive('?code=abc123&state=st4te')
    handleOAuthCallback(T0 + 60_000)
    expect(location.pathname + location.search).toBe('/')
    expect(readPending()?.ret).toEqual({ code: 'abc123' })
    expect(signInReturnPending()).toBe(true)
    expect(fromApi()).toBe(true)
    expect(useNav.getState().route).toEqual({ name: 'settings', page: 'libsync' })
  })

  it('records provider errors with their description', () => {
    writePending(pending())
    arrive('?error=access_denied&error_description=The+user+denied&state=st4te')
    handleOAuthCallback(T0 + 1000)
    expect(readPending()?.ret).toEqual({ error: 'access_denied', description: 'The user denied' })
  })

  it('a wrong state or an old slot becomes expired', () => {
    writePending(pending())
    arrive('?code=abc&state=other')
    handleOAuthCallback(T0 + 1000)
    expect(readPending()?.ret).toEqual({ error: 'expired' })

    writePending(pending())
    arrive('?code=abc&state=st4te')
    handleOAuthCallback(T0 + PENDING_TTL + 1)
    expect(readPending()?.ret).toEqual({ error: 'expired' })
  })

  it('without a pending sign-in it only cleans the URL', () => {
    arrive('?code=abc&state=st4te')
    handleOAuthCallback(T0)
    expect(location.pathname + location.search).toBe('/')
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    expect(useNav.getState().route.name).toBe('library')
  })

  it('ignores a malformed slot', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ v: 1, kind: 'icloud', state: 'x' }))
    expect(readPending()).toBeNull()
    localStorage.setItem(PENDING_KEY, '{not json')
    expect(readPending()).toBeNull()
    clearPending()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })
})
