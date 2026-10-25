// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { backendContract } from './contract.test-helper'
import { createBackend } from './index'
import { MemoryBackend } from './memory'
import { BackendError } from './types'
import { listAll } from './util'

let n = 0
backendContract('memory', () => new MemoryBackend(`contract-${n++}`, { caps: { maxSmallPut: 1000 }, partSize: 300, maxPage: 4 }))

backendContract('memory without conditional put', () => {
  const b = new MemoryBackend(`contract-plain-${n++}`, { caps: { maxSmallPut: 2000 }, partSize: 512 })
  b.caps.conditionalPut = false
  return b
})

describe('MemoryBackend', () => {
  it('instances with the same name share one store', async () => {
    const a = new MemoryBackend('shared-1')
    const b = new MemoryBackend('shared-1')
    await a.put('k', new Uint8Array([1]))
    expect(await b.get('k')).toEqual(new Uint8Array([1]))
    MemoryBackend.reset('shared-1')
    expect(await b.get('k')).toBeNull()
  })

  it('injects faults per op, key and count, before or after the effect', async () => {
    const b = new MemoryBackend('faults')
    b.failNext('put', { key: 'x' })
    await expect(b.put('x', new Uint8Array([1]))).rejects.toMatchObject({ code: 'network' })
    expect(await b.head('x')).toBeNull()
    await b.put('x', new Uint8Array([1]))

    b.failNext('put', { after: true, error: new BackendError('server', 'lost response', { status: 500 }) })
    await expect(b.put('y', new Uint8Array([2]))).rejects.toMatchObject({ code: 'server' })
    expect(await b.get('y')).toEqual(new Uint8Array([2])) // landed anyway

    const off = b.fail({ op: ['get', 'head'], key: /^z/, times: Infinity })
    await expect(b.get('z1')).rejects.toBeInstanceOf(BackendError)
    await expect(b.head('z2')).rejects.toBeInstanceOf(BackendError)
    expect(await b.get('x')).not.toBeNull()
    off()
    expect(await b.get('z1')).toBeNull()
    expect(b.calls.filter((c) => c.op === 'put').length).toBe(3)
  })

  it('a hook sees every op and can fail it', async () => {
    const seen: string[] = []
    const b = new MemoryBackend('hook', {
      hook: (op, key) => {
        seen.push(`${op}:${key}`)
        if (key === 'bad') throw new BackendError('forbidden')
      },
    })
    await b.put('ok', new Uint8Array(0))
    await expect(b.get('bad')).rejects.toMatchObject({ code: 'forbidden' })
    expect(seen).toEqual(['put:ok', 'get:bad'])
  })

  it('upload resumes after a lost part response (part stored server-side, not in state)', async () => {
    const b = new MemoryBackend('lost-part', { caps: { maxSmallPut: 100 }, partSize: 100 })
    const data = new Uint8Array(450).map((_, i) => i & 255)
    let last: import('./types').UploadState | undefined
    b.failNext('uploadPart', { after: true }) // part 1 lands, the response is lost
    const reads: number[] = []
    const src = { size: data.length, read: async (s: number, e: number) => {
        reads.push(s)
        return data.slice(s, e)
      },
    }
    await expect(b.upload('obj', src, { onState: async (s) => void (last = s) })).rejects.toBeInstanceOf(BackendError)
    expect(last?.done).toBe(0)
    reads.length = 0
    await b.upload('obj', src, { state: last })
    expect(reads[0]).toBe(116) // part 2: the server already had part 1 (16 B head + 100)
    expect(await b.get('obj')).toEqual(data)
    expect(b.pendingUploads()).toBe(0)
  })

  it('aborted signals reject before touching the store', async () => {
    const b = new MemoryBackend('abort')
    const ac = new AbortController()
    ac.abort()
    await expect(b.put('k', new Uint8Array(1), { signal: ac.signal })).rejects.toThrow()
    expect(await b.head('k')).toBeNull()
  })

  it('check() reports the conditional capability', async () => {
    const b = new MemoryBackend('check')
    const r = await b.check()
    expect(r.ok).toBe(true)
    expect(b.caps.conditionalPut).toBe(true)
    b.failNext('get')
    const bad = await b.check()
    expect(bad.ok).toBe(false)
    expect(bad.error?.code).toBe('network')
    expect(bad.steps.find((s) => s.id === 'read')?.ok).toBe(false)
  })
})

describe('createBackend', () => {
  it('builds memory, s3 and the cloud-drive backends', () => {
    expect(createBackend({ kind: 'memory', name: 'f' })).toBeInstanceOf(MemoryBackend)
    const s3 = createBackend({
      kind: 's3', provider: 'r2', endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', bucket: 'b',
      prefix: 'openstand/', accessKeyId: 'k', secretAccessKey: 's', pathStyle: true,
    })
    expect(s3.kind).toBe('s3')
    expect(s3.label).toBe('Cloudflare R2 · b/openstand')
    expect(createBackend({ kind: 'dropbox', root: '' }).kind).toBe('dropbox')
    expect(createBackend({ kind: 'gdrive', folder: '1AbCdEfGhIjK', account: 'rod@example.com' }).label).toBe('Google Drive · rod@example.com')
    expect(createBackend({ kind: 'onedrive', folder: '' }).kind).toBe('onedrive')
    expect(() => createBackend({ kind: 'icloud' } as never)).toThrow(BackendError)
  })
})

describe('listAll (bounded)', () => {
  it('collects every page, and stops with a clear error past maxKeys or on a looping cursor', async () => {
    const b = new MemoryBackend(`listall-${Date.now()}`, { maxPage: 3 })
    for (let i = 0; i < 10; i++) await b.put(`p/${i}`, new Uint8Array(1))
    expect((await listAll(b, 'p/')).map((o) => o.key)).toEqual(Array.from({ length: 10 }, (_, i) => `p/${i}`))
    await expect(listAll(b, 'p/', { maxKeys: 9 })).rejects.toMatchObject({ code: 'unknown', providerCode: 'TooManyKeys' })
    const looping = { ...b, caps: b.caps, list: async () => ({ items: [{ key: 'p/x', size: 1 }], cursor: 'same' }) } as unknown as MemoryBackend
    await expect(listAll(looping, 'p/')).rejects.toMatchObject({ providerCode: 'ListLoop' })
  })

  it('get caps bodies like S3: maxBytes without a range, the range length with one', async () => {
    const b = new MemoryBackend(`cap-${Date.now()}`, { caps: { rangeGet: false } })
    await b.put('k', new Uint8Array(100))
    expect((await b.get('k', { maxBytes: 100 }))!.length).toBe(100)
    await expect(b.get('k', { maxBytes: 99 })).rejects.toMatchObject({ providerCode: 'TooLarge' })
    expect((await b.get('k', { range: [0, 199] }))!.length).toBe(100)
    await expect(b.get('k', { range: [0, 9] })).rejects.toMatchObject({ providerCode: 'RangeIgnored' })
  })
})
