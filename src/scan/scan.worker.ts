// Scan processing worker: keeps decoding, warping and filtering off the main thread.
import { handle, type Request } from './processor'

self.onmessage = async (e: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = e.data
  try {
    const { result, transfer } = await handle(req)
    self.postMessage({ id, result }, { transfer })
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
