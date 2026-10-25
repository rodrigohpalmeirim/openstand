/** Setup-wizard state: S3 provider presets, form validation and the step machine. Pure. */
import type { AccountInfo, BackendCheck, BackendCheckStepId, BackendConfig, BackendDescription, OAuthKind, S3Config, S3Provider } from '../backends/types'
import { drive, type SignInProblem } from './signin'

export interface ProviderPreset {
  id: S3Provider
  label: string
  /** Long name for the storage label and docs. */
  name: string
  /** Fields the form asks for besides bucket and keys. */
  asks: ('accountId' | 'region' | 'endpoint')[]
  regionPlaceholder?: string
  pathStyle: boolean
  hint: string
  docs?: { label: string; url: string }
  /** Where the CORS rule goes. */
  corsWhere: string
  /** Provider console, for "Your storage is full" and key rotation. */
  console?: string
  /** How to replace the storage keys: create a new one, then revoke the old one. */
  rotate: string
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'r2',
    label: 'R2',
    name: 'Cloudflare R2',
    asks: ['accountId'],
    pathStyle: true,
    hint: 'Create an R2 API token with “Object Read & Write” permission, limited to this bucket. The account ID is on the R2 overview page.',
    docs: { label: 'R2 API tokens', url: 'https://developers.cloudflare.com/r2/api/tokens/' },
    corsWhere: 'In the Cloudflare dashboard open R2 → your bucket → Settings → CORS policy → Add CORS policy, and paste the rule.',
    console: 'https://dash.cloudflare.com/?to=/:account/r2/overview',
    rotate: 'In the Cloudflare dashboard open R2 → Manage API tokens. Create a new token with “Object Read & Write” for this bucket only. After the reset, delete the old token there.',
  },
  {
    id: 'b2',
    label: 'B2',
    name: 'Backblaze B2',
    asks: ['region'],
    regionPlaceholder: 'us-west-004',
    pathStyle: true,
    hint: 'Create an application key restricted to this bucket. The region is part of the bucket’s S3 endpoint. B2 bills listing after 2,500 calls a day; with three devices that is about $0.01 a month.',
    docs: { label: 'B2 S3-compatible API', url: 'https://www.backblaze.com/docs/cloud-storage-s3-compatible-api' },
    corsWhere: 'Run this with the Backblaze command-line tool: b2 bucket update --cors-rules \'<rule>\' <bucket>. The web console can’t set the headers OpenStand needs.',
    console: 'https://secure.backblaze.com/b2_buckets.htm',
    rotate: 'In the Backblaze console open Application Keys and add a new key restricted to this bucket. After the reset, delete the old key there.',
  },
  {
    id: 'aws',
    label: 'AWS',
    name: 'Amazon S3',
    asks: ['region'],
    regionPlaceholder: 'eu-central-1',
    pathStyle: false,
    hint: 'Use an IAM user whose policy only allows this bucket. Add a lifecycle rule that aborts incomplete multipart uploads after 7 days.',
    docs: { label: 'S3 CORS configuration', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/enabling-cors-examples.html' },
    corsWhere: 'In the AWS console open S3 → your bucket → Permissions → Cross-origin resource sharing (CORS) → Edit, and paste the rule.',
    console: 'https://console.aws.amazon.com/s3/',
    rotate: 'In the AWS console open IAM → Users → the sync user → Security credentials and create a new access key. After the reset, deactivate and delete the old key there.',
  },
  {
    id: 'minio',
    label: 'MinIO',
    name: 'MinIO',
    asks: ['endpoint', 'region'],
    regionPlaceholder: 'us-east-1',
    pathStyle: true,
    hint: 'Use an access key whose policy only allows this bucket.',
    docs: { label: 'MinIO documentation', url: 'https://min.io/docs/minio/linux/index.html' },
    corsWhere: 'MinIO allows every site by default. If you set MINIO_API_CORS_ALLOW_ORIGIN, add this site to it. The rule below works with mc too.',
    rotate: 'In the MinIO console open Access Keys (or use mc admin accesskey) and create a new key limited to this bucket. After the reset, delete the old key there.',
  },
  {
    id: 'other',
    label: 'Other',
    name: 'S3-compatible storage',
    asks: ['endpoint', 'region'],
    regionPlaceholder: 'us-east-1',
    pathStyle: true,
    hint: 'Any storage with an S3-compatible API. Use keys limited to this bucket if your provider allows it.',
    corsWhere: 'Paste the rule into your provider’s CORS settings for this bucket.',
    rotate: 'In your provider’s console create a new access key, limited to this bucket if possible. After the reset, delete or disable the old key there.',
  },
]

