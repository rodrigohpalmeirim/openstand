# Library sync: implementation spec

Status: phase 1 (S3-compatible storage) implemented, wire format **v2** (§4.4). Read `AGENTS.md` first.

Library sync keeps a whole library (songs, files, annotations, setlists, layers) identical on all of a
user's devices. There are no accounts: the user brings their own storage. Everything is end-to-end
encrypted, and every device keeps a full offline copy. It is separate from the existing **performance
sync** (`src/sync/`, leader/follower page turns), which stays unchanged. The only thing the two share is
the relay.

Decisions already made by the user, restated so they aren't reopened:

- Storage backends: S3-compatible in phase 1, Dropbox in phase 2, Google Drive and OneDrive in phase 3.
- Always end-to-end encrypted. A random library secret is turned into keys and ids with HKDF.
- Storage is append-only, and each device writes only its own keys.
- The relay sends instant notices; polling is the fallback.
- Merge: HLC timestamps, LWW per field, merge per element, tombstones.
- Devices pair with a QR code.

---

## 1. Module layout and ownership

New code goes in **`src/libsync/`**. `src/sync/` keeps meaning performance sync.

| Path | Purpose | WP |
| --- | --- | --- |
| `src/libsync/model.ts` | **Contract.** Wire and state types (§4, §6). Frozen after step 0. | 0 → 1 |
| `src/libsync/hlc.ts` | Hybrid logical clock | 1 |
| `src/libsync/hash.ts` | Canonical JSON and a fast 64-bit value hash (cyrb53-style), used for change detection | 1 |
| `src/libsync/fields.ts` | Per-collection field tables (§5), `syncedKv()`, validators | 1 |
| `src/libsync/merge.ts` | `project`, `diff`, `mergeDelta`, `materialize`, `rebase` (all pure) | 1 |
| `src/libsync/joinPlan.ts` | Pure merge plan for joining with a non-empty library (§10.3) | 1 |
| `src/libsync/crypto.ts` | HKDF derivation, sealed envelopes, chunked container, blob names, notices | 2 |
| `src/libsync/codec.ts` | Batch/snapshot encode and decode (gzip via `CompressionStream`, NDJSON streaming) | 2 |
| `src/libsync/paths.ts` | Storage key builders and parsers (§3) | 2 |
| `src/libsync/pairing.ts` | Pairing code encode, decode and validation (§11) | 2 |
| `src/libsync/backends/types.ts` | **Contract.** `StorageBackend`, configs, errors (§7). Frozen after step 0. | 0 → 2 |
| `src/libsync/backends/memory.ts` | In-memory backend with fault injection (all tests use it) | 2 |
| `src/libsync/backends/s3.ts` | S3 via `aws4fetch`: multipart, XML, `check()` | 2 |
| `src/libsync/backends/index.ts` | `createBackend(config, ctx)` factory | 2 |
| `src/libsync/backends/contract.test-helper.ts` | Reusable backend contract suite (memory, then MinIO) | 2 |
| `worker/index.ts`, `server/relay.mjs`, `server/relay-test.mjs` | Library-sync rooms (§9) | 2 |
| `src/db/db.ts` (edit) | `version(2)` tables, middleware install, `putBlob` id = hash, `MissingBlobError`, prune guard, `recordPlay` | 3 |
| `src/db/capture.ts` | DBCore capture middleware (§8.1). No libsync imports. | 3 |
| `src/libsync/state.ts` | Typed access to the `sync*` tables | 3 |
| `src/libsync/engine.ts` | Scheduler: capture → push, poll → pull → apply, maintenance, Web Lock | 3 |
| `src/libsync/apply.ts` | Apply remote deltas inside Dexie transactions | 3 |
| `src/libsync/blobs.ts` | Resumable upload/download queue, `useBlobState`, prioritising | 3 |
| `src/libsync/relay.ts` | Notice channel over `RelayTransport` | 3 |
| `src/libsync/join.ts` | Enable, join, leave, reset, repair flows | 3 |
| `src/libsync/api.ts` | **Contract.** Public facade for the UI (§12.1). Stubbed in step 0. | 0 → 3 |
| `src/libsync/service.ts` | `registerService`, library-switch handling. Side-effect import added to `src/modules.ts`. | 3 |
| `src/annotations/store.ts`, `src/annotations/history.ts` (edit) | Three-way flush, remote reload, rebasing undo (§8.5) | 3 |
| `src/library/editor/SongEditor.tsx`, `src/files/import.ts` (edit) | Save with rebase/latest-read (§8.4) | 3 |
| `src/library/browse/libraries.ts`, `src/library/browse/Welcome.tsx` (small edits) | Stop sync on delete; `isUntouchedDemo` | 3 |
| `src/libsync/ui/*` | Settings section, wizard, QR show/scan, indicator, pending placeholders (§12) | 4 |
| `src/settings/sections.tsx`, `src/library/browse/Sidebar.tsx`, `src/library/Thumb.tsx`, `src/backup/BackupSettings.tsx` (additive) | Wiring | 4 |
| `src/viewer/PageView.tsx`, `src/viewer/Viewer.tsx` | Pending placeholder and `recordPlay`. **Lead-owned:** WP4 or WP3 hands over a small patch. | lead |

New dependencies, installed once by the lead in step 0 (approval needed, see Q1):

| Package | Why | Size (min+gz) | Licence |
| --- | --- | --- | --- |
| `aws4fetch` | SigV4 signing with WebCrypto; supports `datetime` for clock-skew retries | ~3.5 KB | MIT |
| `lean-qr` | QR *generation* (canvas/SVG) | ~3.5 KB | MIT |
| `jsqr` | QR *decoding* where `BarcodeDetector` is missing (Safari, Firefox, desktop Chrome on Windows/Linux). Lazy-loaded, only when scanning. | ~46 KB | Apache-2.0 |

We hand-roll nothing for SigV4: canonical-URI and header encoding bugs are subtle, and aws4fetch is tiny,
maintained and widely used. Compression uses the native `CompressionStream('gzip')` (Safari 16.4+, Node 18+),
not fflate.

---

## 2. Keys, ids and secrets

```ts
secret      = crypto.getRandomValues(new Uint8Array(32))           // created on the first device
HKDF-SHA256(ikm = secret, salt = utf8("openstand-sync-v1"), info = label):
  libraryId = base32(deriveBits("library-id", 128))   // 26 chars [a-z2-7]; storage path segment
  roomId    = base32(deriveBits("room-id", 128))      // 26 chars; relay room. Independent HKDF output,
                                                      // so it can't be linked to the storage location.
  envKey[e]   = deriveKey("v2/envelope/" + e, AES-GCM-256)   // e = key epoch, 0 for now; meta, devices, batches, notices
  blobKey[e]  = deriveKey("v2/blob/" + e, AES-GCM-256)       // blob container chunks
  snapKey[e]  = deriveKey("v2/snapshot/" + e, AES-GCM-256)   // snapshot container chunks
  nonceKey[e] = deriveKey("v2/blob-nonce/" + e, HMAC-SHA-256) // content-derived blob chunk nonces (§4.2)
  nameKey     = deriveKey("blob-name", HMAC-SHA-256)          // blob object names
  v1Key       = deriveKey("enc-key/0", AES-GCM-256)           // decrypt only: recognises v1 objects (§4.4)
deviceId    = 16 lowercase hex chars (64 random bits). New on every join; never reused.
```

- base32 is RFC 4648, lowercase, without padding. Derived keys are non-extractable.
- **Key separation (v2).** Envelopes, blob chunks and snapshot chunks each have their own AES key, so the
  random nonces of envelopes and snapshots and the deterministic nonces of blobs never share a key. The
  salt and the `library-id`, `room-id` and `blob-name` labels are unchanged from v1, so storage paths, rooms
  and blob names didn't move.
- The raw secret is stored in `syncState.config.secret` (base64url), because pairing has to display it.
  It sits in the same trust domain as the library data in IndexedDB.
- **Blob object names use a keyed HMAC, not the plaintext hash:**
  `blobName = base32(HMAC(nameKey, hexToBytes(sha256)))` (52 chars). A plaintext SHA-256 would let the
  storage provider (or anyone with bucket access) confirm outright that a library holds a specific known
  file, and the names would match across libraries. The HMAC costs nothing and still deduplicates within a
  library. It does **not** hide sizes (next point).
- **What the storage provider (or anyone who can list the bucket) still sees.** Nothing is padded:
  - every blob's **exact plaintext size**: `ciphertextSize = size + 16 + 28 · ceil(size / 1 MiB)` is a
    fixed, public function of it;
  - the number of blobs, devices and snapshots, the size and count of every batch and snapshot, and the
    **timing** of every write (when a device is used, how much it changes, when files are added);
  - so the provider **can match known file sizes**: if a particular published PDF or recording has a
    distinctive size, an object of exactly that ciphertext size is strong evidence that the library holds
    it, and objects of the same size in different libraries are probably the same file. Encryption hides
    contents, titles, names and metadata, not sizes or activity patterns.

  What the relay sees: the room id, IP addresses and notice timing. Neither sees titles, file contents,
  annotations or song metadata.

**Key rotation (format-ready, not built).** Every ciphertext carries an epoch byte. A real rotation means
a stolen device knew the secret, so rotation is **"Reset sync"** (§10.5): a new secret gives a new
`libraryId` path and room, everything is re-uploaded, and the remaining devices pair again by QR.
Epoch > 0 is reserved for a future keyring (re-encrypting in place without changing location). The epoch
byte isn't authenticated on its own, so readers treat an unknown epoch as `corrupt` for that object (§4.4),
never as a format verdict.

---

## 3. Storage layout

All keys sit under the backend root (bucket + user prefix, default `openstand/`):

| Key | Writer | Body | Lifecycle |
| --- | --- | --- | --- |
| `os1/<libraryId>/meta` | creator | sealed `{v:1, createdAt, name}` | written once (`If-None-Match: *` where supported); used to check the key on join |
| `os1/<libraryId>/devices/<dev>` | owner | sealed `DeviceRecord` | owner overwrites it (on name change, at most daily, on retire) |
| `os1/<libraryId>/heads/<dev>/<seq10>` | owner | empty | written after every log entry; owner deletes older ones |
| `os1/<libraryId>/log/<dev>/<seq10>` | owner | sealed `Batch` | write-once; owner prunes (§3.2) |
| `os1/<libraryId>/snap/<dev>/<n10>` | owner | chunked container: gzip NDJSON snapshot | write-once; owner prunes |
| `os1/<libraryId>/blobs/<blobName>` | any device | chunked container (encrypted file) | write-once and idempotent (deterministic ciphertext); GC per §3.2 |

- `seq10` and `n10` are 10-digit zero-padded decimals starting at `0000000001`, so lexicographic order is
  numeric order.
- **Polling is one LIST of `heads/`**, which returns every device's latest seq in a single request. Only
  new `log/` keys are then fetched by GET.
- A batch's `log/` key is written *before* its `heads/` marker. Readers never see a head for a batch that
  doesn't exist yet: S3, R2, B2 and MinIO all give strong read-after-write consistency.
