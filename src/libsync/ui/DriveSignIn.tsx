/**
 * Cloud-drive pieces shared by the setup wizard, the join flow and Settings (docs/SYNC-DRIVES.md §7): what
 * signing in gives OpenStand access to (Google's required in-app disclosure, used for every provider), the
 * signed-in account card, sign-in problems and the provider's disconnect pages.
 */
import { Check, ExternalLink, FolderOpen, Info, Loader2, Lock, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AccountInfo, BackendDescription, OAuthKind } from '../api'
import { Button, cx } from '../../ui/primitives'
import { fmtBytes } from './format'
import { Note } from './parts'
import { accountLabel, drive, localhostHint, type SignInProblem } from './signin'

const linkCls = 'inline-flex items-center gap-1 text-accent hover:underline'

export function PrivacyLink({ children = 'Privacy policy' }: { children?: ReactNode }) {
  return (
    <a href="/privacy" target="_blank" rel="noopener" className={linkCls}>
      {children} <ExternalLink className="size-3.5" />
    </a>
  )
}

/** Opens the folder (or the provider) in a new tab. */
export function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2"
    >
      {children} <ExternalLink className="size-3.5 text-muted" />
    </a>
  )
}

/**
 * What signing in gives OpenStand access to, and why. Google requires this in the app before the consent
 * screen (Limited Use); it's shown for every provider so the three read the same.
 */
export function AccessDisclosure({ kind }: { kind: OAuthKind }) {
  const p = drive(kind)
  return (
    <section aria-label="What OpenStand can access" className="grid gap-2 rounded-xl border border-line px-4 py-3 text-sm">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted">What OpenStand can access</h4>
      <ul className="grid gap-1.5">
        <li className="flex items-start gap-2">
          <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted" />
          <span>
            {kind === 'gdrive' ? (
              <>Only the folder and files OpenStand creates in your Google Drive. It can’t open, list or change anything else.</>
            ) : (
              <>
                Only its own folder, <b>{p.location}</b>. It can’t see anything else in your {p.name}.
              </>
            )}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <UserRound className="mt-0.5 size-4 shrink-0 text-muted" />
          <span>Your account name, email address and free space, to show which account this device uses and warn you before it’s full.</span>
        </li>
      </ul>
      <p className="text-muted">
        Only to store your encrypted library and sync it between your devices.{' '}
        {kind === 'dropbox'
          ? 'None of it is sent to OpenStand or shared with anyone.'
          : 'It stays on your devices; OpenStand’s sign-in helper only passes sign-in requests on and keeps nothing. It isn’t shared with anyone.'}{' '}
        <PrivacyLink />
      </p>
    </section>
  )
}

/** §7.1 "Sign in" step body: where the data lives, encryption and the disclosure (the button is in the footer). */
export function DriveSignInPanel({ kind, problem, onChooseAccount }: { kind: OAuthKind; problem?: SignInProblem; onChooseAccount: () => void }) {
  const p = drive(kind)
  const local = import.meta.env.DEV && !/[?&]libsyncMock=/.test(location.search) ? localhostHint() : undefined
  return (
    <div className="grid gap-4">
      {problem && <SignInProblemNote problem={problem} onChooseAccount={onChooseAccount} />}
      <ul className="grid gap-2 text-sm">
        <li className="flex items-start gap-2.5">
          <FolderOpen className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>
            OpenStand will ask {p.name} for access to one folder only: <b>{p.location}</b>.
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <Lock className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>Everything in it is encrypted on this device first; {p.name} can’t read your music.</span>
        </li>
        <li className="flex items-start gap-2.5">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>
            Each of your devices signs in by itself.
            {p.kind !== 'dropbox' && ' Sign-in passes through OpenStand’s sign-in helper, which doesn’t store or log anything.'}
          </span>
        </li>
      </ul>
      <AccessDisclosure kind={kind} />
      {local && (
        <Note tone="warn">
          Sign-in only works on the registered address. Open <a className="font-medium text-accent underline" href={local + location.pathname}>{local}</a> to sign in.
        </Note>
      )}
      <DesktopAppNote kind={kind} />
    </div>
  )
}

/** "Sign in with Dropbox / Google / Microsoft": 44 px, no brand logos (§7.1). */
export function SignInButton({ kind, busy, onClick, className }: { kind: OAuthKind; busy?: boolean; onClick: () => void; className?: string }) {
  return (
    <Button variant="primary" className={cx('h-11', className)} onClick={onClick} disabled={busy}>
      {busy && <Loader2 className="size-4 animate-spin" />}
      Sign in with {drive(kind).signInWith}
    </Button>
  )
}

