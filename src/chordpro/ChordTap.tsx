/**
 * Tap a chord in a rendered song to see its diagram. A window-level capture listener hit-tests
 * chord elements (so it works under transparent overlays) and keeps the tap away from the
 * viewer's page-turn zones; the block containing the chord shows the popover.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChordDiagram } from '../music/ChordDiagram'
import { loadInstrument, lookupDiagram, type Diagram, type Shape } from '../music/diagrams'
import { settings } from '../state/settings'
import { useViewer } from '../state/viewer'
import { Popover } from '../ui/primitives'
import type { ChordCtx } from './render'

const EVENT = 'os-chordtap'

let users = 0
let downAt: { el: HTMLElement; x: number; y: number } | null = null

function chordAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const c = (el as HTMLElement).closest?.('[data-chord]') as HTMLElement | null
    if (c && c.closest('[data-taparea]')) return c
  }
  return null
}

function onDown(e: PointerEvent) {
  downAt = null
  if (!settings().text.diagramTap || useViewer.getState().annotating || e.button > 0) return
  const el = chordAt(e.clientX, e.clientY)
  if (!el) return
  e.stopPropagation()
  downAt = { el, x: e.clientX, y: e.clientY }
}

function onUp(e: PointerEvent) {
  const d = downAt
  downAt = null
  if (!d) return
  e.stopPropagation()
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return
  d.el.closest('[data-taparea]')?.dispatchEvent(new CustomEvent(EVENT, { detail: d.el }))
}

function useGlobalTapListener() {
  useEffect(() => {
    if (users++ === 0) {
      window.addEventListener('pointerdown', onDown, true)
      window.addEventListener('pointerup', onUp, true)
    }
    return () => {
      if (--users === 0) {
        window.removeEventListener('pointerdown', onDown, true)
        window.removeEventListener('pointerup', onUp, true)
      }
    }
  }, [])
}

export function ChordTapArea({ chords, children }: { chords: ChordCtx; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useGlobalTapListener()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = (e: Event) => setAnchor((e as CustomEvent<HTMLElement>).detail)
    el.addEventListener(EVENT, on)
    return () => el.removeEventListener(EVENT, on)
  }, [])
  return (
    <div ref={ref} data-taparea="">
      {children}
      {anchor && (
        <ChordPopover
          anchor={anchor}
          name={anchor.dataset.chord ?? ''}
          label={anchor.dataset.label ?? anchor.dataset.chord ?? ''}
          chords={chords}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  )
}

function ChordPopover({ anchor, name, label, chords, onClose }: { anchor: HTMLElement; name: string; label: string; chords: ChordCtx; onClose: () => void }) {
  const [, force] = useState(0)
  const [variant, setVariant] = useState(0)
  useEffect(() => {
    loadInstrument(chords.instrument).then(() => force((n) => n + 1))
  }, [chords.instrument])
  // Song definitions refer to chords as written; they apply only while untransposed.
  const d: Diagram | null = lookupDiagram(name, chords.instrument, chords.semitones || chords.capo ? [] : chords.defines)
  const shapes: Shape[] = d ? [d.shape, ...(d.variants ?? [])] : []
  const shown = d ? { ...d, shape: shapes[variant % shapes.length] } : null
  return (
    <Popover anchor={anchor} open onClose={onClose} align="center" className="!p-3">
      <div className="flex flex-col items-center gap-2 text-fg" style={{ fontSize: 22 }}>
        {shown ? (
          <ChordDiagram diagram={shown} label={label} size={1.3} bg="var(--os-surface)" />
        ) : (
          <div className="px-2 py-1 text-sm text-muted">No diagram for {label}</div>
        )}
        {shapes.length > 1 && (
          <button
            type="button"
            className="h-9 rounded-lg px-3 text-xs text-muted hover:bg-surface-2"
            onClick={() => setVariant((v) => v + 1)}
          >
            Voicing {(variant % shapes.length) + 1} / {shapes.length}
          </button>
        )}
      </div>
    </Popover>
  )
}
