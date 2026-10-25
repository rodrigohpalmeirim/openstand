import { describe, expect, it } from 'vitest'
import { LibSyncFailure, offStatus, type LibSyncErrorCode, type LibSyncStatus } from '../api'
import { controls, downloadLine, errorText, failureText, fmtBytes, pairingWarning, indicatorState, initialLine, phaseLine, relayNote, stepLabel, syncProblem, timeAgo, uploadLine } from './format'

const NOW = 1_800_000_000_000
const on = (p: Partial<LibSyncStatus> = {}): LibSyncStatus => ({ ...offStatus(), configured: true, phase: 'idle', ...p })
const tp = (files: number, doneFiles: number, bytes = 0, doneBytes = 0) => ({ files, doneFiles, bytes, doneBytes })

describe('error wording', () => {
  it('status lines', () => {
    expect(phaseLine(on({ lastSyncAt: NOW - 2 * 60_000 }), NOW)).toBe('Up to date · 2 min ago')
    expect(phaseLine(on())).toBe('Up to date')
    expect(phaseLine(on({ phase: 'offline' }))).toBe('Offline. Changes will sync when you’re back online.')
    expect(uploadLine(tp(3, 0, 12e6))).toBe('Uploading 3 files (12 MB)')
    expect(downloadLine(tp(125, 5))).toBe('Downloading 120 files. You can keep using OpenStand.')
  })

  it('fixed message and action per error code', () => {
    const t = (code: LibSyncErrorCode, message: string = code, detail?: string) => errorText({ code, message, detail })
    expect(t('auth')).toMatchObject({ message: 'Your storage rejected the access key. It may have expired or been revoked.', actionLabel: 'Update storage keys' })
    expect(t('cors')).toMatchObject({ message: 'Your bucket doesn’t allow this site yet.', actionLabel: 'Show CORS rule' })
    expect(t('quota')).toMatchObject({ message: 'Your storage is full.', actionLabel: 'Open provider' })
    expect(t('localQuota', 'localQuota', '1200000000')).toMatchObject({ message: 'This device is out of space (needs 1.2 GB more).', actionLabel: 'Storage settings' })
    expect(t('clock')).toMatchObject({ message: 'This device’s clock is wrong, so the storage refused the request.', actionLabel: 'Retry' })
    expect(t('clockAhead', '“iPad” has its clock set 3 h ahead. Edits from it may win over newer ones.')).toMatchObject({
      message: '“iPad” has its clock set 3 h ahead. Edits from it may win over newer ones.',
      warning: true,
    })
    expect(t('clockAhead').action).toBeUndefined()
    expect(t('wrongSecret')).toMatchObject({ message: 'This code doesn’t match the data in that storage.', actionLabel: 'Join again' })
    expect(t('libraryGone')).toMatchObject({
      message: 'The synced library was reset or deleted from another device.',
      actionLabel: 'Join with a new code',
      secondaryLabel: 'Stop syncing',
    })
    expect(t('libraryGone').hint).toMatch(/new pairing code from a device that’s still syncing/)
    expect(t('newerFormat')).toMatchObject({ message: 'Another device uses a newer OpenStand. Update this one to keep syncing.', actionLabel: 'Reload app' })
    expect(t('rejoin')).toMatchObject({ message: 'This device needs to rejoin the synced library.', actionLabel: 'Rejoin' })
    expect(t('corrupt')).toMatchObject({ message: 'This device needs to rejoin the synced library.', actionLabel: 'Rejoin' })
  })

  it('never says "conflict"', () => {
    const codes: LibSyncErrorCode[] = ['auth', 'cors', 'quota', 'localQuota', 'network', 'clock', 'clockAhead', 'wrongSecret', 'libraryGone', 'newerFormat', 'corrupt', 'rejoin', 'server', 'unknown']
    for (const code of codes) expect(errorText({ code, message: code }).message.toLowerCase()).not.toContain('conflict')
  })

  it('formats sizes and ages', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(3.2e9)).toBe('3.2 GB')
    expect(timeAgo(NOW - 10_000, NOW)).toBe('just now')
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe('3 h ago')
    expect(timeAgo(NOW - 26 * 3600_000, NOW)).toBe('yesterday')
  })
})

describe('indicatorState', () => {
  it('up to date, offline, paused', () => {
    expect(indicatorState(on()).icon).toBe('cloud')
    expect(indicatorState(on({ phase: 'offline' })).icon).toBe('off')
    expect(indicatorState(on({ phase: 'paused' })).icon).toBe('off')
  })
  it('transfers show a progress ring, downloads first', () => {
    expect(indicatorState(on({ phase: 'syncing', upload: tp(4, 1, 100, 25) }))).toMatchObject({ icon: 'upload', progress: 0.25 })
    expect(indicatorState(on({ phase: 'syncing', upload: tp(4, 1), download: tp(10, 5, 200, 50) }))).toMatchObject({ icon: 'download', progress: 0.25 })
    expect(indicatorState(on({ phase: 'starting', initial: { kind: 'join', step: 's', done: 1, total: 4 } }))).toMatchObject({ icon: 'download', progress: 0.25 })
  })
  it('errors get an alert with a dot; warnings do not', () => {
    expect(indicatorState(on({ phase: 'error', error: { code: 'auth', message: 'x', at: 0 } }))).toMatchObject({ icon: 'alert', dot: true })
    expect(indicatorState(on({ error: { code: 'clockAhead', message: 'x', at: 0 } })).icon).toBe('cloud')
  })
})

