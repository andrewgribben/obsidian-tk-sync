// Fake TK MCP client and OAuth tests. No network: HttpFn is a recording stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TkClient } from "../src/tk-client.ts";
import type { HttpRequest, HttpResponse, TkDocMeta, TkTokens } from "../src/types.ts";
import { TkSharedDocError } from "../src/types.ts";

function freshTokens(overrides?: Partial<TkTokens>): TkTokens {
  return {
    client_id: "client-1",
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

const docMeta: TkDocMeta = {
  id: "doc-1",
  title: "Hello",
  tags: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function rpcResult(id: number, result: unknown): HttpResponse {
  return {
    status: 200,
    headers: {},
    text: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

function toolCallResult(id: number, payload: unknown, isError = false): HttpResponse {
  return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], isError });
}

/** Builds a fake HttpFn + recorded requests. `handler` decides each response in order. */
function makeHarness(handler: (req: HttpRequest, callIndex: number) => HttpResponse) {
  const requests: HttpRequest[] = [];
  let i = 0;
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return handler(req, i++);
  };
  return { http, requests };
}

function rpcMethod(req: HttpRequest): string {
  return (JSON.parse(req.body ?? "{}") as { method: string }).method;
}
function rpcId(req: HttpRequest): number | undefined {
  return (JSON.parse(req.body ?? "{}") as { id?: number }).id;
}

test("every MCP request carries the User-Agent header", async () => {
  const { http, requests } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, { protocolVersion: "2025-06-18" });
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, { documents: [], has_more: false });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  await client.listDocuments();
  assert.ok(requests.length > 0);
  for (const r of requests) assert.equal(r.headers["User-Agent"], "obsidian-tk-sync/0.1");
});

