/**
 * URLs that come from song data (typed by the user, imported from a package, or synced from another device)
 * must never be opened with a scheme that runs code or hands off to another app (`javascript:`, `data:`,
 * `intent:`, `file:`, custom protocols). Every place that opens or plays such a URL goes through here.
 */
const ALLOWED = new Set(['http:', 'https:'])

/**
 * Normalise an external URL from song data. Bare addresses ("example.com/x", "localhost:8080") get `https://`.
 * Returns the parsed, re-serialised URL (so what is opened is exactly what was checked), or null when the
 * address is empty, malformed or uses a scheme other than http/https.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim()
  if (!s) return null
  // "host:port…" looks like a scheme to a regex; treat it as a bare host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d+(?:[/?#]|$)/i.test(s)
  let u: URL
  try {
    u = new URL(hasScheme ? s : `https://${s.replace(/^\/+/, '')}`)
  } catch {
    return null
  }
  if (!ALLOWED.has(u.protocol) || !u.hostname) return null
  return u.href
}

/** Open an external URL from song data in a new tab. Returns false (and opens nothing) if it isn't http(s). */
export function openExternalUrl(raw: string | null | undefined): boolean {
  const url = safeExternalUrl(raw)
  if (!url) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}
