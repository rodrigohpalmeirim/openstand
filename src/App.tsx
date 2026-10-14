import { lazy, Suspense, useEffect, useState } from 'react'
import { useHistorySync } from './library/history'
import { Library } from './library/Library'
import { useNav } from './state/nav'
import { useSettings } from './state/settings'
import { useViewer } from './state/viewer'
import { AskHost, ToastProvider } from './ui/primitives'
import { startBackgroundServices } from './services'

// Screens not needed to show the library are split out to keep startup light on tablets.
const SettingsScreen = lazy(() => import('./settings/SettingsScreen').then((m) => ({ default: m.SettingsScreen })))
const Viewer = lazy(() => import('./viewer/Viewer').then((m) => ({ default: m.Viewer })))
// The text editor is only opened from the viewer, so its host mounts once the viewer has been used.
const TextEditorHost = lazy(() => import('./textedit/TextEditor').then((m) => ({ default: m.TextEditorHost })))

function Loading({ dark }: { dark?: boolean }) {
  return (
    <div className={`fixed inset-0 z-40 flex items-center justify-center ${dark ? 'bg-black' : ''}`}>
      <div className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-40" />
    </div>
  )
}

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
  // Back button / gesture closes the viewer, editors and dialogs, then walks back through sections.
  useHistorySync()
  const route = useNav((n) => n.route)
  const performing = useViewer((v) => v.queue.length > 0)
  useEffect(() => startBackgroundServices(), [])
  const [textHost, setTextHost] = useState(false)
  if (performing && !textHost) setTextHost(true)
  return (
    <ToastProvider>
      <div className="h-full" aria-hidden={performing || undefined} inert={performing || undefined}>
        {route.name === 'settings' ? (
          <Suspense fallback={<Loading />}>
            <SettingsScreen />
          </Suspense>
        ) : (
          <Library />
        )}
      </div>
      {performing && (
        <Suspense fallback={<Loading dark />}>
          <Viewer />
        </Suspense>
      )}
      {textHost && (
        <Suspense fallback={null}>
          <TextEditorHost />
        </Suspense>
      )}
      <AskHost />
    </ToastProvider>
  )
}
