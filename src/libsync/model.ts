/**
 * Library sync: shared wire and state types.
 *
 * CONTRACT: change only additively.
 * Type-only apart from the tuning constants and `PairingError`; safe to import from anywhere.
 */
import type { BackendConfig, OAuthKind, TokenSet, UploadState } from './backends/types'
import type { AudioTrack, KV, PageAnnotations, Setlist, Song, SongFile } from '../db/schema'

// ---------------------------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------------------------

/**
 * Hybrid logical clock timestamp: `${wall 12 hex}${counter 4 hex}${deviceId 16 hex}`, 32 chars.
 * Fixed width, so plain string comparison is the (causal-or-arbitrary) total order.
 */
export type Hlc = string

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** Synced record kinds. `ann` = one annotation page, `kv` = an allow-listed kv key. */
export type Collection = 'song' | 'setlist' | 'ann' | 'kv'

/** The local row type each collection is projected from / materialised into. */
export interface CollectionRows {
  song: Song
  setlist: Setlist
  ann: PageAnnotations
  kv: KV
}

/**
 * A partial (batch op) or full (snapshot line) state of one record. Same type for both.
 *
 * `id` is `Song.id` | `Setlist.id` | `${songId}:${fileId}:${page}` | kv key, by `c`.
 */
export interface RecordDelta {
  c: Collection
  id: string
  /** Alive register. A delete sets `[hlc, false]`; putting a row with a dead id is an undelete. */
  a?: [Hlc, boolean]
  /** LWW registers. `[hlc]` = unset/undefined. Flattened (`flat`) objects use dotted paths (`metronome.bpm`). */
  f?: Record<string, [Hlc] | [Hlc, Json]>
  /** Max/min registers; the kind comes from the field table. No hlc. */
  m?: Record<string, number>
  /** Keyed lists, maps and sets. */
  l?: Record<string, ListDelta>
  /** PN-counters: field -> deviceId -> [inc, dec], full per-device totals. Total = max(0, Σinc − Σdec). */
  n?: Record<string, Record<string, [number, number]>>
}

export interface ListDelta {
  /**
   * Explicit order register (lists/sets only). Emitted only when materialising without it would give a
   * different order, i.e. real reorders, never plain appends or edits.
   */
  o?: [Hlc, string[]]
  /** Element key -> [hlc, value | null (= tombstone), bornHlc]. */
  e?: Record<string, [Hlc, Json | null, Hlc]>
}

/** One sealed log entry `os1/<libraryId>/log/<d>/<seq10>`. */
export interface Batch {
  v: 1
  /** deviceId (also bound by the envelope AAD). */
  d: string
  /** seq (also bound by the envelope AAD). */
  s: number
  /** Wall ms when built. */
  t: number
  hlcMax: Hlc
  ops: RecordDelta[]
  /** SHA-256 hex of blobs this device has finished uploading (wakes `waiting` downloads). */
  blobsReady?: string[]
}

/**
 * `files` list element value on the wire. `SongFile.blobId` never travels; `blob` is the content
 * SHA-256 hex. `blob: ''` means the sending device itself lacked the file data. The element key is the
 * `SongFile.id`.
 */
export type WireSongFile = Omit<SongFile, 'id' | 'blobId'> & { blob: string; mime: string }

/** `audio` list element value on the wire. URL-only tracks have no `blob`. Key = `AudioTrack.id`. */
export type WireAudioTrack = Omit<AudioTrack, 'id' | 'blobId'> & { blob?: string; mime?: string }

/** Plaintext of `os1/<libraryId>/meta`. Written once; decrypting it on join proves the key. */
export interface MetaRecord {
  v: 1
  createdAt: number
  name: string
}

/** Plaintext of `os1/<libraryId>/devices/<dev>`. */
export interface DeviceRecord {
  v: 1
  id: string
  name: string
  platform: string
  appVersion: string
  createdAt: number
  lastSeenAt: number
  /** Set on leave. A retired device never writes again, so others may prune its keys. */
  retired?: boolean
}

/**
 * Snapshot line 1. Every following NDJSON line is a full `RecordDelta` (all registers,
 * tombstones included).
 */
export interface SnapshotHeader {
  v: 1
  kind: 'snapshot'
  /** Writing deviceId. */
  d: string
  /** Snapshot number (the `<n10>` in its key). */
  n: number
  /** Wall ms when written. */
  t: number
  /** deviceId -> highest contiguous seq merged in (`vector[d]` = last uploaded own seq). */
  vector: Record<string, number>
  /** Number of `RecordDelta` lines that follow. */
  records: number
  hlcMax: Hlc
  /**
   * What this snapshot dropped, as wall-clock ms cut-offs: dead records' field values with an `a`
   * hlc older than `deadFields`, element tombstones older than `elementTombs`. Compare an `Hlc` against
   * these via its wall part (`parseHlc(h).wall`).
   */
  horizon: { deadFields: number; elementTombs: number }
}

