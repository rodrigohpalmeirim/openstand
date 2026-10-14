import { ChevronLeft, ChevronRight, Menu as MenuIcon } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_SETTINGS, useSettings, type TouchZone } from '../state/settings'
import { cx, Button } from '../ui/primitives'
import { ACTIONS, type ActionId } from '../viewer/actions'
import { ActionMenu, Row } from './kit'

const ZONES: TouchZone[] = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']
const ZONE_NAME: Record<TouchZone, string> = {
  tl: 'Top left',
  tc: 'Top centre',
  tr: 'Top right',
  ml: 'Middle left',
  mc: 'Centre',
  mr: 'Middle right',
  bl: 'Bottom left',
  bc: 'Bottom centre',
  br: 'Bottom right',
}

type Zones = Record<TouchZone, ActionId>
const grid = (rows: [ActionId, ActionId, ActionId][]): Zones => {
  const flat = rows.flat()
  return Object.fromEntries(ZONES.map((z, i) => [z, flat[i]])) as Zones
}

const PRESETS: { name: string; zones: Zones }[] = [
  { name: 'Sides turn, centre menu', zones: DEFAULT_SETTINGS.pageTurn.zones },
  {
    name: 'Forward almost everywhere',
    zones: grid([
      ['prevPage', 'toggleToolbar', 'nextPage'],
      ['prevPage', 'nextPage', 'nextPage'],
      ['prevPage', 'nextPage', 'nextPage'],
    ]),
  },
  {
    name: 'Top back, bottom forward',
    zones: grid([
      ['prevPage', 'prevPage', 'prevPage'],
      ['prevPage', 'toggleToolbar', 'nextPage'],
      ['nextPage', 'nextPage', 'nextPage'],
    ]),
  },
]

function ZoneIcon({ a }: { a: ActionId }) {
  if (a === 'nextPage' || a === 'nextHalfPage') return <ChevronRight className="size-5" />
  if (a === 'prevPage' || a === 'prevHalfPage') return <ChevronLeft className="size-5" />
  if (a === 'toggleToolbar') return <MenuIcon className="size-4" />
  return null
}

/** Visual 3x3 tap-zone editor over a page silhouette. */
export function ZoneEditor() {
  const zones = useSettings((st) => st.s.pageTurn.zones)
  const setIn = useSettings((st) => st.setIn)
  const [edit, setEdit] = useState<{ zone: TouchZone; el: HTMLElement } | null>(null)
  const setZone = (z: TouchZone, a: ActionId) => setIn('pageTurn', { zones: { ...zones, [z]: a } })
  const same = (a: Zones) => ZONES.every((z) => a[z] === zones[z])

  return (
    <Row stacked label="Tap zones" hint="Tap a zone to choose what a single tap there does while performing.">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <div
          className="relative aspect-[3/4] w-full max-w-64 shrink-0 overflow-hidden rounded-lg border border-line bg-white shadow-sm"
          aria-label="Page tap zones"
          role="group"
        >
          {/* faux staff lines so it reads as a page */}
          <div className="pointer-events-none absolute inset-x-[10%] inset-y-[9%] flex flex-col justify-between" aria-hidden>
            <div className="mx-auto mb-1 h-1.5 w-1/3 rounded bg-neutral-300" />
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-[3px]">
                {Array.from({ length: 5 }, (_, j) => (
                  <div key={j} className="h-px bg-neutral-300" />
                ))}
              </div>
            ))}
          </div>
          <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-px p-px">
            {ZONES.map((z) => {
              const a = zones[z]
              const none = a === 'none'
              const turn = a === 'nextPage' || a === 'prevPage' || a === 'nextHalfPage' || a === 'prevHalfPage'
              return (
                <button
                  key={z}
                  onClick={(e) => setEdit({ zone: z, el: e.currentTarget })}
                  aria-label={`${ZONE_NAME[z]}: ${ACTIONS[a].label}`}
                  className={cx(
                    'flex flex-col items-center justify-center gap-0.5 rounded-sm p-1 text-center text-[11px] font-medium leading-tight transition',
                    'hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent',
                    edit?.zone === z && 'ring-2 ring-accent',
                    none
                      ? 'border border-dashed border-neutral-300 text-neutral-400'
                      : turn
                        ? 'bg-[color-mix(in_srgb,var(--os-accent)_16%,transparent)] text-neutral-800'
                        : 'bg-neutral-900/5 text-neutral-700',
                  )}
                >
                  <ZoneIcon a={a} />
                  <span>{none ? 'Nothing' : ACTIONS[a].label}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex w-full flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Layouts</span>
          {PRESETS.map((p) => (
            <Button
              key={p.name}
              variant={same(p.zones) ? 'primary' : 'secondary'}
              className="justify-start"
              onClick={() => setIn('pageTurn', { zones: p.zones })}
            >
              {p.name}
            </Button>
          ))}
        </div>
      </div>
      <ActionMenu
        anchor={edit?.el ?? null}
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit ? ZONE_NAME[edit.zone] : undefined}
        value={edit ? zones[edit.zone] : 'none'}
        onChange={(a) => edit && setZone(edit.zone, a)}
      />
    </Row>
  )
}
