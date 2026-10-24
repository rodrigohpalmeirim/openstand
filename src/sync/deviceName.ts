/**
 * Friendly default device names ("iPad", "Pixel 8", "Windows PC", "Mac") and the platform label of a device
 * record, from the user agent and, where the browser has them, UA client hints (`navigator.userAgentData`).
 * Pure apart from the cached hints; shared by performance sync and library sync.
 */

export interface DeviceInfo {
  userAgent: string
  /** `navigator.platform` (legacy; tells iPadOS apart from macOS together with touch points). */
  platform?: string
  maxTouchPoints?: number
  /** UA client hints: low-entropy `platform` / `mobile`, high-entropy `model`. */
  hints?: { platform?: string; mobile?: boolean; model?: string }
}

export interface DeviceKind {
  /** Default name, e.g. "iPad", "Pixel 8", "Android tablet", "Windows PC". */
  name: string
  /** Platform label for the device record, e.g. "iPadOS", "Android", "Android tablet", "macOS". */
  platform: string
}

/** Android UA model token (`Android 14; Pixel 8 Build/…`); reduced UAs only carry "K". */
function androidModel(ua: string): string | undefined {
  const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*[;)]/.exec(ua)
  const model = m?.[1]?.trim()
  if (!model || model === 'K' || /^(wv|Mobile|Tablet|Linux|U|rv:.*|[a-z]{2}(-[a-z]{2})?)$/i.test(model)) return undefined
  return model
}

const cleanModel = (m?: string) => {
  const t = m?.trim()
  return t && t !== 'K' ? t : undefined
}

export function describeDevice(info: DeviceInfo): DeviceKind {
  const ua = info.userAgent ?? ''
  const hp = info.hints?.platform?.toLowerCase() ?? ''
  const touchMac = /Mac/.test(info.platform ?? '') && (info.maxTouchPoints ?? 0) > 1
  if (/iPad/.test(ua) || (touchMac && !/iPhone|iPod/.test(ua))) return { name: 'iPad', platform: 'iPadOS' }
  if (/iPhone/.test(ua)) return { name: 'iPhone', platform: 'iOS' }
  if (/iPod/.test(ua)) return { name: 'iPod', platform: 'iOS' }
  if (hp === 'android' || /Android/.test(ua)) {
    const model = cleanModel(info.hints?.model) ?? androidModel(ua)
    // Android tablets send no "Mobile" token (and `mobile: false` in client hints).
    const tablet = info.hints?.mobile === false || (info.hints?.mobile === undefined && !/Mobile/.test(ua))
    return { name: model ?? (tablet ? 'Android tablet' : 'Android phone'), platform: tablet ? 'Android tablet' : 'Android' }
  }
  if (hp === 'chrome os' || hp === 'chromeos' || /CrOS/.test(ua)) return { name: 'Chromebook', platform: 'ChromeOS' }
  if (hp === 'windows' || /Windows/.test(ua)) return { name: 'Windows PC', platform: 'Windows' }
  if (hp === 'macos' || /Macintosh|Mac OS X/.test(ua)) return { name: 'Mac', platform: 'macOS' }
  if (hp === 'linux' || /Linux|X11/.test(ua)) return { name: 'Linux PC', platform: 'Linux' }
  return { name: 'This device', platform: 'Web' }
}

// ---------------------------------------------------------------------------------------------
// The running browser
// ---------------------------------------------------------------------------------------------

interface UAData {
  platform?: string
  mobile?: boolean
  getHighEntropyValues?(hints: string[]): Promise<{ model?: string; platform?: string; mobile?: boolean }>
}

let cachedHints: DeviceInfo['hints']
let loading: Promise<void> | undefined

const uaData = (): UAData | undefined =>
  typeof navigator === 'undefined' ? undefined : ((navigator as Navigator & { userAgentData?: UAData }).userAgentData ?? undefined)

/** Reads the high-entropy client hints (the phone model) once; resolves at once where there are none. */
export function loadDeviceHints(): Promise<void> {
  const d = uaData()
  if (!d?.getHighEntropyValues) return Promise.resolve()
  loading ??= d
    .getHighEntropyValues(['model', 'platform'])
    .then((h) => void (cachedHints = { platform: h.platform ?? d.platform, mobile: h.mobile ?? d.mobile, model: h.model }))
    .catch(() => {})
  return loading
}

export function thisDevice(): DeviceKind {
  if (typeof navigator === 'undefined') return { name: 'This device', platform: 'node' }
  const d = uaData()
  return describeDevice({
    userAgent: navigator.userAgent ?? '',
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    hints: cachedHints ?? (d ? { platform: d.platform, mobile: d.mobile } : undefined),
  })
}

/** This device's default name (before the user renames it). */
export const defaultDeviceName = () => thisDevice().name

/**
 * `base`, or "base 2", "base 3", … when a device that joined earlier already uses that name (case-insensitive).
 * Only earlier devices count, so two devices never keep swapping names.
 */
export function uniqueDeviceName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}
