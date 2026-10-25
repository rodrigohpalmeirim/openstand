/**
 * "Add a device": the pairing QR and text code (§11). Shown only on request; hides after 2 minutes, and is
 * covered the moment the page is hidden or loses focus (so app-switcher snapshots don't capture it).
 */
import { Copy, Eye, EyeOff, Loader2, QrCode, ShieldAlert } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLibSync } from '../api'
import { Button, confirmDialog } from '../../ui/primitives'
import { clearClipboardLater, copyText } from './clipboard'
import { pairingCode } from './client'
import { failureText, pairingWarning } from './format'
import { drawQr } from './qr'

const SHOW_MS = 2 * 60_000
const CLEAR_MS = 60_000

export function PairingQr() {
  const WARNING = pairingWarning(useLibSync((st) => st.backendKind))
  const [code, setCode] = useState<string | null>(null)
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [covered, setCovered] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const showBtn = useRef<HTMLButtonElement>(null)
  // A pending clipboard clear deliberately outlives this component (the dialog is usually closed by then).
  const cancelClear = useRef<(() => void) | null>(null)

  // Layout effect: the QR is drawn in the same commit that mounts the canvas, never shown blank first.
  useLayoutEffect(() => {
    if (code && !covered && canvas.current) drawQr(canvas.current, code)
  }, [code, covered])

  // Cover the code as soon as the page is backgrounded or loses focus. The canvas is hidden synchronously
  // (before React re-renders) because iOS takes the app-switcher snapshot right after `visibilitychange`.
  // Layout effect: the listeners are in place in the same commit that shows the code, so no blur is missed.
  useLayoutEffect(() => {
    if (!code) return
    const cover = () => {
      if (canvas.current) canvas.current.style.visibility = 'hidden'
      setCovered(true)
    }
    const onVis = () => document.visibilityState === 'hidden' && cover()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', cover)
    window.addEventListener('pagehide', cover)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('blur', cover)
      window.removeEventListener('pagehide', cover)
    }
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
      setCovered(false)
      setCode(c)
    } catch (e) {
      setError(failureText(e, 'Couldn’t create the pairing code.'))
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!code) return
    const ok = await confirmDialog({
      title: 'Copy the pairing code?',
      message: `${WARNING} Paste it only on your own device. OpenStand clears it from the clipboard after a minute when the browser allows that; if it can’t, copy something else once you’ve pasted it.`,
      confirmLabel: 'Copy code',
    })
    if (ok && (await copyText(code, 'Pairing code copied'))) {
      cancelClear.current?.()
      cancelClear.current = clearClipboardLater(code, CLEAR_MS)
    }
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
      {covered ? (
        <button
          type="button"
          onClick={() => setCovered(false)}
          className="flex size-[calc(min(260px,62vw)+0.5rem)] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line bg-surface px-4 text-sm text-muted hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Eye className="size-6" />
          <span className="font-medium text-fg">Tap to show the code</span>
          <span className="text-xs">Hidden while you were away from this page.</span>
        </button>
      ) : (
        <div className="rounded-xl bg-white p-1 shadow-sm">
          <canvas
            ref={canvas}
            role="img"
            aria-label="Pairing QR code"
            className="block size-[min(260px,62vw)]"
            style={{ imageRendering: 'pixelated' }}
          />
        </div>
      )}
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
