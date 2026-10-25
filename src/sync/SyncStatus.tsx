import { RadioTower, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { useSettings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { Button, cx, useMenu } from '../ui/primitives'
import { DarkPop } from '../viewer/dark'
import { sends } from './protocol'
import { disconnect, syncNow, useMyRole, useSync, type SyncStatus as Status } from './sync'

const DOT: Record<Status, string> = {
  off: 'bg-faint',
  connecting: 'bg-warn animate-pulse',
  online: 'bg-ok',
  error: 'bg-danger animate-pulse',
}

export function syncLabel(status: Status, peers: number, role: string, configError?: boolean) {
  if (status === 'connecting') return 'Connecting…'
  if (status === 'error') return configError ? 'Sync settings problem' : 'Reconnecting…'
  if (status === 'off') return 'Sync off'
  const r = role === 'leader' ? 'Leading' : role === 'follower' ? 'Following' : 'Synced'
  return `${r} · ${peers}`
}

export const ROLE_LABEL = { leader: 'Leader', follower: 'Follower', peer: 'Both ways' } as const

/** Device list used by the pill popover and the settings screen. */
export function PeerList({ empty = 'No other devices yet' }: { empty?: string }) {
  const peers = useSync((s) => s.peers)
  const list = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name))
  if (!list.length) return <div className="px-3 py-2 text-sm text-faint">{empty}</div>
  return (
    <ul className="grid gap-0.5">
      {list.map((p) => (
        <li key={p.id} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
          <span className="size-2 shrink-0 rounded-full bg-ok" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{p.name}</span>
            {p.song && <span className="block truncate text-xs text-muted">{p.song}</span>}
          </span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{ROLE_LABEL[p.role]}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Small connection pill for the viewer chrome (dark). Renders nothing while sync is off; tapping it
 * shows connected devices with quick "sync now" / disconnect without leaving the song.
 */
export function SyncStatus({ className }: { className?: string }) {
  const status = useSync((s) => s.status)
  const error = useSync((s) => s.configError ?? s.error)
  const configError = useSync((s) => !!s.configError)
  const peers = useSync((s) => Object.keys(s.peers).length)
  const role = useMyRole()
  const room = useSettings((s) => s.s.sync.room)
  const chrome = useViewer((v) => v.toolbar || v.annotating)
  const m = useMenu()
  const { open, close } = m
  // The pill lives in the toolbar: close its popover when the toolbar hides.
  useEffect(() => {
    if (!chrome && open) close()
  }, [chrome, open, close])
  if (status === 'off') return null
  return (
    <>
      <button
        ref={m.ref}
        type="button"
        title="Device sync"
        aria-label={`Device sync: ${syncLabel(status, peers, role, configError)}`}
        onClick={m.toggle}
        className={cx(
          'inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-2.5 text-xs font-medium text-white/85 backdrop-blur transition hover:bg-white/15',
          className,
        )}
      >
        <RadioTower className="size-3.5" />
        <span className={cx('size-1.5 rounded-full', DOT[status])} />
        <span className="tabular-nums">{syncLabel(status, peers, role, configError)}</span>
      </button>
      <DarkPop anchor={m.anchor} open={m.open} onClose={m.close} className="w-72">
        <div className="px-3 pb-1 pt-2">
          <div className="text-sm font-semibold">Room “{room}”</div>
          <div className="text-xs text-muted">
            This device: {ROLE_LABEL[role]}
            {status === 'error' && error ? ` · ${error}` : ''}
          </div>
        </div>
        <PeerList />
        <div className="flex gap-2 border-t border-line p-2">
          {sends(role) && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void syncNow()} disabled={!peers} className="flex-1">
              Sync others to me
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              m.close()
              disconnect()
            }}
          >
            Disconnect
          </Button>
        </div>
      </DarkPop>
    </>
  )
}
