// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  S3Backend,
  normalizePrefix,
  parseListObjects,
  parseListParts,
  parseRetryAfter,
  s3Error,
  serverTime,
  xmlDecode,
  xmlText,
} from './s3'
import { BackendError, type S3Config } from './types'

const cfg: S3Config = {
  kind: 's3',
  provider: 'minio',
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'music',
  prefix: 'openstand/',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  pathStyle: true,
}

const xmlErr = (code: string, message = '', extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message>${extra}<RequestId>1</RequestId></Error>`

type Handler = (req: Request) => Response | Promise<Response>

function mockFetch(handler: Handler) {
  const calls: Request[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    calls.push(req)
    return handler(req)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

afterEach(() => S3Backend.resetClockSkew())

describe('S3 XML', () => {
  it('decodes entities', () => {
    expect(xmlDecode('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233; &#x1F3B5; &bogus;')).toBe(`a & b <c> "d" 'e' é 🎵 &bogus;`)
    expect(xmlText('<A><B/></A>', 'B')).toBe('')
    expect(xmlText('<A></A>', 'B')).toBeUndefined()
  })

  it('parses ListObjectsV2 (recorded MinIO response)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>music</Name><Prefix>openstand/os1/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated><NextContinuationToken>MXRlc3Q=/+x</NextContinuationToken><Contents><Key>openstand/os1/a&amp;b</Key><LastModified>2026-10-24T10:00:00.000Z</LastModified><ETag>&#34;d41d8cd98f00b204e9800998ecf8427e&#34;</ETag><Size>0</Size><StorageClass>STANDARD</StorageClass></Contents><Contents><Key>openstand/os1/c</Key><LastModified>2026-10-24T10:00:01.000Z</LastModified><ETag>&quot;abc-2&quot;</ETag><Size>12345</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`
    const r = parseListObjects(xml)
    expect(r.truncated).toBe(true)
    expect(r.next).toBe('MXRlc3Q=/+x')
    expect(r.items).toEqual([
      { key: 'openstand/os1/a&b', size: 0, etag: '"d41d8cd98f00b204e9800998ecf8427e"', lastModified: Date.parse('2026-10-24T10:00:00.000Z') },
      { key: 'openstand/os1/c', size: 12345, etag: '"abc-2"', lastModified: Date.parse('2026-10-24T10:00:01.000Z') },
    ])
    expect(parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ items: [], truncated: false })
  })

  it('parses ListParts', () => {
    const xml = `<ListPartsResult><Bucket>b</Bucket><Key>k</Key><UploadId>u</UploadId><NextPartNumberMarker>2</NextPartNumberMarker><IsTruncated>true</IsTruncated>
<Part><PartNumber>1</PartNumber><LastModified>2026-10-24T10:00:00.000Z</LastModified><ETag>"e1"</ETag><Size>8388832</Size></Part>
<Part><PartNumber>2</PartNumber><ETag>"e2"</ETag><Size>100</Size></Part></ListPartsResult>`
    expect(parseListParts(xml)).toEqual({ parts: [{ n: 1, etag: '"e1"', size: 8388832 }, { n: 2, etag: '"e2"', size: 100 }], truncated: true, next: '2' })
  })
})