export const preset = (id: S3Provider) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]

export interface S3Form {
  provider: S3Provider
  accountId: string
  region: string
  endpoint: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  pathStyle: boolean
}

export const DEFAULT_PREFIX = 'openstand/'

export function emptyForm(provider: S3Provider = 'r2'): S3Form {
  return { provider, accountId: '', region: '', endpoint: '', bucket: '', prefix: DEFAULT_PREFIX, accessKeyId: '', secretAccessKey: '', pathStyle: preset(provider).pathStyle }
}

/** Prefill from a saved config (e.g. "Update storage keys"). */
export function formFromConfig(c: S3Config): S3Form {
  const r2 = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com\/?$/i.exec(c.endpoint)
  return {
    provider: c.provider,
    accountId: c.provider === 'r2' && r2 ? r2[1] : '',
    region: c.provider === 'r2' ? '' : c.region,
    endpoint: c.provider === 'minio' || c.provider === 'other' ? c.endpoint : '',
    bucket: c.bucket,
    prefix: c.prefix,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    pathStyle: c.pathStyle,
  }
}

export type FormErrors = Partial<Record<keyof S3Form, string>>

const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')

/** Field-level problems; empty when the form can be tested. `pageProtocol` is for the mixed-content check. */
export function validateForm(f: S3Form, pageProtocol = typeof location === 'undefined' ? 'https:' : location.protocol): FormErrors {
  const e: FormErrors = {}
  const asks = preset(f.provider).asks
  if (asks.includes('accountId')) {
    if (!f.accountId.trim()) e.accountId = 'Enter your Cloudflare account ID.'
    else if (!/^[0-9a-f]{32}$/i.test(f.accountId.trim())) e.accountId = 'The account ID is 32 letters and digits (0–9, a–f).'
  }
  if (asks.includes('region') && f.provider !== 'minio' && f.provider !== 'other' && !f.region.trim()) e.region = 'Enter the bucket’s region.'
  if (asks.includes('region') && f.region.trim() && !/^[a-z0-9-]+$/i.test(f.region.trim())) e.region = 'A region looks like “us-west-004”.'
  if (asks.includes('endpoint')) {
    const raw = f.endpoint.trim()
    let url: URL | null = null
    try {
      url = new URL(raw)
    } catch {
      /* invalid */
    }
    if (!raw) e.endpoint = 'Enter the storage address.'
    else if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) e.endpoint = 'Enter a full address, like https://s3.example.com.'
    else if (url.protocol === 'http:' && pageProtocol === 'https:' && !isLocalHost(url.hostname))
      e.endpoint = 'This page is served over https, so the browser only allows an https address (or one on this computer).'
  }
  const bucket = f.bucket.trim()
  if (!bucket) e.bucket = 'Enter the bucket name.'
  else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) e.bucket = 'Bucket names use 3–63 lowercase letters, digits, dots and hyphens.'
  if (/^\/|\.\.|\\/.test(f.prefix.trim())) e.prefix = 'Use a plain folder name, like “openstand/”.'
  if (!f.accessKeyId.trim()) e.accessKeyId = 'Enter the access key ID.'
  if (!f.secretAccessKey.trim()) e.secretAccessKey = 'Enter the secret access key.'
  return e
}

const normPrefix = (p: string) => {
  const t = p.trim().replace(/^\/+/, '')
  return t === '' ? '' : t.endsWith('/') ? t : `${t}/`
}

/** The `BackendConfig` a valid form describes (endpoints per the presets). */
export function toConfig(f: S3Form): S3Config {
  const region = f.region.trim()
  const endpoint =
    f.provider === 'r2'
      ? `https://${f.accountId.trim().toLowerCase()}.r2.cloudflarestorage.com`
      : f.provider === 'b2'
        ? `https://s3.${region}.backblazeb2.com`
        : f.provider === 'aws'
          ? `https://s3.${region}.amazonaws.com`
          : f.endpoint.trim().replace(/\/+$/, '')
  return {
    kind: 's3',
    provider: f.provider,
    endpoint,
    region: f.provider === 'r2' ? 'auto' : region || 'us-east-1',
    bucket: f.bucket.trim(),
    prefix: normPrefix(f.prefix),
    accessKeyId: f.accessKeyId.trim(),
    secretAccessKey: f.secretAccessKey.trim(),
    pathStyle: f.provider === 'other' ? f.pathStyle : preset(f.provider).pathStyle,
  }
}

/* ------------------------------------------------------------------ Steps */

/**
 * S3: storage → form → check → start → pair. Cloud drives: storage → signin → (redirect
 * to the provider and back) → check → start → pair.
 */
