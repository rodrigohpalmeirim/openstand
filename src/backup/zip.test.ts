// @vitest-environment node
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { MemorySink, ZipReader, ZipWriter, crc32 } from './zip'

async function build(zip64 = false) {
  const sink = new MemorySink()
  const w = new ZipWriter(sink, { zip64 })
  await w.addText('manifest.json', JSON.stringify({ hello: 'wörld' }))
  const bin = new Uint8Array(70000).map((_, i) => (i * 31) & 0xff)
  // A local-header-like signature inside binary data must not confuse anything.
  bin.set([0x50, 0x4b, 0x07, 0x08], 100)
  await w.addBlob('blobs/a', new Blob([bin]))
  await w.addBytes('empty', new Uint8Array(0))
  await w.finish()
  return { blob: sink.blob(), bin }
}

describe('zip', () => {
  it('computes CRC-32', () => {
    expect(crc32(strToU8('123456789')).toString(16)).toBe('cbf43926')
  })

  it('round-trips through its own reader', async () => {
    for (const z64 of [false, true]) {
      const { blob, bin } = await build(z64)
      const r = await ZipReader.open(blob)
      expect([...r.entries.keys()]).toEqual(['manifest.json', 'blobs/a', 'empty'])
      expect(await r.json('manifest.json')).toEqual({ hello: 'wörld' })
      expect(await r.bytes('blobs/a')).toEqual(bin)
      expect((await r.blob('blobs/a', 'application/pdf')).type).toBe('application/pdf')
      expect((await r.bytes('empty')).length).toBe(0)
    }
  })

  it('is readable by other zip implementations', async () => {
    const { blob, bin } = await build()
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
    expect(new TextDecoder().decode(files['manifest.json'])).toContain('wörld')
    expect(files['blobs/a']).toEqual(bin)
  })

  it('reads archives written by other tools', async () => {
    const data = zipSync({ 'a.txt': strToU8('hi'), 'dir/b.bin': [new Uint8Array([1, 2, 3]), { level: 0 }] })
    const r = await ZipReader.open(new Blob([data as BlobPart]))
    expect(await r.text('a.txt')).toBe('hi')
    expect(await r.bytes('dir/b.bin')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects non-zip data', async () => {
    await expect(ZipReader.open(new Blob(['not a zip at all, sorry']))).rejects.toThrow(/ZIP/)
  })
})