describe('non-fatal stream warnings', () => {
  const unknown = { code: 'unknown' as const, message: 'Changes from “iPad” can’t be read right now. Other devices keep syncing.', at: 0 }
  const newer = { code: 'newerFormat' as const, message: '“Pixel 8” uses a newer OpenStand. Update this one to get its changes.', at: 0 }
  // The service mirrors the warning into `error` while the phase isn't `error`.
  const warned = on({ phase: 'idle', streams: { a: unknown, b: newer }, warning: unknown, error: unknown })

  it('are warnings, not errors: no red dot, a softer amber one, normal icon', () => {
    expect(syncProblem(warned).error).toBeUndefined()
    const st = indicatorState(warned)
    expect(st).toMatchObject({ icon: 'cloud', warn: true })
    expect(st.dot).toBeFalsy()
    expect(st.label).toContain('“iPad”')
  })

  it('use the engine’s device-specific sentences, one per device, with a retry note and an update action', () => {
    expect(syncProblem(warned).warning).toEqual({
      lines: [unknown.message, newer.message],
      note: 'OpenStand keeps retrying in the background.',
      action: 'reload',
      actionLabel: 'Reload app',
    })
    expect(syncProblem(on({ warning: { code: 'unknown', message: 'unknown', at: 0 } })).warning?.lines).toEqual(['Some changes from another device couldn’t be applied yet.'])
  })

  it('a real fatal error still shows as an error', () => {
    const fatal = on({ phase: 'error', error: { code: 'unknown', message: 'unknown', at: 0 }, streams: { a: unknown } })
    expect(syncProblem(fatal)).toEqual({ error: fatal.error })
    expect(indicatorState(fatal)).toMatchObject({ icon: 'alert', dot: true })
    expect(syncProblem(on({ phase: 'offline', error: { code: 'network', message: 'x', at: 0 } }))).toEqual({})
  })
})

describe('enable/join steps', () => {
  const ids = ['verify', 'bootstrap', 'register', 'merge', 'publish', 'snapshot', 'somethingNew']
  it('every checkpoint phase has friendly wording; no raw identifier reaches the screen', () => {
    for (const kind of ['upload', 'join'] as const)
      for (const step of ids) {
        const label = stepLabel({ kind, step })
        expect(label).not.toContain(step)
        expect(label).toMatch(/^[A-Z].*…$/)
      }
  })
  it('right after a reset: "Uploading songs and files…" without "0 of 1"', () => {
    expect(initialLine({ kind: 'upload', step: 'publish', done: 0, total: 1 })).toBe('Uploading songs and files…')
    expect(initialLine({ kind: 'join', step: 'bootstrap', done: 812, total: 1240 })).toBe('Loading the synced library… 812 of 1,240')
    expect(initialLine({ kind: 'join', step: 'publish', done: 0, total: 1 })).toBe('Uploading this device’s songs…')
  })
  it('the status card headline during the first upload', () => {
    expect(phaseLine(on({ phase: 'starting', initial: { kind: 'upload', step: 'publish', done: 0, total: 1 } }))).toBe('Uploading your library…')
  })
})

describe('failure toasts', () => {
  it('never show a bare code', () => {
    expect(failureText(new LibSyncFailure('unknown', 'unknown'))).toBe('Something went wrong while syncing.')
    expect(failureText(new LibSyncFailure('libraryGone', 'libraryGone'))).toBe('The synced library was reset or deleted from another device.')
    expect(failureText(new LibSyncFailure('unknown', 'Library sync is not running'))).toBe('Library sync is not running')
    expect(failureText(new Error('TypeError'))).toBe('Something went wrong. Try again.')
    expect(failureText(new Error('Couldn’t reach the bucket.'))).toBe('Couldn’t reach the bucket.')
  })
})

