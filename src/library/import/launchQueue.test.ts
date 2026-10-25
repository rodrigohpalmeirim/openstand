import { describe, expect, it } from 'vitest'
import { startBackgroundServices } from '../../services'
import { useNav } from '../../state/nav'
import { useLibraryUI } from '../browse/ui'

type Consumer = (p: { files: FileSystemFileHandle[] }) => Promise<void>

describe('files opened with the installed app', () => {
  it('go to the library, where the import dialog lives, even when Settings was open', async () => {
    let consume: Consumer | undefined
    Object.assign(window, { launchQueue: { setConsumer: (c: Consumer) => (consume = c) } })
    await import('./launchQueue')
    const stop = startBackgroundServices()
    useNav.getState().go({ name: 'library', section: 'setlists' })
    useNav.getState().go({ name: 'settings', page: 'pedals' })
    const file = new File(['%PDF-1.4'], 'Song.pdf', { type: 'application/pdf' })
    await consume!({ files: [{ getFile: async () => file } as unknown as FileSystemFileHandle] })
    expect(useNav.getState().route).toEqual({ name: 'library', section: 'setlists' })
    expect(useLibraryUI.getState().importing?.initial).toHaveLength(1)
    stop()
  })
})
