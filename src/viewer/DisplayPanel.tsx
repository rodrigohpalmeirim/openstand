import { BookOpen, Columns2, File, GalleryHorizontal, Rows3, SplitSquareVertical } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { updateSong } from '../db/db'
import { rotateSongPages } from '../annotations/rotate'
import type { DisplayMode, FitMode } from '../db/schema'
import { useTerms } from '../library/browse/terms'
import { useSettings } from '../state/settings'
import { visiblePages } from '../tools/navigation'
import { Segmented, Slider, toast, Toggle } from '../ui/primitives'
import type { PanelProps } from './panels'
import { pageSettingsKey } from './pageSource'

export const MODE_LABELS: Record<DisplayMode, string> = {
  single: 'Single page',
  double: 'Two pages',
  halfPage: 'Half-page turns',
  verticalScroll: 'Vertical scroll',
  horizontalScroll: 'Horizontal scroll',
}

const MODE_ICONS: Record<DisplayMode, React.ReactNode> = {
  single: <File className="size-4" />,
  double: <Columns2 className="size-4" />,
  halfPage: <SplitSquareVertical className="size-4" />,
  verticalScroll: <Rows3 className="size-4" />,
  horizontalScroll: <GalleryHorizontal className="size-4" />,
}

/** Segmented controls on the always-dark viewer: readable unselected labels, finger-sized on touch. */
export const DARK_SEG =
  '!bg-white/5 !border-white/10 [&>button[aria-checked=false]]:!text-white/65 [&>button[aria-checked=true]]:!bg-white [&>button[aria-checked=true]]:!text-neutral-900 pointer-coarse:[&>button]:!h-9'

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="shrink-0 text-sm text-white/80">{label}</span>
      {children}
    </div>
  )
}

const landscapeQuery = '(orientation: landscape)'
const subscribeOrientation = (cb: () => void) => {
  const mq = window.matchMedia?.(landscapeQuery)
  mq?.addEventListener('change', cb)
  return () => mq?.removeEventListener('change', cb)
}
const isLandscape = () => window.matchMedia?.(landscapeQuery).matches ?? false

