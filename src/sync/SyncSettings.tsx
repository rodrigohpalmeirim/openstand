import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, AppWindow, ListMusic, RadioTower, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { db } from '../db/db'
import { useSettings } from '../state/settings'
import { Button, Field, Input, Segmented, Select, Toggle, cx } from '../ui/primitives'
import { sends, type Role } from './protocol'
import { PeerList, ROLE_LABEL, syncLabel } from './SyncStatus'
import { connect, defaultDeviceName, disconnect, shareSetlist, syncNow, useSync } from './sync'
import { mixedContentProblem } from './transports'

const ROLE_HINT: Record<Role, string> = {
  leader: 'This device controls the others: page turns and songs go out, nothing comes in.',
  follower: 'This device obeys the leader: it turns pages and opens songs when the leader does.',
  peer: 'Everyone turns everyone’s pages — good for two screens of one musician.',
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4">
      <span className="text-sm">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </label>
  )
}

/** Devices & sync section of the settings screen. */
export function SyncSettings() {
  const s = useSettings((st) => st.s.sync)
  const setIn = useSettings((st) => st.setIn)
  const status = useSync((st) => st.status)
  const error = useSync((st) => st.error)
  const relay = useSync((st) => st.relay)
  const peerCount = useSync((st) => Object.keys(st.peers).length)
  const active = useSync((st) => st.active)
  const setlists = useLiveQuery(() => db.setlists.orderBy('name').toArray(), [])
  const [share, setShare] = useState('')
  const [relayDraft, setRelayDraft] = useState(s.relayUrl)
  const [roomDraft, setRoomDraft] = useState(s.room)
  const mixed = mixedContentProblem(relayDraft)

  const dot = status === 'online' ? 'bg-ok' : status === 'connecting' ? 'bg-warn animate-pulse' : status === 'error' ? 'bg-danger' : 'bg-faint'
  const statusText =
    status === 'off'
      ? 'Not connected'
      : status === 'online'
        ? `${syncLabel(status, peerCount, s.role)} other device${peerCount === 1 ? '' : 's'}${s.relayUrl ? '' : ' (this browser only)'}`
        : status === 'connecting'
          ? 'Connecting to the relay…'
          : `Can’t reach the relay — retrying${error ? ` (${error})` : ''}`

  const commit = () => {
    const room = roomDraft.trim() || 'band'
    if (room !== s.room || relayDraft.trim() !== s.relayUrl) setIn('sync', { room, relayUrl: relayDraft.trim() })
    if (room !== roomDraft) setRoomDraft(room)
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
        <RadioTower className="size-5 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={cx('size-2 rounded-full', dot)} />
            {statusText}
          </div>
          <div className="text-xs text-muted">
            Room “{s.room}” · {ROLE_LABEL[s.role]}
            {active && s.relayUrl ? ` · relay ${relay}` : ''}
          </div>
        </div>
        {active ? (
          <Button onClick={disconnect}>Disconnect</Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              commit()
              setTimeout(connect)
            }}
          >
            Connect
          </Button>
        )}
      </div>

      <Field label="This device">
        <Segmented
          value={s.role}
          onChange={(role) => setIn('sync', { role })}
          options={(['leader', 'follower', 'peer'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
        />
      </Field>
      <p className="-mt-4 text-sm text-muted">{ROLE_HINT[s.role]}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Device name">
          <Input value={s.deviceName} placeholder={defaultDeviceName()} onChange={(e) => setIn('sync', { deviceName: e.target.value })} />
        </Field>
        <Field label="Room" hint="Devices with the same room see each other.">
          <Input value={roomDraft} onChange={(e) => setRoomDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder="band" />
        </Field>
      </div>

      <Field
        label="Relay address (for separate devices)"
        hint={
          mixed ? (
            <span className="flex items-start gap-1.5 text-warn">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This page is served over https, so the browser only allows a secure relay (wss://…) or one on this computer.
            </span>
          ) : (
            <>
              Leave empty to sync only windows of this browser. To connect phones and tablets, run{' '}
              <code className="rounded bg-surface-2 px-1 font-mono">node server/relay.mjs</code> on a computer on the same network and enter its
              address, e.g. <span className="font-mono">192.168.1.20:8787</span>.
            </>
          )
        }
      >
        <Input value={relayDraft} onChange={(e) => setRelayDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} placeholder="ws://192.168.1.20:8787" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </Field>

      {s.role !== 'leader' && (
        <div className="grid gap-1">
          <SwitchRow label="Turn pages with the others" checked={s.followPages} onChange={(followPages) => setIn('sync', { followPages })} />
          <SwitchRow label="Open the same songs and setlists" hint="Songs are matched by title when libraries differ" checked={s.followSongs} onChange={(followSongs) => setIn('sync', { followSongs })} />
        </div>
      )}
      <SwitchRow label="Connect when OpenStand starts" checked={s.autoConnect} onChange={(autoConnect) => setIn('sync', { autoConnect })} />

      {active && (
        <section className="grid gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Connected devices</h3>
          <div className="rounded-xl border border-line">
            <PeerList empty={s.relayUrl ? 'Waiting for other devices to join this room…' : 'Open OpenStand in another window to try it.'} />
          </div>
          {sends(s.role) && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" icon={<RefreshCw className="size-4" />} onClick={() => void syncNow()} disabled={!peerCount}>
                Sync others to my song
              </Button>
              <div className="flex items-center gap-2">
                <Select className="h-8 w-auto min-w-40 text-sm" value={share} onChange={(e) => setShare(e.target.value)} aria-label="Setlist to share">
                  <option value="">Share a setlist…</option>
                  {setlists?.map((sl) => (
                    <option key={sl.id} value={sl.id}>
                      {sl.name}
                    </option>
                  ))}
                </Select>
                <Button size="sm" icon={<ListMusic className="size-4" />} disabled={!share || !peerCount} onClick={() => void shareSetlist(share)}>
                  Send
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      <div>
        <Button size="sm" variant="ghost" icon={<AppWindow className="size-4" />} onClick={() => window.open(location.href, '_blank', 'popup,width=900,height=700')}>
          Open a second window
        </Button>
        <p className="mt-1 text-xs text-muted">For a second screen or a laptop with a page-turn pedal. Connect both windows with the same room.</p>
      </div>
    </div>
  )
}
