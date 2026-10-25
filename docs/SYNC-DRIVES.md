# Library sync on cloud drives: Dropbox, Google Drive, OneDrive

Status: **spec, not implemented.** Extends `docs/SYNC.md` (read it first: §3 layout, §7 backend contract,
§10 engine, §11 pairing, §12 UI). It replaces the sketch in SYNC.md §7.2. Where the two disagree, this file
wins. In particular, the token route is `POST /api/oauth/<provider>/token`, not `/api/oauth/token`.

Decisions already made by the user, restated so they aren't reopened:

- All three providers ship together. There are no accounts on our side: each device signs into the drive
  itself. The pairing code carries the library secret, the backend kind and non-secret hints (folder id,
  account email and id). It **never** carries OAuth tokens.
- Visible app folders: Dropbox "App folder" access (`/Apps/<name>/`); a visible "OpenStand" folder in
  My Drive with the `drive.file` scope; OneDrive `special/approot` (`Apps/<name>`) with
  `Files.ReadWrite.AppFolder`, for personal and work/school accounts (`common`).
- Dropbox uses browser PKCE with no secret. Google and Microsoft exchange tokens through a stateless
  Worker route that holds the client secrets and stores nothing.
- The redirect URI is `/oauth/callback` on the app's origin. Client IDs are public build-time config. The
  privacy page is `/privacy`.

Facts marked **[probe 2026-10-25]** were checked with `curl` preflights and unauthenticated requests
against the live endpoints from `Origin: https://openstand.rodlabs.dev`. Everything else cites the
provider's documentation. Items marked **verify (e2e)** are not settled by the docs and are checked by
the opt-in real-account script (§9.3) before release.

---

## 1. Overview

| | Dropbox | Google Drive | OneDrive |
| --- | --- | --- | --- |
| Where the data lives | `Dropbox/Apps/OpenStand/os1/…` | `My Drive/OpenStand/` (flat: one file per key, name = key) | `OneDrive/Apps/OpenStand/os1/…` |
| Scope | `files.metadata.read files.content.read files.content.write account_info.read` | `https://www.googleapis.com/auth/drive.file` | `Files.ReadWrite.AppFolder offline_access openid profile email` |
| Token exchange | browser → `api.dropboxapi.com/oauth2/token` (PKCE, no secret) | browser → Worker → `oauth2.googleapis.com/token` | browser → Worker → `login.microsoftonline.com/common/oauth2/v2.0/token` |
| Key mapping | real paths | flat names + `appProperties` d1..d3 for prefix queries | real folders down to depth 3, deeper segments joined with `~` |
| Conditional create | atomic (`mode: add`, `strict_conflict`) | **emulated**, not atomic (§4.3) | atomic (`@microsoft.graph.conflictBehavior=fail`) |
| Requests per poll (LIST `heads/`) | 1 | 1 | 1 |
| `BackendConfig` | `{kind:'dropbox', root:'', account, accountId}` | `{kind:'gdrive', folder:<fileId>, account, accountId}` | `{kind:'onedrive', folder:'', account, accountId}` |

---

## 2. Contracts (step 0)

### 2.1 `backends/types.ts` (additive edits only)

```ts
export type OAuthKind = 'dropbox' | 'gdrive' | 'onedrive'

export type BackendConfig =
  | S3Config                                               // unchanged
  /** `root`: sub-path inside the app folder; '' = the app folder itself (the UI always uses ''). */
  | { kind: 'dropbox'; root: string; account?: string; accountId?: string }
  /** `folder`: Drive file id of the visible OpenStand folder. Required, non-empty. */
  | { kind: 'gdrive'; folder: string; account?: string; accountId?: string }
  /** `folder`: sub-path inside approot; '' = approot (the UI always uses ''). */
  | { kind: 'onedrive'; folder: string; account?: string; accountId?: string }
  | { kind: 'memory'; name: string }
// account   = display hint, usually the email ("rod@example.com"). ≤ 320 chars.
// accountId = the provider's stable id: Dropbox account_id, Google about.user.permissionId,
//             OneDrive approot.parentReference.driveId. ≤ 200 chars. Both are non-secret hints that let a
//             joining device detect a wrong account (§7.3). Neither is ever a credential.

export type BackendErrorCode = /* existing */ | 'reauth'
// 'reauth' = this device must sign in again: no tokens, refresh refused (invalid_grant), consent revoked,
//            a required scope was not granted, or a fresh token still gets 401.

export interface AccountInfo { id: string; email?: string; name?: string }

/** Per-device OAuth access for one backend (implemented in oauth/tokens.ts, faked in tests). */
export interface AccessTokenSource {
  readonly kind: OAuthKind
  /** A valid access token; refreshes first if it expires within 5 min. Throws BackendError('reauth'|'network'). */
  token(o?: { signal?: AbortSignal }): Promise<string>
  /** `rejected` got a 401: refresh (once per rejected token, across tabs) and return the new token. */
  refreshAfter401(rejected: string, o?: { signal?: AbortSignal }): Promise<string>
}

export interface BackendContext {
  fetch?: typeof fetch
  now?: () => number
  /** @deprecated never used; OAuth backends take `auth`. */
  tokens?: { get(): Promise<TokenSet | undefined>; set(t: TokenSet): Promise<void> }
  /** Required for dropbox/gdrive/onedrive; a missing one makes every call throw BackendError('reauth'). */
  auth?: AccessTokenSource
}

export interface BackendDescription {
  account: AccountInfo
  /** For people: "Dropbox › Apps › OpenStand", "Google Drive › OpenStand", "OneDrive › Apps › OpenStand". */
  location: string
  /** Opens the folder in the provider's web UI. */
  openUrl?: string
  freeBytes?: number
}

export interface StorageBackend {
  /* …existing… */
  /** Who is signed in and where the data lives. OAuth backends implement it; S3/memory omit it. */
  describe?(o?: { signal?: AbortSignal }): Promise<BackendDescription>
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt: number          // wall ms
  account?: string           // display (email)
  accountId?: string         // same meaning as BackendConfig.accountId
  scope?: string             // granted scopes, as returned by the token endpoint
}
```

`OAuthProvider` in types.ts (§7.2 sketch) is superseded by `oauth/config.ts`. Leave it in place, marked
`@deprecated`.

### 2.2 `api.ts` (additive)

```ts
export type LibSyncErrorCode = /* existing */ | 'reauth' | 'wrongAccount'
export interface LibSyncStatus { /* existing */ backendKind?: BackendKind }

/** OAuth providers usable here: a client id is configured, and for gdrive/onedrive the Worker route answers (§6.4). */
export function oauthProviders(): Promise<OAuthKind[]>
/** Saves the pending sign-in (§5.2) and navigates away. Never resolves when it works. */
export function startSignIn(kind: OAuthKind, intent: SignInIntent, o?: { chooseAccount?: boolean; loginHint?: string }): Promise<void>
/** Sync: a callback is waiting to be completed (localStorage check, no import). */
export function signInReturnPending(): boolean
/** Exchanges the code, stores the tokens in syncState.oauth of the pending library DB, identifies the account. */
export function completeSignIn(): Promise<SignInResult>     // LibSyncFailure on error (§5.5)
/** After sign-in: the BackendConfig for setup. gdrive finds or creates the OpenStand folder (§4.1). */
export function driveBackendConfig(kind: OAuthKind): Promise<BackendConfig>
/** `backend.describe()` with this device's tokens (wizard and settings). */
export function describeBackend(cfg: BackendConfig): Promise<BackendDescription>
```

### 2.3 `oauth/types.ts` (new contract)

```ts
export type SignInIntent =
  | { type: 'setup' }
  | { type: 'join'; pairing: string }          // the OSJ1. code, so the join resumes after the redirect
  | { type: 'reauth'; accountId?: string }     // must come back as the same account
export interface PendingSignIn {
  v: 1; kind: OAuthKind; state: string; verifier: string; redirectUri: string
  db: string                                    // library DB name the tokens belong to
  intent: SignInIntent; createdAt: number
  /** Set by the callback page. */
  ret?: { code: string } | { error: string; description?: string }
}
export interface SignInResult { kind: OAuthKind; intent: SignInIntent; account: AccountInfo }
export type SignInErrorCode = 'denied' | 'expired' | 'scope' | 'wrongAccount' | 'exchange' | 'notConfigured' | 'network'
```

`SignInErrorCode` reaches the UI as `LibSyncFailure` codes: `denied`, `expired`, `exchange` and
`notConfigured` become `unknown` with fixed messages; `scope` becomes `reauth`; `wrongAccount` stays
`wrongAccount`; `network` stays `network`.

### 2.4 `oauth/config.ts`: client ids and provider table (committed)

```ts
export const OFFICIAL_ORIGINS = ['https://openstand.rodlabs.dev', 'http://localhost:5317']
const OFFICIAL: Record<OAuthKind, string> = {
  dropbox: '',   // App key from the Dropbox App Console (§10.1); public
  gdrive: '',    // "<n>-<x>.apps.googleusercontent.com" (§10.2); public
  onedrive: '',  // Application (client) ID GUID (§10.3); public
}
/** VITE_DROPBOX_CLIENT_ID / VITE_GDRIVE_CLIENT_ID / VITE_ONEDRIVE_CLIENT_ID; 'off' hides the provider. */
export function oauthClientId(kind: OAuthKind, origin = location.origin): string | null
// 1. env var set: 'off' → null, else the value (self-hosters).
// 2. origin ∈ OFFICIAL_ORIGINS and OFFICIAL[kind] non-empty → OFFICIAL[kind].
// 3. otherwise null: the provider is hidden. Official ids only work on origins whose redirect URIs are
//    registered, so a self-hosted build without its own ids never offers a sign-in that fails.
export const DROPBOX_APP_FOLDER = import.meta.env.VITE_DROPBOX_APP_FOLDER || 'OpenStand'   // display only
export const PROVIDERS: Record<OAuthKind, ProviderSpec>   // the §5.3 table as data
```

The Worker reads its own copies of the Google and Microsoft client ids from `wrangler.jsonc` vars. The
app hides gdrive/onedrive when `GET /api/oauth/providers` doesn't list that provider with the **same**
client id (§6.4), so a mismatched deployment shows nothing rather than failing at sign-in.