/**
 * Plaintext of a relay notice: device `d` has written up to seq `s`. A plain notice has no `k`.
 * `k: 'ping'` asks the room's other devices to answer with a `pong` addressed `to` the pinger, echoing the
 * nonce `p`. Older builds sent pings from a "Test instant sync" button; current ones only answer them. Both
 * still carry the sender's head in `s` (≥ 0), so devices that predate them read them as plain notices.
 */
export interface NoticePayload {
  d: string
  s: number
  k?: 'ping' | 'pong'
  /** ping/pong: random nonce (8–32 base64url chars). */
  p?: string
  /** pong: the device id that sent the ping. */
  to?: string
}

/**
 * Relay text frame. `n` = base64url(sealed(JSON NoticePayload)), aad `os1|notice|${roomId}`,
 * not gzipped. ≤ 1 KiB.
 */
export interface NoticeFrame {
  v: 1
  n: string
}

// ---------------------------------------------------------------------------------------------
// Pairing (the payload type lives here because api.ts exposes it before pairing.ts exists;
// pairing.ts re-exports it and owns encode/decode)
// ---------------------------------------------------------------------------------------------

/**
 * What a QR / text pairing code carries. Text form: `"OSJ1." + base64url(deflateRaw(JSON))`.
 * OAuth backends carry `{kind, root | folder, account?, accountId?}` in `b`: the account fields are
 * non-secret hints for "sign in with the same account". Never OAuth tokens: each
 * device signs in by itself.
 */
export interface PairingPayload {
  v: 1
  /** Library secret, base64url. */
  s: string
  /** Library name. */
  n?: string
  b: BackendConfig
  /** Relay base; `null` = polling only. */
  r?: string | null
}

export type PairingErrorCode = 'format' | 'version'

