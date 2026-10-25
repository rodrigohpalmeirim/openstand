import { useEffect, useRef, type CSSProperties } from 'react'

/**
 * The performance viewer is always dark. The UI kit reads Tailwind colour variables, so overriding
 * them on a wrapper renders every primitive (Input, Select, Toggle, Segmented…) dark while keeping the
 * user's accent colour.
 */
export const DARK_VARS = {
  '--color-bg': '#0f1011',
  '--color-surface': '#17181a',
  '--color-surface-2': '#232428',
  '--color-surface-3': '#34353a',
  '--color-line': '#33343a',
  '--color-fg': '#ecebe8',
  '--color-muted': '#a09d96',
  '--color-faint': '#76736c',
  colorScheme: 'dark',
} as CSSProperties

/** Stop native pointerdown from reaching the stage gesture handler (page turns, zones). */
export function useStopStagePointer<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    el.addEventListener('pointerdown', stop)
    return () => el.removeEventListener('pointerdown', stop)
  }, [])
  return ref
}

/** Parse "m:ss" (or plain seconds) into seconds; undefined when empty/invalid. */
export function parseClock(text: string): number | undefined {
  const t = text.trim()
  if (!t) return undefined
  const parts = t.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/**
 * A song length typed as "m:ss" → whole seconds; empty → 0 (cleared); undefined when invalid. A bare
 * number under 60 means minutes ("4" = 4:00): no song is a few seconds long.
 */
export function parseSongLength(text: string): number | undefined {
  const t = text.trim()
  if (!t) return 0
  const v = parseClock(t)
  if (v === undefined) return undefined
  return Math.round(/^\d+(\.\d+)?$/.test(t) && v < 60 ? v * 60 : v)
}
