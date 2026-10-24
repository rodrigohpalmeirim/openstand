/** Scan a pairing QR with the camera, or paste the text code (always offered; desktops often lack a camera). */
import { Camera, CameraOff, Loader2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Textarea } from '../../ui/primitives'
import { cameraApiAvailable, createFrameDecoder, hasCamera, openQrCamera, scanFrames } from './qr'

type Cam = 'checking' | 'starting' | 'on' | 'off' | 'denied' | 'none' | 'unsupported' | 'failed'

const CAM_TEXT: Partial<Record<Cam, string>> = {
  denied: 'OpenStand isn’t allowed to use the camera. Allow it in the browser’s site settings, or paste the code below.',
  none: 'No camera found. Paste the code below instead.',
  unsupported: 'This browser can’t use the camera here. Paste the code below instead.',
  failed: 'The camera didn’t start. Try again, or paste the code below.',
}

export function PairScanner({ onCode, busy }: { onCode: (text: string) => void; busy?: boolean }) {
  const [cam, setCam] = useState<Cam>('checking')
  const [text, setText] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const session = useRef<{ stream?: MediaStream; stopScan?: () => void; dead?: boolean }>({})
  const onCodeRef = useRef(onCode)
  const pasteId = useId()

  useEffect(() => {
    onCodeRef.current = onCode
  })

  const stop = () => {
    const s = session.current
    s.dead = true
    s.stopScan?.()
    s.stream?.getTracks().forEach((t) => t.stop())
    session.current = {}
  }

  const start = async () => {
    stop()
    const s: typeof session.current = {}
    session.current = s
    setCam('starting')
    try {
      const [stream, decoder] = await Promise.all([openQrCamera(), createFrameDecoder()])
      if (s.dead) return stream.getTracks().forEach((t) => t.stop())
      s.stream = stream
      const v = video.current
      if (!v) return stop()
      v.srcObject = stream
      await v.play().catch(() => {})
      setCam('on')
      s.stopScan = scanFrames(v, decoder.decode, (code) => {
        stop()
        setCam('off')
        onCodeRef.current(code)
      })
    } catch (e) {
      if (s.dead) return
      const name = (e as Error)?.name
      setCam(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'none' : 'failed')
    }
  }

  useEffect(() => {
    let live = true
    void (async () => {
      if (!cameraApiAvailable()) return live && setCam('unsupported')
      if (!(await hasCamera())) return live && setCam('none')
      if (live) await start()
    })()
    return () => {
      live = false
      stop()
    }
    // Start once on mount; `start` only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = () => {
    const t = text.trim()
    if (t && !busy) onCode(t)
  }

  const showVideo = cam === 'starting' || cam === 'on'
  return (
    <div className="grid gap-4">
      <div className="relative mx-auto aspect-square w-full max-w-72 overflow-hidden rounded-2xl border border-line bg-black">
        <video ref={video} muted playsInline aria-label="Camera view" className={showVideo ? 'size-full object-cover' : 'hidden'} />
        {showVideo && (
          <div aria-hidden className="pointer-events-none absolute inset-[14%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]" />
        )}
        {(cam === 'starting' || cam === 'checking') && (
          <div className="absolute inset-0 flex items-center justify-center text-white/80">
            <Loader2 className="size-6 animate-spin" />
            <span className="sr-only">Starting the camera</span>
          </div>
        )}
        {!showVideo && cam !== 'checking' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center text-sm text-white/80">
            <CameraOff className="size-7 text-white/60" />
            <p>{CAM_TEXT[cam] ?? 'Camera is off.'}</p>
            {(cam === 'off' || cam === 'failed' || cam === 'denied') && (
              <Button size="sm" icon={<Camera className="size-4" />} onClick={() => void start()}>
                {cam === 'off' ? 'Scan again' : 'Try again'}
              </Button>
            )}
          </div>
        )}
      </div>
      {cam === 'on' && <p className="-mt-2 text-center text-sm text-muted">Point the camera at the pairing code on your other device.</p>}

      <div className="grid gap-1.5">
        <label htmlFor={pasteId} className="text-xs font-medium uppercase tracking-wide text-muted">
          Or paste the code
        </label>
        <div className="flex items-start gap-2">
          <Textarea
            id={pasteId}
            rows={2}
            className="min-h-0 flex-1 resize-none font-mono text-xs"
            placeholder="OSJ1.…"
            value={text}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <Button variant="primary" onClick={submit} disabled={!text.trim() || busy} className="h-[3.75rem]">
            Continue
          </Button>
        </div>
        <span className="text-xs text-faint">On the other device: Settings → Library sync → Add a device → Copy code.</span>
      </div>
    </div>
  )
}
