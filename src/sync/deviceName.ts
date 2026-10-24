/**
 * Friendly default device names ("iPad", "Pixel 8", "Windows PC", "Mac") and the platform label of a device
 * record, from the user agent and, where the browser has them, UA client hints (`navigator.userAgentData`).
 * Pure apart from the cached hints; shared by performance sync and library sync.
 *
 * Tablets often pose as desktops: iPadOS Safari sends a Mac UA, and Chrome on large Android tablets requests
 * the desktop site by default (any Android device can turn it on), sending the desktop Linux UA
 * (`X11; Linux x86_64`) with client hints platform "Linux", model "" and mobile false. Newer Chrome can
 * still say "Tablet"/"Mobile" in the `formFactors` hint; otherwise a touch-first device (coarse primary
 * pointer, no hover, several touch points) that claims Linux is taken for Android, a tablet when the shorter
 * side of its screen is at least 600 CSS px (Android's own tablet threshold). Linux laptops with touchscreens
 * have a mouse or touchpad as their primary pointer, so they stay "Linux PC".
 */

export interface DeviceInfo {
  userAgent: string
  /** `navigator.platform` (legacy; tells iPadOS apart from macOS together with touch points). */
  platform?: string
  maxTouchPoints?: number
  /** UA client hints: low-entropy `platform` / `mobile`, high-entropy `model` and `formFactors`. */
  hints?: { platform?: string; mobile?: boolean; model?: string; formFactors?: string[] }
  /** The primary pointer is touch: `(pointer: coarse)` matches and `(hover: hover)` doesn't. */
  touchPrimary?: boolean
  /** The shorter side of the screen, in CSS px. */
  screenShort?: number
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

const ANDROID_TABLET: DeviceKind = { name: 'Android tablet', platform: 'Android tablet' }
const ANDROID_PHONE: DeviceKind = { name: 'Android phone', platform: 'Android' }

/** `formFactors` says tablet or phone (undefined: absent, or only "Desktop" etc.). */
function formFactor(info: DeviceInfo): 'tablet' | 'phone' | undefined {
  const ff = info.hints?.formFactors?.map((f) => f.toLowerCase()) ?? []
  return ff.includes('tablet') ? 'tablet' : ff.includes('mobile') ? 'phone' : undefined
}

/** A device whose browser claims desktop Linux but is touch-first: Android asking for the desktop site. */
function disguisedAndroid(info: DeviceInfo): DeviceKind | undefined {
  const ff = formFactor(info)
  if (ff) return ff === 'tablet' ? ANDROID_TABLET : ANDROID_PHONE
  if (!info.touchPrimary || (info.maxTouchPoints ?? 0) < 2) return undefined
  return (info.screenShort ?? 0) >= 600 ? ANDROID_TABLET : ANDROID_PHONE
}

export function describeDevice(info: DeviceInfo): DeviceKind {
  const ua = info.userAgent ?? ''
  const hp = info.hints?.platform?.toLowerCase() ?? ''
  // iPadOS asks for the desktop site: a Mac UA (and platform "MacIntel") with touch points.
  const touchMac = (/Mac/.test(info.platform ?? '') || (!info.platform && /Macintosh/.test(ua))) && (info.maxTouchPoints ?? 0) > 1
  if (/iPad/.test(ua) || (touchMac && !/iPhone|iPod/.test(ua))) return { name: 'iPad', platform: 'iPadOS' }
  if (/iPhone/.test(ua)) return { name: 'iPhone', platform: 'iOS' }
  if (/iPod/.test(ua)) return { name: 'iPod', platform: 'iOS' }
  if (hp === 'android' || /Android/.test(ua)) {
    const model = cleanModel(info.hints?.model) ?? androidModel(ua)
    // Android tablets send no "Mobile" token (and `mobile: false` in client hints).
    const ff = formFactor(info)
    const tablet = ff ? ff === 'tablet' : info.hints?.mobile === false || (info.hints?.mobile === undefined && !/Mobile/.test(ua))
    return { name: model ?? (tablet ? 'Android tablet' : 'Android phone'), platform: tablet ? 'Android tablet' : 'Android' }
  }
  if (hp === 'chrome os' || hp === 'chromeos' || /CrOS/.test(ua)) return { name: 'Chromebook', platform: 'ChromeOS' }
  if (hp === 'windows' || /Windows/.test(ua)) return { name: 'Windows PC', platform: 'Windows' }
  if (hp === 'macos' || /Macintosh|Mac OS X/.test(ua)) return { name: 'Mac', platform: 'macOS' }
  if (hp === 'linux' || /Linux|X11/.test(ua)) return disguisedAndroid(info) ?? { name: 'Linux PC', platform: 'Linux' }
  return { name: 'This device', platform: 'Web' }
}

// ---------------------------------------------------------------------------------------------
// The running browser
// ---------------------------------------------------------------------------------------------

interface UAData {
  platform?: string
  mobile?: boolean
  getHighEntropyValues?(hints: string[]): Promise<{ model?: string; platform?: string; mobile?: boolean; formFactors?: string[] }>
}

let cachedHints: DeviceInfo['hints']
let loading: Promise<void> | undefined

const uaData = (): UAData | undefined =>
  typeof navigator === 'undefined' ? undefined : ((navigator as Navigator & { userAgentData?: UAData }).userAgentData ?? undefined)

/** Reads the high-entropy client hints (phone model, form factors) once; resolves at once where there are none. */
export function loadDeviceHints(): Promise<void> {
  const d = uaData()
  if (!d?.getHighEntropyValues) return Promise.resolve()
  loading ??= d
    .getHighEntropyValues(['model', 'platform', 'formFactors'])
    .then(
      (h) =>
        void (cachedHints = {
          platform: h.platform ?? d.platform,
          mobile: h.mobile ?? d.mobile,
          model: h.model,
          formFactors: Array.isArray(h.formFactors) ? h.formFactors : undefined,
        }),
    )
    .catch(() => {})
  return loading
}

const matches = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches

/** Touch-first: the primary pointer is coarse and can't hover (phones, tablets; not touchscreen laptops). */
const touchPrimary = () => matches('(pointer: coarse)') && !matches('(hover: hover)')

function screenShort(): number | undefined {
  if (typeof screen === 'undefined' || !screen.width || !screen.height) return undefined
  return Math.min(screen.width, screen.height)
}

export function thisDevice(): DeviceKind {
  if (typeof navigator === 'undefined') return { name: 'This device', platform: 'node' }
  const d = uaData()
  return describeDevice({
    userAgent: navigator.userAgent ?? '',
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    hints: cachedHints ?? (d ? { platform: d.platform, mobile: d.mobile } : undefined),
    touchPrimary: touchPrimary(),
    screenShort: screenShort(),
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
