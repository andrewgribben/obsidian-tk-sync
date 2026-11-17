# obsidian-tk-sync

Obsidian plugin: two-way sync between one vault folder and TK (tk.xyz, Medium's writing app) through TK's official MCP server (`https://tk.xyz/mcp`, Streamable HTTP, OAuth 2.1 + PKCE, dynamic client registration, loopback redirect `http://127.0.0.1:<port>/callback` only). Desktop only.

## Layout
- `src/types.ts` shared contracts. Change only with the coordinator's agreement.
- `src/tiptap.ts` Tiptap JSON -> Markdown (pure).
- `src/tk-client.ts`, `src/auth.ts` MCP JSON-RPC client and OAuth (no `obsidian` import; HTTP via injected `HttpFn`).
- `src/sync.ts` sync engine (pure; vault via `VaultIO`, TK via `TkApi`).
- `src/ui/` settings tab, status bar, notices (Obsidian API).
- `src/main.ts` wiring only.
- `spike/` throwaway Python probe (`tk.py`), real tool schemas in `spike/tools.json`.

## Rules
- UK English, no em dashes. Smallest change that fully works; no new runtime dependencies.
- Pure modules must not import `obsidian`. Tests: `node --test` on `.ts` files (Node 24 type stripping): use `.ts` import extensions and erasable syntax only (no enums, no parameter properties, no namespaces).
- `npm run check` (typecheck + tests + build) must pass.
- Never commit secrets. `.tk-token.json` and plugin `data.json` are gitignored.
- Do not push, publish, or delete anything in TK. Live TK calls: read-only, except edits to a throwaway test note the owner names.

## Sync rules (owner decisions)
- Never create a TK duplicate: before creating, a local file links to an unlinked TK note whose title matches by `titleKey` (case, spaces and punctuation ignored). Differing text gives a `(TK conflict ...)` copy, never an overwrite.
- TK delete: trash the local file if unchanged since the last sync, otherwise keep it as local-only. Obsidian delete only unlinks (no TK delete API). Sync stops if TK suddenly lists far fewer notes.
- Traffic lights (optional; vault names only, never TK titles; emoji then one or more spaces): only 🟠 syncs. 🟢 (final edition), 🔴 and unprefixed notes are never pushed, and a same-titled TK note is not pulled. A note's colour is its own prefix, else its folder's; any unprefixed subfolder means ignored. Nothing is renamed. Unmatched TK notes are pulled to the folder root as `🟠 <title>`. Policy lives in `lightOfPath()`/`isPaused()` in `src/sync.ts`.
- Changing the sync folder resets sync records (old links would read as local deletes).

## TK facts (verified 2026-11-17)
- Cloudflare blocks requests without a non-default User-Agent (error 1010).
- Tool results are `result.content[0].text` holding a JSON string. `get_document_content` format `json` returns `content` as a JSON *string* of the Tiptap doc; `get_recent_documents` with `include_content` returns content too (may lag a few seconds).
- The doc title is also the body's first `heading` level 1. Writes take Markdown; `update_document` replaces the whole body (owner only; shared docs error until `confirm_shared: true`).
- `create_document`/`update_document` responses carry an `updated_at` a few microseconds off the stored value; `TkClient` re-reads the doc after writes so sync state matches `listDocuments`.
- Real notes contain TK-only nodes: `figure` (image + caption), `embed` (url only), `pullquote`, `mention` (id only), `tkInlinePrompt`. Embeds and mentions cannot round-trip.
- Every text node may carry an `author` mark (AI attribution); ignore it.
- Notes created via the API are flagged `created_by_ai`. Owner accepted this.
- No delete tool exists.
