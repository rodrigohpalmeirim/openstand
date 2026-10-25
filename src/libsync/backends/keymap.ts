/**
 * Key ↔ drive path mapping shared by the cloud-drive backends (docs/SYNC-DRIVES.md §2.5, §4.2, §4.3).
 *
 * Keys are lowercase ASCII `[a-z0-9./-]` segments joined by `/` (Dropbox and OneDrive paths are
 * case-insensitive). Anything else throws `BackendError('unknown', …, {providerCode: 'BadKey'})`, so a
 * future key format fails loudly in tests rather than colliding on a drive.
 */
import { BackendError } from './types'

/** How many leading segments become real folders on OneDrive, and get `d1..d3` on Drive. */
export const MAX_DEPTH = 3

const SEGMENT = /^[a-z0-9.-]+$/
const PARTIAL = /^[a-z0-9.-]*$/

const bad = (what: string, key: string, why: string) =>
  new BackendError('unknown', `Invalid storage ${what} ${JSON.stringify(key)}: ${why}`, { providerCode: 'BadKey' })

/**
 * Checks one segment. Empty segments (`''`, `a//b`, a leading or trailing `/`), `~`, non-ASCII and
 * upper case are refused; so is a trailing `.` (OneDrive refuses it, and it rules out `.` and `..`).
 */
function checkSegment(seg: string, key: string, what: string): void {
  if (!seg) throw bad(what, key, 'empty segment')
  if (!SEGMENT.test(seg)) throw bad(what, key, 'only a-z 0-9 . - are allowed')
  if (seg.endsWith('.')) throw bad(what, key, 'a segment may not end with "."')
}

/** The key's `/`-separated segments, validated. */
export function segments(key: string): string[] {
  if (typeof key !== 'string' || !key) throw bad('key', String(key), 'empty')
  const segs = key.split('/')
  for (const s of segs) checkSegment(s, key, 'key')
  return segs
}

/**
 * OneDrive (§4.2): the first `min(n−1, 3)` segments are real folders, the rest is the file name with
 * `/` replaced by `~`. `os1/<lib>/heads/<dev>/<seq>` → folder `[os1, <lib>, heads]`, leaf `<dev>~<seq>`.
 */
export function deep3(key: string): { folder: string[]; leaf: string } {
  const segs = segments(key)
  const depth = Math.min(segs.length - 1, MAX_DEPTH)
  return { folder: segs.slice(0, depth), leaf: segs.slice(depth).join('~') }
}

/** Inverse of `deep3`. Throws `BadKey` for a name `deep3` can't have produced (e.g. a stray file). */
export function fromDeep3(folder: string[], leaf: string): string {
  if (folder.length > MAX_DEPTH) throw bad('path', [...folder, leaf].join('/'), 'too deep')
  const rest = leaf.split('~')
  // `~` only appears below a full-depth folder: shallower keys have a single-segment leaf.
  if (rest.length > 1 && folder.length < MAX_DEPTH) throw bad('path', [...folder, leaf].join('/'), 'unexpected "~"')
  const key = [...folder, ...rest].join('/')
  segments(key)
  return key
}

/**
 * Drive (§4.3): `d1..d3` = the key's first 1, 2 and 3 segments, set only when they are proper folder
 * prefixes. `os1/<lib>/heads/<dev>/<seq>` → `{d1: 'os1', d2: 'os1/<lib>', d3: 'os1/<lib>/heads'}`;
 * `os1/<lib>/meta` → `{d1, d2}`.
 */
export function dirProps(key: string): { d1?: string; d2?: string; d3?: string } {
  const segs = segments(key)
  const out: { d1?: string; d2?: string; d3?: string } = {}
  const depth = Math.min(segs.length - 1, MAX_DEPTH)
  if (depth >= 1) out.d1 = segs[0]
  if (depth >= 2) out.d2 = segs.slice(0, 2).join('/')
  if (depth >= 3) out.d3 = segs.slice(0, 3).join('/')
  return out
}

/**
 * The deepest complete folder of a list prefix, capped at 3 segments: `os1/<lib>/heads/` →
 * `{folder: [os1, <lib>, heads], depth: 3}`; `os1/<lib>/log/<dev>/` → the same depth-3 folder
 * (`log`); `os1/<lib>/he` → `[os1, <lib>]`; `''` → `[]`. Callers list that folder (or `d<depth>`) and then
 * filter by `startsWith(prefix)`. The partial last segment may be empty or end with `.`.
 */
export function prefixScope(prefix: string): { folder: string[]; depth: number } {
  if (typeof prefix !== 'string') throw bad('prefix', String(prefix), 'not a string')
  const segs = prefix.split('/')
  const partial = segs.pop()!
  if (!PARTIAL.test(partial)) throw bad('prefix', prefix, 'only a-z 0-9 . - are allowed')
  for (const s of segs) checkSegment(s, prefix, 'prefix')
  const folder = segs.slice(0, MAX_DEPTH)
  return { folder, depth: folder.length }
}
