/** Main-thread client for the scan processor: a worker when possible, in-process otherwise. */
import type { EncodedPage } from './pdf'
import type { LoadResult, RenderParams, Request } from './processor'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let workerBroken = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined'
let seq = 0
const pending = new Map<number, Pending>()
/** Requests a page was loaded with, so the in-process fallback can catch up if the worker fails. */
const loaded = new Map<string, Blob>()
const localLoaded = new Set<string>()

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (!worker) {
    try {
      worker = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const p = pending.get(e.data.id)
        if (!p) return
        pending.delete(e.data.id)
        if (e.data.error !== undefined) p.reject(new Error(e.data.error))
        else p.resolve(e.data.result)
      }
      worker.onerror = () => {
        for (const p of pending.values()) p.reject(new Error('Scan worker failed'))
        pending.clear()
      }
    } catch {
      workerBroken = true
      return null
    }
  }
  return worker
}

async function runLocal(req: Request): Promise<unknown> {
  const proc = await import('./processor')
  // Pages loaded into a (now failed) worker need loading here first.
  if (req.op !== 'load' && req.op !== 'drop' && !localLoaded.has(req.page)) {
    const blob = loaded.get(req.page)
    if (blob) await proc.load(req.page, blob)
    localLoaded.add(req.page)
  }
  if (req.op === 'load') localLoaded.add(req.page)
  return (await proc.handle(req)).result
}

async function call<T>(req: Request): Promise<T> {
  if (req.op === 'load') loaded.set(req.page, req.blob)
  if (req.op === 'drop') loaded.delete(req.page)
  const w = getWorker()
  if (w) {
    try {
      return await new Promise<T>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        w.postMessage({ id, req })
      })
    } catch (e) {
      // Some browsers have workers but no 2D OffscreenCanvas / createImageBitmap inside them: if the
      // same photo loads in-process, stop using the worker.
      if (req.op !== 'load') throw e
      const r = await runLocal(req).catch(() => Promise.reject(e))
      workerBroken = true
      worker?.terminate()
      worker = null
      return r as T
    }
  }
  return (await runLocal(req)) as T
}

export const scanEngine = {
  load: (page: string, blob: Blob) => call<LoadResult>({ op: 'load', page, blob }),
  render: (page: string, params: RenderParams, maxLong: number) => call<ImageBitmap>({ op: 'render', page, params, maxLong }),
  exportPage: (page: string, params: RenderParams) => call<EncodedPage>({ op: 'export', page, params }),
  drop: (page: string) => void call<null>({ op: 'drop', page }).catch(() => {}),
}
