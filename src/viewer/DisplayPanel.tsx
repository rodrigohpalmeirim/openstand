import { BookOpen, Columns2, File, GalleryHorizontal, Rows3, SplitSquareVertical } from 'lucide-react'
import { db } from '../db/db'
import type { DisplayMode, FitMode, PageSettings } from '../db/schema'
import { useSettings } from '../state/settings'
import { Segmented, Slider, Toggle } from '../ui/primitives'
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

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-white/80">{label}</span>
      {children}
    </div>
  )
}

export function DisplayPanel({ song, pages, currentPage, mode }: PanelProps) {
  const s = useSettings((st) => st.s)
  const setIn = useSettings((st) => st.setIn)
  const songMode = song.display?.mode
  const fit = song.display?.fit ?? s.display.fit
  const setSongDisplay = (patch: Partial<{ mode: DisplayMode; fit: FitMode }>) =>
    db.songs.update(song.id, { display: { ...song.display, ...patch } })

  const dp = pages[currentPage]
  const pageKey = dp?.type === 'file' ? pageSettingsKey(dp.file.id, dp.page) : null
  const ps: PageSettings = pageKey ? song.pageSettings[pageKey] ?? {} : {}
  const rotate = (delta: number) => {
    if (!pageKey) return
    const rotation = ((((ps.rotation ?? 0) + delta) % 360) + 360) % 360
    db.songs.update(song.id, { pageSettings: { ...song.pageSettings, [pageKey]: { ...ps, rotation: rotation as PageSettings['rotation'] } } })
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
          <span>{songMode ? 'Saved for this song' : 'Using default for all songs'}</span>
          {songMode ? (
            <button className="text-[var(--os-accent)]" onClick={() => {
                const { mode: _omit, ...rest } = song.display ?? {}
                db.songs.update(song.id, { display: rest })
              }}>
              Use default
            </button>
          ) : (
            <button className="text-[var(--os-accent)]" onClick={() => setIn('display', { mode })}>
              Make default
            </button>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Fit</h3>
        <Segmented
          className="w-full !bg-white/5 !border-white/10"
          value={fit}
          onChange={(f) => setSongDisplay({ fit: f })}
          options={[
            { value: 'page', label: 'Whole page' },
            { value: 'width', label: 'Width' },
            { value: 'height', label: 'Height' },
          ]}
        />
      </section>

      <section className="divide-y divide-white/10">
        <Row label="Night mode">
          <Toggle checked={s.display.nightMode} onChange={(v) => setIn('display', { nightMode: v })} />
        </Row>
        <Row label="Paper">
          <Segmented
            size="sm"
            className="!bg-white/5 !border-white/10"
            value={s.display.paperTone}
            onChange={(v) => setIn('display', { paperTone: v })}
            options={[
              { value: 'white', label: 'White' },
              { value: 'cream', label: 'Cream' },
              { value: 'sepia', label: 'Sepia' },
            ]}
          />
        </Row>
        <Row label="Dim screen">
          <Slider className="w-36" min={0.3} max={1} step={0.05} value={s.display.brightness} onChange={(v) => setIn('display', { brightness: v })} />
        </Row>
        <Row label="Page turn">
          <Segmented
            size="sm"
            className="!bg-white/5 !border-white/10"
            value={s.display.transition}
            onChange={(v) => setIn('display', { transition: v })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'slide', label: 'Slide' },
              { value: 'fade', label: 'Fade' },
            ]}
          />
        </Row>
        {mode === 'halfPage' && (
          <Row label="Half-page split">
            <Slider className="w-36" min={0.3} max={0.7} step={0.05} value={s.display.halfPageSplit} onChange={(v) => setIn('display', { halfPageSplit: v })} />
          </Row>
        )}
        <Row label="Page numbers">
          <Toggle checked={s.display.showPageNumber} onChange={(v) => setIn('display', { showPageNumber: v })} />
        </Row>
      </section>

      {pageKey && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-white/50">
            <BookOpen className="size-3.5" /> This page
          </h3>
          <div className="flex gap-2">
            <button className="flex-1 rounded-lg border border-white/10 py-2 text-sm hover:bg-white/5" onClick={() => rotate(-90)}>
              Rotate ↺
            </button>
            <button className="flex-1 rounded-lg border border-white/10 py-2 text-sm hover:bg-white/5" onClick={() => rotate(90)}>
              Rotate ↻
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
