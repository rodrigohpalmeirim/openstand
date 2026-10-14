/**
 * Background services started once at app launch (MIDI listeners, device sync, file handling).
 * Each module registers itself here so App stays agnostic of them.
 */
type Service = () => void | (() => void)
const services: Service[] = []

export function registerService(s: Service) {
  services.push(s)
}

export function startBackgroundServices(): () => void {
  const stops = services.map((s) => {
    try {
      return s()
    } catch (e) {
      console.error('service failed to start', e)
      return undefined
    }
  })
  return () => stops.forEach((s) => s?.())
}