export function DisplayPanel({ song, pages, currentPage, mode, stops, pos, paged }: PanelProps) {
  const s = useSettings((st) => st.s)
  const setIn = useSettings((st) => st.setIn)
  const terms = useTerms()
  const songMode = song.display?.mode
  const fit = song.display?.fit ?? s.display.fit
  // Performance lock: layout, fit and rotation stay as they are on stage.
  const locked = s.display.performanceLock
  const unlocked = (fn: () => void) => () => (locked ? toast('Performance lock is on') : fn())
  const setSongDisplay = (patch: Partial<{ mode: DisplayMode; fit: FitMode }>) =>
    unlocked(() => updateSong(song.id, { display: { ...song.display, ...patch } }))()
  // "Make default" sets the default the viewer is using now: the landscape one when it applies.
  const landscapeDefault = useSyncExternalStore(subscribeOrientation, isLandscape) && s.display.landscapeMode !== 'same'
  const defaultMode = landscapeDefault ? s.display.landscapeMode : s.display.mode

  // Spreads show two pages: rotate either.
  const shown = [...new Set(visiblePages(stops, pos, paged, currentPage))].sort((a, b) => a - b).filter((i) => pages[i]?.type === 'file')
  const [picked, setPicked] = useState<number | null>(null)
  const target = picked !== null && shown.includes(picked) ? picked : (shown[0] ?? currentPage)
  const dp = pages[target]
  const pageKey = dp?.type === 'file' ? pageSettingsKey(dp.file.id, dp.page) : null
  // Crop and annotations turn with the page.
  const rotate = (delta: number) => {
    if (pageKey) void rotateSongPages(song, [pageKey], delta)
  }

  return (
    <div className="space-y-5 p-4 text-white">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Layout</h3>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(MODE_LABELS) as DisplayMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setSongDisplay({ mode: m })}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                mode === m ? 'border-[var(--os-accent)] bg-[var(--os-accent)]/15 text-white' : 'border-white/10 text-white/70 hover:bg-white/5'
              }`}
            >
              {MODE_ICONS[m]}
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-white/50">
          <span>{songMode ? `Saved for this ${terms.song}` : landscapeDefault ? 'Using the landscape default' : `Using default for all ${terms.songs}`}</span>
          <div className="flex gap-3">
            {songMode && (
              <button className="text-[var(--os-accent)]" onClick={unlocked(() => {
                  const { mode: _omit, ...rest } = song.display ?? {}
                  updateSong(song.id, { display: rest })
                })}>
                Use default
              </button>
            )}
            {mode !== defaultMode && (
              <button className="text-[var(--os-accent)]" onClick={unlocked(() => setIn('display', landscapeDefault ? { landscapeMode: mode } : { mode }))}>
                {landscapeDefault ? 'Make landscape default' : 'Make default'}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* The horizontal strip always shows whole pages; the vertical one scrolls, so "Height" is "Whole page" there. */}
      {mode !== 'horizontalScroll' && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Fit</h3>
          <Segmented
            className={`w-full ${DARK_SEG}`}
            value={mode === 'verticalScroll' && fit === 'height' ? 'page' : fit}
            onChange={(f) => setSongDisplay({ fit: f })}
            options={[
              { value: 'page', label: 'Whole page' },
              { value: 'width', label: 'Width' },
              ...(mode === 'verticalScroll' ? [] : [{ value: 'height' as const, label: 'Height' }]),
            ]}
          />
        </section>
      )}

      <section className="divide-y divide-white/10">
        <Row label="Night mode">
          <Toggle checked={s.display.nightMode} onChange={(v) => setIn('display', { nightMode: v })} />
        </Row>
        <Row label="Paper">
          <Segmented
            size="sm"
            className={DARK_SEG}
            value={s.display.paperTone}
            onChange={(v) => setIn('display', { paperTone: v })}
            options={[
              { value: 'white', label: 'White' },
              { value: 'cream', label: 'Cream' },
              { value: 'sepia', label: 'Sepia' },
              { value: 'gray', label: 'Gray' },
              { value: 'cool', label: 'Cool' },
            ]}
          />
        </Row>
        <Row label="Dim screen">
          <Slider className="w-36" min={0.3} max={1} step={0.05} value={s.display.brightness} onChange={(v) => setIn('display', { brightness: v })} />
        </Row>
        <Row label="Page turn">
          <Segmented
            size="sm"
            className={DARK_SEG}
            value={s.display.transition}
            onChange={(v) => setIn('display', { transition: v })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'slide', label: 'Slide' },
              { value: 'fade', label: 'Fade' },
              { value: 'curl', label: 'Curl' },
            ]}
          />
        </Row>
        {mode === 'double' && (
          <Row label="Turns">
            <Segmented
              size="sm"
              className={DARK_SEG}
              value={s.display.twoPageTurn}
              onChange={(v) => setIn('display', { twoPageTurn: v })}
              options={[
                { value: 'two', label: '2 pages', title: '[1|2] → [3|4]' },
                { value: 'single', label: '1 page', title: '[1|2] → [2|3]' },
                { value: 'alternate', label: 'Alternate', title: '[1|2] → [3|2] → [3|4]' },
              ]}
            />
          </Row>
        )}
        {mode === 'halfPage' && (
          <Row label="Half-page split">
            <Slider className="w-36" min={0.3} max={0.7} step={0.05} value={s.display.halfPageSplit} onChange={(v) => setIn('display', { halfPageSplit: v })} />
          </Row>
        )}
        <Row label="Page numbers">
          <Toggle checked={s.display.showPageNumber} onChange={(v) => setIn('display', { showPageNumber: v })} />
        </Row>
      </section>

      <section className="divide-y divide-white/10">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-white/50">On-screen</h3>
        <Row label="Clock">
          <Segmented
            size="sm"
            className={DARK_SEG}
            value={s.overlays.clock}
            onChange={(v) => setIn('overlays', { clock: v })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'tl', label: '↖', title: 'Top left' },
              { value: 'tr', label: '↗', title: 'Top right' },
              { value: 'bl', label: '↙', title: 'Bottom left' },
              { value: 'br', label: '↘', title: 'Bottom right' },
            ]}
          />
        </Row>
        {s.overlays.clock !== 'off' && (
          <Row label="24-hour clock">
            <Toggle checked={s.overlays.clock24h} onChange={(v) => setIn('overlays', { clock24h: v })} />
          </Row>
        )}
        <Row label={<span>Capo badge<span className="block text-xs text-white/45">Chord {terms.songs} that use a capo</span></span>}>
          <Toggle checked={s.overlays.capo} onChange={(v) => setIn('overlays', { capo: v })} />
        </Row>
      </section>

      {pageKey && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/50">
            <BookOpen className="size-3.5" /> {shown.length > 1 ? 'Page' : 'This page'}
          </h3>
          {shown.length > 1 && (
            <Segmented
              className={`mb-2 w-full ${DARK_SEG}`}
              value={target}
              onChange={setPicked}
              options={shown.map((i) => ({ value: i, label: `Page ${i + 1}` }))}
            />
          )}
          <div className="flex gap-2">
            <button className="flex-1 rounded-lg border border-white/10 py-2 text-sm hover:bg-white/5" onClick={unlocked(() => rotate(-90))}>
              Rotate ↺
            </button>
            <button className="flex-1 rounded-lg border border-white/10 py-2 text-sm hover:bg-white/5" onClick={unlocked(() => rotate(90))}>
              Rotate ↻
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