describe('S3 error mapping (§7.1)', () => {
  const map = (status: number, body: string, headers?: Record<string, string>) => s3Error(status, body, new Headers(headers))
  it.each([
    [403, xmlErr('InvalidAccessKeyId', 'The Access Key Id you provided does not exist in our records.'), 'auth'],
    [403, xmlErr('SignatureDoesNotMatch'), 'auth'],
    [400, xmlErr('ExpiredToken'), 'auth'],
    [401, '', 'auth'],
    [403, xmlErr('AccessDenied', 'Access Denied'), 'forbidden'],
    [403, xmlErr('AccessDenied', 'Cannot upload files, storage cap exceeded.'), 'quota'],
    [403, xmlErr('QuotaExceeded'), 'quota'],
    [507, xmlErr('XMinioStorageFull', 'Storage backend has reached its minimum free drive threshold.'), 'quota'],
    [503, xmlErr('SlowDown', 'Please reduce your request rate.'), 'rateLimited'],
    [429, '', 'rateLimited'],
    [412, xmlErr('PreconditionFailed'), 'precondition'],
    [409, xmlErr('ConditionalRequestConflict'), 'precondition'],
    [403, xmlErr('RequestTimeTooSkewed', 'The difference between the request time and the server\'s time is too large.'), 'clock'],
    [404, xmlErr('NoSuchBucket'), 'notFound'],
    [404, xmlErr('NoSuchUpload'), 'notFound'],
    [500, xmlErr('InternalError'), 'server'],
    [400, xmlErr('InvalidArgument'), 'unknown'],
  ])('%i %s -> %s', (status, body, code) => {
    const e = map(status, body)
    expect(e).toBeInstanceOf(BackendError)
    expect(e.code).toBe(code)
    expect(e.status).toBe(status)
  })

  it('carries Retry-After and the provider code', () => {
    const e = map(503, xmlErr('SlowDown'), { 'retry-after': '7' })
    expect(e.retryAfterMs).toBe(7000)
    expect(e.providerCode).toBe('SlowDown')
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(parseRetryAfter('soon')).toBeUndefined()
  })

  it('finds the server time in the body or the Date header', () => {
    expect(serverTime(xmlErr('RequestTimeTooSkewed', '', '<ServerTime>2026-10-24T12:00:00Z</ServerTime>'))).toBe(Date.parse('2026-10-24T12:00:00Z'))
    expect(serverTime('', new Headers({ date: 'Sat, 24 Oct 2026 12:00:00 GMT' }))).toBe(Date.parse('2026-10-24T12:00:00Z'))
    expect(serverTime('', new Headers())).toBeNull()
  })
})

