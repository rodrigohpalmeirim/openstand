import { describe, expect, it } from 'vitest'
import { authorizeUrl, classifyTokenError, hasRequiredScope, jwtClaims } from './providers'
import { jwt } from './oauth.test-helper'

const base = { clientId: 'cid', redirectUri: 'http://localhost:5317/oauth/callback', codeChallenge: 'chal', state: 'st' }
const params = (u: string) => Object.fromEntries(new URL(u).searchParams)

describe('authorize URLs', () => {
  it('Dropbox: offline access, PKCE S256, the four scopes; no login hint', () => {
    const u = authorizeUrl('dropbox', { ...base, loginHint: 'a@b.c' })
    expect(u.startsWith('https://www.dropbox.com/oauth2/authorize?')).toBe(true)
    expect(params(u)).toEqual({
      client_id: 'cid',
      redirect_uri: base.redirectUri,
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge_method: 'S256',
      code_challenge: 'chal',
      state: 'st',
      scope: 'account_info.read files.metadata.read files.content.read files.content.write',
    })
    expect(u).not.toContain('+')
    expect(params(authorizeUrl('dropbox', { ...base, chooseAccount: true })).force_reauthentication).toBe('true')
  })

  it('Google: offline access with consent, granted scopes included, login hint; "choose account" overrides prompt', () => {
    const p = params(authorizeUrl('gdrive', { ...base, loginHint: 'rod@example.com' }))
    expect(p).toMatchObject({
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge_method: 'S256',
      scope: 'https://www.googleapis.com/auth/drive.file',
      login_hint: 'rod@example.com',
    })
    const c = params(authorizeUrl('gdrive', { ...base, chooseAccount: true, loginHint: 'rod@example.com' }))
    expect(c.prompt).toBe('select_account consent')
    expect(c.login_hint).toBeUndefined()
  })

  it('Microsoft: the common tenant, query response mode, AppFolder scope', () => {
    const u = authorizeUrl('onedrive', { ...base, loginHint: 'x@outlook.com' })
    expect(u.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?')).toBe(true)
    expect(params(u)).toMatchObject({
      response_type: 'code',
      response_mode: 'query',
      code_challenge_method: 'S256',
      scope: 'offline_access openid profile email Files.ReadWrite.AppFolder',
      login_hint: 'x@outlook.com',
    })
    expect(params(authorizeUrl('onedrive', { ...base, chooseAccount: true })).prompt).toBe('select_account')
  })
})

describe('granted scope check', () => {
  it('needs the provider scope; Microsoft matches case-insensitively with or without the Graph prefix', () => {
    expect(hasRequiredScope('dropbox', 'account_info.read files.content.read files.content.write')).toBe(true)
    expect(hasRequiredScope('dropbox', 'account_info.read files.content.read')).toBe(false)
    expect(hasRequiredScope('gdrive', 'openid https://www.googleapis.com/auth/drive.file')).toBe(true)
    expect(hasRequiredScope('gdrive', '')).toBe(false)
    expect(hasRequiredScope('onedrive', 'https://graph.microsoft.com/Files.ReadWrite.AppFolder openid')).toBe(true)
    expect(hasRequiredScope('onedrive', 'files.readwrite.appfolder')).toBe(true)
    expect(hasRequiredScope('onedrive', 'Files.Read openid')).toBe(false)
    // No `scope` in the answer: can't tell, the identity call decides.
    expect(hasRequiredScope('gdrive', undefined)).toBe(true)
  })
})

describe('token endpoint errors', () => {
  it('classifies grant, config, rate-limit, network and other refusals', () => {
    expect(classifyTokenError(400, 'invalid_grant').failure).toBe('grant')
    expect(classifyTokenError(400, 'interaction_required').failure).toBe('grant')
    expect(classifyTokenError(401, 'invalid_client').failure).toBe('config')
    expect(classifyTokenError(503, 'not_configured').failure).toBe('config')
    expect(classifyTokenError(403, 'origin_not_allowed').failure).toBe('config')
    expect(classifyTokenError(502, 'upstream_unavailable').failure).toBe('network')
    const r = classifyTokenError(429, 'rate_limited', '60')
    expect([r.failure, r.retryAfterMs]).toEqual(['rateLimited', 60_000])
    expect(classifyTokenError(400, 'invalid_request').failure).toBe('rejected')
  })
})

describe('id_token claims', () => {
  it('decodes without verifying, and tolerates garbage', () => {
    expect(jwtClaims(jwt({ email: 'a@b.c', name: 'Á' }))).toEqual({ email: 'a@b.c', name: 'Á' })
    expect(jwtClaims('nope')).toEqual({})
    expect(jwtClaims(undefined)).toEqual({})
    expect(jwtClaims('a.!!!.c')).toEqual({})
  })
})
