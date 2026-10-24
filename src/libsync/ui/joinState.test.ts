import { describe, expect, it } from 'vitest'
import { LibSyncFailure, type JoinPreview } from '../api'
import { PairingError, type PairingPayload } from '../model'
import { initialJoin, joinErrorText, joinReducer, joinTarget, mergeLine, previewLine, type JoinAction, type JoinState } from './joinState'

const payload = { v: 1, s: 'x', b: { kind: 'memory', name: 'm' } } as PairingPayload
const preview: JoinPreview = { remoteSongs: 1240, remoteBytes: 3.2e9, localSongs: 12, matches: 3, suggested: 'newLibrary' }
const run = (...a: JoinAction[]) => a.reduce(joinReducer, initialJoin() as JoinState)

describe('joinReducer', () => {
  it('scan → checking → preview with the suggested mode', () => {
    expect(run({ type: 'code' }).step).toBe('checking')
    const s = run({ type: 'code' }, { type: 'parsed', payload }, { type: 'previewed', preview: { ...preview, suggested: 'here' } })
    expect(s).toMatchObject({ step: 'preview', mode: 'here', payload })
  })

  it('defaults to a separate new library when this device has songs', () => {
    expect(run({ type: 'code' }, { type: 'parsed', payload }, { type: 'previewed', preview }).mode).toBe('newLibrary')
  })

  it('a bad code returns to scanning with the error', () => {
    expect(run({ type: 'code' }, { type: 'failed', error: 'nope' })).toMatchObject({ step: 'scan', error: 'nope' })
  })

  it('a failed join returns to the preview so it can be retried', () => {
    const s = run({ type: 'code' }, { type: 'parsed', payload }, { type: 'previewed', preview }, { type: 'mode', mode: 'merge' }, { type: 'join' }, { type: 'failed', error: 'x' })
    expect(s).toMatchObject({ step: 'preview', mode: 'merge', error: 'x', payload })
    expect(joinReducer(s, { type: 'join' })).toMatchObject({ step: 'joining', error: undefined })
  })

  it('mode and join only apply on the preview', () => {
    expect(run({ type: 'mode', mode: 'merge' }).mode).toBe('newLibrary')
    expect(run({ type: 'join' }).step).toBe('scan')
  })

  it('back from the preview starts over', () => {
    expect(run({ type: 'code' }, { type: 'parsed', payload }, { type: 'previewed', preview }, { type: 'back' })).toEqual(initialJoin())
  })
})

describe('wording', () => {
  it('explains pairing-code problems', () => {
    expect(joinErrorText(new PairingError('format'))).toMatch(/isn’t an OpenStand pairing code/)
    expect(joinErrorText(new PairingError('version'))).toMatch(/newer OpenStand/)
  })
  it('uses the §12.3 wording for facade failures', () => {
    expect(joinErrorText(new LibSyncFailure('wrongSecret'))).toBe('This code doesn’t match the data in that storage.')
    expect(joinErrorText(new LibSyncFailure('libraryGone'))).toBe('The synced library was reset or deleted from another device.')
    expect(joinErrorText(new LibSyncFailure('network'))).toMatch(/Can’t reach/)
  })
  it('previews and merge lines', () => {
    expect(previewLine(preview)).toEqual({ remote: 'Synced library: 1,240 songs, 3.2 GB', local: 'This device: 12 songs' })
    expect(previewLine({ ...preview, localSongs: 1 }, 'Band').remote).toBe('“Band”: 1,240 songs, 3.2 GB')
    expect(mergeLine(preview)).toBe('3 of your songs are already in the synced library and will be combined; 9 will be added.')
    expect(mergeLine({ ...preview, matches: 0 })).toBe('12 songs from this device will be added to the synced library.')
  })
})

describe('joinTarget', () => {
  const s3 = (endpoint: string, over: Partial<import('../backends/types').S3Config> = {}) =>
    ({ v: 1, s: 'x', b: { kind: 's3', provider: 'other', endpoint, region: 'auto', bucket: 'music', prefix: 'openstand/', accessKeyId: 'a', secretAccessKey: 'b', pathStyle: true, ...over } }) as PairingPayload

  it('shows the endpoint host, bucket and relay host', () => {
    expect(joinTarget({ ...s3('https://acc.r2.cloudflarestorage.com'), r: 'wss://relay.example.org/relay' }, { host: 'app.test' })).toEqual({
      storage: 'acc.r2.cloudflarestorage.com',
      bucket: 'music/openstand/',
      relay: 'relay.example.org',
      insecure: false,
    })
    expect(joinTarget({ ...s3('https://s3.eu-central-1.amazonaws.com', { pathStyle: false }), r: '/relay' }, { host: 'app.test' })).toMatchObject({
      storage: 'music.s3.eu-central-1.amazonaws.com',
      relay: 'app.test (this site)',
    })
    expect(joinTarget({ ...s3('https://x.test'), r: null }).relay).toBeUndefined()
  })

  it('flags plain http except to this machine', () => {
    expect(joinTarget(s3('http://evil.example.com:9000')).insecure).toBe(true)
    expect(joinTarget(s3('http://192.168.1.20:9000')).insecure).toBe(true)
    expect(joinTarget(s3('http://localhost:9000')).insecure).toBe(false)
    expect(joinTarget(s3('http://127.0.0.1:9000')).insecure).toBe(false)
    expect(joinTarget(s3('https://s3.example.com')).insecure).toBe(false)
  })

  it('handles non-S3 backends', () => {
    expect(joinTarget(payload)).toEqual({ storage: 'memory', relay: undefined, insecure: false })
  })
})
