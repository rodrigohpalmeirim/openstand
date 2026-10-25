import { describe, expect, it } from 'vitest'
import { BackendError, type BackendCheck } from '../backends/types'
import { checkFailureText, checkLabel, emptyForm, formFromConfig, initialWizard, needsCors, stepOrder, toConfig, validateForm, visibleSteps, wizardReducer, type S3Form, type WizardState } from './wizard'

const R2_ID = '0123456789abcdef0123456789abcdef'
const keys = { bucket: 'my-music', accessKeyId: 'AKIA', secretAccessKey: 'shh' }
const form = (p: Partial<S3Form>): S3Form => ({ ...emptyForm(p.provider ?? 'r2'), ...keys, ...p })

describe('validateForm', () => {
  it('asks for every required field', () => {
    const e = validateForm(emptyForm('r2'))
    expect(Object.keys(e).sort()).toEqual(['accessKeyId', 'accountId', 'bucket', 'secretAccessKey'])
  })
  it('checks the R2 account id format', () => {
    expect(validateForm(form({ accountId: 'nope' })).accountId).toMatch(/32/)
    expect(validateForm(form({ accountId: R2_ID }))).toEqual({})
  })
  it('requires a region for B2 and AWS, not for MinIO', () => {
    expect(validateForm(form({ provider: 'b2' })).region).toBeDefined()
    expect(validateForm(form({ provider: 'aws', region: 'eu-central-1' }))).toEqual({})
    expect(validateForm(form({ provider: 'minio', endpoint: 'http://localhost:9000' }), 'http:')).toEqual({})
  })
  it('rejects plain-http endpoints from an https page unless they are local', () => {
    expect(validateForm(form({ provider: 'other', endpoint: 'http://s3.example.com' }), 'https:').endpoint).toMatch(/https/)
    expect(validateForm(form({ provider: 'other', endpoint: 'http://127.0.0.1:9000' }), 'https:')).toEqual({})
    expect(validateForm(form({ provider: 'other', endpoint: 'ftp://x' })).endpoint).toBeDefined()
    expect(validateForm(form({ provider: 'other', endpoint: 'not a url' })).endpoint).toBeDefined()
  })
  it('checks bucket names and the folder', () => {
    expect(validateForm(form({ accountId: R2_ID, bucket: 'My_Bucket' })).bucket).toBeDefined()
    expect(validateForm(form({ accountId: R2_ID, prefix: '../x' })).prefix).toBeDefined()
  })
})

describe('toConfig', () => {
  it('fills the S3 provider presets', () => {
    expect(toConfig(form({ accountId: R2_ID.toUpperCase(), prefix: 'openstand/' }))).toEqual({
      kind: 's3',
      provider: 'r2',
      endpoint: `https://${R2_ID}.r2.cloudflarestorage.com`,
      region: 'auto',
      bucket: 'my-music',
      prefix: 'openstand/',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      pathStyle: true,
    })
    const b2 = toConfig(form({ provider: 'b2', region: 'us-west-004' }))
    expect([b2.endpoint, b2.region, b2.pathStyle]).toEqual(['https://s3.us-west-004.backblazeb2.com', 'us-west-004', true])
    const aws = toConfig(form({ provider: 'aws', region: 'eu-central-1' }))
    expect([aws.endpoint, aws.pathStyle]).toEqual(['https://s3.eu-central-1.amazonaws.com', false])
  })
  it('trims input, normalises the folder and defaults the region', () => {
    const c = toConfig(form({ provider: 'minio', endpoint: ' http://localhost:9000/ ', bucket: ' b-1 ', prefix: '/music', region: '', accessKeyId: ' k ' }))
    expect(c).toMatchObject({ endpoint: 'http://localhost:9000', bucket: 'b-1', prefix: 'music/', region: 'us-east-1', accessKeyId: 'k' })
  })
  it('keeps the path-style choice only for Other', () => {
    expect(toConfig(form({ provider: 'other', endpoint: 'https://x.y', pathStyle: false })).pathStyle).toBe(false)
    expect(toConfig(form({ provider: 'minio', endpoint: 'https://x.y', pathStyle: false })).pathStyle).toBe(true)
  })
  it('round-trips through formFromConfig', () => {
    for (const f of [form({ accountId: R2_ID }), form({ provider: 'b2', region: 'us-west-004' }), form({ provider: 'other', endpoint: 'https://s3.example.com', region: 'x1' })]) {
      const c = toConfig(f)
      expect(toConfig(formFromConfig(c))).toEqual(c)
    }
  })
})