describe('controls per state', () => {
  const err = (code: LibSyncErrorCode) => on({ phase: 'error', error: { code, message: code, at: 0 } })
  it('library gone or unreadable: only the banner’s actions', () => {
    for (const code of ['libraryGone', 'wrongSecret'] as const)
      expect(controls(err(code))).toMatchObject({ syncNow: false, addDevice: false, storageKeys: false, pause: false, recheck: false })
    expect(controls(err('libraryGone')).deleteRemote).toBe(false)
  })
  it('rejoin/corrupt: no pairing code or sync, storage keys stay', () => {
    for (const code of ['rejoin', 'corrupt'] as const) expect(controls(err(code))).toMatchObject({ syncNow: false, addDevice: false, storageKeys: true })
  })
  it('newer format elsewhere: no Sync now, pairing still fine', () => {
    expect(controls(err('newerFormat'))).toMatchObject({ syncNow: false, addDevice: true })
  })
  it('retryable errors, paused, offline', () => {
    expect(controls(err('auth'))).toMatchObject({ syncNow: true, syncNowOff: undefined, addDevice: true, storageKeys: true })
    expect(controls(on({ phase: 'paused' }))).toMatchObject({ syncNow: true, syncNowOff: 'Sync is paused.', addDevice: true, pause: true })
    expect(controls(on({ phase: 'offline' })).syncNowOff).toBeUndefined()
  })
})

describe('instant updates: never a bare "off"', () => {
  it('the status card notes it while syncing runs', () => {
    expect(relayNote(on({ relay: 'open', relayConfigured: true }))).toBe('Instant updates on')
    expect(relayNote(on({ relay: 'off', relayConfigured: false }))).toBe('Instant updates off: no relay configured')
    expect(relayNote(on({ relay: 'error', relayConfigured: true }))).toBe('Instant updates reconnecting')
    expect(relayNote(on({ relay: 'connecting', relayConfigured: true }))).toBe('Instant updates connecting…')
    expect(relayNote(on({ phase: 'paused', relay: 'off' }))).toBeUndefined()
    expect(relayNote(on({ phase: 'offline', relay: 'error' }))).toBeUndefined()
  })
})

describe('cloud drives', () => {
  const t = (code: LibSyncErrorCode, kind?: Parameters<typeof errorText>[1], want?: string, message: string = code) => errorText({ code, message }, kind, want)
  it('names the provider and offers to sign in again', () => {
    expect(t('reauth', 'gdrive')).toMatchObject({
      message: 'Sign in to Google Drive again to keep syncing. Your changes are kept on this device until then.',
      action: 'signIn',
      actionLabel: 'Sign in again',
    })
    expect(t('auth', 'dropbox')).toMatchObject({ message: 'Dropbox refused access to the OpenStand folder.', actionLabel: 'Sign in again' })
    expect(t('quota', 'onedrive')).toMatchObject({ message: 'Your OneDrive storage is full.', action: 'openProvider', actionLabel: 'Open OneDrive' })
  })
  it('wrong account: whose drive the library is in, and another account', () => {
    expect(t('wrongAccount', 'dropbox', 'rod@example.com')).toMatchObject({
      message: 'This library is in rod@example.com’s Dropbox, not in the account you signed in with.',
      actionLabel: 'Sign in with another account',
    })
    expect(t('wrongAccount', 'gdrive').message).toBe('This library isn’t in the Google Drive account you signed in with.')
  })
  it('S3 wording is unchanged; the new codes have a fallback without a kind', () => {
    expect(t('auth', 's3').actionLabel).toBe('Update storage keys')
    expect(t('quota').actionLabel).toBe('Open provider')
    expect(t('reauth').actionLabel).toBe('Sign in again')
    expect(t('wrongAccount').actionLabel).toBe('Sign in with another account')
  })
  it('the status headline uses the backend kind', () => {
    expect(phaseLine(on({ phase: 'error', backendKind: 'dropbox', error: { code: 'reauth', message: 'reauth', at: 0 } }))).toBe(
      'Sign in to Dropbox again to keep syncing. Your changes are kept on this device until then.',
    )
  })
  it('signed out: no Sync now or Re-check until signed in; Sign in again and pairing stay', () => {
    for (const code of ['reauth', 'wrongAccount'] as const)
      expect(controls(on({ phase: 'error', backendKind: 'gdrive', error: { code, message: code, at: 0 } }))).toMatchObject({ syncNow: false, recheck: false, storageKeys: true, addDevice: true })
  })
  it('toasts name the drive too', () => {
    expect(failureText(new LibSyncFailure('reauth'), undefined, 'onedrive')).toBe('Sign in to OneDrive again to keep syncing. Your changes are kept on this device until then.')
  })
})

describe('pairing-code warning per backend', () => {
  it('S3 codes carry the storage keys; drive codes the library key and account, never a sign-in', () => {
    expect(pairingWarning('s3')).toBe('Anyone with this code can read and change your library and use your storage keys.')
    expect(pairingWarning(undefined)).toBe(pairingWarning('s3'))
    const g = pairingWarning('gdrive')
    expect(g).toMatch(/^Treat this code like a password: anyone with it can read and change your library\./)
    expect(g).toMatch(/names your Google Drive account but holds no sign-in, so the other device still signs in to Google Drive with the same account/)
    expect(g).not.toMatch(/storage keys/)
  })
})