export type WizardStep = 'storage' | 'form' | 'signin' | 'check' | 'start' | 'pair'

/** Where the library goes: an S3-compatible bucket or a cloud drive. */
export type StorageChoice = 's3' | OAuthKind

export interface WizardState {
  step: WizardStep
  storage: StorageChoice
  form: S3Form
  /** Show field errors only after the first attempt to continue. */
  showErrors: boolean
  checking: boolean
  check?: BackendCheck
  /** A thrown (not reported) failure of the check or the start. */
  failure?: string
  starting: boolean
  /** Drives: leaving for the provider's sign-in page (the page is about to unload). */
  signingIn?: boolean
  /** Drives: finishing a sign-in that came back from the provider. */
  resuming?: boolean
  /** Drives: why the last sign-in didn't work (shown on the sign-in step). */
  signInError?: SignInProblem
  /** Drives: who signed in. */
  account?: AccountInfo
  /** Drives: the config `driveBackendConfig` made after sign-in (what `enableSync` gets). */
  driveConfig?: BackendConfig
  /** Drives: where the data lives and free space (`describeBackend`; optional). */
  description?: BackendDescription
}

export type WizardAction =
  | { type: 'storage'; storage: StorageChoice }
  | { type: 'provider'; provider: S3Provider }
  | { type: 'field'; field: keyof S3Form; value: string | boolean }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'checkStart' }
  | { type: 'checkDone'; check: BackendCheck }
  | { type: 'checkFailed'; message: string }
  | { type: 'startBegin' }
  | { type: 'startDone' }
  | { type: 'startFailed'; message: string }
  /** Drives: about to redirect to the provider. */
  | { type: 'signInStart' }
  /** Drives: the redirect didn't happen, or the sign-in came back with an error. */
  | { type: 'signInFailed'; problem: SignInProblem }
  /** Drives: a sign-in came back from the provider and is being completed. */
  | { type: 'resume'; kind: OAuthKind }
  /** Drives: signed in, and the drive's config is ready for the connection test. */
  | { type: 'signedIn'; account: AccountInfo; config: BackendConfig }
  | { type: 'described'; description: BackendDescription }

export const initialWizard = (storage: StorageChoice = 's3'): WizardState => ({
  step: storage === 's3' ? 'storage' : 'signin',
  storage,
  form: emptyForm(),
  showErrors: false,
  checking: false,
  starting: false,
})

const S3_ORDER: WizardStep[] = ['storage', 'form', 'check', 'start', 'pair']
const DRIVE_ORDER: WizardStep[] = ['storage', 'signin', 'check', 'start', 'pair']
export const stepOrder = (storage: StorageChoice) => (storage === 's3' ? S3_ORDER : DRIVE_ORDER)

/** Forgets everything a drive sign-in produced (another storage, or "Back" to the sign-in step). */
const noDrive = { account: undefined, driveConfig: undefined, description: undefined, check: undefined, signInError: undefined, failure: undefined }

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case 'storage':
      return s.step === 'storage' && a.storage !== s.storage ? { ...s, ...noDrive, storage: a.storage } : s
    case 'provider':
      return { ...s, form: { ...s.form, provider: a.provider, pathStyle: preset(a.provider).pathStyle }, check: undefined, failure: undefined }
    case 'field':
      // Any edit invalidates an earlier connection test.
      return { ...s, form: { ...s.form, [a.field]: a.value }, check: undefined, failure: undefined }
    case 'next': {
      if (s.step === 'form' && Object.keys(validateForm(s.form)).length) return { ...s, showErrors: true }
      if (s.step === 'check' && !s.check?.ok) return s
      // A drive moves past the sign-in step only by coming back from the provider.
      if (s.step === 'signin') return s
      const order = stepOrder(s.storage)
      const i = order.indexOf(s.step)
      return { ...s, step: order[Math.min(order.length - 1, i + 1)], failure: undefined }
    }
    case 'back': {
      if (s.checking || s.starting || s.signingIn || s.resuming || s.step === 'pair') return s
      const order = stepOrder(s.storage)
      const i = order.indexOf(s.step)
      const step = order[Math.max(0, i - 1)]
      return { ...s, ...(step === 'signin' || step === 'storage' ? noDrive : {}), step, failure: undefined }
    }
    case 'checkStart':
      return { ...s, step: 'check', checking: true, check: undefined, failure: undefined }
    case 'checkDone':
      return { ...s, checking: false, check: a.check }
    case 'checkFailed':
      return { ...s, checking: false, resuming: false, failure: a.message }
    case 'startBegin':
      return { ...s, step: 'start', starting: true, failure: undefined }
    case 'startDone':
      return { ...s, starting: false, step: 'pair' }
    case 'startFailed':
      return { ...s, starting: false, failure: a.message }
    case 'signInStart':
      return s.storage === 's3' ? s : { ...s, signingIn: true, signInError: undefined }
    case 'signInFailed':
      return s.storage === 's3' ? s : { ...s, ...noDrive, step: 'signin', signingIn: false, resuming: false, checking: false, signInError: a.problem }
    case 'resume':
      return { ...s, ...noDrive, storage: a.kind, step: 'check', resuming: true, checking: true, signingIn: false }
    case 'signedIn':
      return { ...s, resuming: false, account: a.account, driveConfig: a.config }
    case 'described':
      return { ...s, description: a.description }
  }
}