test("initializes once, keeps and reuses the Mcp-Session-Id", async () => {
  const { http, requests } = makeHarness((req, i) => {
    const method = rpcMethod(req);
    if (method === "initialize") {
      return { status: 200, headers: { "mcp-session-id": "sess-1" }, text: JSON.stringify({ jsonrpc: "2.0", id: rpcId(req), result: {} }) };
    }
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, { documents: [docMeta], has_more: false });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  await client.listDocuments();
  await client.listDocuments();
  const initCalls = requests.filter((r) => rpcMethod(r) === "initialize");
  assert.equal(initCalls.length, 1, "initialize should run only once");
  const toolCalls = requests.filter((r) => rpcMethod(r) === "tools/call");
  for (const r of toolCalls) assert.equal(r.headers["Mcp-Session-Id"], "sess-1");
});

test("parses an SSE-formatted response body", async () => {
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    const id = rpcId(req)!;
    const payload = { content: [{ type: "text", text: JSON.stringify({ documents: [docMeta], has_more: false }) }] };
    return {
      status: 200,
      headers: {},
      text: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: payload })}\n\n`,
    };
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  const docs = await client.listDocuments();
  assert.deepEqual(docs, [docMeta]);
});

test("pages get_recent_documents across has_more", async () => {
  const page1 = [docMeta, { ...docMeta, id: "doc-2" }];
  const page2 = [{ ...docMeta, id: "doc-3" }];
  const { http, requests } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    const args = (JSON.parse(req.body ?? "{}") as { params: { arguments: { offset: number } } }).params.arguments;
    if (args.offset === 0) return toolCallResult(rpcId(req)!, { documents: page1, has_more: true });
    return toolCallResult(rpcId(req)!, { documents: page2, has_more: false });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  const docs = await client.listDocuments();
  assert.deepEqual(docs.map((d) => d.id), ["doc-1", "doc-2", "doc-3"]);
  const toolCalls = requests.filter((r) => rpcMethod(r) === "tools/call");
  assert.equal(toolCalls.length, 2);
});

test("getDocument parses the stringified Tiptap content", async () => {
  const tiptap = { type: "doc", content: [{ type: "paragraph", text: "hi" }] };
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, { ...docMeta, content: JSON.stringify(tiptap) });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  const doc = await client.getDocument("doc-1");
  assert.deepEqual(doc.content, tiptap);
  assert.equal(doc.id, "doc-1");
});

test("401 triggers one refresh and retry", async () => {
  const tokens = freshTokens();
  let saved: TkTokens | null = null;
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.url.includes("/oauth/token")) {
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
      };
    }
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    if (method === "tools/call" && req.headers.Authorization === "Bearer access-1") {
      return { status: 401, headers: {}, text: "unauthorized" };
    }
    assert.equal(req.headers.Authorization, "Bearer access-2");
    return toolCallResult(rpcId(req)!, { documents: [], has_more: false });
  };
  const client = new TkClient(
    http,
    () => saved ?? tokens,
    async (t) => {
      saved = t;
    },
  );
  const docs = await client.listDocuments();
  assert.deepEqual(docs, []);
  assert.equal(saved !== null && (saved as TkTokens).access_token, "access-2");
});

test("proactively refreshes when access token is near expiry", async () => {
  let refreshCalled = false;
  const nearExpiry = freshTokens({ expires_at: Date.now() + 60 * 1000 });
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.url.includes("/oauth/token")) {
      refreshCalled = true;
      return { status: 200, headers: {}, text: JSON.stringify({ access_token: "access-fresh", refresh_token: "refresh-1", expires_in: 3600 }) };
    }
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    assert.equal(req.headers.Authorization, "Bearer access-fresh");
    return toolCallResult(rpcId(req)!, { documents: [], has_more: false });
  };
  let saved: TkTokens | null = null;
  const client = new TkClient(http, () => saved ?? nearExpiry, async (t) => { saved = t; });
  await client.listDocuments();
  assert.ok(refreshCalled);
});

test("404 with an active session re-initializes once and retries", async () => {
  let initCount = 0;
  let sawSession = false;
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") {
      initCount++;
      return { status: 200, headers: { "mcp-session-id": "sess-" + initCount }, text: JSON.stringify({ jsonrpc: "2.0", id: rpcId(req), result: {} }) };
    }
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    if (method === "tools/call") {
      if (!sawSession) {
        sawSession = true;
        return { status: 404, headers: {}, text: "session expired" };
      }
      return toolCallResult(rpcId(req)!, { documents: [], has_more: false });
    }
    throw new Error("unexpected method " + method);
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  const docs = await client.listDocuments();
  assert.deepEqual(docs, []);
  assert.equal(initCount, 2, "should re-initialize once after a 404");
});

test("isError result throws an Error with the TK message", async () => {
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, "document not found", true);
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  await assert.rejects(() => client.getDocument("missing"), /document not found/);
});

test("a shared-document refusal on update throws TkSharedDocError", async () => {
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, "This document is shared; pass confirm_shared to proceed", true);
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  await assert.rejects(() => client.updateDocument("doc-1", "T", "body"), TkSharedDocError);
});

test("throws a clear error when there are no tokens", async () => {
  const http = async (): Promise<HttpResponse> => {
    throw new Error("should not be called");
  };
  const client = new TkClient(http, () => null, async () => {});
  await assert.rejects(() => client.listDocuments(), /Not connected to TK/);
});

test("createDocument and updateDocument send the expected tool args", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    const params = (JSON.parse(req.body ?? "{}") as { params: { name: string; arguments: unknown } }).params;
    calls.push({ name: params.name, args: params.arguments });
    if (params.name === "get_document_content") {
      return toolCallResult(rpcId(req)!, { ...docMeta, updated_at: "stored-ts", content: "{\"type\":\"doc\"}" });
    }
    return toolCallResult(rpcId(req)!, { ...docMeta, updated_at: "write-response-ts" });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  const created = await client.createDocument("Hello", "body text");
  const updated = await client.updateDocument("doc-1", "Hello", "new body");
  assert.deepEqual(calls[0], { name: "create_document", args: { title: "Hello", content: "body text" } });
  assert.deepEqual(calls[2], { name: "update_document", args: { document_id: "doc-1", title: "Hello", content: "new body" } });
  // TK's write responses carry an updated_at that differs from the stored one; we must return the stored one.
  assert.equal(created.updated_at, "stored-ts");
  assert.equal(updated.updated_at, "stored-ts");
  assert.equal((updated as { content?: unknown }).content, undefined);
});

test("an expired token is refreshed even on the first initialize", async () => {
  let saved: TkTokens | null = null;
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.url.includes("/oauth/token")) {
      return { status: 200, headers: {}, text: JSON.stringify({ access_token: "access-2", expires_in: 3600 }) };
    }
    if (req.headers.Authorization === "Bearer access-1") return { status: 401, headers: {}, text: "unauthorized" };
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, { documents: [], has_more: false });
  };
  const client = new TkClient(http, () => saved ?? freshTokens(), async (t) => { saved = t; });
  assert.deepEqual(await client.listDocuments(), []);
  assert.equal(saved !== null && (saved as TkTokens).access_token, "access-2");
});

test("a failed initialize is retried on the next call instead of failing forever", async () => {
  let initCalls = 0;
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") {
      initCalls++;
      if (initCalls === 1) return { status: 500, headers: {}, text: "boom" };
      return rpcResult(rpcId(req)!, {});
    }
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, { documents: [], has_more: false });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  await assert.rejects(() => client.listDocuments(), /500/);
  assert.deepEqual(await client.listDocuments(), []);
  assert.equal(initCalls, 2);
});

test("pagination stops on an empty page even if has_more is true", async () => {
  const { http } = makeHarness((req) => {
    const method = rpcMethod(req);
    if (method === "initialize") return rpcResult(rpcId(req)!, {});
    if (method === "notifications/initialized") return { status: 200, headers: {}, text: "" };
    return toolCallResult(rpcId(req)!, { documents: [], has_more: true });
  });
  const client = new TkClient(http, () => freshTokens(), async () => {});
  assert.deepEqual(await client.listDocuments(), []);
});
