import { toast } from '../../ui/primitives'

/** Copies text and confirms with a toast. Resolves false when the browser refuses. */
export async function copyText(text: string, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast(done, 'ok')
    return true
  } catch {
    toast('Couldn’t copy. Select the text and copy it yourself.', 'error')
    return false
  }
}

/**
 * After `ms`, empties the clipboard if it still holds `text` (a secret). Only when that is possible without
 * bothering the user: the page must be focused (waits for the next focus otherwise, up to `giveUpMs`) and
 * clipboard-read must already be granted, since asking would pop a permission prompt or a paste bubble. When
 * the clipboard holds something else, or can't be read, it is left alone. Returns a cancel function.
 */
export function clearClipboardLater(text: string, ms = 60_000, giveUpMs = 30 * 60_000): () => void {
  let done = false
  const start = Date.now()
  const onFocus = () => void attempt()
  const cancel = () => {
    done = true
    clearTimeout(timer)
    window.removeEventListener('focus', onFocus)
  }
  const attempt = async () => {
    if (done) return
    if (Date.now() - start > giveUpMs) return cancel()
    if (!document.hasFocus()) {
      window.addEventListener('focus', onFocus, { once: true })
      return
    }
    cancel()
    try {
      const clip = navigator.clipboard
      if (!clip?.readText || !navigator.permissions?.query) return
      const st = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })
      if (st.state !== 'granted') return
      if ((await clip.readText()) === text) await clip.writeText('')
    } catch {
      // Not readable or not writable here: skip silently.
    }
  }
  const timer = setTimeout(() => void attempt(), ms)
  return cancel
}
