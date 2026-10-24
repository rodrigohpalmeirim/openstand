import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeDevice, uniqueDeviceName } from './deviceName'

const UA = {
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ asks for the desktop site: a Mac UA, told apart by touch points.
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  reducedPhone: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  reducedTablet: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  firefoxTablet: 'Mozilla/5.0 (Android 14; Tablet; rv:125.0) Gecko/125.0 Firefox/125.0',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
}

describe('default device names', () => {
  it.each([
    [{ userAgent: UA.ipad }, 'iPad', 'iPadOS'],
    [{ userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 }, 'iPad', 'iPadOS'],
    [{ userAgent: UA.iphone }, 'iPhone', 'iOS'],
    [{ userAgent: UA.pixel }, 'Pixel 8', 'Android'],
    [{ userAgent: UA.reducedPhone }, 'Android phone', 'Android'],
    [{ userAgent: UA.reducedTablet }, 'Android tablet', 'Android tablet'],
    [{ userAgent: UA.firefoxTablet }, 'Android tablet', 'Android tablet'],
    // Client hints give the model the reduced UA hides.
    [{ userAgent: UA.reducedPhone, hints: { platform: 'Android', mobile: true, model: 'Pixel 8' } }, 'Pixel 8', 'Android'],
    [{ userAgent: UA.reducedTablet, hints: { platform: 'Android', mobile: false, model: 'SM-X710' } }, 'SM-X710', 'Android tablet'],
    [{ userAgent: UA.windows }, 'Windows PC', 'Windows'],
    [{ userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 0 }, 'Mac', 'macOS'],
    [{ userAgent: UA.linux, hints: { platform: 'Linux', mobile: false } }, 'Linux PC', 'Linux'],
    [{ userAgent: UA.chromebook }, 'Chromebook', 'ChromeOS'],
    [{ userAgent: '' }, 'This device', 'Web'],
  ])('%o → %s', (info, name, platform) => {
    expect(describeDevice(info)).toEqual({ name, platform })
  })

  it('never names a device after its browser', () => {
    for (const ua of Object.values(UA)) expect(describeDevice({ userAgent: ua }).name).not.toMatch(/Chrome |Safari|Firefox|Edge| on /)
  })
})

describe('tablets and phones asking for the desktop site', () => {
  // Chrome on Android with "Desktop site" (the default on large tablets): desktop Linux UA, hints say Linux.
  const desktopSite = { userAgent: UA.linux, hints: { platform: 'Linux', mobile: false, model: '' } }
  const touch = { touchPrimary: true, maxTouchPoints: 10 }

  it.each([
    // formFactors (newer Chrome) wins when it says tablet or phone.
    [{ ...desktopSite, hints: { ...desktopSite.hints, formFactors: ['Tablet'] } }, 'Android tablet', 'Android tablet'],
    [{ ...desktopSite, hints: { ...desktopSite.hints, formFactors: ['Mobile'] } }, 'Android phone', 'Android'],
    [{ ...desktopSite, hints: { ...desktopSite.hints, formFactors: ['Tablet'] }, touchPrimary: false }, 'Android tablet', 'Android tablet'],
    // Without it: touch-first + Linux → Android; the screen's shorter side decides tablet or phone.
    [{ ...desktopSite, ...touch, screenShort: 800 }, 'Android tablet', 'Android tablet'],
    [{ ...desktopSite, ...touch, screenShort: 600 }, 'Android tablet', 'Android tablet'],
    [{ ...desktopSite, ...touch, screenShort: 412 }, 'Android phone', 'Android'],
    [{ ...desktopSite, hints: { ...desktopSite.hints, formFactors: ['Desktop'] }, ...touch, screenShort: 800 }, 'Android tablet', 'Android tablet'],
    [{ userAgent: UA.linux, ...touch, screenShort: 800 }, 'Android tablet', 'Android tablet'],
    // Linux laptops: a mouse or touchpad is the primary pointer, even with a touchscreen.
    [{ ...desktopSite, touchPrimary: false, maxTouchPoints: 10, screenShort: 1080 }, 'Linux PC', 'Linux'],
    [{ ...desktopSite, touchPrimary: false, maxTouchPoints: 0, screenShort: 1080 }, 'Linux PC', 'Linux'],
    [{ ...desktopSite, hints: { ...desktopSite.hints, formFactors: ['Desktop'] }, touchPrimary: false, maxTouchPoints: 0 }, 'Linux PC', 'Linux'],
    [{ ...desktopSite, touchPrimary: true, maxTouchPoints: 0, screenShort: 800 }, 'Linux PC', 'Linux'],
    // Not Linux: a touch-first Windows tablet or a Chromebook keeps its own name.
    [{ userAgent: UA.windows, ...touch, screenShort: 800, hints: { platform: 'Windows', formFactors: ['Desktop', 'Tablet'] } }, 'Windows PC', 'Windows'],
    [{ userAgent: UA.chromebook, ...touch, screenShort: 800 }, 'Chromebook', 'ChromeOS'],
    // A real Android UA: formFactors overrides the Mobile token.
    [{ userAgent: UA.reducedPhone, hints: { platform: 'Android', mobile: true, formFactors: ['Tablet'] } }, 'Android tablet', 'Android tablet'],
    // iPadOS asks for the desktop site too: a Mac UA with touch points.
    [{ userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5, touchPrimary: true, screenShort: 820 }, 'iPad', 'iPadOS'],
    [{ userAgent: UA.ipadDesktop, maxTouchPoints: 5 }, 'iPad', 'iPadOS'],
    [{ userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 0, touchPrimary: false }, 'Mac', 'macOS'],
  ])('%o → %s', (info, name, platform) => {
    expect(describeDevice(info)).toEqual({ name, platform })
  })
})