- `If-None-Match: *` is used on `log/`, `snap/` and `meta` when `caps.conditionalPut` is true. A `412` on
  `log/` means this deviceId was cloned or its state restored. Stop and show the `rejoin` error. Never
  overwrite.

```ts
interface DeviceRecord { v: 1; id: string; name: string; platform: string; appVersion: string; createdAt: number; lastSeenAt: number; retired?: boolean }
```

### 3.1 Snapshots

A snapshot is the device's full merged state after its own outbox has drained (`syncDirty` and
`syncOutbox` both empty, read in one read transaction):

- Line 1 is the header: `{v:1, kind:'snapshot', d, n, t, vector: Record<deviceId, seq>, records, hlcMax, horizon: {deadFields: number, elementTombs: number}}`.
- Each following line is one `RecordDelta` (§4) carrying **all** registers for that record, tombstones
  included.
- `vector[x]` is the highest contiguous seq from device `x` already merged in (`vector[self]` is the last
  uploaded own seq).

| Rule | Value |
| --- | --- |
| When to write one | Log entries not covered by the newest known snapshot (any device) ≥ 500, or their size ≥ 8 MiB. At most once per 24 h per device, only when idle (not performing, page visible). The first device writes one right after its initial upload. |
| Choosing one to bootstrap from | Read each header with a range GET of chunk 0. Use only snapshots whose vector has valid device ids and seqs and never exceeds the trusted heads, that aren't dated (`t`) or stamped (`hlcMax`) more than 24 h in the future, and whose author has a valid (decryptable) device record. Live authors rank before retired ones, then the largest heads-capped `Σ vector`, then the newest `t`. Cursor moves from a snapshot are capped at the trusted heads. |
| What it drops | Field values of dead records whose `a` hlc is older than 30 days (the `a` register stays forever: about 60 B). Element tombstones older than 180 days. Both cut-offs go in `horizon`. Readers cap the horizon they act on at `min(horizon.elementTombs, t − 180 d, now − 180 d)`. |
| Header validation (codec) | `d` a device id, `n ≥ 1` matching the key, `t` a time not more than 24 h (`CLOCK_AHEAD_MAX`) past the reader's clock, `records` a safe integer ≤ 50,000,000, `hlcMax` a valid HLC, `vector` device id → non-negative safe integer, both `horizon` values numbers ≤ `t`. Any violation is `corrupt`. Every record line is validated like a batch op (§4.4), may be at most 64 Mi characters, and there may not be more lines than `records`. |

### 3.2 Pruning without coordination

None of these needs locks or acks. Correctness rests on two facts: snapshots contain the full state, and
merging is idempotent.

| Object | Who deletes | When |
| --- | --- | --- |
| `log/<me>/<s>` | me | It is ≥ 14 days old, **and** some snapshot (any device) at least 24 h old has `vector[me] ≥ s`. |
| `heads/<me>/<s>` | me | Right after `heads/<me>/<s'>` with `s' > s` is written (lazily, best effort). Readers take the max. |
| `snap/<me>/<n>` | me | Keep my latest 2. Delete older ones once my newest is ≥ 24 h old. |
| `log/<x>/*`, `heads/<x>/*`, `snap/<x>/*` of a **retired** device x | any device | Same coverage rule as above, but only if `devices/<x>.retired`. A retired device never writes again, so this can't race. |
| `blobs/<name>` | any device, at most weekly | Fully caught up, then LIST `blobs/`. Delete objects that are (a) not referenced by any alive song, or any song that died less than 30 days ago, and (b) `LastModified` > 30 days ago. |
| `devices/<me>` | me | Never deleted. Marked `retired` on leave. |

- **Gap recovery.** A reader whose cursor for device x is `c` finds `log/x/(c+1)` missing while
  `heads/x` > c. It lists `log/x/` to find the lowest seq still available, merges the snapshot that covers
  the gap (`vector[x] ≥ lowest − 1`), and continues.
- **Blob GC is the one rule that isn't strictly race-free.** Device A could delete a blob in the instant
  device B re-references it, after B's HEAD saw it. The 30-day grace window makes this practically
  impossible, and the **repair pass** heals it anyway. The repair pass runs weekly and on demand, and only
  touches blobs that device holds: it HEADs every blob referenced by an alive song and re-uploads any that
  are missing.
- **Stale devices.** A device with `lastSync.hlc` older than a snapshot's `horizon.elementTombs` may have
  missed tombstones that have since been discarded. On catch-up it applies the snapshot and then deletes,
  locally only, any alive record or element whose `born ≤ lastSync.hlc` and which is absent from the
  snapshot. The network knew about those, so their absence means they were deleted. Newer local items are
  its own unsynced work and are published normally. This only happens when the snapshot covers everything
  this device has merged (its vector is at or past every cursor), so a snapshot that is behind can't delete
  what it simply hasn't seen.

---

## 4. Wire formats

```ts
type Hlc = string                       // §6.1; fixed width, so string comparison is order
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Collection = 'song' | 'setlist' | 'ann' | 'kv'

/** A partial (batch op) or full (snapshot line) state of one record. Same type for both. */
interface RecordDelta {
  c: Collection
  id: string                                       // songId | setlistId | `${songId}:${fileId}:${page}` | kv key
  a?: [Hlc, boolean]                               // alive register
  f?: Record<string, [Hlc] | [Hlc, Json]>          // LWW registers; [hlc] = unset/undefined; dotted path for flattened objects
  m?: Record<string, number>                       // max/min registers (kind from field table), no hlc
  l?: Record<string, ListDelta>                    // keyed lists/maps/sets
  n?: Record<string, Record<string, [number, number]>>  // PN-counters: deviceId -> [inc, dec] (full per-device totals)
}
interface ListDelta {
  o?: [Hlc, string[]]                              // explicit order register (lists/sets only)
  e?: Record<string, [Hlc, Json | null, Hlc]>      // element key -> [hlc, value | null (= tombstone), bornHlc]
}

interface Batch {
  v: 1
  d: string                                        // deviceId (also bound by AAD)
  s: number                                        // seq (also bound by AAD)
  t: number                                        // wall ms when built
  hlcMax: Hlc
  ops: RecordDelta[]
  blobsReady?: string[]                            // sha256 hex of blobs this device has finished uploading
}
```

**Blob references on the wire.** `SongFile.blobId` and `AudioTrack.blobId` never travel; the content
hash does. A file element value is `Omit<SongFile, 'id' | 'blobId'> & { blob: string; mime: string }`, and
an audio element is `Omit<AudioTrack, 'id' | 'blobId'> & { blob?: string; mime?: string }`, where `blob` is
the SHA-256 hex. `blob: ''` means the sending device itself lacked the file data.

Size limits:

- A batch holds ≤ 500 ops or ≤ 1 MiB of JSON before gzip, whichever is reached first.
- One op may exceed that alone, up to 16 MiB (for example an `ImageAnnotation` with a data URL).
- Notices are ≤ 1 KiB.

### 4.1 Sealed envelope (meta, devices, batches)

```
[0]      0x02               format version
[1]      epoch              0
[2..13]  nonce              12 random bytes
[14..]   AES-GCM(envKey[epoch], nonce, plaintext = gzip(JSON), aad) || tag(16)
aad = [0x02, epoch] || utf8(`os1|${kind}|${libraryId}|${rest}`)   kind/rest:
      batch   -> `${deviceId}|${seq}`
      device  -> `${deviceId}`
      meta    -> ``
      (notice -> aad = [0x02, epoch] || utf8(`os1|notice|${roomId}`), §4.3)
```

The AAD binds every object to its own key path and to its version and epoch bytes. Anyone who can write to
the bucket but lacks the key can't swap or replay batches between paths. Random 96-bit nonces under
`envKey` are fine for the number of envelopes a library writes.

### 4.2 Chunked container (blobs, snapshots)

```
Header (16 B): "OSC1" | ver=2 (u8) | epoch (u8) | log2Chunk=20 (u8) | flags (u8: bit0 deterministic nonces)
               | plaintextSize (u64 BE)
Chunk i (i = 0..n-1, n = max(1, ceil(size / CHUNK))):  nonce(12) | ciphertext(len_i) | tag(16)
  len_i = CHUNK (1 MiB) except the last; an empty plaintext gives a single 0-length chunk
  offset_i = 16 + i * (CHUNK + 28)                     -> any chunk range is computable
  aad_i    = header(16) || utf8(`|${ctx}|${i}|${i === n-1 ? 1 : 0}`)   // last-flag stops truncation
  ctx      = `blob|${blobName}`  or  `snap|${libraryId}|${deviceId}|${n10}`
  key      = blobKey[epoch] for blobs, snapKey[epoch] for snapshots
Blob nonces (flags bit0):  nonce_i = HMAC(nonceKey[epoch], u32be(len(aad_i)) || aad_i || plaintext_i)[0..12]
Snapshot nonces:           random
ciphertextSize(size) = 16 + n * 28 + size
```

**Blob nonces are deterministic and content-derived.** The nonce is a PRF of the chunk's plaintext and its
whole AAD (format version, epoch, chunk size, total size, blob name, index, last-flag). So:

- the same file always encrypts to the same bytes: a multipart part can be re-encrypted and re-sent
  identically after a crash, two devices uploading the same file produce identical objects, and a download
  can resume from any chunk;
- a nonce repeats only for the **identical plaintext chunk at the identical position of an identically
  sized file with the same name**, which yields identical ciphertext and leaks nothing. Two different
  plaintexts never meet under one key and nonce, even if a device files content under the wrong hash
  (v1 derived the nonce from the claimed hash alone, so a wrong claim reused nonces; that is the reason
  for v2). The 96-bit truncation gives the collision bound of random nonces.

**Every download is verified against its SHA-256, whatever its size** (§10.2). Up to 32 MiB with one
WebCrypto digest; above that with a streaming SHA-256 (`@noble/hashes`, lazy-loaded) fed chunk by chunk
from the stored chunks, so memory stays at about one chunk. The GCM tags only prove that a key holder
wrote the object, not that it is the file the hash names; a mismatch is discarded and never stored.

### 4.3 Relay notice

```
text frame: {"v":1,"n":"<base64url(sealed(JSON {d, s}) with aad = [0x02, epoch] || utf8(`os1|notice|${roomId}`), no gzip)>"}
```

Receivers decrypt the notice and ignore their own `d`. If `s > cursor[d]`, they fetch `log/d/(cursor+1..s)`
at once, from the socket's message handler rather than through a timer (hidden pages get their timers
throttled, to once a minute in Chrome after 5 min hidden). A notice during a running pull queues one more.

Connection test ("Test instant sync" in Settings): the same frame and sealing, with the payload
`{d, s, k: "ping", p}` or `{d, s, k: "pong", p, to}`. `p` is a random nonce (8–32 base64url chars), `to` the
pinging device; `s` is the sender's head (≥ 0 here, ≥ 1 for plain notices). Every other device answers a
ping with a pong addressed `to` the pinger echoing `p`; the pinger counts only pongs that decrypt with the
library key, are addressed to it and carry its current nonce. Both double as notices (`s` is a valid head),
so devices that predate them treat them as plain notices and never answer.

### 4.4 Format versions, errors and input validation