/** Thrown by `decodePairing` / `parsePairingCode`: `format` = not a code, `version` = newer code format. */
export class PairingError extends Error {
  readonly code: PairingErrorCode
  constructor(code: PairingErrorCode, message?: string) {
    super(message ?? (code === 'version' ? 'Pairing code is from a newer OpenStand' : 'Not a valid pairing code'))
    this.name = 'PairingError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------
// HLC (implementation in hlc.ts, which re-exports this interface)
// ---------------------------------------------------------------------------------------------

export interface HlcClock {
  /** max(last.wall, wall); the counter increments within the same ms, and on overflow wall goes up by 1. */
  now(wall?: number): Hlc
  /**
   * Standard HLC receive. A remote wall > CLOCK_AHEAD_WARN ahead still advances the clock (and warns); one
   * more than CLOCK_AHEAD_MAX ahead, or a malformed value, is refused: returns false, clock untouched.
   */
  receive(remote: Hlc, wall?: number): boolean
  /** Persisted with every batch build and every apply (`syncState.clock`). */
  readonly last: Hlc
}

// ---------------------------------------------------------------------------------------------
// Local state (Dexie version(2) tables)
// ---------------------------------------------------------------------------------------------

/**
 * What the network knows about a record: hlcs and value hashes, no values (the value lives in the row).
 * Table `syncShadow`, indexes `id, c`.
 */
export interface ShadowRecord {
  id: string
  c: Collection
  a?: [Hlc, boolean]
  /** field -> [hlc, valueHash]; `''` = unset. */
  f: Record<string, [Hlc, string]>
  m: Record<string, number>
  /** list field -> order register + element key -> [hlc, valueHash ('' = tombstone), bornHlc]. */
  l: Record<string, { o?: [Hlc, string[]]; e: Record<string, [Hlc, string, Hlc]> }>
  n: Record<string, Record<string, [number, number]>>
  /** Opaque state of an unknown collection, kept and included in our snapshots. */
  x?: unknown
}

/** Table `syncDirty`, indexes `id, deferredSince`. Written by the capture middleware. */
export interface DirtyRow {
  /** `${c}/${recordId}` */
  id: string
  /** Wall ms of the last local write; used as the HLC wall when diffing. */
  at: number
  /** Set by the `ann` orphan guard; dropped after DIRTY_DEFER_MAX. */
  deferredSince?: number
}

/** Table `syncOutbox`, primary key `seq`. A sealed batch waiting to be pushed. */
export interface OutboxRow {
  seq: number
  /** Sealed envelope bytes. */
  bytes: Uint8Array
  /** Number of ops in the batch. */
  ops: number
  hlcMax: Hlc
  blobsReady: string[]
}

export type TransferDir = 'up' | 'down'

/** `waiting` = the remote blob 404'd; waiting for its uploader. */
export type TransferState = 'queued' | 'active' | 'waiting' | 'failed'

/** Table `syncTransfers`, primary key `[dir+hash]`, indexes `state, priority`. */
export interface TransferRow {
  dir: TransferDir
  /** Content SHA-256 hex. */
  hash: string
  /** Plaintext size in bytes. */
  size: number
  mime: string
  state: TransferState
  /** Higher first. `prioritizeSongs` adds 1000. */
  priority: number
  attempts: number
  /** Wall ms before which the row isn't retried. */
  nextAt: number
  error?: string
  /** Backend resumable-upload state. */
  upload?: UploadState
  /** down: number of contiguous decrypted chunks already stored in `syncChunks`. */
  doneChunks?: number
}

/** Table `syncChunks`, primary key `[hash+index]`: decrypted download parts. */
export interface ChunkRow {
  hash: string
  index: number
  data: Blob
}

/** `syncState.config`. */
export interface SyncConfig {
  v: 1
  /** Raw library secret, base64url (pairing has to display it). */
  secret: string
  libraryId: string
  roomId: string
  deviceId: string
  backend: BackendConfig
  /** Relay base URL; `null` = polling only. */
  relay: string | null
  /** Library name (also in `meta` and the pairing payload). */
  name: string
  joinedAt: number
  paused: boolean
}

export type JoinMode = 'here' | 'newLibrary' | 'merge'

/**
 * Join progress checkpoint steps.
 * - `bootstrap`: streaming the snapshot then the logs (capture flag off)
 * - `register`: capture flag on, new deviceId, `devices/<me>` written
 * - `merge`: join-merge transaction (merge mode only)
 * - `publish`: marking local-only records dirty
 */
export type JoinPhase = 'bootstrap' | 'register' | 'merge' | 'publish'

/** `syncState.join`: present only while a join is in progress. Every step is idempotent. */
export interface JoinCheckpoint {
  phase: JoinPhase
  mode: JoinMode
  startedAt: number
  /** Merge mode: values of the synced kv keys stashed before bootstrap (step 5). */
  stash?: Record<string, unknown>
  /** Key of the snapshot being bootstrapped from, if any. */
  snapshot?: string
}

/** `syncState.maintenance`: wall ms of the last run of each task. */
export interface MaintenanceState {
  snapshotAt: number
  pruneAt: number
  gcAt: number
  repairAt: number
}

/** Typed `syncState` key -> value map. */
export interface SyncStateValues {
  config: SyncConfig
  /** Last `Hlc` (clock.last). */
  clock: Hlc
  /** Next own seq, allocated when a batch is sealed. */
  seq: { next: number }
  /** deviceId -> last merged seq. */
  cursors: Record<string, number>
  /** Last time fully caught up; `seq` = own last pushed seq then (older states lack it). */
  lastSync: { at: number; hlc: Hlc; seq?: number }
  /** Cached snapshot headers by storage key. */
  snapshots: Record<string, SnapshotHeader>
  /** Cached `devices/*`. */
  devices: DeviceRecord[]
  maintenance: MaintenanceState
  join: JoinCheckpoint
  /** OAuth tokens. Per device and library, never shared, synced or backed up. */
  oauth: Partial<Record<OAuthKind, TokenSet>>
}

export type SyncStateKey = keyof SyncStateValues

/** Table `syncState`, primary key `key`. */
export type SyncStateRow = { [K in SyncStateKey]: { key: K; value: SyncStateValues[K] } }[SyncStateKey]

// ---------------------------------------------------------------------------------------------
// Size limits and tuning constants
// ---------------------------------------------------------------------------------------------

const KiB = 1024
const MiB = 1024 * KiB
const DAY = 24 * 60 * 60 * 1000

/** Batch limits: ≤ `ops` ops or ≤ `bytes` of JSON before gzip; one op alone may be up to `opBytes`. */
export const BATCH_MAX = { ops: 500, bytes: 1 * MiB, opBytes: 16 * MiB } as const
export const NOTICE_MAX = 1 * KiB
export const CAPTURE_DEBOUNCE = 1500
/** Pull interval: `visible` normally, `relay` while the relay is open (a safety net for missed notices). */
export const POLL = { visible: 30_000, relay: 60_000 } as const
/** Chunked-container chunk size (log2Chunk = 20). */
export const CHUNK = 1 * MiB
/** Ciphertext at or below this goes up in a single PUT; above it, multipart/resumable. */
export const SINGLE_PUT_MAX = 16 * MiB
/** Multipart part size, in chunks. */
export const PART = 8
/** Download range size, in chunks. */
export const RANGE = 4
export const SNAPSHOT_TRIGGER = { batches: 500, bytes: 8 * MiB, minInterval: DAY } as const
export const LOG_RETENTION = { age: 14 * DAY, snapshotAge: DAY } as const
export const BLOB_GC_GRACE = 30 * DAY
export const BLOB_GC_INTERVAL = 7 * DAY
export const DEAD_FIELDS_TTL = 30 * DAY
export const ELEMENT_TOMB_TTL = 180 * DAY
export const DIRTY_DEFER_MAX = DAY
export const CLOCK_AHEAD_WARN = 5 * 60 * 1000
/** Remote timestamps further ahead than this never advance the clock; ops carrying them wait (or are dropped). */
export const CLOCK_AHEAD_MAX = DAY
/** A batch with ops ahead by more than CLOCK_AHEAD_MAX but at most this waits for time to catch up; beyond it they are dropped. */
export const CLOCK_AHEAD_STALL = 30 * DAY
/** Wire `size` claims above this are treated as unknown (0): a lying peer can't fake an out-of-space error. */
export const BLOB_CLAIM_MAX = 4 * 1024 * MiB
export const MULTIPART_STALE = 6 * DAY
