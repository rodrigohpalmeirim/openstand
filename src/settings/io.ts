import { migrateSettings, SETTINGS_VERSION, type Settings } from '../state/settings'

/** Fields that only make sense on this device and are not carried over by export/import. */
const DEVICE_ONLY: (keyof Settings)[] = ['recentSearches', 'onboarded']

export function settingsToJSON(s: Settings): string {
  const copy: Partial<Settings> = { ...s }
  for (const k of DEVICE_ONLY) delete copy[k]
  return JSON.stringify({ app: 'openstand', kind: 'settings', version: SETTINGS_VERSION, exportedAt: new Date().toISOString(), settings: copy }, null, 2)
}

/**
 * Parse an exported settings file and merge it over `current` (device-only fields are kept).
 * Accepts the export envelope or a bare settings object. Throws a readable error otherwise.
 */
export function settingsFromJSON(text: string, current: Settings): Settings {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('This file does not contain settings.')
  const env = data as { app?: string; kind?: string; version?: number; settings?: unknown }
  if (env.app && env.app !== 'openstand') throw new Error('This settings file is from another app.')
  if (env.kind && env.kind !== 'settings') throw new Error(`This is an OpenStand ${env.kind} file, not a settings file.`)
  const body = env.kind === 'settings' ? env.settings : data
  if (!body || typeof body !== 'object') throw new Error('This file does not contain settings.')
  if (typeof env.version === 'number' && env.version > SETTINGS_VERSION) throw new Error('These settings come from a newer version of OpenStand. Update the app first.')
  const merged = migrateSettings(body, typeof env.version === 'number' ? env.version : SETTINGS_VERSION)
  for (const k of DEVICE_ONLY) (merged as unknown as Record<string, unknown>)[k] = current[k]
  return merged
}

export function downloadText(name: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}