### 2.5 Shared helpers (step 0, with tests)

| File | Exports |
| --- | --- |
| `backends/keymap.ts` | `segments(key)` (throws on `''`, `//`, a leading `/`, `~`, or non-ASCII); `deep3(key) → {folder: string[], leaf: string}` and `fromDeep3(folder, leaf)` (OneDrive, §4.2); `dirProps(key) → {d1?, d2?, d3?}` (Drive, §4.3); `prefixScope(prefix) → {folder: string[], depth: number}` (the deepest complete folder of a prefix, capped at 3) |
| `backends/http.ts` | `class OAuthHttp { constructor(ctx, o: {mapError(res, body): BackendError; label}) ; send(url, init & {auth?: boolean; expect?: number[]; maxBody?: number}): Promise<Response>; json<T>(…): Promise<T> }`. It adds `Authorization: Bearer`, and on a 401 calls `auth.refreshAfter401` once and retries; a second 401 is `reauth`. A thrown fetch becomes `network` (or the abort error). It reads error bodies through `readBody` (64 KiB, truncated) and never retries anything else: retrying is the engine's job, as for S3. |
| `backends/fakes/harness.ts` | `FakeServer` base: a `fetch`-compatible router (`fake.fetch`), per-route fault injection, a call log, a token simulator (§9.1) |

Keys are always lowercase ASCII (`[a-z0-9./-]`): Dropbox and OneDrive paths are case-insensitive. All
three backends throw `BackendError('unknown', …, {providerCode:'BadKey'})` on any other key, so a future key
format fails loudly in tests rather than colliding on a drive.

---

## 3. Shared rules for the three backends

- **Listing.** None of the three can list in key order from a cursor. `list()` collects every provider
  page for the prefix (bounded by `LIST_MAX_KEYS`, otherwise `TooManyKeys`), removes duplicate names
  (Drive), sorts by key, applies `startAfter`, and returns **one page without a cursor**. `limit` is a hint
  and may be exceeded; only `check()` passes one (verified: `grep "limit:" src/libsync`). The contract suite
  accepts this: pages only have to concatenate in sorted order.
- **Bodies.** `get` uses `readBody` from `s3.ts` with the same caps as S3 (SYNC.md §4.4): the range
  length, else `maxBytes ?? GET_MAX`; a 200 to a range request is accepted only if it fits
  (`RangeIgnored`); 416 → empty array; a range that runs past the end is clamped by the server.
  JSON answers are capped at 8 MiB, error bodies at 64 KiB.
- **Uploads.** `upload()` must call `onState` **before the first `src.read`**, with `done: 0` and a live
  session: Dropbox starts the session with an empty body; Drive and Graph create the session first. It
  then calls `onState` after every acknowledged chunk with `done` = the bytes the server confirmed. Resume
  asks the server for its offset, so a chunk that landed before a crash isn't read again. A completed
  session resumes as a no-op without reads (the contract checks this). `UploadState.backend` =
  `${kind}:${accountId}:${root|folder}`, so another account never resumes a session.
- **Chunks need not align with the 1 MiB crypto chunks.** `encryptChunks` serves any `[start, end)`
  (`crypto.ts`), so each backend uses the chunk size its provider wants.
- **Rate limits.** 429, and 503 with a retry hint, become `rateLimited` with `retryAfterMs` taken from
  wherever the browser can read it (see each provider). The engine and the transfer queue already back off;
  `rateLimited` must not show "Offline" (WP-O, §11).
