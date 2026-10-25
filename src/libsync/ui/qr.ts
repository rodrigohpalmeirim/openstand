/**
 * QR codes for pairing: drawing with lean-qr, and scanning with `BarcodeDetector` where it
 * supports QR, else jsQR (lazy-loaded, ~46 KB, only when scanning).
 */
import { correction, generate, mode, type Bitmap2D } from 'lean-qr'
import { cameraApiAvailable, hasCamera } from '../../scan/camera'

export { cameraApiAvailable, hasCamera }

/** The code as a QR matrix: byte mode, error correction M. */
export function qrBitmap(text: string): Bitmap2D {
  return generate(mode.bytes(new TextEncoder().encode(text)), { minCorrectionLevel: correction.M })
}

/** Draws the code at one pixel per module with a 4-module quiet zone; scale it up with CSS (pixelated). */
export function drawQr(canvas: HTMLCanvasElement, text: string) {
  qrBitmap(text).toCanvas(canvas, { on: [0, 0, 0], off: [255, 255, 255], pad: 4 })
}

/** RGBA pixels of the code, `scale` px per module, with a 4-module quiet zone (tests, previews). */
export function qrPixels(text: string, scale = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const bmp = qrBitmap(text)
  const pad = 4
  const n = (bmp.size + 2 * pad) * scale
  const data = new Uint8ClampedArray(n * n * 4).fill(255)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (bmp.get(Math.floor(x / scale) - pad, Math.floor(y / scale) - pad)) {
        const i = (y * n + x) * 4
        data[i] = data[i + 1] = data[i + 2] = 0
      }
  return { data, width: n, height: n }
}

/** Largest size within `max` px on the long side, keeping the aspect ratio (never upscales). */
export function fitWithin(w: number, h: number, max = 800): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/** Decodes RGBA pixels with jsQR. */
export async function decodePixels(data: Uint8ClampedArray, width: number, height: number): Promise<string | null> {
  const { default: jsQR } = await import('jsqr')
  return jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null
}

interface BarcodeDetectorLike {
  detect(src: CanvasImageSource): Promise<{ rawValue: string; format: string }[]>
}
interface BarcodeDetectorCtor {
  new (o?: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

/** `BarcodeDetector` with QR support, if this browser has it. */
export async function nativeDetector(g: object = globalThis): Promise<BarcodeDetectorLike | null> {
  const BD = (g as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!BD) return null
  try {
    const formats = (await BD.getSupportedFormats?.()) ?? []
    return formats.includes('qr_code') ? new BD({ formats: ['qr_code'] }) : null
  } catch {
    return null
  }
}

export type FrameDecoder = (video: HTMLVideoElement) => Promise<string | null>

/** A decoder for video frames: native when available, otherwise jsQR on a frame downscaled to ≤ 800 px. */
export async function createFrameDecoder(): Promise<{ decode: FrameDecoder; kind: 'native' | 'jsqr' }> {
  const native = await nativeDetector()
  if (native)
    return {
      kind: 'native',
      decode: async (video) => (await native.detect(video)).find((c) => c.rawValue)?.rawValue ?? null,
    }
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return {
    kind: 'jsqr',
    decode: async (video) => {
      if (!ctx || !video.videoWidth) return null
      const { width, height } = fitWithin(video.videoWidth, video.videoHeight)
      if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height })
      ctx.drawImage(video, 0, 0, width, height)
      const img = ctx.getImageData(0, 0, width, height)
      return jsQR(img.data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null
    },
  }
}

/** Rear camera at a modest resolution: enough for a QR, unlike the scanner's 4K stills. */
export function openQrCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment', width: { ideal: 1280 } } })
}

/**
 * Decodes frames every `interval` ms until a code is found or `stop()` is called. A frame is never decoded
 * while the previous one is still being decoded.
 */
export function scanFrames(video: HTMLVideoElement, decode: FrameDecoder, onCode: (text: string) => void, interval = 150): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped) return
    let text: string | null = null
    try {
      if (video.readyState >= 2) text = await decode(video)
    } catch {
      /* a bad frame; keep going */
    }
    if (stopped) return
    if (text) {
      stopped = true
      onCode(text)
      return
    }
    timer = setTimeout(tick, interval)
  }
  timer = setTimeout(tick, interval)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
