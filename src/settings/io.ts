import { DEFAULT_SETTINGS, mergeSettings, migrateSettings, SETTINGS_VERSION, type Settings } from '../state/settings'

/**
 * Settings paths that only make sense on this device (its band-sync identity and connection, its MIDI
 * ports): not exported, and an import keeps this device's values.
 */
const DEVICE_ONLY = [
  'recentSearches',
  'onboarded',
  'sync.deviceName',
  'sync.role',
  'sync.relayUrl',
  'sync.room',
  'sync.autoConnect',
  'midi.inputs',
  'midi.outputs',
]

type Obj = Record<string, unknown>

/** Copy `s` with the value at each dotted path replaced by `from`'s (or removed when `from` is undefined). */
function withPaths<T>(s: T, paths: string[], from?: T): T {
  const out = structuredClone(s) as Obj
  for (const path of paths) {
    const keys = path.split('.')
    const last = keys.pop()!
    const parent = keys.reduce<Obj | undefined>((o, k) => o?.[k] as Obj | undefined, out)
    if (!parent) continue
    if (from === undefined) delete parent[last]
    else parent[last] = structuredClone(keys.reduce<Obj | undefined>((o, k) => o?.[k] as Obj | undefined, from as Obj)?.[last])
  }
  return out as T
}

export function settingsToJSON(s: Settings): string {
  const copy = withPaths(s, DEVICE_ONLY)
  return JSON.stringify({ app: 'openstand', kind: 'settings', version: SETTINGS_VERSION, exportedAt: new Date().toISOString(), settings: copy }, null, 2)
}

/**
 * "Reset all settings": defaults everywhere (bindings included), but things the user made rather than
 * chose are kept (annotation favourites and recent colours, import patterns), and so is everything
 * device-only: this device's sync name, room and connection (resetting them would silently move it out
 * of its band's room), its MIDI ports, and the onboarding / recent-search state.
 */
export function resetAllSettings(s: Settings): Settings {
  const D = DEFAULT_SETTINGS
  const reset = mergeSettings({
    ...D,
    annotations: { ...D.annotations, presets: s.annotations.presets, recentColors: s.annotations.recentColors },
    importPrefs: { ...D.importPrefs, filePattern: s.importPrefs.filePattern, folderPattern: s.importPrefs.folderPattern, folderFromEnd: s.importPrefs.folderFromEnd },
  })
  return withPaths(reset, DEVICE_ONLY, s)
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
  return withPaths(merged, DEVICE_ONLY, current)
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
