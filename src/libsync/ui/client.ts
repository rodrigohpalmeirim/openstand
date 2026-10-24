/**
 * The UI's view of the libsync facade. Everything delegates to `../api` at call time; the dev-only
 * `?libsyncMock=<phase>` switch (mock.ts) can swap in fake actions and blob states so every screen can be
 * driven without storage. Production never sets overrides.
 */
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import * as api from '../api'
import type { BlobState } from '../api'
import type { BackendConfig } from '../backends/types'
import type { JoinMode, PairingPayload } from '../model'

type Api = typeof api
export type Actions = Pick<
  Api,
  | 'checkBackend'
  | 'enableSync'
  | 'pairingCode'
  | 'parsePairingCode'
  | 'previewJoin'
  | 'joinSync'
  | 'syncNow'
  | 'setPaused'
  | 'leaveSync'
  | 'deleteRemoteData'
  | 'repair'
  | 'updateBackend'
>

const over: Partial<Actions> = {}

/** Dev mocks only. */
export function overrideActions(a: Partial<Actions>) {
  Object.assign(over, a)
}

export const checkBackend = (cfg: BackendConfig) => (over.checkBackend ?? api.checkBackend)(cfg)
export const enableSync = (o: { backend: BackendConfig; relay?: string | null }) => (over.enableSync ?? api.enableSync)(o)
export const pairingCode = () => (over.pairingCode ?? api.pairingCode)()
export const parsePairingCode = (text: string) => (over.parsePairingCode ?? api.parsePairingCode)(text)
export const previewJoin = (p: PairingPayload) => (over.previewJoin ?? api.previewJoin)(p)
export const joinSync = (p: PairingPayload, mode: JoinMode) => (over.joinSync ?? api.joinSync)(p, mode)
export const syncNow = () => (over.syncNow ?? api.syncNow)()
export const setPaused = (paused: boolean) => (over.setPaused ?? api.setPaused)(paused)
export const leaveSync = () => (over.leaveSync ?? api.leaveSync)()
export const deleteRemoteData = () => (over.deleteRemoteData ?? api.deleteRemoteData)()
export const repair = () => (over.repair ?? api.repair)()
export const updateBackend = (cfg: BackendConfig) => (over.updateBackend ?? api.updateBackend)(cfg)

/** Dev mocks only: a fake blob state per id (undefined = ask the engine). */
export const useMockBlobs = create<{ state?: (blobId: string) => BlobState | undefined }>(() => ({}))

/** `useBlobState`, overridable by the dev mock. Always calls both hooks so the hook order never changes. */
export function useBlob(blobId: string | undefined): BlobState {
  return useBlobRaw(blobId) ?? { state: 'local' }
}

/** `useBlob`, but `undefined` until the state is known. */
export function useBlobRaw(blobId: string | undefined): BlobState | undefined {
  const mock = useMockBlobs((m) => m.state)
  const real = api.useBlobStateRaw(blobId)
  return (blobId && mock?.(blobId)) || real
}

/**
 * The current library's storage config, read back from the pairing payload (the facade has no getter, and
 * the payload carries exactly the shared `BackendConfig`). Used to prefill "Update storage keys" and to show
 * the CORS rule or provider console for the right provider.
 */
export async function currentPayload(): Promise<PairingPayload | null> {
  try {
    return await parsePairingCode(await pairingCode())
  } catch {
    return null
  }
}

/** Calls `onReady` when the blob arrives locally (latest callback; resubscribes only when the id changes). */
export function useBlobReady(blobId: string | undefined, onReady?: () => void) {
  const cb = useRef(onReady)
  useEffect(() => {
    cb.current = onReady
  })
  useEffect(() => (blobId ? api.onBlobReady(blobId, () => cb.current?.()) : undefined), [blobId])
}

/** For `Thumb.tsx`: a file's blob state; `onReady` fires once it arrives. */
export function usePendingFile(blobId: string | undefined, onReady: () => void): BlobState {
  const b = useBlob(blobId)
  useBlobReady(b.state === 'local' ? undefined : blobId, onReady)
  return b
}
