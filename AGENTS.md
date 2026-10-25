# OpenStand — guide for contributors (human or AI)

OpenStand is an open-source, offline-first PWA sheet-music reader, library and performance tool:
a clean-room re-implementation of the *features* of MobileSheets (Android), documented from a
reverse-engineering pass in `../re/spec/*.md` (feature specs; read the one for your area).
We re-implement behaviour; never copy code, assets or text from the original app.

## Stack
React 19 + TypeScript (strict), Vite 8, Tailwind v4 (tokens in `src/index.css`: bg, surface, surface-2/3,
line, fg, muted, faint, accent, accent-fg, accent-soft, danger, ok, warn — use them, never hard-coded
light/dark colours in the library/settings UI; the performance viewer is always dark), Dexie (IndexedDB),
zustand, pdf.js (`src/files/pdf.ts`), pdf-lib, abcjs, fflate, lucide-react icons. Tests: vitest (`npm test`).

## Architecture map
- `src/db/schema.ts` data model (Song with files/pageOrder/pageSettings/bookmarks/links/audio/midi, Setlist,
  annotations, blobs). `src/db/db.ts` Dexie DB (`db`, `putBlob`, `getBlob`, `uid`, `getKV/setKV`).
  To patch a song use `updateSong(id, patch)` from db.ts (NOT `db.songs.update` — Dexie's key-path typing
  recurses through the self-referencing MidiCommand type and fails to compile).
  Changing the Dexie schema: add a NEW `this.version(n+1)` — never edit version(1).
- `src/files/` import pipeline (`importFiles`, patterns), kinds, pdf.js wrapper.
- `src/viewer/` performance mode (owned by the lead): `Viewer.tsx`, layout (stops/spreads), `input.ts`
  (touch zones, swipes, keys), `actions.ts` (ACTIONS catalogue + `registerActions`/`runAction`/`onAction`),
  `events.ts` (`on('songOpened'|'pageChanged'|'songClosed')`), `panels.tsx` (side panels; `PanelProps`).
- `src/state/` zustand stores: `settings.ts` (persisted Settings; `useSettings`, `settings()`), `viewer.ts`
  (`useViewer`: queue/index/position/panel/…; `open(queue, index, {setlistId})` starts performing), `nav.ts`.
- `src/chordpro/` parser + renderer, `src/music/chords.ts` chord parsing/transposition.
- `src/scan/` camera scanner (lazy; `openScanner()`/`scanToNewSong()` in `launch.tsx`; image work in a worker).
  `src/faces/` face gestures (pure detector in `gestures.ts`; MediaPipe loads only when used).
  `src/library/editor/combine.ts` merges a song's files into one PDF and remaps per-page data.
- `src/ui/primitives.tsx` UI kit: Button, IconButton, Input, Textarea, Select, Field, Toggle, Segmented,
  Slider, Dialog, Popover, Menu/useMenu, toast(), confirmDialog(), promptDialog(), Empty, Kbd. Reuse them.
- `src/services.ts` `registerService(fn)` for background services; add a side-effect import to `src/modules.ts`.
- `src/libsync/` library sync (separate from `src/sync/`). Pure model: `hlc.ts`, `hash.ts`,
  `fields.ts` (per-collection field tables, `syncedKv` allow-list), `merge.ts` (project/diff/mergeDelta/materialize/
  rebase), `joinPlan.ts`. Storage and wire: `crypto.ts` (HKDF keys, sealed envelopes, chunked blob container),
  `codec.ts`, `paths.ts`, `pairing.ts`, `backends/` (`s3.ts` via aws4fetch, `memory.ts` for tests,
  `contract.test-helper.ts`). Engine: `engine.ts` (capture → push, poll/notice → pull → apply, maintenance),
  `apply.ts`, `blobs.ts` (transfer queue), `relay.ts` (notices), `join.ts` (enable/join/leave/reset), `state.ts`,
  `service.ts` (one engine per library DB, Web Lock). `api.ts` is the UI facade (`useLibSync`, `useBlobState`,
  `onBlobReady`); `ui/` holds the settings section, wizard, pairing, indicator and `BlobPending`. Only `api.ts`,
  `service.ts`, `state.ts`, `fields.ts` and the indicator are in the startup bundle; the rest loads lazily.
  `src/db/capture.ts` is a Dexie DBCore middleware marking changed records dirty (no libsync imports). New kv keys
  sync only if added to `syncedKv`. `getBlob` throws `MissingBlobError` while a synced file is still downloading:
  show `BlobPending` rather than an error. Count plays with `recordPlay`, not a read-modify-write.
  Design notes, if present locally, live in the gitignored `.notes/` folder.
- `src/sync/` device sync; `server/relay.mjs` (Node) and `worker/index.ts` (Cloudflare Durable Object) are two
  implementations of the same dumb relay contract: `?room=NAME`, rebroadcast text frames to the room's other
  clients (library sync uses `/relay/lib/<roomId>` rooms with tighter limits). Keep them in step. `wrangler.jsonc` deploys `dist/` + the relay; run `npm run cf:typegen` after
  changing it (needs glibc ≥ 2.35 for workerd; use a `node:24-bookworm` container on older systems).

## Rules for parallel work
- Several agents work in this tree at once. Only edit files you OWN (listed in your task). Shared files
  (`schema.ts`, `settings.ts`, `actions.ts`, `modules.ts`, `panels.tsx`) may receive small ADDITIVE edits:
  re-read right before editing, keep the change minimal, never reformat or reorder others' code.
- Keep the public contracts of stubs you replace (component name + props) — other modules import them.
- `npx tsc -b --noEmit` must pass for your files; if errors are in files you don't own, ignore them (another
  agent is mid-edit) unless they persist and block you — then report it.
- Don't run `git commit` (the lead commits). Don't install new dependencies without a strong reason; if you
  do, say so in your final report.
- Dev server: http://127.0.0.1:5317 (already running; Vite HMR). To test UI use the t3-code preview tools
  with `reuseExistingTab: false` and keep your own tabId. Sample files: `samples/` (regenerate:
  `node scripts/make-samples.mjs`). Test logic with vitest unit tests next to the code (`*.test.ts`).
- UX bar: polished, touch-friendly (44px targets), keyboard accessible, works on phone/tablet/desktop,
  light+dark themes. Prefer fewer, clearer options with good defaults over mirroring every original setting;
  improve on the original where it is clunky. Write short comments only where the "why" is non-obvious.
