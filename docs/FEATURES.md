# Feature parity with MobileSheets

OpenStand's feature set was planned from a reverse-engineering pass over MobileSheets 3.9.42 for Android
(UI resources, settings, menus and the readable parts of the code; see `../re/spec/` in the original
workspace). This table tracks where OpenStand stands. ✅ = implemented, ◐ = partial or different by design,
— = not implemented.

## Library

| Feature | Status | Notes |
| --- | --- | --- |
| Songs with multiple files (PDF, images, ChordPro, text, ABC) | ✅ | |
| 12 group types (setlists, collections, artists, albums, genres, composers, sources, custom, keys, signatures, years) + tags | ✅ | Labels and visibility configurable |
| Recent / Favorites / Bookmarks tabs | ✅ | Favorites is an OpenStand addition |
| Sorting (title, dates, play stats, rating, difficulty, duration, key), ignore articles, accent-insensitive collation | ✅ | |
| Search with field selector, quick filters, include/exclude/assigned filters, saved filters | ✅ | |
| A–Z jump index | ✅ | |
| Modern / classical terminology (Songs ↔ Pieces) | ✅ | |
| Grid / thumbnail library view | ✅ | Not in MobileSheets |
| Multi-select, batch edit, add/remove to setlists & collections | ✅ | |
| Setlists: ordering, duplicates, set breaks/placeholders, per-entry notes, shuffle/sort | ✅ | |
| Song editor: all metadata fields, configurable fields, chip inputs with autocomplete | ✅ | |
| Page order (text grammar + visual editor, repeats, multi-file) | ✅ | |
| Crop editor with auto-crop (incl. aggressive) | ✅ | |
| Import with filename/folder metadata patterns, combine files, skip duplicates, conflict policy | ✅ | |
| PDF-bookmark / CSV index import (one book → many songs) | ✅ | |
| Duplicate song, create snippet | ✅ | |
| Multiple libraries | ✅ | One IndexedDB database each |
| Title/caption format templates | — | Captions show configurable fields; numbers or keys can go in the title itself |
| Find missing files / fix broken paths | ◐ | Files live inside the app, so paths can't break |
| Camera scanning: multi-page, corner adjustment, perspective correction, colour / grey / clean B&W | ✅ | Existing photos work too |
| Combine a song's files into one PDF | ✅ | Keeps crop, rotation and annotations |
| Convert PDF to images | — | Not needed: PDFs render directly |
| Cloud providers (Dropbox, Drive, OneDrive, Nextcloud) | ◐ | Dropbox, Google Drive and OneDrive for library sync; importing from them uses the OS file picker / File System Access |

## Performance view

| Feature | Status | Notes |
| --- | --- | --- |
| Single page, two pages (2-page / 1-page / alternate turns), half-page turns, vertical scroll | ✅ | Plus horizontal scroll |
| Fit page / width / height, pinch zoom, two-finger reset | ✅ | |
| Per-song display overrides, separate landscape default | ✅ | |
| Night mode, page colour tones, dimming | ✅ | |
| Page turn animation (or none) | ✅ | Slide, fade |
| Touch zones, swipes, double tap, long press, two/three-finger taps → configurable actions | ✅ | 3×3 zone grid |
| Bluetooth pedals / keyboard with tap + long-press bindings, presets, debounce | ✅ | Pedals that emulate a keyboard |
| AirTurn Direct Mode (BLE) | — | Not possible from a browser |
| Face gestures (wink, smile, head turn/tilt, eyebrows, mouth, lips) | ✅ | All 11, each mapped to any action, with a live tuning view |
| Setlist navigation, next-up hint, setlist panel | ✅ | |
| Bookmarks, link points (D.S./coda jumps), smart buttons | ✅ | |
| Auto-scroll (duration or speed based, delays, timed page turns) | ✅ | |
| Metronome (subdivisions, accents, count-in, visual beat, tap tempo, multiple tempos) | ✅ | Synthesised sounds |
| Audio player (A–B loop, speed with pitch preserved, autoplay) | ✅ | |
| Notes (panel and popup on load) | ✅ | |
| Clock and capo overlays | ✅ | |
| Go to page, page slider with preview | ✅ | |
| Performance lock | ✅ | |
| Keep screen on | ✅ | Wake Lock API |
| Orientation lock | — | Browsers only allow it in full-screen mode on Android; use the system rotation lock |

## Annotations

| Feature | Status | Notes |
| --- | --- | --- |
| Pen (pressure), highlighter, eraser (stroke-partial / object / box) | ✅ | |
| Line, arrow, rectangle, ellipse, crescendo/decrescendo, text, stamps | ✅ | Stamps are original SVG artwork |
| Select, lasso, move, resize, recolour, copy/paste | ✅ | |
| Layers, presets/favorites, undo/redo | ✅ | |
| Stylus-only mode, palm rejection, pen eraser button | ✅ | |
| Export/print with annotations burned in | ✅ | |
| Snipping tool, piano staff, snap to grid | ✅ | Snips work on every page type, not only PDFs |

## Text, ChordPro, ABC

| Feature | Status | Notes |
| --- | --- | --- |
| ChordPro directive set incl. sections, conditional selectors, `%{meta}`, markup | ✅ | |
| Plain text chord-sheet detection and conversion | ✅ | |
| Key-aware transposition, capo, chord naming systems | ✅ | Also Latin/solfège and Nashville |
| Chord diagrams (guitar, ukulele, piano) | ✅ | |
| Text editor with live preview, chord-tap mode, templates | ✅ | |
| ABC rendering, transposition, pagination, playback | ✅ | abcjs |

## MIDI, devices, data

| Feature | Status | Notes |
| --- | --- | --- |
| Song MIDI commands on load (PC, bank/patch select, CC, notes, SysEx, song select, clock, pauses, batches) | ✅ | Web MIDI (not on iOS Safari) |
| MIDI learn, MIDI → actions, song recall from MIDI | ✅ | |
| Library sync between devices | ✅ | Whole library (songs, files, annotations, layers, setlists, play history) through your own Dropbox, Google Drive or OneDrive app folder or S3-compatible storage (R2, B2, S3, MinIO), end-to-end encrypted, full offline copy on every device, merges offline edits per field. Pair by QR or text code; instant updates through the relay, else polling. |
| Leader/follower page sync between devices | ✅ | BroadcastChannel, or a WebSocket relay (`server/relay.mjs`, or built into the Cloudflare deployment) |
| Full library export / import (backup and restore; replace or merge) | ✅ | `.osbackup`, Settings → Export & import |
| Share songs/setlists as packages | ✅ | `.ospkg` |
| Export files (with annotations, crop, merged PDF), title lists (.txt/.pdf), print | ✅ | |
| Settings export/import | ✅ | |
| PC companion | — | OpenStand runs in any desktop browser; library sync (above) covers the rest |
| Genos/PSR-SX registration link | ◐ | No dedicated button; record the keyboard's registration message with MIDI learn |
