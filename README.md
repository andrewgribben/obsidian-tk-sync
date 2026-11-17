# TK Sync for Obsidian

Sync a folder in your Obsidian vault with [TK](https://tk.xyz), Medium's writing app.

Unofficial. Desktop only. Uses TK's own MCP connection, so you sign in with your TK account and nothing is scraped.

## Install

1. Download `main.js` and `manifest.json` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/tk-sync/`.
3. In Obsidian, turn on **TK Sync** under **Settings → Community plugins**.

## Set up

1. Open **Settings → TK Sync**.
2. Choose a **Folder**.
3. Click **Connect to TK** and approve in your browser.
4. Click **Sync now**.

## How it works

- Notes in the folder are uploaded to TK. TK notes are downloaded into the folder.
- Edits sync both ways.
- If a note changed in both places, TK's version is saved next to yours as `(TK conflict …)`. Nothing is overwritten.
- Notes are matched by title, so you don't get duplicates.
- Deleting a note in TK moves your copy to Obsidian's trash, unless you've edited it since the last sync.
- Deleting a note in Obsidian never deletes it in TK.

## Traffic lights (optional)

Turn on **Traffic lights** to choose which notes sync by starting the file name with:

- 🟠 sync
- 🟢 published, don't sync
- 🔴 don't sync

Notes with no prefix are left alone. A prefixed subfolder passes its colour to the notes inside. TK never sees the emoji.

## Commands

- **Sync with TK now**
- **Reset sync**: forgets which notes are linked. Use it if a note you deleted should come back. Nothing is deleted.

## Limits

- TK has no delete through its API, so the plugin can't delete TK notes.
- Notes uploaded by the plugin are marked as created by AI in TK.
- Tags don't sync. Renaming a note in TK doesn't rename the file.
- Embeds come back as plain links.

## Development

```
npm install
npm run check   # typecheck, tests, build
```

Node 24 or later.

## Licence

MIT
