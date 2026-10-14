/** Rear-camera access for the scanner: highest practical resolution, torch, still capture. */

/** getUserMedia exists (needs a secure context). Whether a camera is really there is only known after asking. */
export function cameraApiAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && (typeof isSecureContext === 'undefined' || isSecureContext)
}

/** Best-effort check without prompting: false when the browser lists no video inputs at all. */
export async function hasCamera(): Promise<boolean> {
  if (!cameraApiAvailable()) return false
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.some((d) => d.kind === 'videoinput')
  } catch {
    return true
  }
}

type TorchCaps = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] }
interface ImageCaptureLike {
  takePhoto(settings?: Record<string, unknown>): Promise<Blob>
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike

export interface CameraSession {
  stream: MediaStream
  torch: boolean
  setTorch(on: boolean): Promise<void>
  /** Capture a still; `video` is the element showing the stream (frame-grab fallback). */
  capture(video: HTMLVideoElement): Promise<Blob>
  stop(): void
}

export async function openCamera(): Promise<CameraSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // 4:3 at the sensor's full width where possible: pages are closer to 4:3 than 16:9.
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
  })
  const track = stream.getVideoTracks()[0]
  const caps = (track.getCapabilities?.() ?? {}) as TorchCaps
  if (caps.focusMode?.includes('continuous'))
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
  const IC = (globalThis as { ImageCapture?: ImageCaptureCtor }).ImageCapture

  const grab = async (video: HTMLVideoElement) => {
    const c = document.createElement('canvas')
    c.width = video.videoWidth
    c.height = video.videoHeight
    c.getContext('2d')!.drawImage(video, 0, 0)
    return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Capture failed'))), 'image/jpeg', 0.92))
  }

  return {
    stream,
    torch: !!caps.torch,
    setTorch: (on) => track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }),
    async capture(video) {
      // A still photo (ImageCapture) has the sensor's full resolution; a frame grab is instant but only
      // as big as the stream. Prefer the still when the stream is small, with a timeout because some
      // devices never resolve it.
      if (IC && Math.max(video.videoWidth, video.videoHeight) < 3000) {
        try {
          const still = await Promise.race([
            new IC(track).takePhoto(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
          ])
          if (still.size) return still
        } catch {
          /* fall back to a frame grab */
        }
      }
      return grab(video)
    },
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}
