import { useLibraryUI } from '../../library/browse/ui'
import { useNav } from '../../state/nav'

/** Opens the Library sync settings page (and closes the phone drawer). */
export function openLibSyncSettings() {
  useLibraryUI.getState().set({ drawer: false })
  useNav.getState().go({ name: 'settings', page: 'libsync' })
}
