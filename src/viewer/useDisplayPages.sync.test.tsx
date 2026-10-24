import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { db, putBlob } from '../db/db'
import { emptySong, type Song } from '../db/schema'
import { emitBlobReady } from '../libsync/api'
import { settings } from '../state/settings'
import { useDisplayPages } from './useDisplayPages'

const BOX = { width: 800, height: 1000 }
const OPTS = { transpose: 0, columns: 1, zoom: 1 }

describe('useDisplayPages with a text file that is still downloading (library sync)', () => {
  it('shows a pending page, then the text once the file arrives', async () => {
    // Text files live in blobs like PDFs do; a synced song can arrive before its file.
    const body = '{title: Later}\n[C]Words arrive [G]later\n'
    const data = new TextEncoder().encode(body).buffer as ArrayBuffer
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const song: Song = { ...emptySong({ id: 'later', title: 'Later' }), files: [{ id: 'f1', name: 'later.cho', kind: 'chordpro', blobId: hash, pageCount: 1, size: data.byteLength }] }
    const style = settings().text
    const { result } = renderHook(() => useDisplayPages(song, BOX, style, OPTS))
    await waitFor(() => expect(result.current.pages.map((p) => p.type)).toEqual(['pending']))

    await act(async () => {
      expect((await putBlob(data, 'text/plain')).id).toBe(hash)
      emitBlobReady(hash)
    })
    await waitFor(() => expect(result.current.pages[0]?.type).toBe('text'))
    expect(result.current.loading).toBe(false)
    await db.blobs.delete(hash)
  })
})
