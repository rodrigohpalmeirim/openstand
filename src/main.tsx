import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import './modules'
import App from './App.tsx'
import { CALLBACK_PATH, handleOAuthCallback } from './libsync/oauth/callback'

// Back from a drive sign-in (docs/SYNC-DRIVES.md §5.2): record the result before the first render.
if (location.pathname === CALLBACK_PATH) handleOAuthCallback()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
