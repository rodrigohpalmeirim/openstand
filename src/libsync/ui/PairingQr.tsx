/** "Add a device": the pairing QR and text code (§11). Shown only on request; hides after 2 minutes. */
import { Copy, EyeOff, Loader2, QrCode, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, confirmDialog } from '../../ui/primitives'
import { copyText } from './clipboard'
import { pairingCode } from './client'
import { drawQr } from './qr'

const SHOW_MS = 2 * 60_000
const WARNING = 'Anyone with this code can read and change your library and use your storage keys.'

export function PairingQr() {
  const [code, setCode] = useState<string | null>(null)
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const showBtn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (code && canvas.current) drawQr(canvas.current, code)
  }, [code])

  useEffect(() => {
    if (!code) return
    const t = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= until) {
        setCode(null)
        // Keep keyboard focus somewhere sensible when the code disappears.
        setTimeout(() => showBtn.current?.focus())
      }
    }, 1000)
    return () => clearInterval(t)
  }, [code, until])

  const show = async () => {
    setLoading(true)
    setError(null)
    try {
      const c = await pairingCode()
      const n = Date.now()
      setNow(n)
      setUntil(n + SHOW_MS)
      setCode(c)
    } catch (e) {
      setError((e as Error).message || 'Couldn’t create the pairing code.')
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!code) return
    const ok = await confirmDialog({ title: 'Copy the pairing code?', message: WARNING, confirmLabel: 'Copy code' })
    if (ok) await copyText(code, 'Pairing code copied')
  }

  if (!code)
    return (
      <div className="grid justify-items-start gap-2">
        <Button ref={showBtn} variant="primary" icon={loading ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />} onClick={show} disabled={loading}>
          Show pairing code
        </Button>
        <p className="text-xs text-muted">Shows a QR code to scan with the other device. It hides itself after 2 minutes.</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    )

  const left = Math.max(0, Math.ceil((until - now) / 1000))
  return (
    <div className="grid justify-items-center gap-3 rounded-xl border border-line bg-surface-2 p-4 text-center">
      <p className="max-w-sm text-sm">
        On the other device, open <b>Settings → Library sync → Join from another device</b> and scan this code.
      </p>
      <div className="rounded-xl bg-white p-1 shadow-sm">
        <canvas
          ref={canvas}
          role="img"
          aria-label="Pairing QR code"
          className="block size-[min(260px,62vw)]"
          style={{ imageRendering: 'pixelated' }}
        />
      </div>
      <p className="text-xs tabular-nums text-muted" aria-live="off">
        Hides in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button icon={<Copy className="size-4" />} onClick={copy}>
          Copy code
        </Button>
        <Button variant="ghost" icon={<EyeOff className="size-4" />} onClick={() => setCode(null)}>
          Hide
        </Button>
      </div>
      <p className="flex max-w-sm items-start gap-2 text-left text-xs text-muted">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
        {WARNING} Only show it to your own devices.
      </p>
    </div>
  )
}
