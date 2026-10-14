import { AlertTriangle, Cable, Loader2 } from 'lucide-react'
import { useSettings } from '../state/settings'
import { Button, cx } from '../ui/primitives'
import { enableMidi, midiSupport, useMidi } from './midi'

/** Explains why MIDI isn't usable (unsupported browser, needs HTTPS, off, denied) with a fix button. */
export function MidiAvailability({ dark, compact }: { dark?: boolean; compact?: boolean }) {
  const status = useMidi((m) => m.status)
  const error = useMidi((m) => m.error)
  const enabled = useSettings((s) => s.s.midi.enabled)
  const setIn = useSettings((s) => s.setIn)
  const support = midiSupport()
  const box = cx(
    'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm',
    dark ? 'border-white/10 bg-white/5 text-white/80' : 'border-line bg-surface-2 text-muted',
  )
  const strong = dark ? 'text-white' : 'text-fg'

  if (support === 'unsupported')
    return (
      <div className={box}>
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
        <div>
          <div className={cx('font-medium', strong)}>This browser has no Web MIDI</div>
          {!compact && (
            <p className="mt-0.5">
              Safari on iPhone and iPad (and every iOS browser) cannot talk to MIDI devices. Use Chrome or Edge on a computer or
              Android tablet, or Firefox on desktop.
            </p>
          )}
        </div>
      </div>
    )
  if (support === 'insecure')
    return (
      <div className={box}>
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
        <div>
          <div className={cx('font-medium', strong)}>MIDI needs a secure connection</div>
          {!compact && <p className="mt-0.5">Open OpenStand over https:// (or localhost) to use MIDI devices.</p>}
        </div>
      </div>
    )
  if (!enabled)
    return (
      <div className={box}>
        <Cable className="mt-0.5 size-4 shrink-0" />
        <div className="flex-1">
          <div className={cx('font-medium', strong)}>MIDI is off</div>
          {!compact && <p className="mt-0.5">Turn it on to send patch changes and control OpenStand from pedals and keyboards.</p>}
        </div>
        <Button size="sm" variant="primary" onClick={() => setIn('midi', { enabled: true })}>
          Turn on
        </Button>
      </div>
    )
  if (status === 'requesting')
    return (
      <div className={box}>
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
        <div className={strong}>Waiting for MIDI permission…</div>
      </div>
    )
  if (status === 'denied' || status === 'error')
    return (
      <div className={box}>
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="flex-1">
          <div className={cx('font-medium', strong)}>{status === 'denied' ? 'MIDI permission was blocked' : 'MIDI could not start'}</div>
          {!compact && (
            <p className="mt-0.5">
              {status === 'denied' ? 'Allow MIDI devices for this site in the browser’s site settings, then retry.' : error}
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => void enableMidi()}>
          Retry
        </Button>
      </div>
    )
  return null
}

/** Minimal “ready” check for components that need to send or listen. */
export const useMidiReady = () => useMidi((m) => m.status === 'ready')