const ok: BackendCheck = { ok: true, steps: [{ id: 'list', ok: true }] }
const cors: BackendCheck = { ok: false, steps: [{ id: 'reach', ok: true }, { id: 'cors', ok: false }], error: new BackendError('cors') }

describe('wizardReducer', () => {
  const step = (s: WizardState, ...a: Parameters<typeof wizardReducer>[1][]) => a.reduce(wizardReducer, s)

  it('walks storage → form, and blocks an invalid form', () => {
    let s = step(initialWizard(), { type: 'next' })
    expect(s.step).toBe('form')
    s = step(s, { type: 'next' })
    expect(s).toMatchObject({ step: 'form', showErrors: true })
  })

  it('only continues past the check when it passed', () => {
    let s = step(initialWizard(), { type: 'next' }, { type: 'checkStart' }, { type: 'checkDone', check: cors })
    expect(s).toMatchObject({ step: 'check', checking: false })
    expect(step(s, { type: 'next' }).step).toBe('check')
    s = step(s, { type: 'checkStart' }, { type: 'checkDone', check: ok }, { type: 'next' })
    expect(s.step).toBe('start')
  })

  it('editing a field or switching provider drops an earlier test result', () => {
    const s = step(initialWizard(), { type: 'checkDone', check: ok })
    expect(step(s, { type: 'field', field: 'bucket', value: 'x' }).check).toBeUndefined()
    const p = step(s, { type: 'provider', provider: 'aws' })
    expect(p.check).toBeUndefined()
    expect(p.form.pathStyle).toBe(false)
  })

  it('start → pair, and failures stay on the start step', () => {
    const s = step(initialWizard(), { type: 'startBegin' })
    expect(s).toMatchObject({ step: 'start', starting: true })
    expect(step(s, { type: 'startFailed', message: 'x' })).toMatchObject({ step: 'start', starting: false, failure: 'x' })
    expect(step(s, { type: 'startDone' })).toMatchObject({ step: 'pair', starting: false })
  })

  it('back is ignored while busy and after starting', () => {
    const busy = step(initialWizard(), { type: 'next' }, { type: 'checkStart' })
    expect(step(busy, { type: 'back' }).step).toBe('check')
    const done = step(initialWizard(), { type: 'startBegin' }, { type: 'startDone' })
    expect(step(done, { type: 'back' }).step).toBe('pair')
    expect(step(initialWizard(), { type: 'next' }, { type: 'back' }).step).toBe('storage')
  })
})

describe('check results', () => {
  it('shows the CORS rule for CORS and ETag failures only', () => {
    expect(needsCors(cors)).toBe(true)
    expect(needsCors({ ok: false, steps: [{ id: 'etag', ok: false }] })).toBe(true)
    expect(needsCors({ ok: false, steps: [{ id: 'auth', ok: false }], error: new BackendError('auth') })).toBe(false)
    expect(needsCors(ok)).toBe(false)
  })
  it('explains failures by code', () => {
    expect(checkFailureText(cors)).toMatch(/doesn’t allow this site/)
    expect(checkFailureText({ ok: false, steps: [], error: new BackendError('auth') })).toMatch(/access key/)
    expect(checkFailureText({ ok: false, steps: [{ id: 'write', ok: false }], error: new BackendError('unknown', 'boom') })).toBe('The test failed at “Write a test file”: boom')
  })
})