**Format v2, no migration.** v2 (2026-10-24) changed the envelope and container version bytes, the keys
and the blob nonce. Nothing reads v1. Nothing real had been synced with v1, so there is no migration:
a library that still holds v1 objects has to be recreated with **"Reset sync"** (§10.5).

Only authenticated bytes produce a format verdict. `FormatError.code` is one of:

| Code | Meaning | Scope |
| --- | --- | --- |
| `corrupt` | This object doesn't authenticate or is malformed: wrong key or location, tampering, truncation, a bad register, a hash mismatch, or an **unknown version or epoch byte** (unauthenticated, so it can't be trusted to mean "newer"). | That object (or that device's stream). |
| `newerFormat` | The object authenticated and its JSON `v` is higher than this build knows. | Per stream; tells the user to update. |
| `oldFormat` | The object authenticates under `v1Key` with the v1 layout (version byte 1, epoch 0, v1 AAD). Flipping a v2 object's version byte to 1 doesn't authenticate and stays `corrupt`. | The library needs "Reset sync". The engine maps it to `rejoin` wording. |

Future writers must keep a format change detectable after authentication (bump the JSON `v` inside a v2
envelope), or accept that old readers report the new objects as `corrupt`.

**Decode-level validation** (`codec.ts`; the engine adds trust rules on top, §3.1, §10.1):

- Batches: `v`, `d`/`s` equal to the key path, `t` a number, `hlcMax` a valid HLC, `blobsReady` SHA-256
  hex strings, and every op passes `checkRecordDelta`: string `c` and `id`; every HLC in `a`, `f`, `l.o`
  and `l.e` (value and born) valid; register tuples of the right length; `m` values numbers; counters
  non-negative numbers; no `__proto__` key in any map. One bad op makes the batch `corrupt`.
- Snapshots: the header rules in §3.1, each record line as above, line length ≤ 64 Mi characters.
- Envelopes decompress to at most 64 MiB.

**Size and work limits against anyone with bucket access:**

| Where | Limit |
| --- | --- |
| `backend.get` without a range | `maxBytes`, default `GET_MAX` (64 MiB + 64 KiB); `Content-Length` above it is refused, a stream is cancelled once past it (`BackendError('unknown')`, `providerCode: 'TooLarge'`). |
| `backend.get` with a range | At most the range's length. A server that ignores `Range` (200 with the whole object) is accepted only if the object fits; otherwise the download is aborted (`providerCode: 'RangeIgnored'`). |
| S3 XML answers / error bodies | 8 MiB / 64 KiB (error bodies are truncated). XML is scanned with a linear `indexOf` scanner (4 MB in well under a second, also for unclosed tags). |
| Listing (`listAll` in `backends/util.ts`) | 250,000 keys per prefix, and a cursor that repeats, throw (`TooManyKeys` / `ListLoop`). |
| Snapshot NDJSON | 64 Mi characters per line; `records` ≤ 50,000,000. |
| `objectStream` without range support | One GET of at most 1 GiB. |

**Remaining limits.** A key holder can do anything a device can (write any batch, snapshot or blob); the
checks above bound the damage to availability and to what such a device could do anyway, and downloads
catch wrong file content by hash. Someone with bucket-only access (no key) can fake a head marker for a
known device; that lets a lying snapshot's vector pass the heads cap for that device, and holds that
device's stream back once its real entries run out. Size, count and timing metadata stay visible (§2).

---

## 5. What syncs and how it merges

Merge kinds:

- **lww**: last writer wins on HLC; whole value.
- **flat**: a plain object flattened one level into `field.sub` LWW registers.
- **list**: keyed elements, each element LWW on its whole value, plus an order register.
- **map**: keyed elements without order.
- **set**: a list whose element key is the string value itself.
- **max / min**: numeric max or min.
- **pn**: a counter.
- **const**: set once.
- **local**: never synced.

### 5.1 Song (`c:'song'`, id = `Song.id`)

| Field(s) | Kind | Element key | Notes |
| --- | --- | --- | --- |
| `title`, `sortTitle`, `rating`, `difficulty`, `duration`, `notes`, `keywords`, `sourcePage`, `songNumber`, `favorite` | lww | | Concurrent edits to *different* fields both survive. |
| `artists`, `composers`, `albums`, `genres`, `collections`, `keys`, `signatures`, `sources`, `years`, `tags`, `custom`, `custom2` | set | the string | Concurrent tag adds and removes both survive. Order matters (`artists[0]` is the primary artist). Duplicates are dropped (first one kept). |
| `tempos` | lww | | Small array; duplicates allowed. |
| `files` | list | `SongFile.id` | Values are wire refs (`blob` hash). `updateTextFile` keeps the id and changes the value. |
| `pageOrder` | lww | | `PageRef[]` has no ids. `resolvePageRefs` already drops refs to unknown files. |
| `pageSettings` | map | `${fileId}:${page}` | |
| `display`, `text`, `metronome`, `autoScroll` | flat | | So `metronome.bpm` and `metronome.sound` merge independently. Setting the whole object to `undefined` (reset) unsets every sub-register, and an object with no defined sub-register materialises as `undefined`. |
| `midiOnLoad`, `midiRecall` | lww | | `MidiCommand` has no ids. |
| `bookmarks`, `links`, `smartButtons`, `audio` | list | `.id` | Audio values are wire refs. |
| `createdAt` | min | | |
| `modifiedAt`, `lastPlayedAt` | max | | |
| `playCount` | pn | | Total = max(0, Σinc − Σdec). Each device diffs the local row against the materialised total and adds the difference to its own inc or dec. |
| any unknown top-level field | lww | | Forward compatibility: written to the row as-is and preserved. |

### 5.2 Setlist (`c:'setlist'`)

| Field(s) | Kind | Notes |
| --- | --- | --- |
| `name`, `notes`, `date`, `venue` | lww | |
| `entries` | list, key `SetlistEntry.key` | Element value is the entry without `key`, as a whole LWW value. Concurrent appends both survive. Concurrent reorders: the latest order wins, and elements it doesn't mention are appended. |
| `createdAt` | min | |
| `modifiedAt`, `lastPlayedAt` | max | |

### 5.3 Annotation page (`c:'ann'`, id = `${songId}:${fileId}:${page}`)

| Field | Kind | Notes |
| --- | --- | --- |
| `songId`, `fileId`, `page` | const | Derived from the id. |
| `items` | list, key `Annotation.id` | Each item is a whole LWW value. Order is z-order. Erases become tombstones. |
| (record) | | Never record-tombstoned. A page row is deleted when no items are alive, so a concurrent add on another device survives an "erase all". |

### 5.4 KV (`c:'kv'`, id = kv key). An explicit allow-list: `syncedKv(key)`

| Key | Written by | Sync | Kind |
| --- | --- | --- | --- |
| `layers:<songId>` | `annotations/layers.ts` | yes | `layers`: list keyed by `Layer.id`, value `{name, visible}`. `current` is **local** (each device keeps its own; falls back to the first layer). |
| `textLayout:<songId>` | `viewer/TextLayoutNotice.tsx` | yes | `value`: lww. It describes how synced text annotations were drawn. |
| `library:emptyCollections` | `library/browse/ops.ts` | yes | `value`: set |
| `library:savedFilters` | `library/browse/ops.ts` | yes | `value`: list keyed by `name` |
| `library:recentClearedAt` | `library/browse/ops.ts` | yes | `value`: max. Play history syncs, so clearing "Recent" does too. |
| `backup.lastAt`, `backup.dir`, `backup.remindedAt`, `backup.autoLastAt` | `backup/backup.ts` | **no** | per device (`dir` is a FileSystemHandle) |
| anything else | | **no** | New keys must opt in by being added to `syncedKv`. |

**Never synced:**

- `thumbs` (derived).
- `blobs` rows. File content travels as encrypted objects, and references travel inside songs.
- Settings and everything else in `localStorage`: the libraries list, the route, scanner and export
  prefs, hints.

### 5.5 Rules shared by all collections

- **Alive register `a`.** A delete sets `a = [hlc, false]`. Concurrent field edits don't touch `a`, so
  **a delete wins over concurrent edits**. Putting a row with a dead id locally is an **undelete**: it sets
  `a = [hlc, true]` and re-registers every field. The undo toast of `deleteSetlist` relies on this.
- **Materialising a list.** Take `o.ids` filtered to alive keys, then append the alive keys not in `o`,
  sorted by `(born, key)`.
- **Diffing a list.** Elements that are new or have a changed hash get `[hlc, value, born ?? hlc]`. Alive
  elements that were removed get `[hlc, null, born]`. An `o` register is emitted **only** when
  materialising without it would give a different order. Appends and edits never carry O(n) order lists;
  only real reorders do (z-order changes, setlist moves).
- **Validation on apply.** The field table gives each field a validator (`str`, `num`, `bool`, `json`).
  An op that fails is skipped and logged, never written. An unknown `c` is kept opaquely in `syncShadow.x`
  and included in our snapshots.
- **Demo content.** Demo songs are ordinary songs and sync like any other. Exception: when joining,
  *untouched* demo songs on the joining device are deleted locally first and never published.
  `isUntouchedDemo(song)` checks the demo title, a single text file whose hash equals the hash of
  `DEMO_CHORDPRO` or `DEMO_ABC`, `createdAt === modifiedAt`, and no annotations.

---

## 6. Local state

### 6.1 HLC (`hlc.ts`)

```ts
// `${wall 12 hex}${counter 4 hex}${deviceId 16 hex}` = 32 chars; string order is causal-or-arbitrary total order
export const HLC_ZERO: Hlc
export interface HlcClock { now(wall?: number): Hlc; receive(remote: Hlc, wall?: number): void; readonly last: Hlc }
export function createClock(deviceId: string, last?: Hlc, wall?: () => number): HlcClock
export function parseHlc(h: Hlc): { wall: number; counter: number; device: string }
```

- `now(wall)` returns `max(last.wall, wall)`. The counter increments within the same ms; when it would
  overflow, `wall` goes up by 1.
- `receive` is the standard HLC receive and returns a boolean.
- A remote wall more than 5 min ahead of local time (`CLOCK_AHEAD_WARN`) still advances the clock (so
  convergence holds), and sets the `clockAhead` warning naming that device.
- A remote HLC more than 24 h ahead (`CLOCK_AHEAD_MAX`), or a malformed one, is refused: `receive`
  returns `false` and the clock is untouched, so one bad value can't drag every clock into the future. A
  batch with ops 24 h–30 d ahead holds back that device's stream until local time catches up; ops more than
  30 d ahead (`CLOCK_AHEAD_STALL`) are dropped. A restored `last` that far ahead is ignored.
- The clock saturates at its maximum instead of throwing.
- `clock.last` is persisted with every batch build and every apply.

### 6.2 Dexie `version(2)` (in `db.ts`; version 1 untouched)

```ts
this.version(2).stores({
  syncState: 'key',                       // { key, value }; keys below
  syncDirty: 'id, deferredSince',         // id = `${c}/${recordId}`; { id, at: lastWriteMs, deferredSince? }
  syncShadow: 'id, c',                    // ShadowRecord
  syncOutbox: 'seq',                      // { seq, bytes: Uint8Array (sealed), ops: number, hlcMax, blobsReady }
  syncTransfers: '[dir+hash], state, priority',  // TransferRow
  syncChunks: '[hash+index]',             // { hash, index, data: Blob } decrypted download parts
})
```

```ts
interface ShadowRecord {                  // what the network knows about a record: hlcs + value hashes, no values
  id: string; c: Collection
  a?: [Hlc, boolean]
  f: Record<string, [Hlc, string /*valueHash; '' = unset*/]>
  m: Record<string, number>
  l: Record<string, { o?: [Hlc, string[]]; e: Record<string, [Hlc, string /*hash; '' = tomb*/, Hlc /*born*/]> }>
  n: Record<string, Record<string, [number, number]>>
  x?: unknown                             // opaque unknown-collection state
}
interface TransferRow {
  dir: 'up' | 'down'; hash: string; size: number; mime: string
  state: 'queued' | 'active' | 'waiting' /*404, waiting for uploader*/ | 'failed'
  priority: number; attempts: number; nextAt: number; error?: string
  upload?: UploadState                    // backend resumable state (§7)
  doneChunks?: number                     // down: contiguous decrypted chunks in syncChunks
}
```

The value is kept in the row; the shadow only holds its hash. That keeps sync overhead small, because
annotation pages aren't stored twice. Snapshots join row values with shadow hlcs, which is valid only when
`syncDirty` is empty (§3.1).

`syncState` keys:

| Key | Value |
| --- | --- |
| `config` | `{ v:1, secret, libraryId, roomId, deviceId, backend: BackendConfig, relay: string \| null, name, joinedAt, paused }` |
| `clock` | last `Hlc` |
| `seq` | `{ next: number }`, the next own seq (allocated when a batch is built) |
| `cursors` | `Record<deviceId, number>` |
| `lastSync` | `{ at: number, hlc: Hlc }` (fully caught up) |
| `snapshots` | cached headers `Record<key, SnapshotHeader>` |
| `devices` | cached `DeviceRecord[]` |
| `maintenance` | `{ snapshotAt, pruneAt, gcAt, repairAt }` |
| `join` | checkpoint `{ phase, mode, … }` while a join is in progress |
| `oauth` | phase 2/3 tokens, **per device, never shared** |

The capture flag lives in `localStorage['openstand-libsync:' + dbName] = '1'`, so the middleware can read
it synchronously before the engine starts.

---

## 7. Backend interface (`backends/types.ts`)

```ts
export type BackendConfig =
  | { kind: 's3'; provider: 'r2' | 'b2' | 'aws' | 'minio' | 'other'; endpoint: string; region: string; bucket: string;
      prefix: string; accessKeyId: string; secretAccessKey: string; pathStyle: boolean }
  | { kind: 'dropbox'; root: string }           // phase 2; tokens per device in syncState.oauth
  | { kind: 'gdrive'; folder: string }          // phase 3
  | { kind: 'onedrive'; folder: string }        // phase 3
  | { kind: 'memory'; name: string }            // tests

export interface ObjectInfo { key: string; size: number; etag?: string; lastModified?: number }
export interface ListPage { items: ObjectInfo[]; cursor?: string }      // items sorted by key
export interface ByteSource { size: number; read(start: number, end: number): Promise<Uint8Array> }  // end exclusive
export interface UploadState { v: 1; backend: string; key: string; size: number; createdAt: number; done: number; session: Json }
export interface BackendCaps { rangeGet: boolean; conditionalPut: boolean; maxSmallPut: number }

export interface StorageBackend {
  readonly kind: BackendConfig['kind']
  readonly label: string                         // "Cloudflare R2 · my-bucket/openstand"
  caps: BackendCaps                              // may be refined by check()
  /** Keys relative to the backend root. startAfter is exclusive; backends without it filter client-side. */
  list(prefix: string, o?: { startAfter?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<ListPage>
  head(key: string, o?: { signal?: AbortSignal }): Promise<ObjectInfo | null>
  /** null on 404. range is inclusive [start, end]. Body capped: the range length, else maxBytes (default GET_MAX), §4.4. */
  get(key: string, o?: { range?: [number, number]; signal?: AbortSignal; maxBytes?: number }): Promise<Uint8Array | null>
  put(key: string, body: Uint8Array, o?: { ifNoneMatch?: boolean; signal?: AbortSignal }): Promise<void>  // 412 -> BackendError('precondition')
  delete(key: string, o?: { signal?: AbortSignal }): Promise<void>        // 404 counts as success; callers delete own keys only (§3.2)
  /** Resumable upload of any size. Persists progress through onState; pass the last state back to resume. */
  upload(key: string, src: ByteSource, o: { state?: UploadState; onState?: (s: UploadState) => Promise<void>;
         onProgress?: (bytes: number) => void; signal?: AbortSignal }): Promise<void>
  check(): Promise<BackendCheck>
}
export interface BackendCheck {
  ok: boolean
  steps: { id: 'reach' | 'auth' | 'cors' | 'list' | 'write' | 'read' | 'range' | 'etag' | 'conditional' | 'delete'; ok: boolean; detail?: string }[]
  error?: BackendError
}
export type BackendErrorCode = 'auth' | 'forbidden' | 'notFound' | 'precondition' | 'quota' | 'rateLimited' | 'network'
  | 'cors' | 'clock' | 'tokenExpired' | 'server' | 'unknown'
export class BackendError extends Error { code: BackendErrorCode; status?: number; retryAfterMs?: number; providerCode?: string }
```

### 7.1 S3 (`s3.ts`)

- Built on `AwsClient` from aws4fetch (`service: 's3'`, `region`; `'auto'` for R2).
- URLs are path-style (`endpoint/bucket/key`) unless `pathStyle: false`, which is the AWS default.
  Keys are encoded per path segment.
- `list` is `ListObjectsV2` with `prefix`, `start-after`, `continuation-token` and `max-keys`. The XML is
  parsed with a small linear `indexOf` scanner that decodes entities, not `DOMParser` (so it also runs in Node tests) and not regexes (quadratic on crafted input); bodies are size-capped (§4.4).
- `upload`:
  - `src.size ≤ 16 MiB`: a single PUT.
  - Otherwise multipart. Part size is 8 encrypted chunks = 8 MiB + 224 B; part 1 also carries the 16-byte
    header.
  - `session = { uploadId, partSize, parts: [{ n, etag }] }`. Every part calls `onState`.
  - Resume uses `ListParts`. `NoSuchUpload` means start again.
  - The engine aborts its own sessions older than 6 days. R2 aborts after 7 days by itself; AWS and B2
    users are told to add a lifecycle rule.
- Clock skew: on `RequestTimeTooSkewed`, take the server `Date` header, store the offset, and retry once
  with `datetime` corrected.
- Error mapping:
  - 401/403 `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `ExpiredToken` → `auth`.
  - `AccessDenied` → `forbidden`.
  - B2 403 "cap exceeded" and S3 `QuotaExceeded` → `quota`.
  - 429/503 `SlowDown` → `rateLimited` (honour `Retry-After`).
  - A `TypeError` from fetch while a `mode:'no-cors'` probe to the endpoint succeeds → `cors`. When
    offline (`navigator.onLine === false`, or the probe also fails) → `network`.
- `check()` runs in order:
  1. LIST `max-keys=1`.
  2. PUT `os1/.check-<rand>`.
  3. GET it.
  4. Range GET `bytes=0-0`.
  5. Confirm the `ETag` header is readable. It is needed for multipart, and a missing one means
     `ExposeHeaders` is wrong.
  6. A second PUT with `If-None-Match: *`: expect 412, which sets `caps.conditionalPut`.
  7. DELETE.

**CORS rule users paste.** The UI fills in `location.origin`. AWS console, R2 dashboard and MinIO `mc` all
take this JSON:

```json
[{
  "AllowedOrigins": ["https://openstand.rodlabs.dev"],
  "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"],
  "MaxAgeSeconds": 86400
}]
```

Backblaze B2 (via `b2 bucket update --cors-rules '<json>'`):

```json
[{"corsRuleName":"openstand","allowedOrigins":["https://openstand.rodlabs.dev"],
  "allowedOperations":["s3_get","s3_head","s3_put","s3_post","s3_delete"],
  "allowedHeaders":["*"],"exposeHeaders":["ETag","Content-Length","Content-Range"],"maxAgeSeconds":86400}]
