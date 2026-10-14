import { importPackage } from '../../backup/exportSongs'
import { settings } from '../../state/settings'
import { toast } from '../../ui/primitives'
import { terms } from '../browse/terms'

const PACKAGE_RE = /\.(ospkg|osbackup)$/i

export const PACKAGE_ACCEPT = '.ospkg,.osbackup'

/** Import any OpenStand packages/backups among `files`; returns the remaining (regular) files. */
export async function importPackagesIn(files: File[]): Promise<File[]> {
  const rest: File[] = []
  for (const f of files) {
    if (!PACKAGE_RE.test(f.name)) {
      rest.push(f)
      continue
    }
    try {
      const r = await importPackage(f)
      if (r.songs || r.setlists) toast(`Imported ${terms(settings()).count(r.songs)}${r.setlists ? ` and ${r.setlists} setlist${r.setlists === 1 ? '' : 's'}` : ''}`, 'ok')
    } catch (e) {
      toast(`Couldn't import ${f.name}: ${(e as Error).message}`, 'error')
    }
  }
  return rest
}
