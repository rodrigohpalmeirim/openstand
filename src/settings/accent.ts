import { registerService } from '../services'
import { useSettings, type AccentId } from '../state/settings'

/** Accent presets: [light accent, dark accent, text-on-accent light, text-on-accent dark]. */
export const ACCENTS: Record<AccentId, { label: string; hint: string; light: string; dark: string; fgLight: string; fgDark: string }> = {
  ember: { label: 'Ember', hint: 'A warm orange — the default.', light: '#c2410c', dark: '#fb923c', fgLight: '#ffffff', fgDark: '#1a0d03' },
  ocean: { label: 'Ocean', hint: 'A calm, classic blue.', light: '#1d4ed8', dark: '#60a5fa', fgLight: '#ffffff', fgDark: '#06142b' },
  forest: { label: 'Forest', hint: 'A soft green that’s easy on the eyes.', light: '#15803d', dark: '#4ade80', fgLight: '#ffffff', fgDark: '#04210f' },
  violet: { label: 'Violet', hint: 'A deep purple.', light: '#6d28d9', dark: '#a78bfa', fgLight: '#ffffff', fgDark: '#160a33' },
  // High-visibility red that stays readable on a dark stage.
  stage: { label: 'Stage', hint: 'A strong red that stays easy to spot on a dark stage.', light: '#b91c1c', dark: '#f87171', fgLight: '#ffffff', fgDark: '#2a0505' },
}

function css(): string {
  return Object.entries(ACCENTS)
    .filter(([id]) => id !== 'ember') // ember is the default palette in index.css
    .map(
      ([id, a]) =>
        `:root[data-accent="${id}"]{--os-accent:${a.light};--os-accent-fg:${a.fgLight};--os-accent-soft:${a.light}1a}` +
        `:root.dark[data-accent="${id}"]{--os-accent:${a.dark};--os-accent-fg:${a.fgDark};--os-accent-soft:${a.dark}22}`,
    )
    .join('\n')
}

registerService(() => {
  const style = document.createElement('style')
  style.dataset.openstand = 'accent'
  style.textContent = css()
  document.head.appendChild(style)
  const apply = (id: AccentId) => {
    if (id === 'ember') delete document.documentElement.dataset.accent
    else document.documentElement.dataset.accent = id
  }
  apply(useSettings.getState().s.accent)
  const unsub = useSettings.subscribe((st, prev) => st.s.accent !== prev.s.accent && apply(st.s.accent))
  return () => {
    unsub()
    style.remove()
  }
})