```

MinIO allows every origin by default (`MINIO_API_CORS_ALLOW_ORIGIN`).

The wizard recommends credentials scoped to one bucket (R2: an "Object Read & Write" token limited to that
bucket). Every paired device shares them.

Provider presets:

| Provider | Endpoint | Region | Path-style | Notes |
| --- | --- | --- | --- | --- |
| R2 | `https://<accountId>.r2.cloudflarestorage.com` | `auto` | yes | The form asks for the account id. |
| B2 | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | yes | B2 bills LIST as class C after 2,500 per day free. At a 30 s poll with 3 devices this costs about $0.01 a month; mention it. |
| AWS | `https://s3.<region>.amazonaws.com` | the bucket's region | no | |
| MinIO / other | free entry | free entry | yes | |

### 7.2 Phases 2 and 3 (interface only)

```ts
export interface OAuthProvider {
  kind: 'dropbox' | 'gdrive' | 'onedrive'
  authorizeUrl(p: { codeChallenge: string; state: string; redirectUri: string }): string
  exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet>   // gdrive/onedrive via Worker route below
  refresh(t: TokenSet): Promise<TokenSet>
}
export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number; account?: string }
```

- **Dropbox** works browser-only with PKCE; no secret is needed. Use an app folder, so the root is
  `/Apps/OpenStand`. Upload sessions are sequential appends, and the `Range` header works on download.
  `startAfter` is emulated client-side.
- **Google Drive and OneDrive** exchange tokens through a stateless Worker route that holds the client
  secret and stores nothing:
  - `POST /api/oauth/token` with body
    `{ provider: 'gdrive' | 'onedrive', grant_type: 'authorization_code' | 'refresh_token', code?, code_verifier?, redirect_uri?, refresh_token? }`.
  - The Worker adds `client_id` and `client_secret` (`wrangler secret put GDRIVE_CLIENT_SECRET` and
    `ONEDRIVE_CLIENT_SECRET`), forwards the request to the provider's token endpoint, and returns the
    provider's JSON and status unchanged.
  - Only the site's origin (and `ALLOWED_ORIGINS`) may call it. It never logs bodies.
  - Needs `"/api/*"` added to `run_worker_first` in `wrangler.jsonc`, and `/^\/api\//` added to
    `navigateFallbackDenylist` in `vite.config.ts`.
- **OAuth tokens are per device.** Each device signs in itself, and the pairing payload only carries
  `{kind, root/folder}`. After sign-in, decrypting `meta` proves it's the right account.

---

## 8. Capturing local changes

### 8.1 Mechanism: DBCore middleware with dirty-marking and state-based diff

Recommendation: install a **DBCore middleware** (`src/db/capture.ts`) on every `OpenStandDB` instance,
from its constructor, which covers library switching. It records only **which records changed**, inside
the same IndexedDB transaction. The engine later computes per-field changes by diffing the row against
`syncShadow`.

