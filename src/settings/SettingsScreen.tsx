import { useNav } from '../state/nav'
import { Button } from '../ui/primitives'

/** Settings screen. STUB — owned by the settings module. */
export function SettingsScreen() {
  const go = useNav((n) => n.go)
  return (
    <div className="p-6">
      <Button onClick={() => go({ name: 'library', section: 'songs' })}>Back</Button>
    </div>
  )
}