describe('thisDevice (the running browser)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  /** Stubs navigator, matchMedia and screen, then loads a fresh module (the hints are cached per module). */
  async function load(o: {
    ua: string
    platform?: string
    maxTouchPoints?: number
    coarse: boolean
    hover: boolean
    screen: [number, number]
    uaData?: { platform: string; mobile: boolean; high?: Record<string, unknown> }
  }) {
    const uaData = o.uaData && {
      platform: o.uaData.platform,
      mobile: o.uaData.mobile,
      getHighEntropyValues: async (hints: string[]) => ({
        platform: o.uaData!.platform,
        mobile: o.uaData!.mobile,
        ...Object.fromEntries(Object.entries(o.uaData!.high ?? {}).filter(([k]) => hints.includes(k))),
      }),
    }
    vi.stubGlobal('navigator', { userAgent: o.ua, platform: o.platform ?? '', maxTouchPoints: o.maxTouchPoints ?? 0, userAgentData: uaData })
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? o.coarse : q === '(hover: hover)' ? o.hover : false }))
    vi.stubGlobal('screen', { width: o.screen[0], height: o.screen[1] })
    vi.resetModules()
    const m = await import('./deviceName')
    await m.loadDeviceHints()
    return m.thisDevice()
  }

  it('Android tablet in desktop mode (Chrome without formFactors) is an Android tablet', async () => {
    const d = await load({ ua: UA.linux, platform: 'Linux armv81', maxTouchPoints: 10, coarse: true, hover: false, screen: [1280, 800], uaData: { platform: 'Linux', mobile: false, high: { model: '' } } })
    expect(d).toEqual({ name: 'Android tablet', platform: 'Android tablet' })
  })

  it('uses formFactors when Chrome reports it', async () => {
    const d = await load({ ua: UA.linux, maxTouchPoints: 10, coarse: true, hover: false, screen: [1280, 800], uaData: { platform: 'Linux', mobile: false, high: { model: '', formFactors: ['Tablet'] } } })
    expect(d).toEqual({ name: 'Android tablet', platform: 'Android tablet' })
  })

  it('Android phone in desktop mode is an Android phone', async () => {
    const d = await load({ ua: UA.linux, maxTouchPoints: 5, coarse: true, hover: false, screen: [412, 915], uaData: { platform: 'Linux', mobile: false } })
    expect(d).toEqual({ name: 'Android phone', platform: 'Android' })
  })

  it('a Linux laptop with a touchscreen stays a Linux PC', async () => {
    const d = await load({ ua: UA.linux, platform: 'Linux x86_64', maxTouchPoints: 10, coarse: false, hover: true, screen: [1920, 1080], uaData: { platform: 'Linux', mobile: false, high: { formFactors: ['Desktop'] } } })
    expect(d).toEqual({ name: 'Linux PC', platform: 'Linux' })
  })

  it('iPad Safari (desktop UA, no client hints) is an iPad', async () => {
    const d = await load({ ua: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5, coarse: true, hover: false, screen: [820, 1180] })
    expect(d).toEqual({ name: 'iPad', platform: 'iPadOS' })
  })
})

describe('uniqueDeviceName', () => {
  it('adds a number only when an earlier device has the name', () => {
    expect(uniqueDeviceName('iPad', [])).toBe('iPad')
    expect(uniqueDeviceName('iPad', ['Pixel 8', 'Mac'])).toBe('iPad')
    expect(uniqueDeviceName('iPad', ['ipad'])).toBe('iPad 2')
    expect(uniqueDeviceName('iPad', ['iPad', 'iPad 2'])).toBe('iPad 3')
    expect(uniqueDeviceName('iPad', ['iPad', 'iPad 3'])).toBe('iPad 2')
  })
})