Why this design:

- **Nothing is missed.** Every write path goes through DBCore, including `modify`, `where().delete()`,
  `clear()`, `bulkPut` and `db.table('songs').update`. There are about 70 call sites (§8.6); explicit
  calls would rot, and hooks don't cover `deleteRange` cleanly.
- **Atomic.** The dirty mark commits or rolls back together with the data.
- **Cheap.** Writes do no diffing or hashing, and need no async lookups inside user transactions.
- **Coalescing.** Pen strokes, sliders and other rapid edits become one op at capture time. Intermediate
  states vanish: a backup restore's `clear()` followed by `bulkPut` nets out to field changes, not
  delete-then-create.
- **Self-healing.** Because changes are diffed against the shadow rather than logged, a periodic
  reconcile scan (daily, idle) can find anything missed and is equally correct. Examples: writes from an
  old app version in another tab, or a missing flag.

Middleware contract:

| DBCore call | Behaviour (only when the capture flag for `db.name` is on) |
| --- | --- |
| `transaction(stores, 'readwrite')` touching `songs`, `setlists`, `annotations` or `kv` | Append `'syncDirty'` to `stores`. This is the pattern dexie-cloud uses. |
| `mutate` `add` / `put` | `keys = req.keys ?? req.updates?.keys ?? req.values.map(schema.primaryKey.extractKey)` |
| `mutate` `delete` | `req.keys` |
| `mutate` `deleteRange` (`clear()`, range deletes) | Query primary keys in `req.range` first (`query({ values: false })`), then mark them. |
| `kv` table | Mark only keys where `syncedKv(key)` is true. |
| `blobs`, `thumbs`, `sync*` tables | Ignored. |
| Transaction marked remote (`markRemote(tx)`) | Skip. This is only an optimisation: apply also writes the shadow, so recapturing produces an empty diff. Mark it via `Dexie.currentTransaction` or the identity of `req.trans`; the implementer checks which one works on Dexie 4.4. |

The mark is `syncDirty.put({ id: \`${c}/${key}\`, at: Date.now() })`, with `c` derived from the table:
`songs` → song, `setlists` → setlist, `annotations` → ann, `kv` → kv. It is written through
`down.table('syncDirty').mutate` in the same transaction.

### 8.2 Diff: from dirty to ops

The engine runs this 300 ms after the last dirty change but no sooner than 1.5 s after its previous run (so a
single edit goes out at once and a burst becomes one batch per 1.5 s), immediately on `visibilitychange: hidden`, on
`songClosed`, and before every apply that touches a dirty record. In one rw transaction over the record
tables, `blobs` (read), `syncShadow`, `syncDirty`, `syncOutbox` and `syncState`:

1. Read the row, the shadow and the dirty entry.
2. Project the row into registers (`merge.project(c, row, ctx)`). `ctx.blobHash(blobId)` turns `blobId`
   into a hash: an id that is already 64 hex characters is the hash, otherwise read `blobs.get(id).hash`
   and cache it in memory (the mapping never changes).
3. `delta = merge.diff(c, projection, shadow, clock.now(dirty.at), deviceId)`. Using the write time of the
   dirty mark as the HLC wall keeps LWW faithful to when the user actually edited, even after an offline
   week.
4. A missing row with an existing shadow becomes `a = [hlc, false]`; for `ann`, all items get
   tombstones. A missing row without a shadow is dropped.
5. **Orphan guard (`ann` only).** If the row exists but its song row is missing locally, or `fileId` isn't
   in `song.files`, leave it dirty with `deferredSince`. Retry after any song change. Drop the dirty entry
   after 24 h. This covers combine copies made before the editor saves, and cancelled combines.
6. Append the ops to the open outbox batch, update the shadow, delete the dirty entry.
7. Every new hash in `files` or `audio` with no `up` transfer or known remote copy gets an `up` transfer
   (§8.7).

The outbox is sealed when it reaches its size limit, or after the diff pass. Sealing allocates
`seq.next++` and stores the sealed bytes.

### 8.3 Applying remote changes without recapture

`apply.ts` runs one rw transaction per batch, or per group of up to 2,000 ops while catching up, and calls
`markRemote(tx)` first. For each op:

1. If the record is dirty, run §8.2 for it first in the same transaction.
2. Merge into the shadow (`mergeDelta`).
3. For registers the remote won, write the new value into the row (`materialize`). Dead record → delete
   the row. `ann` with no alive items → delete the row. Otherwise put. Wire `blob` hashes become local
   blob ids: an existing row with that hash, else the hash itself (download pending). Each missing hash
   enqueues a `down` transfer.
4. Advance `cursors[d]` and the clock in the same transaction.

After commit, call `annotationStore.remoteChanged(keys)` and `thumbs` invalidation for changed songs,
and emit `onRemoteApplied` for the UI. Dexie `liveQuery` re-renders the rest automatically.

### 8.4 Stale-object writers (rebase required)

| Site | Problem | Fix (WP3) |
| --- | --- | --- |
| `SongEditor.tsx` `save` → `db.songs.put(s)` | The draft may be minutes old and would revert remote edits to fields the user didn't touch. | Keep `base`. On save: `latest = await db.songs.get(id)`, then `put(merge.rebase('song', base, s, latest))`. Rebase applies base→draft changes at the same granularity as §5 (field, sub-field, element, order) onto `latest`. If `latest` is gone (deleted elsewhere), ask before saving it as a new song. |
| `files/import.ts` `updateTextFile(song, …)`, `addFilesToSong(song, …)` | Called with a `song` that may be stale (the text editor stays open). | Re-read `db.songs.get(song.id)` inside the function and apply the change to that. |
| `viewer/Viewer.tsx:161` play count `playCount: song.playCount + 1` | Read-modify-write on a stale value breaks the PN-counter diff. | New `recordPlay(songId)` in `db.ts`, an atomic `modify` setting `playCount++` and `lastPlayedAt`. The lead swaps the call. |

Other `updateSong` callers patch a whole field from a live-query `song` that is milliseconds old. The
window for a lost concurrent element edit is negligible; leave them as they are.

### 8.5 Annotation store (`annotations/store.ts`, `history.ts`)

The store caches items in memory and flushes after 700 ms. Without changes, its blind `put` would erase
remote items: they'd look like local deletes. Required changes:

- Each `Entry` gets `base: Annotation[]`, the items last read from or written to IndexedDB.
- **`flush`**, in its rw transaction: `db = row?.items ?? []`;
  `merged = applyChanges(db, diffItems(base, items))`; write `merged`; set `base = items = merged` (notify
  if it changed).
- **`remoteChanged(keys)`**, exported: for each loaded key, re-read the row.
  - Not dirty: `items = base = row`.
  - Dirty: `items = applyChanges(row, diffItems(base, items))`, then `base = row`.
  - Notify.
- **`applyChanges(items, d)`** keeps the current order: drop deleted, replace updated in place, append
  created ones in their relative order. `diffItems` already exists; extend it to carry the values.
- **Undo/redo** applies inverse diffs instead of restoring arrays: undo is
  `applyChanges(current, diffItems(after, before))`. Undo then never erases items that arrived from
  another device in between.
- The engine calls `store.flush()` before applying `ann` ops, and `remoteChanged` after commit.

### 8.6 Write-path inventory (as of this spec)

Everything below is captured automatically by the middleware. The **Action** column lists the only extra
work.

| Area | Call sites | Tables | Action |
| --- | --- | --- | --- |
| Import | `files/import.ts` `importFiles` (bulkPut), `createTextSong` (put), `addFilesToSong` and `updateTextFile` (put); `library/import/IndexImport.tsx` (bulkPut); `library/editor/songOps.ts` `createIndexSongs` | songs (+ blobs via `putBlob`) | §8.4 for `updateTextFile` and `addFilesToSong` |
| Editor | `SongEditor.tsx` save (put); `songOps.ts` `duplicateSong` and `createSnippet` (add + `copyAnnotations` bulkPut); `combine.ts` (`putBlob` + annotations bulkPut); `PageOrderEditor.tsx` (`putBlob`) | songs, annotations | §8.4 for SongEditor; combine pages handled by the orphan guard |
| Browse ops | `library/browse/ops.ts`: `setFavorite`, `batchEdit`, `renameGroup`, `deleteGroup`, `addToGroup`, `removeFromGroup` (modify); `deleteSongs` (bulkDelete songs and thumbs, annotations `where().delete()`, setlists modify, `collectGarbage`); setlist `add`/`update`/`delete`/undo-`put`; `perform` (setlists.update `lastPlayedAt`); `setExtraCollections`, `clearRecent`, `setSavedFilters` (kv) | songs, setlists, annotations, kv | none |
| Viewer and tools | `updateSong` from `DisplayPanel`, `MetronomePanel`, `AudioPanel`, `AudioTab`, `LinksPanel`, `BookmarksPanel`, `NotesPanel`, `TextPanel`, `AutoScrollPanel`, `tools/commands.ts`, `useToolActions.ts`, `audio/player.ts`, `TextLayoutNotice.tsx`, `Viewer.tsx` (display mode; play count) | songs, kv | `recordPlay` (§8.4) |
| Annotations | `annotations/store.ts` flush (put/delete), `annotations/layers.ts` `saveLayers` (kv) | annotations, kv | §8.5 |
| Backup and packages | `backup/archive.ts` `restoreArchive` (replace: clear all + bulkPut; merge: bulkPut, annotations delete), `importPackageArchive`, `importBlobs` (blobs put) | all | Replace restore with sync on: confirm "This replaces the library on all your synced devices" (WP4, `BackupSettings.tsx`). Sync tables are not in backups (`writeArchive` reads only library tables). |
| Performance sync | `sync/sync.ts` `applySetlist` (setlists.put) | setlists | none |
| GC | `db.ts` `collectGarbage` (blobs bulkDelete → `pruneAnnotations`); `StoragePanel.tsx` button | blobs, annotations | **Prune guard:** with sync on, `pruneAnnotations` deletes only pages that have **no shadow** (never synced) or whose song's shadow `a` is false. `db.ts` exposes `setPruneFilter(fn)`, which libsync registers, so `db.ts` doesn't import libsync. Synced orphan pages (files removed from a song) are kept: they are invisible and tiny. This prevents a device that received annotations before their song from tombstoning them everywhere. |
| Local only | `backup/backup.ts` kv `backup.*`; `Thumb.tsx`, `StoragePanel` thumbs | kv, thumbs | not synced |
| Libraries | `libraries.ts` `deleteLibrary` (`Dexie.delete`) | n/a | Also clear the capture flag and mark the device retired (best effort) |

### 8.7 `db.ts` changes (WP3)

- `putBlob` stores **new** blobs with `id = hash`, so ids match across devices; legacy uuid ids stay.
  `importBlobs` in `archive.ts` keeps working as it is.
- `export class MissingBlobError extends Error { blobId }` is thrown by `getBlob`. The UI asks libsync
  whether the blob is pending.
- `recordPlay(songId)`, `setPruneFilter(fn)`, and middleware install in the constructor (via
  `src/db/capture.ts`).

---

## 9. Relay (instant notices)

