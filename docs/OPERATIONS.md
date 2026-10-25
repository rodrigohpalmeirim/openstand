# Operations runbook

Recurring maintenance for the official deployment at https://openstand.rodlabs.dev.

## Renewing the OneDrive client secret (every ≤ 24 months)

Microsoft client secrets expire. When the secret the Worker holds (`ONEDRIVE_CLIENT_SECRET`) expires, nobody can sign in to OneDrive and devices can't renew their sign-ins. Every OneDrive device then shows "Sign in to OneDrive again", and signing in fails until the secret is replaced. Google's client secret doesn't expire, and Dropbox doesn't use one.

Renew it 1–2 weeks **before** the expiry date. The date is shown next to the secret in the Entra admin center.

1. **Create the new secret**
   1. Open https://entra.microsoft.com and sign in with the account that owns the app registration.
   2. Go to **Identity → Applications → App registrations → All applications → OpenStand**.
   3. Open **Certificates & secrets → Client secrets → New client secret**.
   4. Description: e.g. `openstand-YYYY-MM`. Expires: **24 months**. Click **Add**.
   5. Copy the **Value** column immediately; it's shown only once. Don't copy the "Secret ID".
2. **Give it to the Worker**, from the project folder:
   ```sh
   cd ~/music-reader/openstand
   npx wrangler login          # only if wrangler says you're not logged in
   npx wrangler secret put ONEDRIVE_CLIENT_SECRET
   ```
   Paste the value when asked. It takes effect immediately; no redeploy is needed.

   If you run the Worker locally, also update `ONEDRIVE_CLIENT_SECRET` in `.dev.vars`.
3. **Check it works**
   - `npx wrangler secret list` should list `ONEDRIVE_CLIENT_SECRET`. It shows only names, never values.
   - `curl https://openstand.rodlabs.dev/api/oauth/providers` should still include `onedrive`.
   - On a device that syncs with OneDrive, open Settings → Library sync and press **Sync now**. It should stay "Up to date", with no "Sign in again" banner.
   - Optionally, watch live with `npx wrangler tail`. Token renewals appear as `oauth onedrive refresh 200`.
4. **Delete the old secret.** In **Certificates & secrets**, delete the expiring one (it has the older expiry date).
5. **Set a reminder** for about two weeks before the new expiry date.

### If it already expired

Do the same steps. Afterwards, each OneDrive device needs one **Sign in again**, from the banner in Settings → Library sync or the sync indicator. Synced data isn't affected.

## Other secrets and settings

| Item | Where | Expires? |
| --- | --- | --- |
| `GDRIVE_CLIENT_SECRET` | Google Cloud console → Google Auth Platform → Clients → OpenStand web | No, but rotate it if it leaks: add a new secret, `wrangler secret put GDRIVE_CLIENT_SECRET`, then delete the old one. |
| Dropbox App key | `src/libsync/oauth/config.ts` | No secret is used. |
| Client ids | `OFFICIAL` in `src/libsync/oauth/config.ts` and `GDRIVE_CLIENT_ID` / `ONEDRIVE_CLIENT_ID` in `wrangler.jsonc` | Never change them: existing Google Drive libraries are tied to the Google client id. |
| `CLOUDFLARE_API_TOKEN` | GitHub repo secret, used by CI to deploy | Only if you gave the token an expiry. When CI deploys start failing with auth errors, create a new token and run `gh secret set CLOUDFLARE_API_TOKEN -R rodrigohpalmeirim/openstand`. |

