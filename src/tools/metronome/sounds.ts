import type { MetronomeSettings } from '../../db/schema'
import type { TickLevel } from './clock'

export type SoundId = MetronomeSettings['sound']

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: 'click', label: 'Click' },
  { id: 'wood', label: 'Woodblock' },
  { id: 'beep', label: 'Beep' },
  { id: 'cowbell', label: 'Cowbell' },
]

const GAIN: Record<TickLevel, number> = { accent: 1, beat: 0.72, sub: 0.4 }
/** Accents are pitched up, subdivisions slightly down, so they are distinguishable without looking. */
const PITCH: Record<TickLevel, number> = { accent: 1.5, beat: 1, sub: 0.85 }

/** Deterministic noise so renders are reproducible. */
function noise(seed = 1) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 31 - 1
  }
}

/**
 * Render one click as raw samples. Everything is synthesised (no audio assets): short decaying
 * partials shaped to resemble each instrument.
 */
export function renderClick(sound: SoundId, level: TickLevel, sampleRate: number): Float32Array {
  const g = GAIN[level]
  const p = PITCH[level]
  const len = { click: 0.03, wood: 0.08, beep: 0.07, cowbell: 0.3 }[sound]
  const n = Math.ceil(len * sampleRate)
  const out = new Float32Array(n)
  const rnd = noise(sound.length * 7 + level.length)
  const TAU = Math.PI * 2
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let v = 0
    switch (sound) {
      case 'click': {
        const env = Math.exp(-t / 0.004)
        v = (rnd() * 0.5 + Math.sign(Math.sin(TAU * 2000 * p * t)) * 0.5) * env
        break
      }
      case 'wood': {
        const env = Math.exp(-t / 0.018)
        const f = 1150 * p
        v = (Math.sin(TAU * f * t) * 0.8 + Math.sin(TAU * f * 2.71 * t) * 0.25 * Math.exp(-t / 0.006)) * env
        break
      }
      case 'beep': {
        const attack = Math.min(1, t / 0.003)
        const release = Math.min(1, (len - t) / 0.01)
        v = Math.sin(TAU * 880 * p * t) * attack * Math.max(0, release) * 0.8
        break
      }
      case 'cowbell': {
        const env = Math.exp(-t / 0.07) * Math.min(1, t / 0.001)
        const sq = (f: number) => Math.sin(TAU * f * t) + Math.sin(TAU * 3 * f * t) / 3 + Math.sin(TAU * 5 * f * t) / 5
        v = Math.tanh((sq(540 * p) + sq(800 * p)) * 0.6) * env * 0.7
        break
      }
    }
    out[i] = v * g
  }
  return out
}
