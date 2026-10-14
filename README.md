# OpenStand

**An open-source sheet-music reader, library and performance tool.** OpenStand runs in any modern browser
and installs as an offline app (PWA) on tablets, phones and desktops. It is a clean-room
re-implementation of the feature set of commercial music-reader apps such as MobileSheets, with a
modernised interface.

**Try it: [openstand.rodlabs.dev](https://openstand.rodlabs.dev)** — everything stays in your browser.

- 📚 **Library** — PDFs, images, ChordPro, plain-text chord sheets and ABC notation. Organise by artist,
  composer, album, genre, key, collection, source book, year, tags and custom fields. Fast search, filters,
  saved filters, sorting, multiple libraries.
- 🎼 **Performance mode** — single page, two-page spreads, half-page turns, vertical/horizontal
  scrolling; fit to page/width/height; pinch zoom; crop & rotate; night mode and paper tones; page-turn
  animations; keep-screen-on; setlist navigation with "next up" hints.
- 🦶 **Hands-free page turning** — configurable 3×3 touch zones, swipes, keyboard and Bluetooth pedals
  (AirTurn, PageFlip, …) with tap and long-press bindings, MIDI messages, and face gestures (head turn /
  mouth open, on-device).
- ✍️ **Annotations** — pressure-sensitive pen, highlighter, shapes, text, musical stamps, eraser,
  selection, layers, undo/redo; stylus-only mode.
- 🎸 **Chord sheets** — ChordPro rendering with transposition (key-aware spelling), capo, chord naming
  systems (English, German, Czech, Scandinavian, Latin, Nashville), chord diagrams, column layout and an
  editor with live preview. ABC notation rendering and playback.
- 🎛️ **Tools** — metronome with count-in and visual beat, auto-scroll, audio player with A–B loops,
  bookmarks, link points for repeats/D.S./codas, song notes.
- 🎹 **MIDI** — send program changes/CC/SysEx when songs load, recall songs from incoming MIDI, map MIDI
  messages to actions (Web MIDI).
- 🔄 **Devices** — leader/follower page sync between devices (same browser windows or via a tiny relay
  server), full-library backup/restore, song packages for sharing, export with annotations.

## Getting started

```bash
npm install       # also copies pdf.js runtime assets to public/pdfjs
npm run dev       # http://localhost:5173
npm test          # unit tests
npm run build     # production build in dist/ (static files; host anywhere)
```

Generate demo content with `node scripts/make-samples.mjs` (writes to `samples/`), then drag the files onto
the app window.

## Installing as an app

Host the `dist/` folder on any static web server **over HTTPS** (Cloudflare Workers — see below — GitHub
Pages, Netlify, or your own server; `localhost` also works for testing), open it and choose *Install app* (Chrome/Edge on
desktop and Android) or *Share → Add to Home Screen* (Safari on iPad/iPhone). The service worker precaches
the whole app, including pdf.js's fonts and image decoders, so it then works fully offline. On Chromium
browsers the installed app also appears in the OS "Open with" menu for PDF, ChordPro, ABC, image and
`.ospkg`/`.osbackup` files. Browsers don't allow installing (or offline use) from plain `http://` LAN
addresses, so tablets need the HTTPS URL.

See [docs/FEATURES.md](docs/FEATURES.md) for a feature-by-feature comparison with MobileSheets.

## Deploying to Cloudflare Workers

`wrangler.jsonc` deploys the built app as static assets plus a sync relay at `/relay` (one Durable Object per
room, `worker/index.ts`), all on the free plan.

```bash
npx wrangler login
npm run deploy        # build + wrangler deploy → https://openstand.<your-subdomain>.workers.dev
npm run cf:dev        # build + run the Worker locally on http://localhost:8787
```

Or deploy from GitHub: either connect the repository in the Cloudflare dashboard (*Workers & Pages → Create →
Import a repository*; build command `npm run build`, deploy command `npx wrangler deploy`), or add
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets: CI then deploys every push to `main`
once the checks pass. Add a custom domain under the Worker's *Settings → Domains & Routes*. To keep other
sites from using your relay, set `ALLOWED_ORIGINS` in `wrangler.jsonc`.

## Syncing devices

Windows of the same browser sync out of the box (BroadcastChannel). On the Cloudflare deployment, devices
sync over the internet: in *Settings → Devices & sync* choose *Use this site* (relay address `/relay`) and
give every device the same room name. Rooms aren't password-protected, so pick an unguessable name.
Otherwise, run the dependency-free relay on any machine on your network and enter its address there:

```bash
node server/relay.mjs            # listens on 0.0.0.0:8787 (PORT, HOST, ALLOWED_ORIGINS env vars)
node --test server/relay-test.mjs
```

If OpenStand is served over HTTPS, browsers require the relay behind TLS (`wss://`).

## Architecture

| Area | Location |
| --- | --- |
| Data model & storage (IndexedDB via Dexie) | `src/db/` |
| Import pipeline, pdf.js wrapper | `src/files/` |
| Performance viewer (layout, input, actions, panels) | `src/viewer/` |
| Library browser, song editor, importers | `src/library/` |
| ChordPro / text / ABC | `src/chordpro/`, `src/music/`, `src/abc/`, `src/textedit/` |
| Annotations | `src/annotations/` |
| Metronome, auto-scroll, audio, bookmarks, links | `src/tools/` |
| MIDI | `src/midi/` |
| Backup, packages, export | `src/backup/` |
| Device sync (+ relay servers) | `src/sync/`, `server/` (Node), `worker/` (Cloudflare) |
| Settings | `src/settings/`, `src/state/settings.ts` |

Everything is stored locally in the browser (IndexedDB). Nothing is uploaded anywhere unless you
connect to a sync relay, which only forwards page turns and song changes and stores nothing. Ask the browser to make storage persistent from *Settings → Storage* so the OS
doesn't evict your library.

## Credits

Built with [pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/),
[abcjs](https://www.abcjs.net/), [Dexie](https://dexie.org/), [React](https://react.dev/),
[Tailwind CSS](https://tailwindcss.com/), [lucide](https://lucide.dev/) and [fflate](https://github.com/101arrowz/fflate).

OpenStand is not affiliated with Zubersoft or MobileSheets.

## License

[MIT](LICENSE)
