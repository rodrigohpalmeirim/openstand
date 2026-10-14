/**
 * Entry points for the scanner. This module is small and safe to import anywhere; the scanner UI
 * and its image pipeline load on demand.
 */
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { importFiles } from '../files/import'

const Scanner = lazy(() => import('./Scanner').then((m) => ({ default: m.Scanner })))

/** Open the scanner; resolves with the PDF of the scanned pages, or null if cancelled. */
export function openScanner(opts: { title?: string } = {}): Promise<File | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      resolve(file)
      setTimeout(() => {
        root.unmount()
        host.remove()
      })
    }
    root.render(
      <Suspense
        fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
            <div className="size-8 animate-spin rounded-full border-2 border-white border-t-transparent opacity-70" />
          </div>
        }
      >
        <Scanner title={opts.title} onDone={finish} onCancel={() => finish(null)} />
      </Suspense>,
    )
  })
}

/** Scan pages into a new song (saved to the library); resolves with its id, or null if cancelled. */
export async function scanToNewSong(): Promise<string | null> {
  const file = await openScanner()
  if (!file) return null
  const r = await importFiles([{ file }])
  return r.songs[0]?.id ?? null
}