**Client** (`libsync/relay.ts`):

- Reuses `RelayTransport` from `src/sync/transports.ts`, with the URL `${relayBase}/lib/${roomId}`.
- `relayBase` comes from `config.relay`: the default is `/relay` when `sameSiteRelayAvailable()`,
  otherwise `null` (polling only). It is included in the pairing payload.
- Connected while sync is on, also while the page is hidden: a covered, minimised or background window still
  gets notices and pulls (mobile browsers may drop the socket; see the wake checks below). Going hidden
  pushes at once.
- Sends `{"ping":1}` on open and every 30 s. Once the relay has answered a ping, no frame at all within
  10 s of a ping (5 s after a wake) means the socket is dead (mobile networks drop connections silently):
  it reconnects at once.
- Posts a notice after every `heads/` write. Notices are coalesced (latest seq only) and spaced ≥ 250 ms
  apart (lib rooms allow 5 msg/s). One posted while the socket is down is sent when it opens, and every
  (re)open re-announces this device's head.
- Every (re)open also pulls (at most every 2 s): notices sent while it was down are lost.
- Focus, `pageshow`, `resume`, `online` and becoming visible reconnect at once (skipping the backoff wait) or
  check an open socket with a ping. Becoming visible and `online` pull at once (no timer); focus/pageshow/resume
  pull only if the relay isn't open or the last pull is over 30 s old. A wake within 1 s of a pull starting
  doesn't start another. The first touch or key press after 30 s also checks the socket with a ping.
- Detects support through the health JSON, which now includes `features: ['lib']`.

**Worker** (`worker/index.ts`):

```ts
const LIB = /^\/relay\/lib\/([a-z2-7]{26})$/
// fetch(): lib = url.pathname.match(LIB)
//   lib  -> DO name `lib:${lib[1]}`, header x-room-kind: lib
//   else -> existing room logic; reject (400) any perf room name starting with "lib:"
// health JSON: { service: 'openstand-relay', features: ['lib'] }
// RelayRoom.fetch(req): kind = req.headers.get('x-room-kind') === 'lib' ? 'lib' : 'perf'
//   this.ctx.acceptWebSocket(server, [kind]); room-full check uses LIMITS[kind].maxRoom
// webSocketMessage: kind = this.ctx.getTags(ws)[0]; enforce LIMITS[kind]
const LIMITS = { perf: { maxMessage: 256 * 1024, maxRoom: 64, perSecond: 60 }, lib: { maxMessage: 1024, maxRoom: 32, perSecond: 5 } }
// constructor: this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"ping":1}', '{"pong":1}'))
```

Same namespace and class, so no migration is needed. The relay still never parses or stores messages.

**Node relay** (`server/relay.mjs`):

- Matches pathname `/(?:relay\/)?lib\/([a-z2-7]{26})$` → room `lib:<id>`, with the same per-kind limits
  and the same `lib:` rejection.
- Answers `{"ping":1}` with `{"pong":1}`, and adds `features` to the health JSON.
- Tests in `server/relay-test.mjs`:
  - lib room: a 1 KiB+1 message closes the socket with 1009;
  - the rate cap holds;
  - a perf `?room=lib:x` gets 400;
  - perf and lib rooms with the same id suffix are isolated.

Without a relay, sync still works by polling (§10.1).

---

## 10. Engine behaviour

### 10.1 Scheduling

There is one engine per library database, in one tab: `navigator.locks.request('openstand-libsync:' +
db.name, …)`. Other tabs only write (their dirty marks show up in the engine tab through Dexie's cross-tab
`storagemutated`) and mirror status over a `BroadcastChannel('openstand-libsync-status')`. The engine
restarts on `switchLibrary` by subscribing to `useLibraries`.

| Task | Trigger |
| --- | --- |
| capture (§8.2) | dirty change, debounced 300 ms, at most once per 1.5 s; `visibilitychange` → hidden; `songClosed` |
| push | Seal → `put log/<me>/<seq>` → `put heads/<me>/<seq>` → notice → delete older head → delete the outbox row. Strictly in seq order; retries are idempotent. |
| pull | Every 30 s while visible (60 s while the relay is open). Also on `visibilitychange` → visible, focus/`pageshow`/`resume` (see §9), `online`, a relay (re)open, `songClosed`, an incoming notice, "Sync now", and when an idle maintenance listing shows another device ahead. While hidden only notices and relay reopens pull (no polling). |
| transfers | Separate pool: 3 downloads, 2 uploads. Paused while performing, except prioritised blobs. Paused while hidden or offline. |
| maintenance | Snapshot, prune, devices refresh, blob GC (weekly), repair (weekly), reconcile scan (daily). Only when idle: visible, not performing, no user input for 60 s. |

Pull, apply and capture run under one async mutex; transfers don't hold it.

Pull, step by step:

1. LIST `heads/`.
2. For each device `d ≠ me` with `head > cursor[d]`, GET `log/d/(cursor+1..head)` with up to 4 in
   parallel, then apply them in order.
3. Heads count only for devices with a decryptable device record (a missing or bad record is negatively
   cached for 10 min; at most 4 lookups per pull). Each stream applies at most 2000 batches per pull.
4. **Per-stream errors** hold back only that device's stream, with its cursor where it was: `corrupt`,
   `newerFormat`, `oldFormat` (§4.4), apply errors and gaps no snapshot covers. A batch is never skipped,
   because skipping would let devices diverge. Held-back streams retry after 30 s, 2 min, 10 min, then
   hourly, and are shown in `status.streams` / `status.warning`. Only storage errors (other than
   not-found), local quota and a closed database fail the whole pull.
5. An undecryptable object planted at this device's own next `log/` key is overwritten.

### 10.2 Blob transfers (`blobs.ts`)

**Upload:**

