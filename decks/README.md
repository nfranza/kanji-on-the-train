Drop your exported `.apkg` files in this folder.

## How to export from Anki desktop so the app can read it

The app parses the deck's SQLite database directly in the browser. Anki's
newer export format compresses that database with zstd, which this app does
not decode. To avoid that, export with legacy support turned on:

1. In Anki desktop: **File → Export**
2. Export format: **Anki Deck Package (.apkg)**
3. Check **"Support older Anki versions"** (this keeps an uncompressed
   `collection.anki2` inside the package, which the app reads)
4. Choose the deck, export, then drop the resulting file here

## Registering a deck

After adding a file here, add an entry for it in `decks.json` at the repo
root, e.g.:

```json
{ "id": "my-deck", "name": "My Deck", "file": "decks/my-deck.apkg" }
```

`id` should be short and unique — it's used as the storage key on your
phone, so if you re-export and replace the same file, keep the same `id`
and the app will treat it as an update to the existing deck rather than a
duplicate.

Commit both files, then open the app once with a network connection so it
can fetch and import the new deck. After that it's fully offline.
