// Applies the saved theme and accent before the app bundle runs, so a dark theme doesn't flash light
// on load. A separate file rather than an inline script: the CSP only allows scripts from 'self'.
// Keep in step with useTheme (src/App.tsx) and src/settings/accent.ts.
;(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('openstand-settings') || 'null')
    var s = (saved && saved.state && saved.state.s) || {}
    var dark = s.theme === 'dark' || (s.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    var root = document.documentElement
    root.classList.toggle('dark', dark)
    if (typeof s.accent === 'string' && s.accent !== 'ember') root.setAttribute('data-accent', s.accent)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#0f1011' : '#f6f5f2')
  } catch {
    /* storage blocked or corrupt: the app applies the theme once it starts */
  }
})()