describe('drive steps', () => {
  const ok = { ok: true, steps: (['reach', 'auth', 'cors', 'list', 'write', 'etag', 'delete'] as const).map((id) => ({ id, ok: true })) }
  const cfg = { kind: 'dropbox' as const, root: '', account: 'rod@example.com', accountId: 'dbid:1' }

  it('storage → sign in; "Next" never skips the sign-in', () => {
    let s = wizardReducer(initialWizard(), { type: 'storage', storage: 'dropbox' })
    s = wizardReducer(s, { type: 'next' })
    expect(s.step).toBe('signin')
    expect(wizardReducer(s, { type: 'next' }).step).toBe('signin')
    expect(wizardReducer(s, { type: 'back' }).step).toBe('storage')
    expect(stepOrder('gdrive')).toEqual(['storage', 'signin', 'check', 'start', 'pair'])
    expect(initialWizard('onedrive').step).toBe('signin')
  })

  it('a failed redirect stays on the sign-in step with the reason', () => {
    let s = wizardReducer(initialWizard('gdrive'), { type: 'signInStart' })
    expect(s.signingIn).toBe(true)
    expect(wizardReducer(s, { type: 'back' })).toBe(s)
    s = wizardReducer(s, { type: 'signInFailed', problem: { message: 'Sign-in was cancelled.', action: 'retry' } })
    expect(s).toMatchObject({ step: 'signin', signingIn: false, signInError: { message: 'Sign-in was cancelled.' } })
  })

  it('resumes at the check after the redirect, then tests and starts', () => {
    let s = wizardReducer(initialWizard(), { type: 'resume', kind: 'dropbox' })
    expect(s).toMatchObject({ storage: 'dropbox', step: 'check', resuming: true, checking: true })
    expect(wizardReducer(s, { type: 'back' })).toBe(s)
    s = wizardReducer(s, { type: 'signedIn', account: { id: 'dbid:1', email: 'rod@example.com' }, config: cfg })
    expect(s).toMatchObject({ resuming: false, driveConfig: cfg, account: { email: 'rod@example.com' } })
    s = wizardReducer(s, { type: 'checkDone', check: ok })
    s = wizardReducer(s, { type: 'next' })
    expect(s.step).toBe('start')
  })

  it('a failed completion goes back to the sign-in step; Back from the check forgets the account', () => {
    const r = wizardReducer(initialWizard(), { type: 'resume', kind: 'gdrive' })
    expect(wizardReducer(r, { type: 'signInFailed', problem: { message: 'x' } })).toMatchObject({ step: 'signin', resuming: false, checking: false })
    let s = wizardReducer(r, { type: 'signedIn', account: { id: '1' }, config: cfg })
    s = wizardReducer(s, { type: 'checkDone', check: ok })
    s = wizardReducer(s, { type: 'back' })
    expect(s).toMatchObject({ step: 'signin', account: undefined, driveConfig: undefined, check: undefined })
  })

  it('names the drive in the checklist and hides the S3-only steps', () => {
    expect(visibleSteps(ok, 'dropbox').map((st) => st.id)).toEqual(['reach', 'auth', 'list', 'write', 'delete'])
    expect(visibleSteps(ok).length).toBe(7)
    expect(checkLabel('auth', 'gdrive')).toBe('Signed in to Google Drive')
    expect(checkLabel('list', 'onedrive')).toBe('Open the OpenStand folder')
    expect(checkLabel('auth')).toBe('Sign in with the access key')
  })

  it('explains drive check failures', () => {
    const fail = (code: BackendError['code']) => ({ ok: false, steps: [{ id: 'auth' as const, ok: false }], error: new BackendError(code) })
    expect(checkFailureText(fail('forbidden'), 'gdrive')).toBe('Google Drive refused access to the OpenStand folder.')
    expect(checkFailureText(fail('quota'), 'dropbox')).toBe('Your Dropbox storage is full.')
    expect(checkFailureText(fail('network'), 'onedrive')).toBe('Can’t reach OneDrive. Check your connection.')
    expect(checkFailureText(fail('unknown'), 'dropbox')).toBe('The test failed at “Signed in to Dropbox”.')
  })
})
