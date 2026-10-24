import { describe, expect, it } from 'vitest'
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

describe('uniqueDeviceName', () => {
  it('adds a number only when an earlier device has the name', () => {
    expect(uniqueDeviceName('iPad', [])).toBe('iPad')
    expect(uniqueDeviceName('iPad', ['Pixel 8', 'Mac'])).toBe('iPad')
    expect(uniqueDeviceName('iPad', ['ipad'])).toBe('iPad 2')
    expect(uniqueDeviceName('iPad', ['iPad', 'iPad 2'])).toBe('iPad 3')
    expect(uniqueDeviceName('iPad', ['iPad', 'iPad 3'])).toBe('iPad 2')
  })
})