The full setup of each provider app is under [Provider app registration](#provider-app-registration) below.

## Provider app registration

How the Dropbox, Google Drive and OneDrive apps behind the drive sign-ins are registered. Follow it to recreate the official apps, or to register your own when self-hosting.

Use these values everywhere (self-hosters: replace `https://openstand.rodlabs.dev` with your own origin):

- Production origin `https://openstand.rodlabs.dev`, redirect `https://openstand.rodlabs.dev/oauth/callback`.
- Development origin `http://localhost:5317`, redirect `http://localhost:5317/oauth/callback`. Use `localhost`, not `127.0.0.1`.
- Privacy policy `https://openstand.rodlabs.dev/privacy`, homepage `https://openstand.rodlabs.dev`.

### Dropbox

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. Choose **Scoped access** → **App folder** → name it **OpenStand**. Names are unique across Dropbox; if it's taken use e.g. "OpenStand Sync", and keep the app folder name "OpenStand" in step 4.
3. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write` (`account_info.read` is already ticked) → **Submit**.
4. **Settings** tab:
   - **App folder name**: `OpenStand`.
   - **OAuth 2 → Redirect URIs**: add both redirect URIs above.
   - **Allow public clients (Implicit Grant & PKCE)**: **Allow**.
   - Copy the **App key**: it's the client id. Put it in `src/libsync/oauth/config.ts` (`OFFICIAL.dropbox`). The App secret is **not** used; don't put it anywhere.
5. **Branding** tab: app name, a short description, an icon, and the website `https://openstand.rodlabs.dev`.
6. **Users:** a new app is in *Development* and only works for your account. Use **Enable additional users** (Settings) for up to 500 users. Once 50 users have linked it, you have two weeks to **Apply for production** ([developer guide](https://www.dropbox.com/developers/reference/developer-guide)).

### Google Drive

1. In the [Google Cloud console](https://console.cloud.google.com/) create a project **OpenStand**.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding:** app name `OpenStand`, user support email, app home page `https://openstand.rodlabs.dev`, privacy policy `https://openstand.rodlabs.dev/privacy`, authorised domain `rodlabs.dev`. A logo is optional, and adding one requires brand verification before it's shown.
   - **Audience:** User type **External**. While it says *Testing*, add yourself (and anyone testing) under **Test users**.
   - **Data access → Add or remove scopes:** add `https://www.googleapis.com/auth/drive.file` ("See, edit, create and delete only the specific Google Drive files you use with this app"). It is listed as non-sensitive. Add nothing else.
   - **Clients → Create client:** type **Web application**, name `OpenStand web`.
     - Authorised JavaScript origins: both origins above.
     - Authorised redirect URIs: both redirect URIs above.
     - Create. Copy the **Client ID** → `src/libsync/oauth/config.ts` (`OFFICIAL.gdrive`) and the `GDRIVE_CLIENT_ID` var in `wrangler.jsonc`. Copy the **Client secret** → `npx wrangler secret put GDRIVE_CLIENT_SECRET` (and into `.dev.vars` for local development).
4. **Publishing:**
   - In *Testing*, refresh tokens expire after **7 days**: every device must sign in again weekly, and only test users can sign in.
   - Before anyone else uses it: **Audience → Publish app** (to *In production*). With only `drive.file` there is no sensitive-scope review.
   - Google still asks apps to complete **brand verification** (verify the domain in [Search Console](https://search.google.com/search-console); homepage and privacy policy reachable) before the app name and logo are shown on the consent screen ([verification requirements](https://support.google.com/cloud/answer/13464321)).
5. **Never change the client id afterwards:** with the `drive.file` scope, libraries already in Drive are only visible to the client id that created them.
6. Google Workspace accounts can be blocked by their admin's third-party-app policy. That's a per-domain setting outside our control.

### Microsoft OneDrive

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/) → **App registrations → New registration**:
   - Name: **OpenStand**. This becomes the folder name `Apps/OpenStand` ([app folder](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)).
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI: platform **Web**, `https://openstand.rodlabs.dev/oauth/callback`.
2. **Authentication:** under the *Web* platform, add `http://localhost:5317/oauth/callback`. **Don't add a "Single-page application" platform:** SPA refresh tokens last 24 h and can't be redeemed by the Worker. Leave implicit grant (access/ID tokens) **off**.
3. **Certificates & secrets → New client secret**, 24 months (the maximum). Copy the **Value** → `npx wrangler secret put ONEDRIVE_CLIENT_SECRET` (and `.dev.vars`). Set a reminder: when it expires, every OneDrive sign-in and refresh fails ("Sign-in for OneDrive isn't set up correctly on this site"). See [Renewing the OneDrive client secret](#renewing-the-onedrive-client-secret-every--24-months).
4. **API permissions → Add a permission → Microsoft Graph → Delegated:** `Files.ReadWrite.AppFolder`, `offline_access`, `openid`, `profile`, `email`. (The default `User.Read` can stay; the app doesn't request it at sign-in.) Don't grant admin consent for your tenant unless you want to.
5. **Overview:** copy the **Application (client) ID** → `src/libsync/oauth/config.ts` (`OFFICIAL.onedrive`) and the `ONEDRIVE_CLIENT_ID` var in `wrangler.jsonc`.
6. **Branding & properties:** home page `https://openstand.rodlabs.dev`, privacy statement `https://openstand.rodlabs.dev/privacy`, logo optional.
7. Work or school accounts:
   - Some organisations only allow apps from verified publishers, or none, and then an admin must approve ([user consent settings](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)). Publisher verification needs a Microsoft AI Cloud Partner Program account; it isn't needed for personal accounts.
   - Microsoft's docs disagree on whether `Files.ReadWrite.AppFolder` works for work or school accounts: the [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#filesreadwriteappfolder) lists it for personal accounts, while the [app folder guide](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder) says it works for both.

### Deploying

```sh
npx wrangler secret put GDRIVE_CLIENT_SECRET
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
# wrangler.jsonc vars: GDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_ID (public), ALLOWED_ORIGINS
npm run deploy
curl https://openstand.rodlabs.dev/api/oauth/providers   # lists gdrive and onedrive with their client ids
```

The app offers Dropbox when its client id is set, and Google Drive and OneDrive when their client id is set **and** the Worker's `/api/oauth/providers` lists them with the same client id.

### Self-hosting

1. Register your own apps as above, with **your** origin's `/oauth/callback`. The official client ids only work on the official origins, so a self-hosted build without its own ids doesn't offer drive sign-in.
2. Build with `VITE_DROPBOX_CLIENT_ID`, `VITE_GDRIVE_CLIENT_ID` and `VITE_ONEDRIVE_CLIENT_ID` set (in `.env.local`, or in CI); `off` hides a provider. Optionally set `VITE_DROPBOX_APP_FOLDER` if your Dropbox app folder isn't named `OpenStand`.
3. In `wrangler.jsonc` set `GDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_ID` and `ALLOWED_ORIGINS`, and add both secrets with `wrangler secret put`.
4. Without the Worker (static hosting), only Dropbox and S3 are offered.
