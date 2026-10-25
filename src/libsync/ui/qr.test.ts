import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePixels, fitWithin, nativeDetector, qrBitmap, qrPixels, scanFrames } from './qr'

// A realistic S3 pairing code is about 300 characters.
const CODE = `OSJ1.${'q1Zy0rM0NDDQMzI0MzQzNjE2MbE0NDY0MzExMjEwMzI0MDAzM_-'.repeat(6)}`

describe('qr generation', () => {
  it('fits a typical pairing code in a small QR version', () => {
    const bmp = qrBitmap(CODE)
    const version = (bmp.size - 17) / 4
    expect(Number.isInteger(version)).toBe(true)
    expect(version).toBeLessThanOrEqual(13)
  })

  it('round-trips through jsQR', async () => {
    const { data, width, height } = qrPixels(CODE, 3)
    expect(width).toBe(height)
    expect(await decodePixels(data, width, height)).toBe(CODE)
  })
})

describe('fitWithin', () => {
  it('downscales the long side to the limit and keeps the ratio', () => {
    expect(fitWithin(1280, 720)).toEqual({ width: 800, height: 450 })
    expect(fitWithin(720, 1280)).toEqual({ width: 450, height: 800 })
  })
  it('never upscales', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 })
  })
})

describe('nativeDetector', () => {
  it('is null without BarcodeDetector', async () => {
    expect(await nativeDetector({})).toBeNull()
  })
  it('is null when QR is not a supported format', async () => {
    class BD {
      static getSupportedFormats = async () => ['ean_13']
      detect = async () => []
    }
    expect(await nativeDetector({ BarcodeDetector: BD })).toBeNull()
  })
  it('uses BarcodeDetector when it supports qr_code', async () => {
    const made: unknown[] = []
    class BD {
      static getSupportedFormats = async () => ['qr_code', 'ean_13']
      constructor(o: unknown) {
        made.push(o)
      }
      detect = async () => [{ rawValue: 'x', format: 'qr_code' }]
    }
    const d = await nativeDetector({ BarcodeDetector: BD })
    expect(d).not.toBeNull()
    expect(made).toEqual([{ formats: ['qr_code'] }])
  })
})

describe('scanFrames', () => {
  afterEach(() => vi.useRealTimers())

  it('polls until a code is found, then stops', async () => {
    vi.useFakeTimers()
    const video = { readyState: 4 } as HTMLVideoElement
    const results = [null, null, 'OSJ1.abc']
    let i = 0
    const decode = vi.fn(async () => (i < results.length ? results[i++] : 'late'))
    const onCode = vi.fn()
    scanFrames(video, decode, onCode, 150)
    await vi.advanceTimersByTimeAsync(149)
    expect(decode).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onCode).toHaveBeenCalledExactlyOnceWith('OSJ1.abc')
    expect(decode).toHaveBeenCalledTimes(3)
  })

  it('stop() cancels pending polls and ignores late results', async () => {
    vi.useFakeTimers()
    let release: (v: string) => void = () => {}
    const decode = vi.fn(() => new Promise<string>((r) => (release = r)))
    const onCode = vi.fn()
    const stop = scanFrames({ readyState: 4 } as HTMLVideoElement, decode, onCode, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(decode).toHaveBeenCalledTimes(1)
    stop()
    release('OSJ1.late')
    await vi.advanceTimersByTimeAsync(500)
    expect(onCode).not.toHaveBeenCalled()
    expect(decode).toHaveBeenCalledTimes(1)
  })

  it('skips frames before the video has data and survives decoder errors', async () => {
    vi.useFakeTimers()
    const video = { readyState: 0 } as HTMLVideoElement
    const decode = vi.fn(async () => {
      throw new Error('bad frame')
    })
    const onCode = vi.fn()
    const stop = scanFrames(video, decode, onCode, 100)
    await vi.advanceTimersByTimeAsync(300)
    expect(decode).not.toHaveBeenCalled()
    Object.assign(video, { readyState: 4 })
    await vi.advanceTimersByTimeAsync(300)
    expect(decode).toHaveBeenCalled()
    expect(onCode).not.toHaveBeenCalled()
    stop()
  })
})
