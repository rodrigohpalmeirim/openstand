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
