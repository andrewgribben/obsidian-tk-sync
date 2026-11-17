// Shared contracts between the converter, TK client, sync engine and UI.
// Pure TypeScript: nothing here (or in tiptap.ts, tk-client.ts, sync.ts) may import 'obsidian',
// so those modules run under `node --test` without Obsidian.

/** Tiptap/ProseMirror JSON node as returned by TK (`get_document_content` format:"json"). */
export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
}

/** Document metadata from `get_recent_documents`. */
export interface TkDocMeta {
  id: string;
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** Full document; `content` is the parsed Tiptap root ({type:"doc", content:[...]}). */
export interface TkDoc extends TkDocMeta {
  content: TiptapNode;
}

/** Thrown when TK refuses an edit because the document is shared (needs confirm_shared). */
export class TkSharedDocError extends Error {}

/** What the sync engine needs from TK. Implemented by TkClient (src/tk-client.ts). */
export interface TkApi {
  /** Every document in the user's own knowledge base, all pages. */
  listDocuments(): Promise<TkDocMeta[]>;
  getDocument(id: string): Promise<TkDoc>;
  /** `markdown` is the body without the title heading. */
  createDocument(title: string, markdown: string): Promise<TkDocMeta>;
  /** Whole-body replace. Throws TkSharedDocError for shared docs. */
  updateDocument(id: string, title: string, markdown: string): Promise<TkDocMeta>;
}

/** Minimal HTTP seam: Obsidian's requestUrl in the plugin (no CORS), fetch in tests/scripts. */
export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>; // lower-cased keys
  text: string;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** OAuth tokens persisted in plugin data. */
export interface TkTokens {
  client_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

/** Vault access the sync engine needs. Paths are vault-relative with '/' separators. */
export interface VaultIO {
  /** All .md files under `folder` (recursive). */
  listMarkdown(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Create or overwrite; creates parent folders. */
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Move to the user's trash (honours their trash setting; restorable). */
  trash(path: string): Promise<void>;
}

/** Persisted link between a vault file and a TK document. */
export interface SyncLink {
  path: string;
  /** sha256 hex of the local file content at last sync. */
  localHash: string;
  /** TK updated_at at last sync. */
  remoteUpdatedAt: string;
}
export interface SyncState {
  version: 1;
  links: Record<string, SyncLink>; // key: TK document id
  /** TK ids the user unlinked by deleting the local file; never re-pulled. */
  ignored: string[];
  /** Vault paths whose TK doc was deleted remotely; never pushed again. */
  localOnly: string[];
}

export interface SyncReport {
  pulled: string[];
  pushed: string[];
  created: string[]; // new TK docs from local files
  conflicts: string[]; // paths of conflict copies written
  /** Local files moved to the trash because their TK doc was deleted and they had no unsynced edits. */
  trashed: string[];
  skipped: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
}