- **Never log** tokens, upload session URLs (Graph's are pre-authenticated), or download URLs.
  `BackendError` messages carry the key and the provider's error code only.

---

## 4. Per-provider mapping

### 4.1 Dropbox (`backends/dropbox.ts`)

Hosts: RPC `https://api.dropboxapi.com/2/…` (JSON body), content `https://content.dropboxapi.com/2/…`
(args in the `Dropbox-API-Arg` header as ASCII JSON). Path of a key: `'/' + (root ? root + '/' : '') + key`.
The app-folder root is `''`. All calls are POST.

| Op | Request | Notes |
| --- | --- | --- |
| list(P) | `files/list_folder {path: <deepest complete folder of P>, recursive: true, limit: 2000, include_deleted: false}` then `files/list_folder/continue {cursor}` while `has_more` | 409 `path/not_found` → `[]`. Keep `.tag === 'file'`; key = `path_lower` minus the root; filter `startsWith(P)`. `size`, `rev` → etag, `server_modified` → lastModified. |
| head | `files/get_metadata {path}` | 409 `path/not_found` → `null`; a folder → `null` |
| get | `content: files/download`, arg `{path}`, optional `Range: bytes=a-b` | 409 `path/not_found` → `null`. 206 on ranges. |
| put | `content: files/upload`, arg `{path, mode: 'add'\|'overwrite', autorename: false, mute: true, strict_conflict: true}`, `Content-Type: application/octet-stream` | `ifNoneMatch` → `mode:'add'`. A 409 whose `error_summary` starts `path/conflict` → `precondition`. `strict_conflict` is needed: without it `add` silently succeeds when the existing file has identical content ([files.stone `WriteMode`, `CommitInfo.strict_conflict`](https://github.com/dropbox/dropbox-api-spec/blob/master/files.stone)). The engine compares bytes after a `precondition` anyway (SYNC.md §10.1). |
| delete | `files/delete_v2 {path}` | 409 `path_lookup/not_found` → success. Empty folders are left behind (harmless). Deleted files go to Dropbox's restorable history, which doesn't count against quota. |
| upload | ≤ `maxSmallPut` → `put`. Else `files/upload_session/start` (arg `{close:false}`, **empty body**) → `onState` → `files/upload_session/append_v2` (arg `{cursor:{session_id, offset}, close:false}`, 8 MiB chunks) → `files/upload_session/finish` (arg `{cursor:{session_id, offset:size}, commit:{path, mode:'overwrite', autorename:false, mute:true}}`, empty body) | `session = {sessionId, chunk}`. Resume: append at `state.done`. A 409 `incorrect_offset` carries `correct_offset`: continue from there when `0 ≤ correct_offset ≤ size`. `not_found` or `closed` → done if `head(key).size === size`, else start again. Sequential sessions have no alignment rule (the 4 MiB multiple applies to *concurrent* sessions). Sessions live 7 days; a request carries at most 150 MiB ([files.stone `upload_session/start`](https://github.com/dropbox/dropbox-api-spec/blob/master/files.stone)). |
| abortUpload | **omitted** | Dropbox has no cancel; sessions expire after 7 days, and stale states are never resumed (`blobs.ts` drops states older than `MULTIPART_STALE`). |
| describe | `users/get_current_account` (needs `account_info.read`, [users.stone](https://github.com/dropbox/dropbox-api-spec/blob/master/users.stone)); `users/get_space_usage` | location `Dropbox › Apps › ${DROPBOX_APP_FOLDER}`, openUrl `https://www.dropbox.com/home/Apps/${encodeURIComponent(DROPBOX_APP_FOLDER)}` |

Caps: `rangeGet: true`, `conditionalPut: true` (atomic), `maxSmallPut: 16 MiB` (the API allows 150 MiB per
request). Max object ≈ 2 TiB (session limit). Options for tests: `{chunk?, maxSmallPut?}`.

Errors (Dropbox answers 409 for endpoint errors, with `{error_summary, error}`):

| Response | BackendError |
| --- | --- |
| 400 (plain-text body) | `unknown` (a bug in our request) |
| 401 `expired_access_token` | refresh and retry once (inside `OAuthHttp`) |
| 401 `invalid_access_token`, `missing_scope`, or a 401 after refresh | `reauth` (`providerCode` = the tag) |
| 403 | `forbidden` |
| 409 `…/not_found` | `null` / success (by op) or `notFound` |
| 409 `path/conflict…` | `precondition` |
| 409 `…insufficient_space…` | `quota` |
| 409 or 429 `too_many_write_operations`; 429 `too_many_requests` | `rateLimited`, `retryAfterMs = error.retry_after × 1000` (body field, default 1 s). The `Retry-After` header is **not** in Dropbox's `Access-Control-Expose-Headers` **[probe]**, so read the body. ([auth.stone `RateLimitError`](https://github.com/dropbox/dropbox-api-spec/blob/master/auth.stone)) |
| 5xx | `server` |

Dropbox serialises writes per namespace and answers concurrent writers with `too_many_write_operations`
([performance guide](https://developers.dropbox.com/dbx-performance-guide)). Our write rate (one log, one
head, one delete per push, two upload slots) is low, so backing off is enough.

### 4.2 OneDrive via Microsoft Graph (`backends/onedrive.ts`)

Base `B = https://graph.microsoft.com/v1.0/me/drive/special/approot`. A key maps through `deep3`:

- The **first `min(n−1, 3)` segments are real folders** and the rest are joined with `~` into the file
  name.
- So `os1/<lib>/heads/<dev>/<seq10>` → folder `os1/<lib>/heads`, file `<dev>~<seq10>`. `os1/<lib>/meta` →
  folder `os1/<lib>`, file `meta`. `os1/<lib>/blobs/<name>` → `os1/<lib>/blobs/<name>`.

Why: Graph lists only one folder's direct children, and `delta` (which would list a subtree) is only
offered on the drive root ([driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)),
which the app-folder scope can't read. With real per-device folders, polling `heads/` would cost 1 + N
requests; with `deep3` every hot prefix (`heads/`, `log/<dev>/`, `snap/`, `devices/`, `blobs/`) is one folder,
so it costs one.

Path addressing: `B:/{segments, each encodeURIComponent'ed}` (item) and `B:/{path}:/content` and so on.

| Op | Request | Notes |
| --- | --- | --- |
| list(P) | `GET B:/{F}:/children?$select=id,name,size,eTag,lastModifiedDateTime,file,folder` (`B/children` for the root), following `@odata.nextLink` | F = `prefixScope(P)`. Files → keys via `fromDeep3`. Subfolders (only at depth < 3) are walked when their key prefix could match P. 404 `itemNotFound` → `[]`. Graph warns that paging `children` while writes happen isn't guaranteed to return every item ([delta, note](https://learn.microsoft.com/en-us/graph/api/driveitem-delta)); see §4.4. |
| head | `GET B:/{path}?$select=id,size,eTag,lastModifiedDateTime,file` | 404 → `null`; a folder → `null` |
| get | `GET B:/{path}?$select=id,size,@microsoft.graph.downloadUrl`, then `fetch(downloadUrl, {headers: range ? {Range} : {}})` **without** `Authorization` | `/content` answers 302, which the browser can't follow after an authorised CORS request; the documented way is the pre-authenticated `downloadUrl`, and `Range` goes on that URL ([get content: "Downloading files in JavaScript apps", "Partial range downloads"](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content)). Personal download and upload hosts (`*.files.1drv.com`, `api.onedrive.com/up/…`) allow our origin, `Range` and `Content-Range` **[probe]**. SharePoint (work/school) download hosts: **verify (e2e)**. The URL may expire within minutes: cache it per key for ≤ 60 s; a 401/403/404 from it → fetch the metadata once more and retry. |
| put | `PUT B:/{path}:/content?@microsoft.graph.conflictBehavior=fail\|replace`, `Content-Type: application/octet-stream` | `ifNoneMatch` → `fail`; 409 (`nameAlreadyExists`) → `precondition` ([put content, conflictBehavior](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_put_content)). Simple upload takes up to 250 MB ([Graph put content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content)). Missing parent folders: if the PUT answers 404/409 for the parent, create each folder with `POST {parent}/children {name, folder:{}, "@microsoft.graph.conflictBehavior":"fail"}` (409 = exists = fine), cache "exists", retry once. **verify (e2e)** whether path PUTs create parents by themselves. |
| delete | `POST B:/{path}:/permanentDelete`; if that answers 400/403/404/501, `DELETE B:/{path}` and remember the fallback per instance | A 404 on DELETE → success. Plain DELETE goes to the recycle bin, which on personal OneDrive can count against quota, and every push deletes one head. `permanentDelete` lists `Files.ReadWrite` as least privilege ([permanentDelete](https://learn.microsoft.com/en-us/graph/api/driveitem-permanentdelete)); whether AppFolder suffices: **verify (e2e)**. |
| upload | ≤ `maxSmallPut` → `put`. Else `POST B:/{path}:/createUploadSession {item:{"@microsoft.graph.conflictBehavior":"replace"}}` → `onState` → `PUT uploadUrl` with `Content-Range: bytes a-b/size`, 10 MiB fragments (32 × 320 KiB), **no** `Authorization` | `session = {uploadUrl, chunk}`. 202 → `nextExpectedRanges`; 200/201 → done. Resume: `GET uploadUrl` → the start of `nextExpectedRanges[0]`; 404 → done if `head.size === size`, else start again; 416 → ask the status, then continue. Fragments must be multiples of 320 KiB, at most 60 MiB, sent in order; an `Authorization` header on the PUT can cause 401 ([createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)). |
| abortUpload | `DELETE uploadUrl` (no auth) | 404 → success. Documented ([createUploadSession, Example 5](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)). |
| describe | `GET B?$select=id,name,webUrl,parentReference` (also creates approot on first use) | accountId = `parentReference.driveId`; email and name come from the id_token (§5.4); location `OneDrive › ${parent folder} › ${name}`, openUrl = `webUrl` |

Caps: `rangeGet: true`, `conditionalPut: true` (atomic), `maxSmallPut: 10 MiB` (Microsoft recommends
sessions above 10 MiB). Max object 250 GB. Options for tests: `{chunk (multiple of 327680), maxSmallPut}`.

Errors (`{error:{code, message}}`):

| Response | BackendError |
| --- | --- |
| 401 | refresh and retry once; again → `reauth` |
| 403 `accessDenied` | `forbidden` (also when a tenant blocks the app) |
| 404 `itemNotFound` | `null` / success / `notFound` |
| 409 on a `fail` PUT, 412 | `precondition` |
| 429, 503 | `rateLimited`, `retryAfterMs` from `Retry-After` (exposed **[probe]**; [throttling](https://learn.microsoft.com/en-us/graph/throttling)) |
| 507 `insufficientStorage`, `quotaLimitReached` | `quota` |
| 423 `resourceLocked`, other 5xx | `server` |

Folder names: OneDrive and SharePoint refuse `" * : < > ? / \ |`, a leading `~$` and a trailing `.`; `~`
inside a name is allowed and keys never contain `~` (keymap enforces it).

### 4.3 Google Drive v3 (`backends/gdrive.ts`)

**Layout: flat.** Every object is one file directly in the OpenStand folder (`config.folder`), and its
`name` is the full key. Each file carries `appProperties`:

- `os: '1'`;
- `d1`, `d2`, `d3`: the key's first 1, 2 and 3 segments, set only when they are proper folder prefixes,
  so `os1/<lib>/heads/<dev>/<seq>` gets `d1=os1`, `d2=os1/<lib>`, `d3=os1/<lib>/heads`.

Why not one Drive folder per path segment:

- Drive has no paths, and folder names aren't unique. Two devices creating `heads/` at once get two folders,
  and keys split between them silently.
- Every key lookup would walk up to five folder levels.
- The flat layout needs no folder creation at all after setup.

Prefix queries use `appProperties has { key='d3' and value='…' }`, which matches exactly
([search files](https://developers.google.com/workspace/drive/api/guides/search-files),
[search terms](https://developers.google.com/workspace/drive/api/guides/ref-search-terms)). We don't use
`name contains`: it only does prefix matching on name terms, and it isn't defined for our separators.
Private `appProperties` hold at most 30 per app per file, at most 124 bytes per key + value
([properties](https://developers.google.com/workspace/drive/api/guides/properties)). Our longest value,
`os1/<26>/devices`, is 38 bytes. A folder holds at most 500,000 items, far above a library's needs.

Base `D = https://www.googleapis.com/drive/v3`, upload base `U = https://www.googleapis.com/upload/drive/v3`.
Fields used everywhere: `id,name,size,version,createdTime,modifiedTime`. The etag is `version`.

| Op | Request | Notes |
| --- | --- | --- |
| list(P) | `GET D/files?q=<Q>&fields=nextPageToken,files(<fields>)&pageSize=1000&spaces=drive` following `pageToken` | `j = min(complete segments of P, 3)`. If `j ≥ 1`: `Q = '<folder>' in parents and appProperties has { key='d<j>' and value='<first j segments>' } and trashed = false`. Else: `… and appProperties has { key='os' and value='1' } …`. Filter `startsWith(P)`; for duplicate names keep the **canonical** file (below). Cache key → id. Escape `\` and `'` in values. |
| resolve(key) | cache, else `GET D/files?q='<folder>' in parents and name = '<key>' and trashed = false&fields=files(<fields>)` | All matches; canonical = earliest `createdTime`, then the lowest `id`. |
| head | resolve → info, or `null` | |
| get | resolve → `GET D/files/{id}?alt=media` (+ `Range`) | A 404 on a cached id (deleted elsewhere) → drop the cache entry, resolve again, retry once. |
| put, new key | `POST U/files?uploadType=multipart&fields=<fields>`, `multipart/related` with metadata `{name:key, parents:[folder], appProperties}` and the bytes; above 5 MiB a single-request resumable upload (multipart is limited to 5 MB, [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)) | Then **dedupe** (below). |
| put, existing key | `PATCH U/files/{canonicalId}?uploadType=media` (resumable above 5 MiB) | Overwrites in place, so `devices/<me>` never multiplies. |
| put with `ifNoneMatch` | resolve; exists → `precondition`; else create, then dedupe | Not atomic, see "Duplicates". |
| delete | resolve **all** files with that name → `DELETE D/files/{id}` each | Permanent (skips the trash). 404 → success. |
| upload | ≤ `maxSmallPut` → `put`. Else `POST U/files?uploadType=resumable&fields=<fields>` with `X-Upload-Content-Type: application/octet-stream`, `X-Upload-Content-Length: size` and the metadata JSON → session URI from `Location` → `onState` → `PUT <uri>` with `Content-Range: bytes a-b/size`, 8 MiB chunks (32 × 256 KiB), `Authorization` included | `session = {uri, chunk}`. 308 → next = (last byte in `Range: bytes=0-N`) + 1, or 0 when there is no `Range`; 200/201 → file metadata (cache the id), then dedupe. Resume: `PUT <uri>` with an empty body and `Content-Range: bytes */size` → 308 (continue from Range), 200/201 (done, no reads), 404 (session expired: start again). Chunks are multiples of 256 KiB except the last; sessions last a week; any other 4xx during the upload means start again ([uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)). Browser reads of `Location` and `Range` are what Google's own CORS sample does ([upload.js](https://github.com/googledrive/cors-upload-sample/blob/master/upload/upload.js)). Fallback when `Location` isn't readable: `X-GUploader-UploadID` is exposed **[probe]**, so the URI is `U/files?uploadType=resumable&upload_id=<id>`. Use `fetch` with the default `redirect: 'follow'`: a 308 without `Location` is then returned to script ([Fetch, HTTP-redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)), while `'manual'` would turn it into an opaque redirect. **verify (e2e)** in Chrome, Safari and Firefox. |
| abortUpload | **omitted** | Cancelling isn't documented for Drive; sessions expire after a week, and stale states are never resumed. |
| describe | `GET D/about?fields=user(displayName,emailAddress,permissionId),storageQuota(limit,usage)` and `GET D/files/{folder}?fields=name,webViewLink,trashed` | accountId = `permissionId`; location `Google Drive › ${name}`; openUrl = `webViewLink` |

**Root folder** (`ensureRootFolder(ctx)`, exported for WP-O, used only by `driveBackendConfig` at setup):

1. Query `mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='openstand' and value='root' } and trashed = false`.
2. Several results → the earliest `createdTime`. None → create
   `{name:'OpenStand', mimeType:'application/vnd.google-apps.folder', parents:['root'], appProperties:{openstand:'root'}, description:'OpenStand library sync. End-to-end encrypted; please don’t edit these files.'}`.
3. The id goes into `BackendConfig.folder`, and with it into the pairing code. A joining device opens
   `files.get(folder)` directly and never searches.

**Why a second device sees the folder.** `drive.file` grants access per file to *the app* for *the user*,
for the files the app created or the user opened with it
([scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)). The grant isn't
tied to a device or a token, so a token from any device of the same user and the same OAuth client sees the
folder and every file in it. Private `appProperties` are keyed to the OAuth client id
([properties](https://developers.google.com/workspace/drive/api/guides/properties)). Consequences:

- **All origins must use one client id.** A library created under another client id is invisible:
  changing the official Google client id orphans every Drive library.
- A folder the user creates by hand is invisible to us, so the marker search can only find our own folder.
- A `files.get(folder)` 404 on a joining device means "another Google account" (or a deleted folder)
  → `wrongAccount` (§7.3).
- Cross-device visibility is the premise; **verify (e2e)** test G-2 checks it with two independent sign-ins.

**Duplicates (no atomic conditional create).** Drive allows two files with the same name in one folder.
The deterministic rule:

- **Canonical file** of a key = earliest `createdTime`, ties broken by the lowest `id`. Every read
  (`get`, `head`, `list`) uses only the canonical file.
- **Dedupe after every create:** query the name. If our new file isn't canonical, delete *ours*, and for
  `ifNoneMatch` puts throw `precondition`. If it is canonical, leave the others: each writer deletes only its
  own losing copy.
- **Overwrites** update the canonical file in place.
- `delete(key)` removes every file with that name.

Why this is safe for SYNC.md's design (§3, §3.2):

| Key | Writers | With duplicates |
| --- | --- | --- |
| `meta` | the creating device, once, for a fresh random libraryId | No contention. |
| `log/<me>/<seq>` | only me; retries resend the identical sealed bytes from `syncOutbox` | A lost-response retry finds the existing file → `precondition` → the engine compares the bytes: identical, done. |
| `heads/<me>/<seq>` | only me; empty bodies | A duplicate is harmless; readers take the max seq. |
| `devices/<me>` | only me, overwritten in place | Only a create race with myself could duplicate it; dedupe heals it. |
| `snap/<me>/<n>` | only me, write-once | Same as log. |
| `blobs/<name>` | any device; deterministic ciphertext | Two devices uploading the same file make byte-identical copies; any copy reads correctly; GC deletes all of them. |

Where it is **not** safe:

1. **Clone detection on `log/`.** On S3, a cloned device writing `log/<me>/<seq>` gets 412 and stops with
   `rejoin`. On Drive, if the clone and the original create the same seq inside the check-then-create
   window (about a second), both succeed until dedupe runs. Dedupe then deletes the later copy and throws
   `precondition` to its writer, so detection still works, *if* the name query already sees the other
   copy (§4.4). If it doesn't, the later batch is silently dropped from what readers see. This needs a
   cloned device (restored from a backup of the browser profile) plus a race, and costs at most one batch.
   Accepted and documented.
2. **Two first-time setups at the same moment** on two devices of one account can create two OpenStand
   folders. Each library keeps its own folder id, so nothing breaks; the user sees two folders. Later setups
   use the oldest.
3. **Blob GC racing a re-upload** already exists on S3 (SYNC.md §3.2); duplicates add nothing new.

Caps: `rangeGet: true`, `conditionalPut: true` (emulated; `check()` reports
`{id:'conditional', ok:true, detail:'emulated (not atomic)'}`), `maxSmallPut: 5 MiB`. Max object 5 TB.
Quota: 1,000,000 units/min per project and 325,000 per user; the daily upload cap is 750 GB
([limits](https://developers.google.com/workspace/drive/api/guides/limits)).

Errors (`{error:{code, message, errors:[{reason}]}}`):

| Response | BackendError |
| --- | --- |
| 401 | refresh and retry once; again → `reauth` |
| 403 `insufficientPermissions`, `insufficientScopes` | `reauth` (`providerCode` = reason) |
| 403 `userRateLimitExceeded`, `rateLimitExceeded`, 429 | `rateLimited`. No readable `Retry-After` (not exposed **[probe]**), so the engine's exponential backoff with jitter, as Google asks ([limits](https://developers.google.com/workspace/drive/api/guides/limits)). |
| 403 `storageQuotaExceeded`, `quotaExceeded` | `quota` |
| 403 `appNotAuthorizedToFile`, other 403 | `forbidden` |
| 404 | `null` / success / `notFound` (a 404 for `config.folder` → `notFound`, `providerCode:'FolderGone'`) |
| 5xx | `server` |

### 4.4 Consistency of listings, and the heads design

SYNC.md §3 relies on strong read-after-write for `heads/`: write `log/` → write `heads/` → readers LIST
`heads/` → GET `log/`.

| | Dropbox | OneDrive | Google Drive |
| --- | --- | --- | --- |
| GET right after PUT | by path; consistent (no documented lag) | by path; consistent (no documented lag) | by **query** (name → id); not documented either way |
| LIST right after PUT | `list_folder`; no documented lag | `children` may miss items written during paging (documented) | `files.list`; not documented |
| What a lag would do | Only delays the poll | Only delays the poll | A head can be visible before its log's name lookup works: that stream holds back and retries after 30 s (SYNC.md §10.1). Correct, but slow. |

Assessment:

- **Correctness never depends on LIST freshness.** A late listing only delays discovery. The relay path
  doesn't list at all: a notice carries `s`, and the engine GETs `log/d/(cursor+1..s)` directly.
- The one failure mode is "head listed, log GET → null". Every other path treats null as a gap and falls
  back to a covering snapshot or holds the stream. That is safe; at worst a 30 s delay.
- **Reading heads by GET instead of LIST** ("probe `log/<d>/<cursor+1>` for every known device") costs N
  requests per poll instead of 1, and still needs a LIST to discover new devices. Not worth it unless lag is
  observed.
- **Decision:** keep LIST `heads/` for all three. The e2e script (§9.3, test X-1) measures write→query lag
  for each provider. If Drive shows misses within 2 s, add the optional engine change: on a log GET
  returning null for a head less than 2 minutes old, retry once after 3 s before gap handling. That's 10
  lines in `engine.ts pullStream`; it isn't part of this round.
- Drive mitigations already in the spec: our own writes fill the key → id cache, so our own reads never wait
  for the index. `list()` results fill the cache too.
- `deleteRemoteData` on OneDrive and Drive lists and deletes until a listing comes back empty (at most 3
  passes), since a paged listing can miss items.

### 4.5 Summary of caps and limits

| | Dropbox | Google Drive | OneDrive |
| --- | --- | --- | --- |
| `caps.rangeGet` | true | true | true (downloadUrl) |
| `caps.conditionalPut` | true, atomic | true, emulated | true, atomic |
| `caps.maxSmallPut` | 16 MiB | 5 MiB | 10 MiB |
| Upload chunk | 8 MiB, sequential | 8 MiB (32 × 256 KiB) | 10 MiB (32 × 320 KiB) |
| Session lifetime | 7 days | 1 week | until `expirationDateTime`, extended by every fragment |
| Max object | ≈ 2 TiB | 5 TB | 250 GB |
| List page | ≤ 2000, cursor | ≤ 1000, pageToken | nextLink |
| Retry hint | body `retry_after` | none (backoff) | `Retry-After` header |
| Deleted objects | restorable history, no quota | gone | recycle bin unless `permanentDelete` works |
| `abortUpload` | omitted | omitted | `DELETE uploadUrl` |

---

## 5. OAuth core (`src/libsync/oauth/`)

### 5.1 Redirect, not popup

| | Popup | Full-page redirect (chosen) |
| --- | --- | --- |
| Installed PWA, Android | `window.open` opens a Custom Tab; `opener` messaging is unreliable | Out-of-scope pages open inside the app window with a URL bar; coming back to `/oauth/callback` (in scope) returns to the app with its storage |
| Installed PWA, iOS | Opens a separate Safari view; `opener` is often null | Same as Android: the in-app browser view, back into the standalone app |
| Provider COOP headers | Can sever `window.opener` | Not involved |
| Popup blockers | Need a user gesture in the same tick | Not involved |
| Cost | | The page reloads; the wizard resumes from saved intent (no form data to lose) |

### 5.2 Flow

```
Wizard/Join/Settings ──startSignIn(kind, intent)──▶ oauth/flow.ts
  verifier = b64url(32 random bytes); challenge = b64url(SHA-256(verifier)); state = b64url(16 random bytes)
  localStorage['openstand-oauth:pending'] = PendingSignIn   (one slot; TTL 15 min; overwritten by a new start)
  location.assign(authorizeUrl)                            (redirectUri = location.origin + '/oauth/callback')
        │
        ▼  provider sign-in and consent
GET /oauth/callback?code=…&state=…   (or ?error=access_denied…)
  served as index.html (Workers assets SPA fallback; the service worker's navigateFallback; Vite in dev)
  main.tsx, before render: if (location.pathname === '/oauth/callback') handleOAuthCallback()   (oauth/callback.ts, tiny, sync)
    history.replaceState(null, '', '/')                    (first: removes the code from the URL)
    pending = read slot; state must match and be < 15 min old, else store ret = {error:'expired'}
    pending.ret = {code} | {error, description}; write it back
    useNav.getState().go({ name: 'settings', page: 'libsync' })
  render <App/> → LibrarySyncSettings mounts → signInReturnPending() → completeSignIn()
    exchange (Dropbox directly; others via the Worker) → check scopes → identify the account
    → reauth: accountId must equal the stored one, else wrongAccount (old tokens kept)
    → store TokenSet in syncState.oauth[kind] of DB pending.db; clear the slot
    → SignInResult → resumes: setup wizard at "check", JoinFlow at "preview", reauth: toast + engine restart
```

- **localStorage, not sessionStorage.** If a browser or OS opens the redirect in another tab or window of
  the same profile, sessionStorage is gone and the sign-in dead-ends. localStorage is the same origin trust
  domain as the IndexedDB that will hold the tokens and the library secret. The slot lives at most 15
  minutes and is deleted when consumed. `intent.pairing` (the code with the secret) sits there for that
  window only.
- **Single use.** `completeSignIn` deletes the slot before the exchange. A failed exchange needs a new
  sign-in; codes are single-use anyway.
- **PKCE (S256) and `state` for all three providers**, including the confidential Google and Microsoft
  clients (defence in depth: a stolen code is useless without the verifier).
- The page sends `Referrer-Policy: no-referrer` (`public/_headers`), so the code never leaks in a Referer.
  The CSP needs no change: `connect-src https:` already covers every API, and top-level navigations
  aren't restricted.
- **Dev:** OAuth works only on `http://localhost:5317`, the registered origin. On `127.0.0.1:5317` the
  wizard says "Open http://localhost:5317 to sign in".

### 5.3 Provider table (`PROVIDERS` in `oauth/config.ts`)

| | Dropbox | Google | Microsoft |
| --- | --- | --- | --- |
| authorize | `https://www.dropbox.com/oauth2/authorize` | `https://accounts.google.com/o/oauth2/v2/auth` | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` |
| fixed params | `response_type=code`, `token_access_type=offline`, `code_challenge_method=S256`, `scope=account_info.read files.metadata.read files.content.read files.content.write` | `response_type=code`, `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`, `scope=https://www.googleapis.com/auth/drive.file` | `response_type=code`, `response_mode=query`, `code_challenge_method=S256`, `scope=offline_access openid profile email Files.ReadWrite.AppFolder` |
| "choose account" (`o.chooseAccount`) | `force_reauthentication=true` | `prompt=select_account consent` | `prompt=select_account` |
| `o.loginHint` (join, reauth) | not supported | `login_hint` | `login_hint` |
| token endpoint | `https://api.dropboxapi.com/oauth2/token`, form: `code, grant_type, code_verifier, client_id, redirect_uri` / `grant_type=refresh_token, refresh_token, client_id` | `/api/oauth/gdrive/token` (§6) | `/api/oauth/onedrive/token` (§6) |
| required granted scope | `files.content.write` | `…/auth/drive.file` | `Files.ReadWrite.AppFolder` (match case-insensitively, with or without the `https://graph.microsoft.com/` prefix) |
| identify | `POST api.dropboxapi.com/2/users/get_current_account` (body `null`, JSON) → `account_id`, `email`, `name.display_name` | `GET drive/v3/about?fields=user(displayName,emailAddress,permissionId)` | `GET …/special/approot?$select=parentReference` → `driveId`; email, name from the id_token claims `email` ‖ `preferred_username`, `name` (decoded, not verified: display only, and it arrives over TLS from our Worker, which got it from Microsoft) |
| refresh token rotates | no | no | yes: always store the new one |

`prompt=consent` makes Google return a refresh token on every sign-in (otherwise only the first time). Each
sign-in then creates a new refresh token; Google keeps 100 per account and client and silently drops the
oldest ([OAuth 2.0, refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)).
That's far above devices × re-sign-ins.

Google shows **granular consent** (a checkbox per scope); the user can untick Drive. A token without
`drive.file` → `scope` error: "OpenStand needs access to its own files in Google Drive. Sign in again and
tick the box."
([granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions))

### 5.4 Tokens (`oauth/tokens.ts`)

- **Storage:** `syncState.oauth[kind]` (already in `model.ts`) of the library DB: per device and per
  library. It's the same trust domain as the library secret and the S3 keys, and never in pairing codes,
  backups (sync tables aren't archived, SYNC.md §8.6) or sync. `joinSync` in `newLibrary` mode copies
  `oauth[kind]` from the old DB into the new one before the join starts. "Stop syncing" clears it with the
  other sync tables. Cancelling the setup wizard before "Start syncing" deletes `oauth[kind]` from an
  unconfigured DB.
- **`tokenSource(db, kind): AccessTokenSource`.**
  - Keeps the TokenSet in memory and refreshes when `expiresAt − now < 5 min`.
  - Refresh runs under `navigator.locks.request('openstand-oauth:' + db.name + ':' + kind)`. Inside the lock
    it re-reads `syncState.oauth` first: if another tab already refreshed (the stored access token differs
    from the rejected or expiring one, and is fresh), it uses that. Otherwise it refreshes and writes the
    merged TokenSet in one Dexie transaction.
  - In-tab single flight: one promise per `(db.name, kind)`. Without Web Locks (Node tests, old Safari) only
    the in-tab mutex runs. Two tabs refreshing at once is still harmless: Google and Dropbox don't rotate
    refresh tokens, and Microsoft doesn't revoke the old one when it rotates
    ([refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)).
  - The engine (one tab, under its Web Lock) and the UI tab's `checkBackend` or `describeBackend` share
    this path.
- **Refresh outcomes:**

  | Outcome | Result |
  | --- | --- |
  | 200 | Store the token (`expiresAt = now + expires_in·1000`; keep the old refresh token unless a new one came) |
  | 400/401 `invalid_grant` (expired, revoked, testing-mode expiry, password reset by an admin) | `BackendError('reauth')` |
  | `invalid_client`, `unauthorized_client`, Worker 503 `not_configured` | `BackendError('unknown', providerCode:'OAuthConfig')`. Wording: "Sign-in for Google Drive isn't set up correctly on this site." |
  | Network error, Worker 502 | `network` |

- **Revocation on "Stop syncing":**
  - Dropbox: `POST https://api.dropboxapi.com/2/auth/token/revoke`. It disables that refresh token only
    ([auth.stone `token/revoke`](https://github.com/dropbox/dropbox-api-spec/blob/master/auth.stone)).
  - Google: **don't** call `oauth2.googleapis.com/revoke`. It removes the app's grant for the account,
    which would sign out every other device. Delete the tokens locally.
  - Microsoft: has no per-token revoke for this flow. Delete locally.
  - The leave dialog links to the account pages to disconnect the app on all devices:
    `https://www.dropbox.com/account/connected_apps`, `https://myaccount.google.com/connections`,
    `https://account.live.com/consent/Manage` (personal) or `https://myapps.microsoft.com` (work).

**Lifetimes:**

| | Access token | Refresh token |
| --- | --- | --- |
| Dropbox | Short-lived; `expires_in` is 14400 (4 h) at the time of writing. Always use `expires_in`. ([OAuth guide](https://developers.dropbox.com/oauth-guide)) | Long-lived; ends when the user unlinks the app or we revoke it |
| Google | 1 h | **7 days while the consent screen is in "Testing"** (only name, email and profile scopes are exempt; drive.file isn't). In production: until revoked, or unused for 6 months. 100 per account and client. ([OAuth 2.0 §expiration](https://developers.google.com/identity/protocols/oauth2#expiration)) |
| Microsoft | 60–90 min | **90 days, renewed on every use** for confidential (Web platform) clients. Only **24 h** for redirect URIs registered as `spa`, renewable only by a new interactive sign-in. That's why the redirect URI is registered as **Web** and redeemed by the Worker. ([refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)) |

**What "Testing" means for the user:** while the Google app is in Testing, only listed test users (up to
100) can sign in, and every device has to sign in to Google again every 7 days. The banner says "Sign in to
Google Drive again to keep syncing", and nothing is lost meanwhile: changes queue locally. Fine for
development, unacceptable for anyone else, so the app must be published (§10.2).

### 5.5 Sign-in errors in the UI

| `SignInErrorCode` | Message | Action |
| --- | --- | --- |
| `denied` | "Sign-in was cancelled." | Try again |
| `expired` | "That sign-in took too long or was started elsewhere. Please try again." | Try again |
| `scope` | "OpenStand needs access to its own files in {Provider}. Sign in again and allow it." | Sign in again |
| `wrongAccount` | "You signed in as {got}, but this library is in {want}." | Sign in with another account (`chooseAccount: true`) |
| `exchange` | "{Provider} didn't accept the sign-in. Please try again." | Try again |
| `notConfigured` | "Sign-in with {Provider} isn't available on this site." | none |
| `network` | "Can't reach {Provider}. Check your connection." | Try again |

---

## 6. Worker token route (`worker/oauth.ts`)

### 6.1 API

```
GET  /api/oauth/providers
  200 { "v": 1, "providers": { "gdrive"?: { "clientId": string }, "onedrive"?: { "clientId": string } } }
      (only providers with both the client id var and the secret set)

POST /api/oauth/{gdrive|onedrive}/token
  Content-Type: application/json; body ≤ 16 KiB
  { "grant": "code", "code": string, "code_verifier": string, "redirect_uri": string }
  { "grant": "refresh", "refresh_token": string }

  200 { access_token, token_type, expires_in, refresh_token?, scope?, id_token? }   (only these fields)
  4xx from the provider → same status, { error, error_description? }   (description ≤ 300 chars)
```

Errors from the route itself, all `{error, error_description?}` JSON:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Bad JSON, unknown `grant`, a missing field, or a field over its limit: `code` 1–4096 chars, `code_verifier` 43–128 chars of `[A-Za-z0-9._~-]`, `refresh_token` 1–8192 chars, no extra fields |
| 400 | `invalid_redirect_uri` | `redirect_uri !== origin + '/oauth/callback'`, where `origin` is the request's (already allowed) `Origin` |
| 403 | `origin_not_allowed` | `Origin` missing or not allowed |
| 404 | `not_found` | Unknown provider or path |
| 405 | `method_not_allowed` | Any method other than GET on `/providers`, POST or OPTIONS on `/token` |
| 413 | `too_large` | `Content-Length` > 16384, or the streamed body passes 16384 bytes |
| 415 | `unsupported_media_type` | Not `application/json` |
| 429 | `rate_limited` | Rate limit hit; `Retry-After: 60` |
| 502 | `upstream_unavailable` | Provider 5xx, a non-JSON answer, or no answer within 10 s |
| 503 | `not_configured` | The client id var or the secret is missing |

### 6.2 Behaviour

1. **Order of checks:** method → provider known → configured → Origin → rate limit → content type → size
   → JSON → fields → redirect URI → upstream.
2. **Allowed origins** = the Worker's own `url.origin` plus `ALLOWED_ORIGINS` (comma-separated). Unlike the
   relay, an **empty `ALLOWED_ORIGINS` means "own origin only"**, never "any".
3. **CORS:** same-origin calls need none. For another allowed origin, answer the preflight (`POST`,
   `content-type`, max-age 600) and echo `Access-Control-Allow-Origin` with `Vary: Origin`. Never `*`. Don't
   use the relay's `json()` helper, which sends `*`.
4. **Response headers:** `Cache-Control: no-store`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `Content-Type: application/json`.
5. **Upstream request:** a fresh `Request` with only `Content-Type: application/x-www-form-urlencoded` and
   `Accept: application/json`. **Never forward `Origin`, cookies or other client headers.** Microsoft
   refuses Web-platform codes redeemed with an `Origin` header, since cross-origin redemption is reserved for
   the `spa` type ([auth code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)).

   | | Google `https://oauth2.googleapis.com/token` | Microsoft `https://login.microsoftonline.com/common/oauth2/v2.0/token` |
   | --- | --- | --- |
   | code | `grant_type=authorization_code, code, code_verifier, redirect_uri, client_id, client_secret` | the same plus `scope=offline_access openid profile email Files.ReadWrite.AppFolder` |
   | refresh | `grant_type=refresh_token, refresh_token, client_id, client_secret` | the same plus that `scope` |

6. **Abuse limits.**
   - Cloudflare rate-limit binding `OAUTH_LIMITER`: 30 requests per 60 s per key
     `${cf-connecting-ip}:${provider}`. Counts are per location and eventually consistent
     ([rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/));
     good enough against floods. A device makes about one refresh per hour per provider.
   - Size caps (above), a 10 s upstream timeout, and no retries.
7. **Logging:** none of request or response bodies, tokens, codes or query strings. At most
   `console.log(provider, grant, upstreamStatus, errorCode)`. `observability` stays on.
8. **Stores nothing.** No KV, no Durable Object, no cache.

**Residual risk (documented).** `Origin` can be forged outside browsers, so anyone can make the Worker
redeem a code or refresh a token *they already hold* for our client id. They can't obtain codes for other
users: the codes are delivered only to our `/oauth/callback` and are bound to a PKCE verifier. A stolen
refresh token for Dropbox works without us anyway (public client). The rate limit stops bulk use.

### 6.3 Wiring

- `worker/index.ts`: `if (url.pathname.startsWith('/api/oauth/')) return handleOAuth(request, env)`, before
  the relay branch; the existing `env.ASSETS.fetch` fallback stays for everything else.
- `wrangler.jsonc`:
  - `run_worker_first: ["/relay", "/relay/*", "/api/*"]`;
  - vars `GDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_ID` (public; `""` = off);
  - `"ratelimits": [{ "name": "OAUTH_LIMITER", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } }]`.

  Then `npm run cf:typegen`.
- Secrets: `npx wrangler secret put GDRIVE_CLIENT_SECRET`, `npx wrangler secret put ONEDRIVE_CLIENT_SECRET`.
- Local dev: `.dev.vars` (already gitignored) with `ALLOWED_ORIGINS=http://localhost:5317`, both client ids
  and both secrets. Run `npm run cf:dev` (port 8787). `vite.config.ts` gets
  `'/api': { target: process.env.OPENSTAND_API ?? 'http://127.0.0.1:8787' }`.
- `vite.config.ts` workbox: add `/^\/api\//` to `navigateFallbackDenylist`. **Leave `/oauth/callback` on
  the navigate fallback**: the app shell *is* the callback handler, and serving the cached `index.html`
  keeps the query string in `location`. Workbox routes don't match POST, so the token calls always reach the
  network.
- The Node relay (`server/relay.mjs`) gets **no** OAuth route. On Node-hosted or static deployments
  `/api/oauth/providers` fails, so Google Drive and OneDrive are hidden; Dropbox works anywhere.

### 6.4 How the app decides what to offer

`oauthProviders()` returns:

- `dropbox` when `oauthClientId('dropbox')` is set;
- `gdrive` and `onedrive` when their client id is set **and** `GET /api/oauth/providers` (cached for the
  session; 5 s timeout) lists them with the same client id.

The storage step shows exactly these, plus S3.

### 6.5 Self-hosting

1. Register your own apps (§10) with **your** origin's `/oauth/callback`.
2. Build with `VITE_DROPBOX_CLIENT_ID`, `VITE_GDRIVE_CLIENT_ID` and `VITE_ONEDRIVE_CLIENT_ID` set (in
   `.env.local`, or in CI); `off` hides a provider. Optionally set `VITE_DROPBOX_APP_FOLDER`.
3. In `wrangler.jsonc` set `GDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_ID` and `ALLOWED_ORIGINS`, and add both
   secrets with `wrangler secret put`.
4. Without the Worker (static hosting), only Dropbox and S3 are offered.

---

## 7. UI (WP-U)

### 7.1 Setup wizard

Steps become `storage → (s3: form | drive: signin) → check → start → pair`.

1. **Storage.**
   - Large radio cards: **S3-compatible** (existing chips), **Dropbox**, **Google Drive**, **OneDrive**.
     Only those `oauthProviders()` returns are shown.
   - Card text: "Uses your {Provider} account. OpenStand gets its own folder and can't see your other
     files."
2. **Sign in.**
   - Explanation, per provider:
     - "OpenStand will ask {Provider} for access to one folder only: **{location}**." The locations are
       Dropbox › Apps › OpenStand, Google Drive › OpenStand, and OneDrive › Apps › OpenStand.
     - "Everything in it is encrypted on this device first; {Provider} can't read your music."
     - "Each of your devices signs in by itself. OpenStand has no servers that see your account."
   - A [Privacy](/privacy) link (new tab).
   - Primary button **Sign in with Dropbox / Google / Microsoft** (44 px, no brand logos). Google's
     branding guidelines apply if its "G" logo is ever used
     ([branding](https://developers.google.com/identity/branding-guidelines)).
   - Dropbox only: "If you use the Dropbox desktop app, it will also download this folder to your
     computers. You can exclude *Apps/OpenStand* with Selective Sync." (The same applies to OneDrive
     without Files On-Demand; Google Drive for desktop streams by default.)
3. **Check** (resumed after the redirect).
   - Header card: "Signed in as **rod@example.com**", "Your library will live in **Dropbox › Apps ›
     OpenStand**" with an "Open folder" link (`describe().openUrl`), and free space if known.
   - Link "Use a different account" → `startSignIn(kind, {type:'setup'}, {chooseAccount: true})`.
   - The connection test runs automatically. The S3-only steps (`cors`, `etag`) aren't shown. Step labels
     per kind: `auth` "Signed in to {Provider}", `list` "Open the OpenStand folder".
4. **Start** and **pair**: unchanged. The pairing code now carries `{kind, root|folder, account,
   accountId}`.

### 7.2 Join from a QR (second device)

1. Scan or paste.
2. For an OAuth kind, the new **sign-in step**:
   - "This library is stored in **{Provider}** ({account})."
   - "Sign in with {Provider} using **the same account**."
   - Button → `startSignIn(kind, {type:'join', pairing: code}, {loginHint: account})`.
3. Back from the redirect, JoinFlow reopens with the stored code at the sign-in step's success state:
   "Signed in as …".
4. If `accountId` and `b.accountId` are both present and differ → a warning note: "This code is for
   {want}, but you signed in as {got}." with buttons **Sign in with another account** (`chooseAccount`) and
   **Continue anyway**.
5. Preview → mode → progress, as today.

### 7.3 Account-mismatch detection

There are three layers:

1. **Before reading anything:** compare `b.accountId` from the pairing code with the signed-in account.
   This is a hint: emails and aliases change, so the user can continue.
2. **Authoritative:** in `openPairing`, for OAuth kinds:
   - Dropbox and OneDrive: `meta` 404;
   - Drive: `files.get(folder)` 404, or `meta` 404 inside it.

   Either raises `SyncError('wrongAccount', detail: hint)` instead of `libraryGone`. Wording: "This library
   isn't in the {Provider} account you signed in with ({got}). The code was made for {want}. Sign in with
   that account, or get a new code if the library was deleted." Actions: **Sign in with another account**
   and **Scan another code**.
3. **Re-auth:** `completeSignIn` for `{type:'reauth'}` refuses a different `accountId` (`wrongAccount`) and
   keeps the old tokens. Without this, signing in as the wrong account would make the engine see `meta`
   404 and report `libraryGone`.

### 7.4 Settings when syncing through a drive

- The storage row reads "Dropbox · rod@example.com" with "Open folder". **Update storage keys** is replaced
  by **Sign in again** (`reauth`).
- New error codes:

  | Code | Message | Action |
  | --- | --- | --- |
  | `reauth` | "Sign in to {Provider} again to keep syncing. Your changes are kept on this device until then." | Sign in again |
  | `wrongAccount` | as in §7.3 | Sign in with another account |
  | `auth`/`forbidden` on an OAuth kind | "{Provider} refused access to the OpenStand folder." | Sign in again |
  | `quota` | "Your {Provider} storage is full." | Open {Provider} |

- The indicator popover shows the `reauth` action too.
- Mock states for development: `?libsyncMock=drive-signin`, `drive-check`, `drive-reauth`,
  `drive-wrongaccount`.

---

## 8. Error mapping summary (to the existing codes)

| Situation | BackendError | LibSyncErrorCode | Engine |
| --- | --- | --- | --- |
| No tokens, `invalid_grant`, revoked consent, a scope missing, 401 after refresh | `reauth` *(new)* | `reauth` *(new)* | FATAL: stop until `completeSignIn` stores tokens, then `svc.restart()` |
| Account doesn't hold the library (join, reauth) | — | `wrongAccount` *(new)* | FATAL (join or re-auth only) |
| Expired access token | handled inside `OAuthHttp` | — | — |
| 403 by policy (tenant, app not authorised for a file) | `forbidden` | `auth`, with OAuth wording | retry with backoff, as today |
| Provider rate limit | `rateLimited` (+ `retryAfterMs`) | — | Back off ≥ `retryAfterMs`; phase stays `syncing` or `idle`, **not** `offline` (change in `toSyncError` and the retry timer) |
| Full drive | `quota` | `quota` | as today |
| Conflict on a conditional create | `precondition` | `rejoin` (log only) | as today |
| Worker misconfigured | `unknown` (`OAuthConfig`) | `unknown` with the §5.4 wording | backoff |

`blobs.ts` treats `reauth` as fatal for the transfer, like `auth` today.

---

## 9. Testing

### 9.1 Fakes (no accounts, in the normal `npm test` run)

The fakes run in-process as a `fetch` passed through `BackendContext.fetch`: no sockets, deterministic,
`// @vitest-environment node`. `fakes/harness.ts` (step 0) provides:

```ts
export class FakeServer {
  readonly fetch: typeof fetch                   // routes by method + URL; unknown routes → 404 and a test failure
  readonly calls: { method: string; url: string; headers: Record<string, string> }[]
  fail(f: { method?: string; path?: RegExp | string; times?: number; after?: boolean
            respond?: { status: number; json?: unknown; text?: string; headers?: Record<string, string> }
            network?: boolean }): () => void   // `after`: the op takes effect, then the response is lost
  auth(): FakeAuth   // AccessTokenSource: issues "tok-1", "tok-2", …; the server accepts only the current one
}
export interface FakeAuth extends AccessTokenSource {
  expireNow(): void   // the current token gets 401 next time
  revoke(): void      // refresh throws BackendError('reauth')
  refreshes: number
}
```

Every fake must **enforce** its provider's rules, so a wrong request fails in tests rather than in
production:

| Fake | Enforces | Also simulates |
| --- | --- | --- |
| `dropbox.fake.ts` | `Authorization` on every call; `Dropbox-API-Arg` is ASCII JSON; `mode`/`autorename`/`strict_conflict` semantics including identical-content add; case-insensitive paths with `path_lower`; `list_folder` paging (page size option, default 2000) in a **shuffled** order; Range → 206; `incorrect_offset` with `correct_offset`; sessions closed after finish; 7-day session expiry (clock option) | 409 conflict and `insufficient_space`; 429 with `retry_after`; `expired_access_token` 401; write lag option |
| `gdrive.fake.ts` | Bearer auth; `q` grammar subset (`in parents`, `name =`, `appProperties has {…}`, `trashed`, `and`, escaping); pageToken paging; multipart and resumable rules (256 KiB multiples except the last, `Content-Range`, 308 + `Range`, `bytes */size` status, 404 after expiry); duplicate names **allowed**; `version` increments | **Query index lag** (`indexLag: n` = new or deleted files stay invisible to queries for the next n list calls); 403 `userRateLimitExceeded`, `storageQuotaExceeded`; `Location` hidden (to test the `X-GUploader-UploadID` fallback) |
| `graph.fake.ts` | Bearer on Graph URLs and **no** `Authorization` on `uploadUrl`/`downloadUrl` (401 if present); fragments multiple of 327,680 B except the last, at most 60 MiB, in order; `conflictBehavior`; path addressing under approot; `children` paging (200 per page); `downloadUrl` that expires after N uses; `permanentDelete` availability switch | 429/503 + `Retry-After`; 507; 416 on a repeated fragment; parent folders not auto-created (switch) |

Test files (one per backend WP):

- `backendContract('<kind> (fake)', make)` with small chunks: Dropbox 64 KiB with `maxSmallPut` 128 KiB;
  Drive 256 KiB / 512 KiB; Graph 320 KiB / 640 KiB, so the resume test covers at least 3 parts.
- A **fault matrix** for each op: injected `network` before and after the op takes effect, 401 → refresh →
  success (exactly one refresh), revoked → `reauth`, 429 → `rateLimited` with the right `retryAfterMs`, 5xx →
  `server`, quota → `quota`.
- Upload resume where the **response was lost after the server stored the chunk** (`after: true`): the
  next run must not read that chunk again (server offset wins).
- Drive only:
  - duplicates: two backends on one fake create the same key concurrently, and every reader picks the same
    canonical file;
  - the loser's dedupe deletes only its own copy;
  - `ifNoneMatch` under a race gives exactly one success;
  - reads stay correct with `indexLag: 3` for our own writes (cache);
  - another instance's reads hold back and then succeed.
- OneDrive only: the `deep3` round trip; `list('os1/')` walks subfolders; heads polling is one request
  (assert `calls.length`).
- `keymap.test.ts`: round trips, rejected keys, `prefixScope` table.
- `worker/oauth.test.ts`: calls `handleOAuth(req, env, fakeUpstream)` directly with every row of the §6.1
  table, checks that `Origin` isn't forwarded, that only the whitelisted fields come back, that nothing is
  logged (spy on `console`), and that the upstream bodies are exact.
- `oauth/*.test.ts`:
  - PKCE vectors (RFC 7636 appendix B);
  - state mismatch and expiry;
  - the callback writes `ret` and replaces the URL;
  - `completeSignIn` against fake token and identity endpoints for all three;
  - the scope check;
  - `wrongAccount` on reauth;
  - the token source: expiry lead time, single flight, cross-"tab" re-read (two sources on one DB), refresh
    rotation for Microsoft.
- Engine integration: the two-device flow from `flows.test.ts` on top of each fake, instead of `MemoryBackend`
  (one parameterised test).

### 9.2 UI

testing-library on the wizard's drive steps, JoinFlow's sign-in step and mismatch warning, and the new error
banners, using mocks (`?libsyncMock=drive-*`). Manual pass in the preview browser: light and dark, phone
width, keyboard.

### 9.3 Opt-in real-account script (the user runs it later)

`src/libsync/e2e/drives.e2e.test.ts`. It is skipped unless `LIBSYNC_DRIVE_TOKENS` points to a JSON file
(default name `.e2e-tokens.json`; add `.e2e-tokens*.json` to `.gitignore`):

```json
{ "dropbox":  { "clientId": "…", "refreshToken": "…" },
  "gdrive":   { "clientId": "…", "clientSecret": "…", "refreshToken": "…", "refreshTokenB": "…" },
  "onedrive": { "clientId": "…", "clientSecret": "…", "refreshToken": "…", "work": { "refreshToken": "…" } } }
```

- **Getting tokens:** in the dev app on `http://localhost:5317`, sign in, then run
  `await openstandDev.exportOAuthTokens()` in the console. It's a dev-only global (`import.meta.env.DEV`,
  added by WP-O) that prints `{kind, clientId, refreshToken}` for the active library. Client secrets come
  from `.dev.vars`. The file is never committed; the script never prints tokens.
- **Refreshing:** the script refreshes directly against the provider token endpoints (Node has no CORS)
  and builds the real backends with a Node `AccessTokenSource`.
- **Run:** `LIBSYNC_DRIVE_TOKENS=.e2e-tokens.json npx vitest run src/libsync/e2e/drives.e2e.test.ts`.

| Test | What |
| --- | --- |
| C-1 | `backendContract` against each real backend in a scratch library prefix, `largeSize = 3 × chunk + 7`, timeout 120 s |
| X-1 | Consistency probe: 50 × (create a key, then immediately list its prefix and resolve it by name/path); report misses and the worst lag |
| G-2 | Drive cross-device visibility: token A creates the root folder and a file; token B (a separate sign-in in another browser profile, same account) finds the folder by marker, reads the file, and sees its `appProperties` |
| M-2 | OneDrive work/school (if `work` is present): approot access with AppFolder, `permanentDelete`, `downloadUrl` with Range, path PUT creating parents |
| D-2 | Dropbox `strict_conflict` on identical content gives 409 |
| All | Rate-limit smoke: 20 parallel small PUTs; expect success or `rateLimited` with a hint, never another error |

Browser-only checks (CORS on the Drive upload `Location`/`Range` and the 308 under fetch, the SharePoint
downloadUrl, iOS and Android installed-PWA redirects) follow a manual checklist in the same file's header
comment, done on `http://localhost:5317` and once on production.

---

## 10. Registering the apps (for the README or a docs page)

Use these values everywhere:

- Production origin `https://openstand.rodlabs.dev`, redirect `https://openstand.rodlabs.dev/oauth/callback`.
- Development origin `http://localhost:5317`, redirect `http://localhost:5317/oauth/callback`. Use
  `localhost`, not `127.0.0.1`.
- Privacy policy `https://openstand.rodlabs.dev/privacy`, homepage `https://openstand.rodlabs.dev`.

### 10.1 Dropbox

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. Choose **Scoped access** → **App folder** → name it **OpenStand**. Names are unique across Dropbox; if
   it's taken use e.g. "OpenStand Sync", and keep the app folder name "OpenStand" in step 4.
3. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write`
   (`account_info.read` is already ticked) → **Submit**.
4. **Settings** tab:
   - **App folder name**: `OpenStand`.
   - **OAuth 2 → Redirect URIs**: add both redirect URIs above.
   - **Allow public clients (Implicit Grant & PKCE)**: **Allow**.
   - Copy the **App key**: it's the client id; put it in `oauth/config.ts` (`OFFICIAL.dropbox`). The App
     secret is **not** used. Don't put it anywhere.
5. **Branding** tab: app name, a short description, an icon, and the website `https://openstand.rodlabs.dev`.
6. **Users:** a new app is in *Development* and only works for your account. Use **Enable additional users**
   (Settings) for up to 500 users. Once 50 users have linked it, you have two weeks to **Apply for
   production** ([developer guide](https://www.dropbox.com/developers/reference/developer-guide)).

### 10.2 Google Drive

1. In the [Google Cloud console](https://console.cloud.google.com/) create a project **OpenStand**.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding:** app name `OpenStand`, user support email, app home page
     `https://openstand.rodlabs.dev`, privacy policy `https://openstand.rodlabs.dev/privacy`, authorised
     domain `rodlabs.dev`. A logo is optional, and adding one requires brand verification before it's
     shown.
   - **Audience:** User type **External**. While it says *Testing*, add yourself (and anyone testing)
     under **Test users**.
   - **Data access → Add or remove scopes:** add `https://www.googleapis.com/auth/drive.file` ("See,
     edit, create and delete only the specific Google Drive files you use with this app"). It is listed as
     non-sensitive. Add nothing else.
   - **Clients → Create client:** type **Web application**, name `OpenStand web`.
     - Authorised JavaScript origins: both origins above.
     - Authorised redirect URIs: both redirect URIs above.
     - Create. Copy the **Client ID** → `oauth/config.ts` (`OFFICIAL.gdrive`) and the `GDRIVE_CLIENT_ID`
       var in `wrangler.jsonc`. Copy the **Client secret** → `npx wrangler secret put GDRIVE_CLIENT_SECRET`
       (and into `.dev.vars` for local dev).
4. **Publishing:**
   - In *Testing*, refresh tokens expire after **7 days**: every device must sign in again weekly, and only
     test users can sign in.
   - Before anyone else uses it: **Audience → Publish app** (to *In production*). With only `drive.file`
     there is no sensitive-scope review.
   - Google still asks apps to complete **brand verification** (verify `rodlabs.dev` in
     [Search Console](https://search.google.com/search-console); homepage and privacy policy reachable)
     before the app name and logo are shown on the consent screen
     ([verification requirements](https://support.google.com/cloud/answer/13464321)).
5. **Never change the client id afterwards:** libraries already in Drive are only visible to the client id
   that created them (§4.3).
6. Google Workspace accounts can be blocked by their admin's third-party-app policy. That's a per-domain
   setting outside our control.

### 10.3 Microsoft OneDrive

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/) → **App registrations → New
   registration**:
   - Name: **OpenStand**. This becomes the folder name `Apps/OpenStand`
     ([app folder](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)).
   - Supported account types: **Accounts in any organizational directory and personal Microsoft
     accounts**.
   - Redirect URI: platform **Web**, `https://openstand.rodlabs.dev/oauth/callback`.
2. **Authentication:** under the *Web* platform, add `http://localhost:5317/oauth/callback`. **Don't add a
   "Single-page application" platform:** SPA refresh tokens last 24 h and can't be redeemed by the Worker.
   Leave implicit grant (access/ID tokens) **off**.
3. **Certificates & secrets → New client secret**, 24 months (the maximum). Copy the **Value** →
   `npx wrangler secret put ONEDRIVE_CLIENT_SECRET` (and `.dev.vars`). Set a reminder: when it expires,
   every OneDrive sign-in and refresh fails ("Sign-in for OneDrive isn't set up correctly on this site").
   Create a new secret, `wrangler secret put` it, then delete the old one.
4. **API permissions → Add a permission → Microsoft Graph → Delegated:** `Files.ReadWrite.AppFolder`,
   `offline_access`, `openid`, `profile`, `email`. (The default `User.Read` can stay; the app doesn't request
   it at sign-in.) Don't grant admin consent for your tenant unless you want to.
5. **Overview:** copy the **Application (client) ID** → `oauth/config.ts` (`OFFICIAL.onedrive`) and the
   `ONEDRIVE_CLIENT_ID` var.
6. **Branding & properties:** home page `https://openstand.rodlabs.dev`, privacy statement
   `https://openstand.rodlabs.dev/privacy`, logo optional.
7. Work or school accounts:
   - Some organisations only allow apps from verified publishers, or none, and then an admin must approve
     ([user consent settings](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent)).
     Publisher verification needs a Microsoft AI Cloud Partner Program account; it isn't needed for
     personal accounts.
   - Microsoft's docs disagree on whether `Files.ReadWrite.AppFolder` works for work/school accounts: the
     [permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#filesreadwriteappfolder)
     lists it for personal accounts, while the [app folder guide](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)
     says it works for both. Test M-2 (§9.3) settles it.

### 10.4 Deploying

```bash
npx wrangler secret put GDRIVE_CLIENT_SECRET
npx wrangler secret put ONEDRIVE_CLIENT_SECRET
# wrangler.jsonc vars: GDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_ID (public), ALLOWED_ORIGINS
npm run deploy
curl https://openstand.rodlabs.dev/api/oauth/providers   # lists gdrive and onedrive with their client ids
```

---

## 11. Work breakdown

**Step 0 (lead, about 2 h).** Contracts and skeletons; everything compiles, and the stubs throw
"not implemented".

| File | Change |
| --- | --- |
| `src/libsync/backends/types.ts` | §2.1 additive edits |
| `src/libsync/api.ts` | §2.2 types and stubs; `LibSyncStatus.backendKind` |
| `src/libsync/oauth/types.ts`, `oauth/config.ts` | §2.3, §2.4 (official ids empty until §10 is done) |
| `src/libsync/oauth/callback.ts` | Full implementation (≈ 40 lines, §5.2): it's tiny, and `main.tsx` imports it statically |
| `src/main.tsx` | `if (location.pathname === '/oauth/callback') handleOAuthCallback()` before `createRoot` |
| `src/libsync/backends/keymap.ts` + test, `backends/http.ts` + test, `backends/fakes/harness.ts` | §2.5 |
| `src/libsync/backends/{dropbox,gdrive,onedrive}.ts` | Stub classes implementing `StorageBackend` (constructor `(cfg, ctx, opts?)`) |
| `src/libsync/backends/index.ts` | `createBackend` builds them, passing `ctx.auth` |
| `src/libsync/pairing.ts` (+ test) | Accept and keep optional `account` (≤ 320) and `accountId` (≤ 200) strings; gdrive `folder` must be non-empty and match `[A-Za-z0-9_-]{10,200}` |
| `worker/oauth.ts` | `handleOAuth` stub answering 501 |
| `worker/index.ts`, `wrangler.jsonc`, `worker-configuration.d.ts` | §6.3 routing, vars, ratelimits, typegen |
| `vite.config.ts` | `/api` dev proxy, `navigateFallbackDenylist` |
| `.gitignore` | `.e2e-tokens*.json` |
| `docs/SYNC.md` | Pointer to this file (done with this spec) |

**Parallel work packages** (each owns exactly its files; small additive edits elsewhere only as listed):

| WP | Owns | Builds against | Done when |
| --- | --- | --- | --- |
| **WP-D Dropbox** | `backends/dropbox.ts`, `backends/dropbox.test.ts`, `backends/fakes/dropbox.fake.ts` | `types.ts`, `http.ts`, `harness.ts` | Contract and fault matrix green on the fake |
| **WP-G Google Drive** | `backends/gdrive.ts` (incl. `ensureRootFolder`), `backends/gdrive.test.ts`, `backends/fakes/gdrive.fake.ts` | same, plus `keymap.dirProps` | Contract, fault matrix, duplicates and lag tests green |
| **WP-M OneDrive** | `backends/onedrive.ts`, `backends/onedrive.test.ts`, `backends/fakes/graph.fake.ts` | same, plus `keymap.deep3` | Contract, fault matrix, one-request heads poll green |
| **WP-O OAuth core** | `oauth/pkce.ts`, `oauth/providers.ts`, `oauth/flow.ts`, `oauth/tokens.ts` + tests; `worker/oauth.ts` + `worker/oauth.test.ts`; `api.ts` (replace the new stubs; `checkBackend`/`describeBackend` pass `auth`; `joinSync` copies tokens; cancel cleanup); **small edits** in `engine.ts` (`createBackend(…, {now, auth})`, `toSyncError` + MESSAGES for `reauth`/`wrongAccount`, FATAL, `rateLimited` not offline, honour `retryAfterMs`), `join.ts` (`backendFor` with `auth`; `wrongAccount` in `openPairing`; Dropbox revoke in `leave`), `blobs.ts` (`reauth` fatal), `service.ts` (restart after a token store); the dev-only `openstandDev.exportOAuthTokens()` | `oauth/types.ts`, the WP-G `ensureRootFolder` signature (stub until WP-G lands) | Unit tests green; manual sign-in round trip on localhost with all three |
| **WP-U UI** | `ui/SetupWizard.tsx`, `ui/wizard.ts`, `ui/JoinFlow.tsx`, `ui/joinState.ts`, `ui/LibrarySyncSettings.tsx`, `ui/format.ts`, `ui/mock.ts`, new `ui/DriveSignIn.tsx` + tests | `api.ts` stubs and mocks | All §7 screens via mocks, in light and dark, phone and desktop |

**Integration order:**

1. Step 0 merges.
2. WP-D, WP-G, WP-M, WP-O and WP-U run in parallel. The backends test only against fakes and the fake token
   source; WP-O tests against fake provider endpoints; WP-U against mocks.
3. Merge the backends as soon as their suites pass (they don't depend on each other). Then WP-O, and replace
   the `ensureRootFolder` stub.
4. Wire WP-U to the real `api.ts`. Run the engine-integration test on all three fakes.
5. The user fills in `OFFICIAL` client ids and `.dev.vars` (§10), then does manual dev runs on
   `http://localhost:5317` with real accounts, plus the browser checklist.
6. `drives.e2e.test.ts` (C-1, X-1, G-2, M-2, D-2). Fix what it finds; decide on the §4.4 engine retry from X-1.
7. Deploy: secrets, vars, publish the Google app, enable Dropbox users. Docs: README "Library sync"
   section (§10 condensed) and the `docs/FEATURES.md` row.

---

## 12. Open questions (with recommendations)

1. **OneDrive for work/school accounts.** The docs conflict on `Files.ReadWrite.AppFolder` for work/school,
   and many tenants require admin approval for unverified multi-tenant apps. *Recommendation:* keep
   `common` and run M-2 with a work account. If AppFolder doesn't work there, show "Work or school
   OneDrive isn't supported yet; use a personal Microsoft account" rather than widening the scope to
   `Files.ReadWrite` (all of OneDrive).
2. **Google publishing and brand verification.** *Recommendation:*
   - Develop in Testing.
   - Before announcing Drive support, verify `rodlabs.dev` in Search Console, make sure `/privacy` is live,
     publish to production, and submit brand verification. Start without a logo so a review isn't
     blocking.
3. **The listing-lag fallback in the engine (§4.4).** *Recommendation:* don't build it now. Decide from the
   X-1 measurements; it's a 10-line change if Drive misses.
4. **Drive layout: flat (one folder, file name = full key) vs. a subfolder per library.** Flat makes Drive's
   folder view a long list of `os1/…` names. *Recommendation:* flat. It avoids every duplicate-folder race
   and needs no folder ids per library. The folder description tells people not to edit it.
5. **Tokens per library DB (as `model.ts` has it) vs. one device-wide token store.** Per-library means
   signing in once per synced library on each device. *Recommendation:* per library, as specified: it
   matches the existing model, keeps leave/reset local to one library, and multiple synced libraries on one
   device are rare. The `newLibrary` join copies the tokens.
6. **Email and account id in the pairing code.** They add PII to the QR, which already holds the library
   secret. *Recommendation:* include both. They make "same account" instructions and mismatch detection
   concrete, and the code is shown only on demand and hides after 2 minutes.
7. **Disconnect on "Stop syncing".** *Recommendation:* revoke only the Dropbox token, since Google's
   revoke would sign out all devices. Link to each provider's connected-apps page for a full disconnect.
8. **OAuth on Node or static self-hosting.** *Recommendation:* Cloudflare-only for Google and OneDrive
   (they're hidden elsewhere). Dropbox works everywhere. Revisit if someone asks.