/** Dropbox (and OneDrive without Files On-Demand) also download the folder to computers with the desktop app. */
export function DesktopAppNote({ kind }: { kind: OAuthKind }) {
  if (kind === 'dropbox')
    return (
      <p className="text-xs text-muted">
        If you use the Dropbox desktop app, it will also download this folder to your computers. You can exclude <i>Apps/OpenStand</i> with Selective Sync.
      </p>
    )
  if (kind === 'onedrive')
    return (
      <p className="text-xs text-muted">
        If the OneDrive desktop app on a computer has Files On-Demand turned off, it downloads this folder there too. You can leave out <i>Apps/OpenStand</i> under “Choose folders”.
      </p>
    )
  return null
}

/** A sign-in that didn't work, with the action §5.5 gives it. */
export function SignInProblemNote({
  problem,
  onRetry,
  onChooseAccount,
  extra,
}: {
  problem: SignInProblem
  onRetry?: () => void
  onChooseAccount?: () => void
  extra?: ReactNode
}) {
  const action =
    problem.action === 'chooseAccount' && onChooseAccount ? (
      <Button size="sm" variant="primary" onClick={onChooseAccount}>
        Sign in with another account
      </Button>
    ) : problem.action === 'retry' && onRetry ? (
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {/scope|allow it|tick the box/i.test(problem.message) ? 'Sign in again' : 'Try again'}
      </Button>
    ) : undefined
  return (
    <Note tone="danger">
      <p className="font-medium">{problem.message}</p>
      {(action || extra) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {action}
          {extra}
        </div>
      )}
    </Note>
  )
}

/** §7.1 check step: "Signed in as …", where the library will live, the folder link and free space. */
export function DriveAccountCard({
  kind,
  account,
  description,
  loading,
  onChooseAccount,
}: {
  kind: OAuthKind
  account?: AccountInfo
  description?: BackendDescription
  loading?: boolean
  onChooseAccount?: () => void
}) {
  const p = drive(kind)
  const who = accountLabel(description?.account ?? account)
  const free = description?.freeBytes
  return (
    <div className="grid gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm">
      <div className="flex items-start gap-2.5">
        {loading ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted" /> : <Check className="mt-0.5 size-4 shrink-0 text-ok" />}
        <span className="min-w-0 break-words">
          {loading ? (
            `Finishing sign-in with ${p.signInWith}…`
          ) : (
            <>
              Signed in as <b>{who ?? `your ${p.name} account`}</b>
            </>
          )}
        </span>
      </div>
      <div className="flex items-start gap-2.5">
        <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted" />
        <span className="min-w-0">
          Your library will live in <b>{description?.location ?? p.location}</b>
          {free !== undefined && <span className="text-muted"> · {fmtBytes(free)} free</span>}
        </span>
      </div>
      {(description?.openUrl || onChooseAccount) && !loading && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6.5">
          {description?.openUrl && (
            <a href={description.openUrl} target="_blank" rel="noreferrer" className={cx(linkCls, 'min-h-8')}>
              Open folder <ExternalLink className="size-3.5" />
            </a>
          )}
          {onChooseAccount && (
            <button type="button" onClick={onChooseAccount} className="min-h-8 rounded text-accent hover:underline">
              Use a different account
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The provider's pages for removing OpenStand from the account (every device), §5.4. */
export function DisconnectLinks({ kind }: { kind: OAuthKind }) {
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {drive(kind).disconnectUrls.map((u) => (
        <a key={u.url} href={u.url} target="_blank" rel="noreferrer" className={linkCls}>
          {u.label} <ExternalLink className="size-3.5" />
        </a>
      ))}
    </span>
  )
}

/** "Stop syncing" dialog text for a drive: what happens to this device's sign-in, and the full disconnect. */
export function DriveLeaveNote({ kind }: { kind: OAuthKind }) {
  const p = drive(kind)
  return (
    <span className="mt-2 block">
      {kind === 'dropbox' ? <>This device’s Dropbox access is revoked. </> : <>This device forgets its {p.name} sign-in. </>}
      Your other devices stay signed in. To disconnect OpenStand from your {p.signInWith} account on every device, remove it at:
      <span className="mt-1 block">
        <DisconnectLinks kind={kind} />
      </span>
    </span>
  )
}
