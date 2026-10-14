import pkgRaw from '../../package.json?raw'
import { useSettings } from '../state/settings'
import { Kbd } from '../ui/primitives'
import { keyLabel } from '../viewer/input'
import { cheatSheet } from './keymap'
import { Row } from './kit'

const pkg = JSON.parse(pkgRaw) as { version: string }

const CREDITS: [string, string, string][] = [
  ['PDF.js', 'Mozilla', 'Apache-2.0'],
  ['pdf-lib', 'Andrew Dillon', 'MIT'],
  ['abcjs', 'Paul Rosen and contributors', 'MIT'],
  ['Dexie.js', 'David Fahlander', 'Apache-2.0'],
  ['React', 'Meta', 'MIT'],
  ['Zustand', 'Poimandres', 'MIT'],
  ['fflate', 'Arjun Barrett', 'MIT'],
  ['Lucide icons', 'Lucide contributors', 'ISC'],
  ['Tailwind CSS', 'Tailwind Labs', 'MIT'],
  ['Inter typeface', 'Rasmus Andersson', 'OFL-1.1'],
  ['MediaPipe Tasks Vision (face gestures, loaded on demand)', 'Google', 'Apache-2.0'],
]

export function AboutInfo() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-12 rounded-xl" />
        <div>
          <div className="text-lg font-semibold">OpenStand</div>
          <div className="text-sm text-muted">Version {pkg.version} · MIT licence</div>
        </div>
      </div>
      <p className="text-sm text-muted">
        An open-source, offline-first sheet music reader, library and performance tool. Your music stays on your device.
      </p>
      <p className="text-sm text-muted">
        Inspired by the features of MobileSheets by Zubersoft. OpenStand is an independent project and is not affiliated with or endorsed by
        Zubersoft.
      </p>
    </div>
  )
}

export function Credits() {
  return (
    <Row stacked label="Open-source software" hint="OpenStand is built on these projects. Thank you.">
      <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {CREDITS.map(([name, by, lic]) => (
          <li key={name} className="flex flex-col">
            <span className="font-medium">{name}</span>
            <span className="text-xs text-muted">
              {by} · {lic}
            </span>
          </li>
        ))}
      </ul>
    </Row>
  )
}

/** Generated from the current key bindings, so it always matches what the viewer does. */
export function ShortcutSheet() {
  const keys = useSettings((st) => st.s.pageTurn.keys)
  const rows = cheatSheet(keys)
  const groups = [...new Set(rows.map((r) => r.group))]
  return (
    <Row stacked label="Keyboard shortcuts while performing" hint="Change these under Pedals & keyboard.">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No keys are assigned.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{g}</div>
              <dl className="flex flex-col gap-1">
                {rows
                  .filter((r) => r.group === g)
                  .map((r) => (
                    <div key={r.action} className="flex items-start justify-between gap-3 text-sm">
                      <dt>{r.label}</dt>
                      <dd className="flex flex-wrap justify-end gap-1">
                        {r.keys.map((k, i) => (
                          <Kbd key={i}>
                            {k.long ? 'Hold ' : ''}
                            {keyLabel(k.key)}
                          </Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Row>
  )
}
