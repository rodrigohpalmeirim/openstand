/**
 * The real timer functions as an object the engine and relay can call as methods. Browsers throw
 * "Illegal invocation" when `window.setTimeout` runs with another object as `this` (as in
 * `{ setTimeout }.setTimeout(…)`); Node doesn't care, so only a real browser showed it. Looked up at call
 * time, so fake timers installed later still apply.
 */
export interface Timers {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
}

export const realTimers: Timers = {
  setTimeout: ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as typeof setTimeout,
  clearTimeout: ((id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id)) as typeof clearTimeout,
  setInterval: ((fn: () => void, ms?: number) => globalThis.setInterval(fn, ms)) as typeof setInterval,
  clearInterval: ((id?: ReturnType<typeof setInterval>) => globalThis.clearInterval(id)) as typeof clearInterval,
}