export const CHECK_LABEL: Record<BackendCheckStepId, string> = {
  reach: 'Reach the storage',
  auth: 'Sign in with the access key',
  cors: 'Allow this site (CORS)',
  list: 'List the bucket',
  write: 'Write a test file',
  read: 'Read it back',
  range: 'Read part of a file',
  etag: 'See upload receipts (ETag)',
  conditional: 'Safe writes (If-None-Match)',
  delete: 'Delete the test file',
}

/** Optional steps don't block syncing (conditional puts just aren't used when missing). */
export const OPTIONAL_STEPS: BackendCheckStepId[] = ['conditional']

/** Steps that only mean something for S3: not shown for a drive. */
const S3_ONLY: BackendCheckStepId[] = ['cors', 'etag']

/** The checklist label for a step; drives name the sign-in and their folder. */
export function checkLabel(id: BackendCheckStepId, storage: StorageChoice = 's3'): string {
  if (storage !== 's3' && id === 'auth') return `Signed in to ${drive(storage).name}`
  if (storage !== 's3' && id === 'list') return 'Open the OpenStand folder'
  if (storage !== 's3' && id === 'reach') return `Reach ${drive(storage).name}`
  return CHECK_LABEL[id]
}

/** The steps to list for this storage. */
export const visibleSteps = (check: BackendCheck | undefined, storage: StorageChoice = 's3') =>
  (check?.steps ?? []).filter((st) => storage === 's3' || !S3_ONLY.includes(st.id))

/** The sentence for a failed check, by `BackendError` code. */
export function checkFailureText(check: BackendCheck, storage: StorageChoice = 's3'): string {
  if (storage !== 's3') {
    const name = drive(storage).name
    switch (check.error?.code) {
      case 'reauth':
        return `${name} wants you to sign in again.`
      case 'auth':
      case 'forbidden':
        return `${name} refused access to the OpenStand folder.`
      case 'network':
        return `Can’t reach ${name}. Check your connection.`
      case 'quota':
        return `Your ${name} storage is full.`
      case 'rateLimited':
        return `${name} is busy right now. Wait a minute, then test again.`
      case 'server':
        return `${name} had a problem answering. Test again in a moment.`
      default: {
        const failed = visibleSteps(check, storage).find((st) => !st.ok && !OPTIONAL_STEPS.includes(st.id))
        return `The test failed${failed ? ` at “${checkLabel(failed.id, storage)}”` : ''}${check.error?.message && /\s/.test(check.error.message) ? `: ${check.error.message}` : '.'}`
      }
    }
  }
  switch (check.error?.code) {
    case 'cors':
      return 'Your bucket doesn’t allow this site yet. Add the CORS rule below, then test again.'
    case 'auth':
      return 'The storage rejected the access key. Check the key ID and secret.'
    case 'forbidden':
      return 'The key works, but it isn’t allowed to use this bucket. Give it read and write access to the bucket.'
    case 'notFound':
      return 'There is no bucket with that name at this address.'
    case 'network':
      return 'Can’t reach the storage. Check the address and your connection.'
    case 'clock':
      return 'This device’s clock is wrong, so the storage refused the request.'
    case 'quota':
      return 'Your storage is full.'
    default: {
      if (check.error?.providerCode === 'NotS3') return 'This address doesn’t look like S3 storage. Check the endpoint.'
      const failed = check.steps.find((s) => !s.ok)
      return failed?.id === 'etag'
        ? 'The bucket hides upload receipts. Add “ETag” to the exposed headers of the CORS rule below.'
        : `The test failed${failed ? ` at “${CHECK_LABEL[failed.id]}”` : ''}${check.error?.message ? `: ${check.error.message}` : '.'}`
    }
  }
}

/** Whether to show the CORS rule after a check. */
export const needsCors = (check?: BackendCheck) =>
  !!check && !check.ok && (check.error?.code === 'cors' || check.steps.some((s) => !s.ok && (s.id === 'cors' || s.id === 'etag')))
