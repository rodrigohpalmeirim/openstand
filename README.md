# OpenStand

**An open-source sheet-music reader, library and performance tool.** OpenStand runs in any modern browser
and installs as an offline app (PWA) on tablets, phones and desktops. It is a clean-room
re-implementation of the feature set of commercial music-reader apps such as MobileSheets, with a
modernised interface.

**Try it: [openstand.rodlabs.dev](https://openstand.rodlabs.dev)** — everything stays in your browser.

- 📚 **Library** — PDFs, images, ChordPro, plain-text chord sheets and ABC notation. Organise by artist,
  composer, album, genre, key, collection, source book, year, tags and custom fields. Fast search, filters,
  saved filters, sorting, multiple libraries. Scan paper scores with the camera (perspective correction and
  black-and-white clean-up) and combine a song's files into one PDF.
- 🎼 **Performance mode** — single page, two-page spreads, half-page turns, vertical/horizontal
  scrolling; fit to page/width/height; pinch zoom; crop & rotate; night mode and paper tones; page-turn
  animations; keep-screen-on; setlist navigation with "next up" hints.
- 🦶 **Hands-free page turning** — configurable 3×3 touch zones, swipes, keyboard and Bluetooth pedals
  (AirTurn, PageFlip, …) with tap and long-press bindings, MIDI messages, and face gestures (wink, smile,
  head turn/tilt and more, on-device).
- ✍️ **Annotations** — pressure-sensitive pen, highlighter, shapes, piano staves, text, musical stamps,
  eraser, selection, snap to grid, layers, undo/redo; a snipping tool to copy bars between pages;
  stylus-only mode.
- 🎸 **Chord sheets** — ChordPro rendering with transposition (key-aware spelling), capo, chord naming
  systems (English, German, Czech, Scandinavian, Latin, Nashville), chord diagrams, column layout and an
  editor with live preview. ABC notation rendering and playback.
- 🎛️ **Tools** — metronome with count-in and visual beat, auto-scroll, audio player with A–B loops,
  bookmarks, link points for repeats/D.S./codas, song notes.
- 🎹 **MIDI** — send program changes/CC/SysEx when songs load, recall songs from incoming MIDI, map MIDI
  messages to actions (Web MIDI).
- 🔄 **Devices** — library sync across your devices through your own storage, end-to-end encrypted;
  leader/follower page sync between devices (same browser windows or via a tiny relay server); full-library
  export/import (backup and restore), song packages for sharing, export with annotations.

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
sites from using your relay, set `ALLOWED_ORIGINS` in `wrangler.jsonc`. Recurring maintenance, such as
renewing the OneDrive client secret, is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Library sync

Library sync keeps a whole library (songs, files, annotations, layers, setlists, play history) the same on
all your devices, and every device keeps a full offline copy. There are no accounts and no OpenStand
server that holds your music: you bring your own storage, and the app talks to it directly from the
browser. Edits made offline sync later and merge field by field, so editing different things on two devices
never loses either change. Set it up in *Settings → Library sync*.

- **Storage:** an app folder in your Dropbox, Google Drive or OneDrive (each device signs in with the same
  account), or any S3-compatible bucket: Cloudflare R2, Backblaze B2, Amazon S3, MinIO or others. For S3, use
  credentials limited to that one bucket; every paired device shares them.
- **End-to-end encrypted:** a random 256-bit library secret is created on the first device, and every
  key is derived from it. Song data, files and file names are encrypted (AES-GCM) before they leave the
  device. The storage provider sees only the number of devices, object sizes and timing, not titles or
  contents (though an exact file size could hint at a well-known file); the relay sees only a random room id.
- **Pairing:** on a synced device choose *Add a device*, then scan the QR code with the other device
  (*Join from another device*), or copy the text code and paste it there. The code carries the library
  secret and the storage credentials, so treat it like a password. A device that already has music can
  join as a separate library (the default) or merge into the synced one.
- **Instant updates:** after each upload a device sends an encrypted notice through the relay (built into
  the Cloudflare deployment at `/relay`), so the others fetch the change within a few seconds. Without a
  relay, devices check the storage every 30 seconds.
- **CORS:** the bucket must allow requests from the site OpenStand runs on. The setup wizard tests this
  and shows the exact rule to paste (methods `GET PUT POST DELETE HEAD`, all headers, and `ETag`,
  `Content-Length`, `Content-Range` and `Date` exposed) plus where to paste it for your provider. MinIO
  sets CORS for the whole server instead (`MINIO_API_CORS_ALLOW_ORIGIN`; it allows every origin by
  default).

For development, run MinIO locally and point the wizard at it (`http://127.0.0.1:9000`, path-style):

```bash
docker run -d --rm --name openstand-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=openstand -e MINIO_ROOT_PASSWORD=openstand-dev-secret \
  minio/minio:latest server /data --console-address :9001
node server/relay.mjs   # optional: instant updates; the dev server proxies /relay to it
```

## Page sync between devices

Windows of the same browser sync out of the box (BroadcastChannel). On the Cloudflare deployment, devices
sync over the internet: in *Settings → Page sync* choose *Use this site* (relay address `/relay`) and
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
| Camera scanning | `src/scan/` |
| ChordPro / text / ABC | `src/chordpro/`, `src/music/`, `src/abc/`, `src/textedit/` |
| Annotations | `src/annotations/` |
| Face gestures | `src/faces/` |
| Metronome, auto-scroll, audio, bookmarks, links | `src/tools/` |
| MIDI | `src/midi/` |
| Backup, packages, export | `src/backup/` |
| Library sync (encrypted, bring-your-own storage) | `src/libsync/`, `src/db/capture.ts` |
| Page sync between devices (+ relay servers) | `src/sync/`, `server/` (Node), `worker/` (Cloudflare) |
| Settings | `src/settings/`, `src/state/settings.ts` |

Everything is stored locally in the browser (IndexedDB). Nothing is uploaded anywhere unless you
turn on library sync (encrypted, to storage you choose) or connect to a sync relay, which only forwards
page turns, song changes and encrypted sync notices and stores nothing. Ask the browser to make storage persistent from *Settings → Storage* so the OS
doesn't evict your library.

## Credits

Built with [pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/),
[abcjs](https://www.abcjs.net/), [Dexie](https://dexie.org/), [React](https://react.dev/),
[Tailwind CSS](https://tailwindcss.com/), [lucide](https://lucide.dev/) and [fflate](https://github.com/101arrowz/fflate).

OpenStand is not affiliated with Zubersoft or MobileSheets.

## License

[MIT](LICENSE)
