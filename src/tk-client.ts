// TK MCP JSON-RPC client over Streamable HTTP. No 'obsidian' import: HTTP goes through
// the injected HttpFn (Obsidian's requestUrl in the plugin, fetch in tests/scripts).
import { refreshTokens } from "./auth.ts";
import {
  TkSharedDocError,
  type HttpFn,
  type TkApi,
  type TkDoc,
  type TkDocMeta,
  type TiptapNode,
  type TkTokens,
} from "./types.ts";

const MCP_URL = "https://tk.xyz/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const USER_AGENT = "obsidian-tk-sync/0.1";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Parses an MCP response body, which is either a bare JSON object or an SSE stream;
 * for SSE, returns the `data:` line carrying a JSON-RPC message with an id. */
function parseRpcBody(text: string): JsonRpcMessage {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcMessage;
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const msg = JSON.parse(t.slice(5).trim()) as JsonRpcMessage;
    if (msg.id !== undefined) return msg;
  }
  throw new Error(`Could not parse TK MCP response: ${trimmed.slice(0, 500)}`);
}

interface RecentDocumentsResult {
  documents: TkDocMeta[];
  has_more: boolean;
}

export class TkClient implements TkApi {
  private http: HttpFn;
  private getTokens: () => TkTokens | null;
  private saveTokens: (t: TkTokens) => Promise<void>;
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;

  constructor(
    http: HttpFn,
    getTokens: () => TkTokens | null,
    saveTokens: (t: TkTokens) => Promise<void>,
  ) {
    this.http = http;
    this.getTokens = getTokens;
    this.saveTokens = saveTokens;
  }

  private async ensureFreshTokens(): Promise<TkTokens> {
    const tokens = this.getTokens();
    if (!tokens) throw new Error("Not connected to TK");
    if (tokens.expires_at - Date.now() < REFRESH_SKEW_MS) {
      const refreshed = await refreshTokens(this.http, tokens);
      await this.saveTokens(refreshed);
      return refreshed;
    }
    return tokens;
  }

  /** Sends one JSON-RPC request/notification, refreshing/retrying/re-initializing as needed. */
  private async rpc(
    method: string,
    params: unknown,
    opts?: { notify?: boolean; isInit?: boolean },
  ): Promise<unknown> {
    const notify = opts?.notify ?? false;
    let tokens = await this.ensureFreshTokens();

    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    let id: number | undefined;
    if (!notify) {
      id = this.nextId++;
      message.id = id;
    }

    const send = async (): Promise<{ status: number; headers: Record<string, string>; text: string }> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": USER_AGENT,
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        Authorization: `Bearer ${tokens!.access_token}`,
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      return this.http({ url: MCP_URL, method: "POST", headers, body: JSON.stringify(message) });
    };

    let res = await send();

    if (res.status === 401) {
      tokens = await refreshTokens(this.http, tokens);
      await this.saveTokens(tokens);
      res = await send();
    }

    if (res.status === 404 && this.sessionId && !opts?.isInit) {
      // MCP session expired server-side: re-initialize once and retry.
      this.sessionId = null;
      this.initialized = null;
      await this.ensureInitialized();
      res = await send();
    }

    const headerSid = res.headers["mcp-session-id"];
    if (headerSid) this.sessionId = headerSid;

    if (notify) return undefined;

    if (res.status !== 200) {
      throw new Error(`TK MCP request failed (${res.status}): ${res.text.slice(0, 500)}`);
    }
    const parsed = parseRpcBody(res.text);
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.rpc(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "obsidian-tk-sync", version: "0.1" },
          },
          { isInit: true },
        );
        await this.rpc("notifications/initialized", undefined, { notify: true, isInit: true });
      })().catch((e) => {
        this.initialized = null; // allow the next call to retry instead of failing forever
        throw e;
      });
    }
    await this.initialized;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? "";
    if (result.isError) {
      // TK has no dedicated error code for the shared-document refusal: it is identified
      // by matching the refusal text, since we cannot trigger a real shared document here.
      if (/shared|confirm_shared/i.test(text)) throw new TkSharedDocError(text);
      throw new Error(text);
    }
    return JSON.parse(text);
  }

  async listDocuments(): Promise<TkDocMeta[]> {
    const all: TkDocMeta[] = [];
    let offset = 0;
    for (;;) {
      const page = (await this.callTool("get_recent_documents", {
        limit: 100,
        offset,
        sort_by: "updated_at",
        order: "desc",
      })) as RecentDocumentsResult;
      all.push(...page.documents);
      if (!page.has_more || page.documents.length === 0) break;
      offset += page.documents.length;
    }
    return all;
  }

  async getDocument(id: string): Promise<TkDoc> {
    const doc = (await this.callTool("get_document_content", {
      document_id: id,
      format: "json",
    })) as TkDocMeta & { content: string };
    return {
      id: doc.id,
      title: doc.title,
      tags: doc.tags,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      content: JSON.parse(doc.content) as TiptapNode,
    };
  }

  // The write responses carry an updated_at a few microseconds off the stored value that
  // listDocuments/getDocument report (verified live), so re-read it; otherwise every push
  // would look like a remote change on the next sync.
  private async stored(id: string): Promise<TkDocMeta> {
    const { content: _content, ...meta } = await this.getDocument(id);
    return meta;
  }

  async createDocument(title: string, markdown: string): Promise<TkDocMeta> {
    const doc = (await this.callTool("create_document", { title, content: markdown })) as TkDocMeta;
    return this.stored(doc.id);
  }

  async updateDocument(id: string, title: string, markdown: string): Promise<TkDocMeta> {
    await this.callTool("update_document", { document_id: id, title, content: markdown });
    return this.stored(id);
  }
}
