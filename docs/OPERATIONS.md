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

The full setup of each provider app is in [SYNC-DRIVES.md §10](SYNC-DRIVES.md).