describe('S3Backend requests', () => {
  it('builds path-style and virtual-hosted URLs with encoded keys', () => {
    const p = new S3Backend(cfg)
    expect(p.url('os1/a b/ü+&')).toBe('http://127.0.0.1:9000/music/openstand/os1/a%20b/%C3%BC%2B%26')
    expect(p.url(null, { 'list-type': '2', prefix: 'openstand/x/', 'start-after': undefined })).toBe(
      'http://127.0.0.1:9000/music?list-type=2&prefix=openstand%2Fx%2F',
    )
    const v = new S3Backend({ ...cfg, endpoint: 'https://s3.eu-west-1.amazonaws.com/', pathStyle: false, prefix: '' })
    expect(v.url('k')).toBe('https://music.s3.eu-west-1.amazonaws.com/k')
    expect(v.url(null)).toBe('https://music.s3.eu-west-1.amazonaws.com/')
    expect(normalizePrefix('/a/b//')).toBe('a/b/')
    expect(normalizePrefix('')).toBe('')
    expect(new S3Backend({ ...cfg, provider: 'b2', prefix: '' }).label).toBe('Backblaze B2 · music')
  })

  it('signs requests (SigV4) and strips the prefix from listed keys', async () => {
    const m = mockFetch(
      () =>
        new Response(
          '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>openstand/os1/x</Key><Size>3</Size></Contents></ListBucketResult>',
        ),
    )
    const b = new S3Backend(cfg, { fetch: m.fetch, now: () => Date.parse('2026-10-24T10:00:00Z') })
    const page = await b.list('os1/', { startAfter: 'os1/a', limit: 5 })
    expect(page).toEqual({ items: [{ key: 'os1/x', size: 3 }] })
    const req = m.calls[0]
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261024\/us-east-1\/s3\/aws4_request/)
    expect(req.headers.get('x-amz-date')).toBe('20261024T100000Z')
    const u = new URL(req.url)
    expect(u.searchParams.get('start-after')).toBe('openstand/os1/a')
    expect(u.searchParams.get('max-keys')).toBe('5')
  })

  it('maps 404 to null, 416 to empty, and slices when Range is ignored', async () => {
    const m = mockFetch((req) => {
      const key = new URL(req.url).pathname
      if (key.endsWith('/missing')) return new Response(xmlErr('NoSuchKey'), { status: 404 })
      if (key.endsWith('/empty')) return new Response(xmlErr('InvalidRange'), { status: 416 })
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 })
    })
    const b = new S3Backend(cfg, { fetch: m.fetch })
    expect(await b.get('missing')).toBeNull()
    expect(await b.get('empty', { range: [0, 0] })).toEqual(new Uint8Array(0))
    expect(await b.get('x', { range: [1, 2] })).toEqual(new Uint8Array([2, 3]))
    expect(m.calls[2].headers.get('range')).toBe('bytes=1-2')
  })

  it('retries once with a corrected clock on RequestTimeTooSkewed', async () => {
    const serverNow = Date.parse('2026-10-24T12:00:00Z')
    const m = mockFetch((req) => {
      const d = req.headers.get('x-amz-date')!
      const t = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`)
      if (Math.abs(t - serverNow) > 15 * 60_000)
        return new Response(xmlErr('RequestTimeTooSkewed', 'skewed', `<ServerTime>2026-10-24T12:00:00Z</ServerTime>`), { status: 403 })
      return new Response(null, { status: 200 })
    })
    const b = new S3Backend(cfg, { fetch: m.fetch, now: () => serverNow - 3 * 3600_000 })
    await b.put('k', new Uint8Array([1]))
    expect(m.calls.length).toBe(2)
    expect(m.calls[1].headers.get('x-amz-date')).toBe('20261024T120000Z')
    await b.put('k2', new Uint8Array([1])) // the offset is remembered
    expect(m.calls.length).toBe(3)
  })

  it('gives up with `clock` when the server time is unknown', async () => {
    const m = mockFetch(() => new Response(xmlErr('RequestTimeTooSkewed'), { status: 403 }))
    const b = new S3Backend(cfg, { fetch: m.fetch })
    await expect(b.put('k', new Uint8Array(1))).rejects.toMatchObject({ code: 'clock' })
  })

  it('tells CORS from offline with a no-cors probe', async () => {
    const blocked = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 })
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const cors = new S3Backend(cfg, { fetch: blocked }, { corsProbe: true })
    await expect(cors.list('')).rejects.toMatchObject({ code: 'cors' })
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    await expect(new S3Backend(cfg, { fetch: down }, { corsProbe: true }).list('')).rejects.toMatchObject({ code: 'network' })
    const check = await cors.check()
    expect(check.ok).toBe(false)
    expect(check.error?.code).toBe('cors')
    expect(check.steps.map((s) => [s.id, s.ok])).toEqual([
      ['reach', true],
      ['cors', false],
    ])
  })

  it('aborts are passed through untouched', async () => {
    const m = mockFetch(() => new Response(null))
    const ac = new AbortController()
    ac.abort()
    const e = await new S3Backend(cfg, { fetch: m.fetch }).get('k', { signal: ac.signal }).catch((x: unknown) => x)
    expect((e as Error).name).toBe('AbortError')
    expect(m.calls.length).toBe(0)
  })

  it('falls back to plain PUTs when If-None-Match is not implemented', async () => {
    const m = mockFetch((req) =>
      req.headers.get('if-none-match') ? new Response(xmlErr('NotImplemented'), { status: 501 }) : new Response(null, { status: 200 }),
    )
    const b = new S3Backend(cfg, { fetch: m.fetch })
    await b.put('k', new Uint8Array(1), { ifNoneMatch: true })
    expect(b.caps.conditionalPut).toBe(false)
    expect(m.calls.length).toBe(2)
    await b.put('k', new Uint8Array(1), { ifNoneMatch: true })
    expect(m.calls.length).toBe(3)
  })

  it('a multipart part without a readable ETag is a CORS problem', async () => {
    const m = mockFetch((req) => {
      const q = new URL(req.url).searchParams
      if (q.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>')
      return new Response(null, { status: 200 })
    })
    const b = new S3Backend(cfg, { fetch: m.fetch }, { partSize: 64 })
    b.caps.maxSmallPut = 100
    const src = { size: 300, read: async (s: number, e: number) => new Uint8Array(e - s) }
    await expect(b.upload('k', src, {})).rejects.toMatchObject({ code: 'cors' })
  })

  it('CompleteMultipartUpload errors hidden in a 200 body are thrown', async () => {
    let n = 0
    const m = mockFetch((req) => {
      const q = new URL(req.url).searchParams
      if (q.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>')
      if (q.has('partNumber')) return new Response(null, { headers: { etag: `"p${++n}"` } })
      if (req.method === 'POST') return new Response(xmlErr('InternalError', 'We encountered an internal error.'))
      return new Response(null)
    })
    const b = new S3Backend(cfg, { fetch: m.fetch }, { partSize: 64 })
    b.caps.maxSmallPut = 100
    const src = { size: 300, read: async (s: number, e: number) => new Uint8Array(e - s) }
    await expect(b.upload('k', src, {})).rejects.toMatchObject({ code: 'server' })
    const complete = m.calls.at(-1)!
    const body = await complete.text()
    expect(body).toBe(
      '<CompleteMultipartUpload>' +
        [1, 2, 3, 4, 5].map((i) => `<Part><PartNumber>${i}</PartNumber><ETag>"p${i}"</ETag></Part>`).join('') +
        '</CompleteMultipartUpload>',
    )
  })
})
