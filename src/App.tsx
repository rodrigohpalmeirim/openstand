import { useEffect } from 'react'
import { Library } from './library/Library'
import { SettingsScreen } from './settings/SettingsScreen'
import { useNav } from './state/nav'
import { useSettings } from './state/settings'
import { useViewer } from './state/viewer'
import { AskHost, ToastProvider } from './ui/primitives'
import { Viewer } from './viewer/Viewer'
import { startBackgroundServices } from './services'

function useTheme() {
  const theme = useSettings((s) => s.s.theme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f1011' : '#f6f5f2')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

export default function App() {
  useTheme()
  const route = useNav((n) => n.route)
  const performing = useViewer((v) => v.queue.length > 0)
  useEffect(() => startBackgroundServices(), [])
  return (
    <ToastProvider>
      <div className="h-full" aria-hidden={performing || undefined} inert={performing || undefined}>
        {route.name === 'settings' ? <SettingsScreen /> : <Library />}
      </div>
      {performing && <Viewer />}
      <AskHost />
    </ToastProvider>
  )
}
