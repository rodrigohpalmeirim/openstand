/**
 * Entry points for the scanner. This module is small and safe to import anywhere; the scanner UI
 * and its image pipeline load on demand.
 */
import { lazy, Suspense, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { importFiles } from '../files/import'
import type { CorrectSession } from './correct'

const Scanner = lazy(() => import('./Scanner').then((m) => ({ default: m.Scanner })))

/** Mount `make(finish)` in its own root until `finish` is called; resolves with its value. */
function mount<T>(make: (finish: (v: T) => void) => ReactElement): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let settled = false
    const finish = (v: T) => {
      if (settled) return
      settled = true
      resolve(v)
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
        {make(finish)}
      </Suspense>,
    )
  })
}

/** Open the scanner; resolves with the PDF of the scanned pages, or null if cancelled. */
export function openScanner(opts: { title?: string } = {}): Promise<File | null> {
  return mount<File | null>((finish) => <Scanner title={opts.title} onDone={finish} onCancel={() => finish(null)} />)
}

/**
 * Open the page editor on pages of an existing file (outline, rotation, filter per page; no adding,
 * removing or reordering). Resolves true once `session.save` succeeded, false if cancelled.
 */
export function openCorrector(opts: { title: string } & CorrectSession): Promise<boolean> {
  return mount<boolean>((finish) => {
    const session: CorrectSession = {
      pages: opts.pages,
      saveLabel: opts.saveLabel,
      save: async (ctx) => {
        const ok = await opts.save(ctx)
        if (ok) finish(true)
        return ok
      },
    }
    return <Scanner title={opts.title} correct={session} onDone={() => finish(true)} onCancel={() => finish(false)} />
  })
}

/** Scan pages into a new song (saved to the library); resolves with its id, or null if cancelled. */
export async function scanToNewSong(): Promise<string | null> {
  const file = await openScanner()
  if (!file) return null
  const r = await importFiles([{ file }])
  return r.songs[0]?.id ?? null
}
