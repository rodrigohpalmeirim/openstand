import { registerService } from '../../services'
import { sourcesFromFileList } from '../../files/import'
import { useNav } from '../../state/nav'
import { useLibraryUI } from '../browse/ui'
import { importPackagesIn } from './packages'

interface LaunchParams {
  files: FileSystemFileHandle[]
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}

/**
 * Files opened with the installed app from the OS ("Open with OpenStand", declared as file_handlers in
 * the web manifest) arrive through the Launch Queue API; send them to the import dialog.
 */
registerService(() => {
  const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue
  if (!queue) return
  queue.setConsumer(async ({ files }) => {
    if (!files?.length) return
    // The import dialog lives in the library view.
    const nav = useNav.getState()
    if (nav.route.name !== 'library') nav.go(nav.lastLibrary)
    const all = await Promise.all(files.map((h) => h.getFile()))
    const rest = await importPackagesIn(all)
    const sources = sourcesFromFileList(rest)
    if (sources.length) useLibraryUI.getState().set({ importing: { initial: sources } })
  })
})
