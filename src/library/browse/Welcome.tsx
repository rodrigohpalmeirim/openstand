import { Music4, Sparkles, Upload } from 'lucide-react'
import { useState } from 'react'
import { db, sha256, type OpenStandDB } from '../../db/db'
import type { Song } from '../../db/schema'
import { createTextSong } from '../../files/import'
import { settings, useSettings } from '../../state/settings'
import { Button, cx, Dialog, toast } from '../../ui/primitives'
import { CLASSICAL_GROUPS } from './terms'
import { ui } from './ui'

const DEMO_CHORDPRO = `{title: Welcome to OpenStand}
{artist: OpenStand Demo Band}
{key: G}
{tempo: 92}
{time: 4/4}
{duration: 2:40}

{comment: Tap the right side of the screen to turn the page, the left side to go back.}

{start_of_verse: Verse 1}
[G]Open up the [D]stand tonight
[Em]Every page is [C]in the light
[G]Charts and lyrics [D]side by side
[C]Nothing left to [D]hunt or [G]find
{end_of_verse}

{start_of_chorus}
[C]Turn the [D]page, [G]keep the [Em]time
[C]Every [D]song a [G]friend of mine
[Am]Mark it [D]up and [G]let it [Em]ring
[C]Hit the [D]stage and [G]sing
{end_of_chorus}

{start_of_verse: Verse 2}
[G]Transpose up or [D]capo down
[Em]Same old song, a [C]brand new sound
[G]Setlist ready, [D]notes in place
[C]Count it in and [D]find the [G]space
{end_of_verse}

{chorus}
`

const DEMO_ABC = `X:1
T:Stand Tune
C:OpenStand Demo
R:reel
M:4/4
L:1/8
Q:1/4=110
K:D
|:A2FA dAFA|B2GB dBGB|A2FA dfed|cABc d2dc:|
|:d2fd adfd|e2ge bege|f2af g2ec|dfec d2d2:|
`

const DEMO_TITLES: Record<string, string> = { 'Welcome to OpenStand': DEMO_CHORDPRO, 'Stand Tune': DEMO_ABC }
const demoHashes = new Map<string, Promise<string>>()
const demoHash = (text: string) => {
  let h = demoHashes.get(text)
  if (!h) demoHashes.set(text, (h = sha256(new TextEncoder().encode(text).buffer as ArrayBuffer)))
  return h
}

/**
 * A demo song exactly as `createDemoSongs` made it: demo title, its single text file unchanged, never
 * edited, no annotations. Joining a synced library deletes these first instead of publishing them.
 */
// oxlint-disable-next-line react/only-export-components -- the demo check belongs next to the demo content
export async function isUntouchedDemo(song: Song, d: OpenStandDB = db): Promise<boolean> {
  const text = DEMO_TITLES[song.title]
  if (!text || song.files.length !== 1 || song.createdAt !== song.modifiedAt) return false
  const blobId = song.files[0].blobId
  const hash = /^[0-9a-f]{64}$/.test(blobId) ? blobId : (await d.blobs.get(blobId))?.hash
  if (hash !== (await demoHash(text))) return false
  return (await d.annotations.where('songId').equals(song.id).count()) === 0
}

/** Create two small demo songs (ChordPro + ABC) so a new user can try performing right away. */
export async function createDemoSongs() {
  try {
    await createTextSong('Welcome to OpenStand', DEMO_CHORDPRO, 'chordpro')
    await createTextSong('Stand Tune', DEMO_ABC, 'abc')
    toast(`Added 2 demo ${settings().terminology === 'piece' ? 'pieces' : 'songs'}`, 'ok')
  } catch (e) {
    toast(`Couldn’t create the demo: ${(e as Error).message}`, 'error')
  }
}

/** First-run welcome: pick terminology, then import music or try the demo. */
export function Welcome() {
  const onboarded = useSettings((s) => s.s.onboarded)
  const terminology = useSettings((s) => s.s.terminology)
  const set = useSettings((s) => s.set)
  const [busy, setBusy] = useState(false)
  if (onboarded) return null
  const finish = () => set({ onboarded: true })
  const choose = (v: 'song' | 'piece') =>
    set({
      terminology: v,
      visibleGroups:
        v === 'piece'
          ? CLASSICAL_GROUPS
          : ['setlists', 'collections', 'artists', 'composers', 'albums', 'genres', 'keys', 'sources', 'tags', 'years', 'signatures'],
    })
  const card = (v: 'song' | 'piece', title: string, sub: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={terminology === v}
      onClick={() => choose(v)}
      className={cx(
        'flex flex-1 flex-col gap-1 rounded-xl border-2 p-4 text-left transition',
        terminology === v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
      )}
    >
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-muted">{sub}</span>
    </button>
  )
  return (
    <Dialog open onClose={finish} size="md" label="Welcome to OpenStand">
      <div className="flex flex-col gap-6 px-6 py-7">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-fg shadow-lg">
            <Music4 className="size-7" />
          </div>
          <h2 className="text-xl font-semibold">Welcome to OpenStand</h2>
          <p className="max-w-sm text-sm text-muted">
            Your sheet music, chord charts and setlists — offline, on any device. Everything stays in this browser unless you export it or turn on encrypted sync.
          </p>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">What do you play?</div>
          <div className="flex gap-3" role="radiogroup">
            {card('song', 'Songs', 'Artists, albums, genres — bands, worship, pop, jazz')}
            {card('piece', 'Pieces', 'Composers, books, years — classical repertoire')}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            size="lg"
            icon={<Upload className="size-5" />}
            onClick={() => {
              finish()
              ui.import()
            }}
          >
            Import your music
          </Button>
          <Button
            size="lg"
            icon={<Sparkles className="size-5" />}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await createDemoSongs()
              setBusy(false)
              finish()
            }}
          >
            Try demo {terminology === 'piece' ? 'pieces' : 'songs'}
          </Button>
          <Button variant="ghost" onClick={finish}>
            Start with an empty library
          </Button>
        </div>
        <a
          href="/privacy"
          target="_blank"
          rel="noopener"
          className="-my-2 self-center rounded px-2 py-1 text-xs text-muted hover:text-fg hover:underline"
        >
          Privacy policy
        </a>
      </div>
    </Dialog>
  )
}
