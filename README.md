# Reps

A minimal offline spaced-repetition app: deck list with a due count, tap in,
flip card, four buttons. Runs as a home-screen PWA on iPhone, no App Store.

## Files

```
index.html      the whole UI (deck list + review screen)
app.js          storage, apkg import, and the SM-2 scheduler
sw.js           service worker — caches everything for offline use
manifest.json   home-screen icon/name config
decks.json      list of which .apkg files to load, and their display names
decks/          put your exported .apkg files here
icon-*.png      home-screen icons
```

## Uploading to GitHub Pages

Upload all of the above (keeping the `decks/` folder structure) to your repo,
commit, then enable Pages in Settings → Pages → deploy from `main` / root.
You already have this set up — just drag these files into the repo root.

## Adding a deck

1. In Anki desktop: File → Export → Anki Deck Package (.apkg), with
   **"Support older Anki versions"** checked. This matters — without it the
   export is zstd-compressed and the app can't read it.
2. Drop the `.apkg` into `decks/`.
3. Add an entry to `decks.json`:
   ```json
   { "id": "some-short-id", "name": "Display Name", "file": "decks/yourfile.apkg" }
   ```
4. Commit. Open the app once with a connection so it can fetch the update —
   it only imports new cards, so re-uploading the same file to refresh a deck
   won't wipe your progress on cards it already has.

## Installing on iPhone

1. Open your GitHub Pages URL in **Safari** (must be Safari).
2. Share button → **Add to Home Screen**.
3. Open it from the home screen icon from now on.

## What's deliberately not here

No card editor, no tags, no cross-device sync, no stats graphs, no
suspend/bury UI. The scheduler intentionally skips Anki's shared daily
limits — every deck's due count is independent, so finishing one deck never
"steals" from another.

## Known limitation

Only the first two fields of each note are used (front/back), and media
(images/audio) embedded in cards isn't imported — text-only for now.
