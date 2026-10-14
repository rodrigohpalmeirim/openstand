import { promptDialog, toast } from '../ui/primitives'

/** Ask for a 1-based page number and jump to it. */
export async function askGoToPage(count: number, current: number, goToPage: (page: number) => void) {
  const v = await promptDialog({ title: 'Go to page', label: `Page (1–${count})`, initial: String(current + 1) })
  if (v === null) return
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > count) toast(`Enter a page between 1 and ${count}`, 'error')
  else goToPage(n - 1)
}