1. HEAD `blobs/<name>`. If it exists with the expected `ciphertextSize` **and** (with range GETs) its first
   28 bytes equal ours (header: version, epoch, size; then chunk 0's content-derived nonce), the blob is
   done. This catches v1 leftovers and stale objects for one tiny GET. It isn't a proof and doesn't need
   to be: confidentiality never depends on it (nonces derive from content, so honest devices never put
   two plaintexts under one key and nonce), and every download verifies the hash, so a bad object that
   passes is caught by readers. A key holder can always upload garbage; a bucket writer can always delete.
2. Otherwise verify the local data's SHA-256 against the hash (streamed above 32 MiB) and refuse to upload
   on a mismatch (`corrupt`; e.g. a legacy row with a wrong hash). Then `backend.upload` with a `ByteSource`
   that encrypts the needed chunks on demand from `BlobRecord.data.slice(...)`, so memory stays bounded.
   Resumable through `TransferRow.upload`.
3. When done, add the hash to the next batch's `blobsReady`.

**Download:**

- Fetch range GETs of 4 chunks, decrypt, and store each chunk in `syncChunks`. `doneChunks` records
  progress, so a download resumes at chunk granularity.
- When complete, assemble `new Blob(parts, { type: mime })`, verify its size and SHA-256 at every size
  (§4.2), then `db.blobs.put({ id: hash, hash, mime, size, data })` and delete the chunks. On a mismatch the
  chunks are deleted, nothing is stored, and the row fails with `corrupt` (retried after an hour).
- A 404 sets the row to `waiting`. It is retried when a batch's `blobsReady` contains the hash, or at the
  latest every 10 min.

**Queue priority:**

1. `prioritize(songIds)`, called when a song or setlist opens, gets +1000.
2. Then songs by `lastPlayedAt`, newest first.
3. Then smaller files first.

**Local space:** checked per blob, from its real size: once the first chunks have decrypted (so the
container header and its size are authentic), `navigator.storage.estimate()` must show the bytes still
needed for that blob plus 200 MB free; otherwise that blob fails with `localQuota` (retried with backoff)
and other, smaller downloads carry on. Sizes claimed in remote ops (capped at 4 GiB each,
`BLOB_CLAIM_MAX`) are only used for priority and progress, so inflated claims can't block downloads. A
`QuotaExceededError` gives the same error. Enabling sync calls `navigator.storage.persist()`.

**Hooks:**

- `useBlobState(blobId)` returns
  `{ state: 'local' | 'queued' | 'downloading' | 'waiting' | 'offline' | 'missing', progress?: number }`.
- `onBlobReady(blobId, cb)` lets the viewer and thumbnails retry once the blob has arrived.

### 10.3 Enable, join and merge

**Enable (first device):**

1. `checkBackend`.
2. Generate the secret, then derive the keys and ids (§2).
3. PUT `meta` (conditional).
4. PUT `devices/<me>`.
5. Set the capture flag.
6. In one transaction, mark every record of the synced tables dirty.
7. The engine publishes batches, and all referenced blobs are queued for upload. This resumes after a
   crash because the dirty marks and transfers persist.
8. Write a snapshot when done.

Pairing can start at once: devices that join early see songs first and files as they arrive.

**Join**, from a pairing payload:

1. Derive the keys and ids, then GET and decrypt `meta`. A failure gives `wrongSecret`, or `libraryGone`
   on 404.
2. `previewJoin` counts the remote songs (from the snapshot header and logs) and the local songs, and
   computes `planJoin` matches.
3. Mode:
   - **here**: the default when the local library is empty or holds only untouched demos, which are
     deleted first.
   - **newLibrary**: the default otherwise. `createLibrary(name)`, then `switchLibrary`.
   - **merge**: an explicit choice.
4. Checkpoint `syncState.join`. Every step below is idempotent.
5. **Merge mode only:** stash the values of the synced kv keys.
6. With the capture flag **off**, stream the best snapshot and then the logs into rows and shadow (§8.3).
   Remote ids are uuids, so they don't collide with local ones. Only kv keys can collide; that's why they
   were stashed.
7. Set the capture flag. New deviceId, `seq.next = 1`. PUT `devices/<me>`.
8. **Merge mode only:** run the join-merge transaction, which is a normal captured write:
   - Matched local song L is merged into remote song R with `merge.joinSong(L, R)`:
     - lww and flat fields: R's values win;
     - set fields: union;
     - `bookmarks`, `links`, `smartButtons`: union, de-duplicated by `(name, pageIndex)`, `(from, to)`
       and `(label, pageIndex, x, y)`;
     - `pageSettings`: R wins per key, and L fills keys R lacks;
     - `favorite`: OR; `createdAt`: min; `lastPlayedAt`: max;
     - play count: L's count is added (so the two counts sum).
   - L's annotation pages are re-keyed to R's id. File ids are mapped by position, which is safe because
     the hash sequences are equal. Items are unioned, since annotation ids differ.
   - `layers:L` is merged into `layers:R` by layer name, and annotation `layer` fields are remapped to
     match.
   - Setlist entries pointing to L are remapped to R.
   - L rows are deleted. They have no shadow, so nothing is emitted for them.
   - Stashed kv values are unioned back.
9. Mark every remaining record that has no shadow dirty (the local-only ones). The engine publishes them.
   Downloads start.

**Match rule** (`planJoin`):

- L and R match when the ordered list of their file hashes is identical and non-empty **and**
  `normTitle(L.title) === normTitle(R.title)`. `normTitle` is the function in `src/sync/protocol.ts`;
  move it to a shared spot or re-export it.
- Same files with a different title stay separate: the user renamed one. Same title with different files
  also stays separate.
- Setlists match when they have the same normalised name and the same mapped `songId` sequence; otherwise
  both are kept.
- The preview shows: "*N* of your songs are already in the synced library and will be combined; *M* will
  be added."

```ts
export interface JoinPlan { songMap: Map<string, string>; setlistMap: Map<string, string>; added: { songs: number; setlists: number } }
export function planJoin(local: { songs: Song[]; setlists: Setlist[] }, remote: { songs: Song[]; setlists: Setlist[] }, hashOf: (blobId: string) => string): JoinPlan
export function joinSong(local: Song, remote: Song): Song
```

### 10.4 Leave

"Stop syncing on this device":

1. Push pending changes (best effort, 10 s timeout).
2. PUT `devices/<me>` with `retired: true` (skipped when `meta` is gone: a deleted or reset library). Its
   `heads/`, `log/` and `snap/` objects stay: a device that joins later still needs this stream until a
   snapshot covers it, and §3.2's retired-device rule prunes them then.
3. Clear all `sync*` tables and the capture flag. Library rows stay; the library becomes a normal local
   one.
4. If downloads are incomplete, warn first: "*N* files haven't downloaded yet and will be missing on this
   device."

### 10.5 Reset and delete

- **"Delete synced data from storage…"** requires typing the library name. It lists and deletes
  `os1/<libraryId>/`. This is the only operation that deletes other devices' keys, and the user invokes it
  deliberately. Meta goes first. Afterwards, other devices get `libraryGone` (meta 404 plus empty heads),
  stop, and keep their local data. Their banner offers **Join with a new code** (stop syncing, then the
  join flow with merge preselected, so the songs stay in this library) and **Stop syncing**.
- **No orphans:** a device that hasn't noticed yet must not write into the old prefix. Before writing it
  HEADs `meta`: once per write cycle for log pushes and snapshots (every locked engine run starts a new
  cycle), fresh for the device record (daily, rename, retire), at most every 30 s for blob uploads. When
  `meta` is gone it stops with `libraryGone` instead of writing.
- **"Reset sync"** is delete followed by enable with a new secret. This is the key-rotation path, used
  after a lost device; the remaining devices then pair again. It is also the only way forward for a
  library that still holds v1-format objects (`oldFormat`, §4.4).

### 10.6 Constants

| Constant | Value |
| --- | --- |
| `CAPTURE_DEBOUNCE` | 1.5 s between captures (each 300 ms after the last change) |
| `POLL` | 30 s, or 60 s while the relay is open |
| `BATCH_MAX` | 500 ops / 1 MiB JSON; a single op may be up to 16 MiB |
| `CHUNK` | 1 MiB |
| `SINGLE_PUT_MAX` | 16 MiB ciphertext |
| `PART` | 8 chunks |
| `RANGE` | 4 chunks |
| `SNAPSHOT_TRIGGER` | 500 uncovered batches or 8 MiB; ≤ 1 per 24 h per device |
| `LOG_RETENTION` | 14 days, and covered by a snapshot ≥ 24 h old |
| `BLOB_GC_GRACE` | 30 days; GC runs at most weekly |
| `DEAD_FIELDS_TTL` | 30 days |
| `ELEMENT_TOMB_TTL` | 180 days |
| `DIRTY_DEFER_MAX` | 24 h |
| `CLOCK_AHEAD_WARN` | 5 min |
| `CLOCK_AHEAD_MAX` | 24 h (refused by `receive`; snapshot `t` / `hlcMax` limit) |
| `CLOCK_AHEAD_STALL` | 30 d (ops further ahead are dropped) |
| `BLOB_CLAIM_MAX` | 4 GiB per claimed file size |
| `GET_MAX` | 64 MiB + 64 KiB (default `get` body cap) |
| `LIST_MAX_KEYS` | 250,000 keys per listed prefix |
| `MULTIPART_STALE` | 6 days |

---

## 11. Pairing

```ts
export interface PairingPayload { v: 1; s: string /*secret b64url*/; n?: string /*library name*/; b: BackendConfig; r?: string | null /*relay base*/ }
// Text code: "OSJ1." + base64url(deflateRaw(JSON))  — same string goes in the QR (byte mode, ECC M).
export function encodePairing(p: PairingPayload): Promise<string>
export function decodePairing(text: string): Promise<PairingPayload>   // trims whitespace, accepts the code embedded in pasted text; throws PairingError('format'|'version')
```

**Why not a URL.** It travels screen to camera only. A URL with a fragment would end up in browser
history and history sync. Also, on iOS a system-camera scan opens Safari, whose storage is separate from
the installed PWA. Scanning is therefore done inside the app.

A typical S3 payload is about 300 characters, which fits a QR version of about 11 (61×61).

**Showing the code:**

- The QR (lean-qr, rendered to canvas) only appears after the user taps "Show pairing code".
- It hides itself after 2 minutes.
- "Copy code" warns: "Anyone with this code can read and change your library and use your storage keys."

**Scanning** (`ui/qr.ts`):

- `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } })`. Don't use
  `scan/camera.ts` `openCamera`: it asks for 4K stills. Reuse `cameraApiAvailable` and `hasCamera`.
- If `'BarcodeDetector' in window` and `getSupportedFormats()` includes `qr_code`, use it. Otherwise
  `import('jsqr')` and decode frames downscaled to ≤ 800 px every ~150 ms.
- The "Paste code" field is always shown next to the camera view, since desktops often have no camera.

---

## 12. UI (WP4)

### 12.1 Facade the UI builds against (`src/libsync/api.ts`, stub first)

```ts
export type LibSyncPhase = 'off' | 'starting' | 'idle' | 'syncing' | 'offline' | 'paused' | 'error'
export type LibSyncErrorCode = 'auth' | 'cors' | 'quota' | 'localQuota' | 'network' | 'clock' | 'clockAhead' | 'wrongSecret'
  | 'libraryGone' | 'newerFormat' | 'corrupt' | 'rejoin' | 'server' | 'unknown'
export interface LibSyncError { code: LibSyncErrorCode; message: string; detail?: string; at: number }
export interface TransferProgress { files: number; bytes: number; doneFiles: number; doneBytes: number }
export interface LibSyncStatus {
  phase: LibSyncPhase
  configured: boolean
  backendLabel?: string
  lastSyncAt?: number
  pendingChanges: number
  upload: TransferProgress
  download: TransferProgress
  offlineReady: { have: number; total: number }        // files present locally / referenced
  initial?: { kind: 'upload' | 'join'; step: string; done: number; total: number }
  relay: 'off' | 'connecting' | 'open' | 'error'
  devices: (DeviceRecord & { self: boolean })[]
  error?: LibSyncError
}
export const useLibSync: import('zustand').UseBoundStore<import('zustand').StoreApi<LibSyncStatus>>
export function checkBackend(cfg: BackendConfig): Promise<BackendCheck>
export function enableSync(o: { backend: BackendConfig; relay?: string | null }): Promise<void>
export function pairingCode(): Promise<string>
export function parsePairingCode(text: string): Promise<PairingPayload>
export function previewJoin(p: PairingPayload): Promise<{ remoteSongs: number; remoteBytes: number; localSongs: number; matches: number; suggested: 'here' | 'newLibrary' }>
export function joinSync(p: PairingPayload, mode: 'here' | 'newLibrary' | 'merge'): Promise<void>
export function syncNow(): Promise<void>
export function setPaused(paused: boolean): Promise<void>
export function leaveSync(): Promise<void>
export function deleteRemoteData(): Promise<void>
export function repair(): Promise<void>
export function updateBackend(cfg: BackendConfig): Promise<void>   // new keys after rotation at the provider
export function renameDevice(name: string): Promise<void>         // '' = default name; overwrites devices/<me>
export function useBlobState(blobId: string | undefined): { state: 'local' | 'queued' | 'downloading' | 'waiting' | 'offline' | 'missing'; progress?: number }
export function onBlobReady(blobId: string, cb: () => void): () => void
export function prioritizeSongs(ids: string[]): void
export function corsRule(provider: BackendConfig & { kind: 's3' }): string   // filled with location.origin
```

The device name comes from `settings().sync.deviceName` (shared with performance sync), falling back to
`defaultDeviceName()` (`src/sync/deviceName.ts`): "iPad", "iPhone", "Pixel 8" (the model from UA client
hints), "Android tablet", "Chromebook", "Windows PC", "Mac" or "Linux PC", never browser plus OS. A
default name gets a number ("iPad 2") when a device that joined earlier already uses it; only earlier
devices count, so names don't flip. Renaming this device in the devices list saves the setting and
overwrites `devices/<me>` at once.

### 12.2 Screens and placement

- **Settings section** `libsync`: title "Library sync", lucide icon `Cloud`, summary "Your library on all
  your devices, end-to-end encrypted". Inserted right before `sync`, whose title "Devices & sync" stays.
  Search keywords: "sync cloud s3 r2 backblaze dropbox devices pair qr".
  - **Off:** three bullets (your own storage; encrypted on the device; every device keeps a full offline
    copy) and two buttons, **Set up sync** and **Join from another device**.
  - **Set up (dialog wizard):**
    1. Storage: S3-compatible, with provider chips R2, B2, AWS, MinIO and Other. Other backends stay
       hidden until they're implemented.
    2. Form, with preset hints and a link to provider docs.
    3. **Test connection** shows the step checklist from `BackendCheck`. When CORS fails, show the rule
       with a Copy button and the provider-specific place to paste it.
    4. **Start syncing**, then progress, then the pairing code.
  - **Join:** camera view with a paste field, then preview ("Synced library: 1,240 songs, 3.2 GB · This
    device: 12 songs"), then a mode choice (radio: new library *recommended* / merge), then progress. The
    user can leave the screen; progress continues in the indicator.
  - **On:**
    - A status card with phase, "Up to date · 2 min ago", pending changes, transfer bars, and "Ready
      offline: 1,238 of 1,240 files".
    - **Sync now** and **Add a device** (QR plus Copy code).
    - The devices list: name, last seen, a "This device" badge with a rename button; retired devices dimmed.
    - Storage: backend label and **Update storage keys**.
    - A **Pause sync** toggle.
    - Danger zone: **Re-check files** (repair), **Stop syncing on this device**, **Delete synced data
      from storage…**.
- **Indicator** `ui/SyncIndicator.tsx`: in `Sidebar.tsx` next to the Settings link, and in the
  SongBrowser header on phones.
  - Icons: `Cloud` (up to date), `CloudUpload` or `CloudDownload` with a progress ring, `CloudOff`
    (offline or paused), `CloudAlert` (error, with a dot).
  - It is a 44 px target that opens a popover with a summary, Sync now, and "Open settings".
  - Hidden when not configured. Never shown in the performance viewer; the existing perf `SyncStatus`
    remains.
- **Pending files:**
  - Song rows show a small `CloudDownload` icon and the caption "Downloading" or "Waiting for upload".
  - `Thumb.tsx` shows a placeholder and retries on `onBlobReady`.
  - Viewer `PageView` (lead patch): on `MissingBlobError`, render `ui/BlobPending.tsx` on the dark stage:
    "Downloading this file… 45%", or offline: "Not downloaded yet. Connect to the internet to get it."
    Retry on ready. Opening a song or setlist calls `prioritizeSongs`.

### 12.3 Wording

Never show "conflict". Use calm, specific wording:

- "Up to date"
- "Uploading 3 files (12 MB)"
- "Downloading 120 files. You can keep using OpenStand."
- "Offline. Changes will sync when you're back online."
- Enable/join steps never show their ids: "Checking the synced library…", "Loading the synced library…
  812 of 1,240", "Adding this device…", "Combining your songs…", "Uploading songs and files…" (join:
  "Uploading this device's songs…"), "Finishing up…". Single-step phases show no "0 of 1".

Each error code below has fixed wording and an action:

| Code | Message | Action |
| --- | --- | --- |
| `auth` | "Your storage rejected the access key. It may have expired or been revoked." | Update storage keys |
| `cors` | "Your bucket doesn't allow this site yet." | Show CORS rule (copy) |
| `quota` | "Your storage is full." | Open provider |
| `localQuota` | "This device is out of space (needs 1.2 GB more)." | Storage settings |
| `clock` | "This device's clock is wrong, so the storage refused the request." | Retry (auto-corrected once) |
| `clockAhead` | "“iPad” has its clock set 3 h ahead. Edits from it may win over newer ones." | none |
| `wrongSecret` | "This code doesn't match the data in that storage." | Join again |
| `libraryGone` | "The synced library was reset or deleted from another device." plus "To keep syncing, get a new pairing code from a device that's still syncing and join again. Your songs stay on this device." | Join with a new code / Stop syncing |
| `newerFormat` | "Another device uses a newer OpenStand. Update this one to keep syncing." | Reload app |
| `rejoin` / `corrupt` | "This device needs to rejoin the synced library." | Rejoin |
| `network` | not an error: phase `offline` | none |

---

## 13. Testing

All libsync tests run with `// @vitest-environment node`. Node 24 provides `crypto.subtle`, `Blob`,
`CompressionStream` and `structuredClone`, and `fake-indexeddb/auto` comes from the setup file. If
fake-indexeddb rejects Node `Blob` values, the engine tests store `Uint8Array` through an injectable
`blobCodec` instead.

Randomised tests use a small seeded PRNG; don't add a dependency.

| Package | Must test |
| --- | --- |
| WP1 | **HLC:** monotonic; same-ms counter; overflow; `receive`; string order equals tuple order; ahead warning. **Merge:** for random delta sets, `mergeDelta` is commutative, associative and idempotent (property test, 1,000 seeds). **Every row in the §5 tables:** concurrent edits of different fields both survive; same field resolves by HLC; set add/remove; list order rule (append without `o`, reorder with `o`, new unknown elements appended by `born`); flat reset; PN counter sums and decrements; max/min; alive and undelete; unknown fields preserved. `project`→`materialize` round-trips for real `Song`/`Setlist`/`PageAnnotations` fixtures. `rebase`. `planJoin`/`joinSong` cases. Layer `current` stays local. |
| WP2 | **Golden vectors:** a fixed secret gives fixed `libraryId`, `roomId` and `blobName`, so a refactor can't silently move every library. Envelope round-trip; wrong AAD fails; any flipped byte, version and epoch included, is `corrupt`; authentic v1 objects are `oldFormat`. Key separation and the nonce derivation checked against node:crypto; a pinned v2 ciphertext; two different files under one claimed hash get different nonces. Downloads of every size reject a hash mismatch. Snapshot header and batch op validation. `get` body caps, linear XML parsing (4 MB < 1 s), bounded `listAll`. **Chunked container** at sizes 0, 1, CHUNK−1, CHUNK, CHUNK+1, 3·CHUNK+5: round-trip; range-resume decrypt from chunk k; deterministic blob ciphertext is byte-identical across runs; a flipped bit, a reordered chunk or a dropped last chunk all fail. Codec NDJSON streaming. Pairing round-trip, garbage input, size ≤ 400 chars for a typical S3 config. **`backendContract(make)` suite**, run against memory: list order, prefix, `startAfter` and pagination; get/head 404 is null; range get; conditional put 412; delete idempotent; `upload` resume after an injected failure at every part. S3 XML parser and error mapping from recorded responses. Relay tests in `server/relay-test.mjs`. |
| WP3 | **Middleware captures every API path:** put, bulkPut, add, `table.update`, `db.table('songs').update`, `Collection.modify`, `delete`, `bulkDelete`, `where().anyOf().delete()`, `clear()`, multi-table transactions, the kv allow-list, and that nothing is captured when the flag is off or the transaction is remote. **Two devices in one process** (two `OpenStandDB` instances, one shared `MemoryBackend`): create, edit, delete propagate; concurrent field edits; annotation add on A while B erases another item; erase propagates; setlist concurrent append and reorder; play counts sum; blob arrives after the song (`useBlobState` goes waiting → downloading → local); upload and download resume after injected failures; third device bootstraps from a snapshot; log pruning followed by gap recovery; stale-device catch-up; join in each mode (`merge` dedupe); replace-restore propagates; prune guard (annotations applied before their song survive `collectGarbage`); annotation store three-way flush and rebased undo; `SongEditor`-style rebase doesn't revert remote edits. Engine uses injectable timers. |
| WP4 | testing-library: wizard validation, pairing paste parsing and errors, error banners per code, indicator states driven by a mocked `useLibSync`. Manual check in the preview browser (light/dark, phone/tablet widths, keyboard). |

**E2E against MinIO** (not in CI; skipped unless the env vars are set). The `minio/minio:latest` image is
already pulled on this machine:

```bash
docker run -d --rm --name openstand-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=openstand -e MINIO_ROOT_PASSWORD=openstand-dev-secret \
  minio/minio:latest server /data --console-address :9001
LIBSYNC_S3_ENDPOINT=http://127.0.0.1:9000 LIBSYNC_S3_KEY=openstand LIBSYNC_S3_SECRET=openstand-dev-secret \
  npx vitest run src/libsync/e2e
docker stop openstand-minio
```

- `src/libsync/e2e/minio.e2e.test.ts` creates the bucket `openstand-e2e-<rand>` with a signed
  `PUT /<bucket>`, runs `backendContract` against `s3.ts` and the two-device scenario through S3 (a 40 MiB
  blob, so multipart runs), then deletes the bucket.
- Browser CORS and UX check: dev server plus the preview tools, with endpoint `http://127.0.0.1:9000`.
  MinIO allows any origin.
- Relay: `npm run cf:dev` and two browser tabs on separate libraries.
- Before release, a manual run on real R2 and B2 with the documented CORS rules.

---

## 14. Work packages

**Step 0 (lead, about 1 hour), done first:**

- Install `aws4fetch`, `lean-qr` and `jsqr`.
- Commit the contracts `src/libsync/model.ts` (§4, §6 types), `backends/types.ts` (§7) and `api.ts`
  (§12.1, with stub implementations: `useLibSync` holds `{phase:'off', configured:false, …}`, functions
  throw `not implemented`).
- Add the Dexie `version(2)` stores to `db.ts`.

From then on, the contracts change only by agreement and additive edits.

| WP | Scope (owns exactly these files) | Builds against | Delivers |
| --- | --- | --- | --- |
| **1. Model and merge** (pure) | `hlc.ts`, `hash.ts`, `fields.ts`, `merge.ts`, `joinPlan.ts` + tests | `model.ts`, `schema.ts` | `project(c, row, ctx)`, `diff(c, proj, shadow, hlc, dev)`, `mergeDelta(state, delta)`, `materialize(c, state, local?)`, `toShadow(state)`, `rebase(c, base, edited, latest)`, `planJoin`, `joinSong`, `syncedKv`, `createClock` |
| **2. Crypto, storage, relay** | `crypto.ts`, `codec.ts`, `paths.ts`, `pairing.ts`, `backends/*`, `worker/index.ts`, `server/relay.mjs`, `server/relay-test.mjs` + tests | `backends/types.ts`, `model.ts` | `deriveLibraryKeys(secret)`, `seal`/`open`, `encryptChunks(ByteSource)`/`decryptChunk`, `blobName`, `sealNotice`/`openNotice`, `encodeBatch`/`decodeBatch`, `writeSnapshot(AsyncIterable<RecordDelta>)`/`readSnapshot(stream)`, `MemoryBackend`, `S3Backend`, `backendContract`, relay lib rooms |
| **3. Engine and DB integration** | `src/db/db.ts`, `src/db/capture.ts`, `state.ts`, `engine.ts`, `apply.ts`, `blobs.ts`, `relay.ts`, `join.ts`, `service.ts`, `api.ts` (replaces the stubs), `src/modules.ts` (one import line), `annotations/store.ts`, `annotations/history.ts`, `SongEditor.tsx` (save), `files/import.ts` (two functions), `libraries.ts` (delete hook), `Welcome.tsx` (`isUntouchedDemo`), plus the patch for the lead (`Viewer.tsx` `recordPlay`) | WP1 and WP2 signatures. Until they land, use the memory backend and trivial merge stubs, or vendor-in from their branches. | A working engine behind `api.ts`, and the two-device integration tests |
| **4. UI** | `src/libsync/ui/*` (`LibrarySyncSettings.tsx`, `SetupWizard.tsx`, `JoinFlow.tsx`, `PairingQr.tsx`, `PairScanner.tsx`, `qr.ts`, `SyncIndicator.tsx`, `BlobPending.tsx`), additive edits in `settings/sections.tsx`, `library/browse/Sidebar.tsx`, `library/Thumb.tsx`, `backup/BackupSettings.tsx`, the `PageView.tsx` patch for the lead | `api.ts` stubs. Uses a dev-only `?libsyncMock=<phase>` switch to drive the states. | All screens in §12 |

**Integration order:**

1. WP1 and WP2 merge as soon as their unit tests pass. They have no dependency on each other.
2. WP3 switches from stubs to the real modules and gets the two-device tests green.
3. WP4 is wired to the real `api.ts`, and the lead applies the viewer patches.
4. MinIO e2e plus a browser run.
5. Docs: a README section, and the "Devices" row in `docs/FEATURES.md`.

Phases 2 and 3 are later WPs that add `backends/dropbox.ts` and so on, plus the Worker OAuth route. They
must pass `backendContract` unchanged.

---

## 15. Decisions (confirmed by the user, 2026-10-24)

1. **New dependencies:** `aws4fetch`, `lean-qr` and `jsqr` (lazy-loaded) are approved.
2. **Remote blob GC:** automatic, with the 30-day grace window and the weekly repair pass (§3.2).
3. **Layer visibility:** synced. Only the *current* layer stays per device.
4. **Joining with a non-empty library:** defaults to a separate new library. Merge is an explicit option.
5. **Wire format v2 without migration** (security review, 2026-10-24): v1 objects are refused with
   `oldFormat` and the user resets sync (§4.4).
6. **`@noble/hashes`** is approved (lazy-loaded) for streaming SHA-256.
7. **No padding:** sizes, counts and timing stay visible to the storage provider, documented in §2.
