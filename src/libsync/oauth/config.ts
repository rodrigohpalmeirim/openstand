/**
 * OAuth client ids and the provider table. Committed: client ids are
 * public. Secrets for Google and Microsoft live only in the Worker (`wrangler secret put`).
 */
import type { OAuthKind } from '../backends/types'
import type { ProviderSpec } from './types'

/** Origins whose `/oauth/callback` is registered with the official apps. */
export const OFFICIAL_ORIGINS = ['https://openstand.rodlabs.dev', 'http://localhost:5317']

const OFFICIAL: Record<OAuthKind, string> = {
  dropbox: 'ovxujea0y80o8ow', // App key from the Dropbox App Console; public
  gdrive: '941966283964-49gajkits27cba91hghkdjl7ujgd2k92.apps.googleusercontent.com', // "<n>-<x>.apps.googleusercontent.com"; public
  onedrive: '355fb297-730d-4c93-ac6c-35368413c885', // Application (client) ID GUID; public
}

type Env = Record<string, string | boolean | undefined>

const ENV_VAR: Record<OAuthKind, string> = {
  dropbox: 'VITE_DROPBOX_CLIENT_ID',
  gdrive: 'VITE_GDRIVE_CLIENT_ID',
  onedrive: 'VITE_ONEDRIVE_CLIENT_ID',
}

/**
 * The client id to sign in with on `origin`, or `null` when the provider is hidden here:
 * 1. `VITE_<KIND>_CLIENT_ID` set (self-hosters): `off` → null, else the value.
 * 2. `origin` ∈ OFFICIAL_ORIGINS and the official id is non-empty → the official id.
 * 3. Otherwise null. Official ids only work on origins whose redirect URIs are registered, so a
 *    self-hosted build without its own ids never offers a sign-in that fails.
 * `env` is a parameter (default `import.meta.env`) so tests can pass their own; `origin` defaults to
 * `location.origin`, or '' where there is no `location` (Node).
 */
export function oauthClientId(kind: OAuthKind, origin: string = globalThis.location?.origin ?? '', env: Env = import.meta.env as Env): string | null {
  const v = env[ENV_VAR[kind]]
  if (typeof v === 'string' && v.trim()) return v.trim() === 'off' ? null : v.trim()
  return OFFICIAL_ORIGINS.includes(origin) && OFFICIAL[kind] ? OFFICIAL[kind] : null
}

/** Display only: the Dropbox app folder name chosen in the App Console. */
export const DROPBOX_APP_FOLDER: string = (import.meta.env.VITE_DROPBOX_APP_FOLDER as string | undefined) || 'OpenStand'

/** The redirect URI on this origin. Must be registered with every provider. */
export const redirectUri = (origin: string = globalThis.location?.origin ?? '') => origin + '/oauth/callback'

// worker/oauth.ts sends the same scope to Microsoft's token endpoint; keep them in step.
const GRAPH_SCOPE = 'offline_access openid profile email Files.ReadWrite.AppFolder'

/** Per-provider sign-in settings. */
export const PROVIDERS: Record<OAuthKind, ProviderSpec> = {
  dropbox: {
    kind: 'dropbox',
    name: 'Dropbox',
    signInWith: 'Dropbox',
    location: `Dropbox › Apps › ${DROPBOX_APP_FOLDER}`,
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    authorizeParams: {
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge_method: 'S256',
      scope: 'account_info.read files.metadata.read files.content.read files.content.write',
    },
    chooseAccountParams: { force_reauthentication: 'true' },
    loginHintParam: null,
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    viaWorker: false,
    requiredScope: 'files.content.write',
    rotatesRefreshToken: false,
    disconnectUrls: [{ label: 'Dropbox connected apps', url: 'https://www.dropbox.com/account/connected_apps' }],
  },
  gdrive: {
    kind: 'gdrive',
    name: 'Google Drive',
    signInWith: 'Google',
    location: 'Google Drive › OpenStand',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    authorizeParams: {
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge_method: 'S256',
      scope: 'https://www.googleapis.com/auth/drive.file',
    },
    chooseAccountParams: { prompt: 'select_account consent' },
    loginHintParam: 'login_hint',
    tokenUrl: '/api/oauth/gdrive/token',
    viaWorker: true,
    requiredScope: 'https://www.googleapis.com/auth/drive.file',
    rotatesRefreshToken: false,
    disconnectUrls: [{ label: 'Google account connections', url: 'https://myaccount.google.com/connections' }],
  },
  onedrive: {
    kind: 'onedrive',
    name: 'OneDrive',
    signInWith: 'Microsoft',
    location: 'OneDrive › Apps › OpenStand',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    authorizeParams: {
      response_type: 'code',
      response_mode: 'query',
      code_challenge_method: 'S256',
      scope: GRAPH_SCOPE,
    },
    chooseAccountParams: { prompt: 'select_account' },
    loginHintParam: 'login_hint',
    tokenUrl: '/api/oauth/onedrive/token',
    viaWorker: true,
    requiredScope: 'Files.ReadWrite.AppFolder',
    rotatesRefreshToken: true,
    disconnectUrls: [
      { label: 'Microsoft account (personal)', url: 'https://account.live.com/consent/Manage' },
      { label: 'Microsoft work or school account', url: 'https://myapps.microsoft.com' },
    ],
  },
}
