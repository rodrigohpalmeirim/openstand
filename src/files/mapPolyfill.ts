/**
 * pdf.js 6 calls Map/WeakMap.prototype.getOrInsert(Computed) (TC39 "upsert"), which many browsers in
 * use (older Chromium, Safari, Firefox ESR) do not ship yet. Install minimal versions when missing.
 */
type Upsert<K, V> = {
  getOrInsert?: (key: K, value: V) => V
  getOrInsertComputed?: (key: K, fn: (key: K) => V) => V
}
for (const C of [Map, WeakMap] as unknown as { prototype: Upsert<unknown, unknown> & { has(k: unknown): boolean; get(k: unknown): unknown; set(k: unknown, v: unknown): unknown } }[]) {
  const proto = C.prototype
  if (!proto.getOrInsert)
    Object.defineProperty(proto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(this: typeof proto, key: unknown, value: unknown) {
        if (!this.has(key)) this.set(key, value)
        return this.get(key)
      },
    })
  if (!proto.getOrInsertComputed)
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(this: typeof proto, key: unknown, fn: (k: unknown) => unknown) {
        if (!this.has(key)) this.set(key, fn(key))
        return this.get(key)
      },
    })
}
export {}
