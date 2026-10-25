// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { OFFICIAL_ORIGINS, PROVIDERS, oauthClientId, redirectUri } from './config'

describe('oauthClientId (SYNC-DRIVES.md §2.4)', () => {
  it('an env override wins; "off" hides the provider', () => {
    expect(oauthClientId('dropbox', 'https://music.example.org', { VITE_DROPBOX_CLIENT_ID: 'my-app-key' })).toBe('my-app-key')
    expect(oauthClientId('gdrive', OFFICIAL_ORIGINS[0], { VITE_GDRIVE_CLIENT_ID: 'off' })).toBeNull()
    expect(oauthClientId('onedrive', 'https://music.example.org', { VITE_ONEDRIVE_CLIENT_ID: ' 0000-guid ' })).toBe('0000-guid')
  })

  it('without an override, other origins get nothing (official ids only work where registered)', () => {
    for (const k of ['dropbox', 'gdrive', 'onedrive'] as const) expect(oauthClientId(k, 'https://music.example.org', {})).toBeNull()
  })

  it('the provider table matches §5.3', () => {
    expect(PROVIDERS.gdrive.chooseAccountParams.prompt).toBe('select_account consent')
    expect(PROVIDERS.dropbox.loginHintParam).toBeNull()
    expect(PROVIDERS.onedrive.authorizeUrl).toContain('/common/')
    expect([PROVIDERS.gdrive.tokenUrl, PROVIDERS.onedrive.tokenUrl]).toEqual(['/api/oauth/gdrive/token', '/api/oauth/onedrive/token'])
    expect(Object.values(PROVIDERS).map((p) => p.authorizeParams.code_challenge_method)).toEqual(['S256', 'S256', 'S256'])
    expect(redirectUri('https://openstand.rodlabs.dev')).toBe('https://openstand.rodlabs.dev/oauth/callback')
  })
})
