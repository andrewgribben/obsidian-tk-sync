import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState,
  sync,
  renamePath,
  isConflictCopy,
  trafficLightOf,
  stripLightPrefix,
  ORANGE_PREFIX,
} from "../src/sync.ts";
import { TkSharedDocError } from "../src/types.ts";
import type {
  SyncState,
  TkApi,
  TkDoc,
  TkDocMeta,
  VaultIO,
} from "../src/types.ts";

// --- In-memory fakes -------------------------------------------------------

class FakeVault implements VaultIO {
  files = new Map<string, string>();
  trashed: string[] = [];
  writeCount = 0;

  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = folder ? `${folder}/` : "";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".md"));
  }
  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`not found: ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    this.writeCount += 1;
    this.files.set(path, data);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async trash(path: string): Promise<void> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`not found: ${path}`);
    this.files.delete(path);
    this.trashed.push(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, v);
  }
}

interface FakeDocRecord {
  meta: TkDocMeta;
  body: string;
}

class FakeApi implements TkApi {
  docs = new Map<string, FakeDocRecord>();
  sharedIds = new Set<string>();
  nextId = 1;
  clock = 1;
  createCount = 0;
  updateCount = 0;

  seed(id: string, title: string, body: string, tags: string[] = []): void {
    const t = `t${this.clock++}`;
    this.docs.set(id, { meta: { id, title, tags, created_at: t, updated_at: t }, body });
  }

  bumpRemote(id: string, body: string): void {
    const rec = this.docs.get(id);
    if (!rec) throw new Error("no such doc");
    rec.body = body;
    rec.meta = { ...rec.meta, updated_at: `t${this.clock++}` };
  }

  async listDocuments(): Promise<TkDocMeta[]> {
    return [...this.docs.values()].map((r) => ({ ...r.meta }));
  }
  async getDocument(id: string): Promise<TkDoc> {
    const rec = this.docs.get(id);
    if (!rec) throw new Error(`no such doc: ${id}`);
    return { ...rec.meta, content: { type: "doc", text: rec.body } };
  }
  async createDocument(title: string, markdown: string): Promise<TkDocMeta> {
    this.createCount += 1;
    const id = `doc-${this.nextId++}`;
    const t = `t${this.clock++}`;
    const meta: TkDocMeta = { id, title, tags: [], created_at: t, updated_at: t };
    this.docs.set(id, { meta, body: markdown });
    return { ...meta };
  }
  async updateDocument(id: string, title: string, markdown: string): Promise<TkDocMeta> {
    this.updateCount += 1;
    const rec = this.docs.get(id);
    if (!rec) throw new Error(`no such doc: ${id}`);
    if (this.sharedIds.has(id)) throw new TkSharedDocError("shared");
    const t = `t${this.clock++}`;
    rec.body = markdown;
    rec.meta = { ...rec.meta, title, updated_at: t };
    return { ...rec.meta };
  }
}

async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toMarkdown = (doc: TkDoc): string => doc.content.text ?? "";

const FOLDER = "TK";

function fixedNow(y: number, m: number, d: number, hh: number, mm: number): () => Date {
  return () => new Date(y, m - 1, d, hh, mm, 0, 0);
}

// --- Tests -------------------------------------------------------------

test("empty state shape", () => {
  const s = emptyState();
  assert.deepEqual(s, { version: 1, links: {}, ignored: [], localOnly: [] });
});

test("isConflictCopy matches conflict file names", () => {
  assert.equal(isConflictCopy("TK/Note (TK conflict 2024-01-15 0930).md"), true);
  assert.equal(isConflictCopy("TK/Note (TK conflict 2024-01-15 0930) 2.md"), true);
  assert.equal(isConflictCopy("TK/Note.md"), false);
  assert.equal(isConflictCopy("TK/Note (conflict).md"), false);
});

test("neither side changed: nothing happens", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Body one");
  vault.files.set(`${FOLDER}/Hello.md`, "Body one");
  const hash = await sha256Hex("Body one");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: hash, remoteUpdatedAt: "t1" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report, { pulled: [], pushed: [], created: [], conflicts: [], trashed: [], skipped: [], errors: [] });
  assert.deepEqual(next.links, state.links);
  assert.equal(vault.writeCount, 0);
  assert.equal(api.updateCount, 0);
});

test("remote only changed: pulls and keeps local frontmatter", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "New remote body");
  const localContent = "---\ntags: [x]\n---\nOld body";
  vault.files.set(`${FOLDER}/Hello.md`, localContent);
  const oldHash = await sha256Hex(localContent);
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: oldHash, remoteUpdatedAt: "old" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.pulled, [`${FOLDER}/Hello.md`]);
  const written = vault.files.get(`${FOLDER}/Hello.md`);
  assert.equal(written, "---\ntags: [x]\n---\nNew remote body");
  assert.equal(next.links["d1"].remoteUpdatedAt, "t1");
  assert.equal(next.links["d1"].localHash, await sha256Hex(written!));
});

test("local only changed: pushes with frontmatter stripped, file untouched", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Original body");
  const localContent = "---\ntags: [x]\n---\nEdited body";
  vault.files.set(`${FOLDER}/Hello.md`, localContent);
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: await sha256Hex("---\ntags: [x]\n---\nOriginal body"), remoteUpdatedAt: "t1" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.pushed, [`${FOLDER}/Hello.md`]);
  assert.equal(api.docs.get("d1")!.body, "Edited body");
  assert.equal(api.docs.get("d1")!.meta.title, "Hello");
  assert.equal(vault.files.get(`${FOLDER}/Hello.md`), localContent, "local file is not rewritten");
  assert.equal(next.links["d1"].localHash, await sha256Hex(localContent));
  assert.equal(next.links["d1"].remoteUpdatedAt, api.docs.get("d1")!.meta.updated_at);
});

test("shared doc error on push: skipped, link unchanged", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Original body");
  api.sharedIds.add("d1");
  const localContent = "Edited body";
  vault.files.set(`${FOLDER}/Hello.md`, localContent);
  const oldLink = { path: `${FOLDER}/Hello.md`, localHash: await sha256Hex("Original body"), remoteUpdatedAt: "t1" };
  let state = emptyState();
  state.links["d1"] = oldLink;

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.skipped, [{ path: `${FOLDER}/Hello.md`, reason: "shared in TK; edit it there" }]);
  assert.deepEqual(next.links["d1"], oldLink);
});

test("both changed: writes a conflict copy, keeps local untouched, next sync pushes local", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Remote edited body");
  const localContent = "Local edited body";
  vault.files.set(`${FOLDER}/Hello.md`, localContent);
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: await sha256Hex("Original body"), remoteUpdatedAt: "stale" };

  const now = fixedNow(2024, 1, 15, 9, 30);
  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown, now });

  const conflictPath = `${FOLDER}/Hello (TK conflict 2024-01-15 0930).md`;
  assert.deepEqual(report.conflicts, [conflictPath]);
  assert.equal(vault.files.get(conflictPath), "Remote edited body");
  assert.equal(vault.files.get(`${FOLDER}/Hello.md`), localContent, "local file untouched");
  assert.equal(next.links["d1"].remoteUpdatedAt, "t1");
  assert.equal(next.links["d1"].localHash, state.links["d1"].localHash, "local hash kept stale so next sync pushes");

  // follow-up sync: local file still differs from the OLD localHash, so it is pushed this time.
  const { state: next2, report: report2 } = await sync({ api, vault, folder: FOLDER, state: next, toMarkdown });
  assert.deepEqual(report2.pushed, [`${FOLDER}/Hello.md`]);
  assert.equal(api.docs.get("d1")!.body, "Local edited body");
  // conflict copy itself was never pushed/pulled again (not a tracked doc)
  assert.equal(vault.files.get(conflictPath), "Remote edited body");
});

test("conflict copy naming avoids overwriting an existing file", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Remote edited body");
  vault.files.set(`${FOLDER}/Hello.md`, "Local edited body");
  vault.files.set(`${FOLDER}/Hello (TK conflict 2024-01-15 0930).md`, "pre-existing");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: await sha256Hex("Original"), remoteUpdatedAt: "stale" };

  const now = fixedNow(2024, 1, 15, 9, 30);
  const { report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown, now });

  assert.deepEqual(report.conflicts, [`${FOLDER}/Hello (TK conflict 2024-01-15 0930) 2.md`]);
});

test("local file deleted by user: link removed, doc id ignored forever", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Remote body");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: "whatever", remoteUpdatedAt: "t1" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.equal(next.links["d1"], undefined);
  assert.deepEqual(next.ignored, ["d1"]);
  assert.equal(vault.files.has(`${FOLDER}/Hello.md`), false);
  assert.deepEqual(report.pulled, [], "not re-pulled on removal sync itself");

  // second sync: doc still exists remotely, unlinked, but ignored -> never pulled back.
  const { state: next2, report: report2 } = await sync({ api, vault, folder: FOLDER, state: next, toMarkdown });
  assert.deepEqual(report2.pulled, []);
  assert.equal(next2.links["d1"], undefined);
  assert.deepEqual(next2.ignored, ["d1"]);
});

test("doc deleted in TK, file unchanged: trashed, link removed", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d2", "Keep", "Keep body"); // another linked doc, still present: guards against the empty-list guard
  vault.files.set(`${FOLDER}/Keep.md`, "Keep body");
  vault.files.set(`${FOLDER}/Hello.md`, "Still here");
  const hash = await sha256Hex("Still here");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: hash, remoteUpdatedAt: "t1" };
  state.links["d2"] = { path: `${FOLDER}/Keep.md`, localHash: await sha256Hex("Keep body"), remoteUpdatedAt: "t1" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.equal(next.links["d1"], undefined);
  assert.deepEqual(next.localOnly, []);
  assert.deepEqual(report.trashed, [`${FOLDER}/Hello.md`]);
  assert.deepEqual(report.skipped, []);
  assert.equal(vault.files.has(`${FOLDER}/Hello.md`), false, "moved to trash");
  assert.deepEqual(vault.trashed, [`${FOLDER}/Hello.md`]);
  assert.equal(api.createCount, 0, "trashed file is not pushed as a new doc");
});

test("doc deleted in TK, file has unsynced edits: kept, marked localOnly", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d2", "Keep", "Keep body");
  vault.files.set(`${FOLDER}/Keep.md`, "Keep body");
  vault.files.set(`${FOLDER}/Hello.md`, "Edited since last sync");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: "stale-hash", remoteUpdatedAt: "t1" };
  state.links["d2"] = { path: `${FOLDER}/Keep.md`, localHash: await sha256Hex("Keep body"), remoteUpdatedAt: "t1" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.equal(next.links["d1"], undefined);
  assert.deepEqual(next.localOnly, [`${FOLDER}/Hello.md`]);
  assert.deepEqual(report.trashed, []);
  assert.deepEqual(report.skipped, [
    { path: `${FOLDER}/Hello.md`, reason: "deleted in TK; kept because it has unsynced edits" },
  ]);
  assert.equal(vault.files.get(`${FOLDER}/Hello.md`), "Edited since last sync", "kept, not trashed");
  assert.equal(api.createCount, 0, "localOnly file is not pushed as a new doc");

  // second sync: still localOnly, still not pushed or trashed.
  const { report: report2 } = await sync({ api, vault, folder: FOLDER, state: next, toMarkdown });
  assert.equal(api.createCount, 0);
  assert.deepEqual(report2.created, []);
  assert.deepEqual(report2.trashed, []);
});

test("safety guard: TK list missing more than half the linked docs (and >=3) throws, nothing changed", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  // Seed 6 remote docs, link all 6 locally, then only 2 remain remotely (4 missing: >half and >=3).
  let state = emptyState();
  for (let i = 1; i <= 6; i++) {
    const id = `d${i}`;
    if (i <= 2) api.seed(id, `Note ${i}`, `body ${i}`);
    vault.files.set(`${FOLDER}/Note ${i}.md`, `body ${i}`);
    state.links[id] = { path: `${FOLDER}/Note ${i}.md`, localHash: await sha256Hex(`body ${i}`), remoteUpdatedAt: "t1" };
  }
  const snapshot = JSON.parse(JSON.stringify(state));

  await assert.rejects(
    () => sync({ api, vault, folder: FOLDER, state, toMarkdown }),
    /TK returned far fewer notes than expected/,
  );
  assert.deepEqual(state, snapshot, "nothing mutated");
  assert.equal(vault.trashed.length, 0);
  assert.equal(vault.writeCount, 0);
});

test("safety guard: remote list empty while links exist throws", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  vault.files.set(`${FOLDER}/Hello.md`, "body");
  const state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: await sha256Hex("body"), remoteUpdatedAt: "t1" };

  await assert.rejects(() => sync({ api, vault, folder: FOLDER, state, toMarkdown }));
  assert.equal(vault.trashed.length, 0);
});

test("safety guard does not trip on a small number of real deletions", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Keep1", "k1");
  api.seed("d2", "Keep2", "k2");
  // d3 genuinely deleted in TK: 1 of 3 missing, well under half.
  vault.files.set(`${FOLDER}/Keep1.md`, "k1");
  vault.files.set(`${FOLDER}/Keep2.md`, "k2");
  vault.files.set(`${FOLDER}/Gone.md`, "gone body");
  const hash = await sha256Hex("gone body");
  const state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Keep1.md`, localHash: await sha256Hex("k1"), remoteUpdatedAt: "t1" };
  state.links["d2"] = { path: `${FOLDER}/Keep2.md`, localHash: await sha256Hex("k2"), remoteUpdatedAt: "t1" };
  state.links["d3"] = { path: `${FOLDER}/Gone.md`, localHash: hash, remoteUpdatedAt: "t1" };

  const { report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });
  assert.deepEqual(report.trashed, [`${FOLDER}/Gone.md`]);
});

test("unlinked remote doc is pulled into the folder and linked", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "My New Note", "Some body");
  let state = emptyState();

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.pulled, [`${FOLDER}/My New Note.md`]);
  assert.equal(vault.files.get(`${FOLDER}/My New Note.md`), "Some body");
  assert.equal(next.links["d1"].path, `${FOLDER}/My New Note.md`);
  assert.equal(next.links["d1"].remoteUpdatedAt, "t1");
});

test("unlinked local file is created in TK", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  vault.files.set(`${FOLDER}/Draft.md`, "---\nfoo: bar\n---\nDraft body");
  let state = emptyState();

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.created, [`${FOLDER}/Draft.md`]);
  const ids = Object.keys(next.links);
  assert.equal(ids.length, 1);
  const rec = api.docs.get(ids[0])!;
  assert.equal(rec.meta.title, "Draft");
  assert.equal(rec.body, "Draft body");
  assert.equal(vault.files.get(`${FOLDER}/Draft.md`), "---\nfoo: bar\n---\nDraft body", "local file not rewritten");
});

test("conflict-copy files are never pushed", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  vault.files.set(`${FOLDER}/Hello (TK conflict 2024-01-15 0930).md`, "leftover");
  let state = emptyState();

  const { report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.created, []);
  assert.equal(api.createCount, 0);
});

test("sanitising a title: illegal chars stripped, whitespace collapsed, empty -> Untitled", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", 'Weird: "Title" / Test * <ok>', "body1");
  api.seed("d2", "   ", "body2");
  let state = emptyState();

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.ok(report.pulled.includes(`${FOLDER}/Weird Title Test ok.md`), report.pulled.join(","));
  assert.ok(report.pulled.includes(`${FOLDER}/Untitled.md`), report.pulled.join(","));
  assert.equal(next.links["d1"].path, `${FOLDER}/Weird Title Test ok.md`);
  assert.equal(next.links["d2"].path, `${FOLDER}/Untitled.md`);
});

test("same-titled TK notes: only one is downloaded", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Note", "body1");
  api.seed("d2", "Note", "body2");
  api.seed("d3", "Note", "body3");
  const state = emptyState();

  const { state: next } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  // Three TK docs share a title: only one is downloaded (owner rule: no duplicates).
  assert.equal(next.links["d1"].path, `${FOLDER}/Note.md`);
  assert.equal(Object.keys(next.links).length, 1);
});

test("first sync populates both sides; second sync is a no-op (idempotent)", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Remote Note", "Remote body");
  vault.files.set(`${FOLDER}/Local Note.md`, "Local body");
  let state = emptyState();

  const { state: s1, report: r1 } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });
  assert.deepEqual(r1.pulled, [`${FOLDER}/Remote Note.md`]);
  assert.deepEqual(r1.created, [`${FOLDER}/Local Note.md`]);

  const writesBefore = vault.writeCount;
  const createsBefore = api.createCount;
  const updatesBefore = api.updateCount;

  const { state: s2, report: r2 } = await sync({ api, vault, folder: FOLDER, state: s1, toMarkdown });

  assert.deepEqual(r2, { pulled: [], pushed: [], created: [], conflicts: [], trashed: [], skipped: [], errors: [] });
  assert.equal(vault.writeCount, writesBefore, "no further file writes");
  assert.equal(api.createCount, createsBefore, "no further creates");
  assert.equal(api.updateCount, updatesBefore, "no further updates");
  assert.deepEqual(s2.links, s1.links);
});

test("an error on one item does not stop processing of others", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Good Remote", "good body");
  vault.files.set(`${FOLDER}/Good Local.md`, "good local body");
  vault.files.set(`${FOLDER}/Bad Local.md`, "bad local body");

  // make creating "Bad Local" fail, but only for that one call.
  const realCreate = api.createDocument.bind(api);
  let calls = 0;
  api.createDocument = async (title: string, markdown: string) => {
    calls += 1;
    if (title === "Bad Local") throw new Error("boom");
    return realCreate(title, markdown);
  };

  let state = emptyState();
  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(report.pulled, [`${FOLDER}/Good Remote.md`]);
  assert.deepEqual(report.created, [`${FOLDER}/Good Local.md`]);
  assert.deepEqual(report.errors, [{ path: `${FOLDER}/Bad Local.md`, error: "boom" }]);
  assert.equal(Object.keys(next.links).length, 2, "the failed item is not linked");
});

test("sync never mutates the input state object", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Remote body");
  vault.files.set(`${FOLDER}/Hello.md`, "Local body");
  const state: SyncState = {
    version: 1,
    links: { d1: { path: `${FOLDER}/Hello.md`, localHash: "stale", remoteUpdatedAt: "stale" } },
    ignored: ["zzz"],
    localOnly: ["TK/Somewhere.md"],
  };
  const snapshot = JSON.parse(JSON.stringify(state));

  await sync({ api, vault, folder: FOLDER, state, toMarkdown });

  assert.deepEqual(state, snapshot);
});

test("renamePath updates a link's path", () => {
  const state: SyncState = {
    version: 1,
    links: { d1: { path: `${FOLDER}/Old.md`, localHash: "h", remoteUpdatedAt: "t" } },
    ignored: ["d2"],
    localOnly: [],
  };
  const next = renamePath(state, `${FOLDER}/Old.md`, `${FOLDER}/New.md`);
  assert.equal(next.links["d1"].path, `${FOLDER}/New.md`);
  assert.deepEqual(state.links["d1"].path, `${FOLDER}/Old.md`, "input not mutated");
});

test("renamePath updates a localOnly entry", () => {
  const state: SyncState = {
    version: 1,
    links: {},
    ignored: [],
    localOnly: [`${FOLDER}/Old.md`],
  };
  const next = renamePath(state, `${FOLDER}/Old.md`, `${FOLDER}/New.md`);
  assert.deepEqual(next.localOnly, [`${FOLDER}/New.md`]);
  assert.deepEqual(state.localOnly, [`${FOLDER}/Old.md`], "input not mutated");
});

test("renamePath is a no-op when the path isn't tracked", () => {
  const state: SyncState = {
    version: 1,
    links: { d1: { path: `${FOLDER}/Other.md`, localHash: "h", remoteUpdatedAt: "t" } },
    ignored: [],
    localOnly: [],
  };
  const next = renamePath(state, `${FOLDER}/Nope.md`, `${FOLDER}/New.md`);
  assert.deepEqual(next.links, state.links);
});

test("both changed but identical content: links without a conflict copy", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Same body");
  vault.files.set(`${FOLDER}/Hello.md`, "---\na: 1\n---\nSame body\n");
  const state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/Hello.md`, localHash: "old", remoteUpdatedAt: "stale" };
  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown });
  assert.deepEqual(report.conflicts, []);
  assert.equal(next.links["d1"].remoteUpdatedAt, "t1");
  const again = await sync({ api, vault, folder: FOLDER, state: next, toMarkdown });
  assert.equal(again.report.pushed.length + again.report.pulled.length, 0);
});

test("unlinked local file matching an unlinked TK title is linked, not duplicated", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Same", "Body");
  api.seed("d2", "Different", "Remote text");
  vault.files.set(`${FOLDER}/Same.md`, "Body\n");
  vault.files.set(`${FOLDER}/Different.md`, "Local text");
  const now = fixedNow(2024, 1, 15, 9, 30);
  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, now });
  assert.equal(api.createCount, 0, "no duplicates created in TK");
  assert.deepEqual(report.created, []);
  assert.equal(next.links["d1"].path, `${FOLDER}/Same.md`);
  assert.deepEqual(report.conflicts, [`${FOLDER}/Different (TK conflict 2024-01-15 0930).md`]);
  assert.equal(vault.files.get(`${FOLDER}/Different.md`), "Local text", "local untouched");
  // Next sync pushes the local version of the differing file; the matching one stays quiet.
  const again = await sync({ api, vault, folder: FOLDER, state: next, toMarkdown });
  assert.deepEqual(again.report.pushed, [`${FOLDER}/Different.md`]);
  assert.equal(api.docs.size, 2);
});

test("CRLF-only changes are not treated as edits", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "a\nb");
  const first = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown });
  vault.files.set(`${FOLDER}/Hello.md`, vault.files.get(`${FOLDER}/Hello.md`)!.replace(/\n/g, "\r\n"));
  const second = await sync({ api, vault, folder: FOLDER, state: first.state, toMarkdown });
  assert.equal(second.report.pushed.length, 0);
});

// --- Traffic lights -----------------------------------------------------

test("trafficLightOf and stripLightPrefix handle single- and double-space prefixes", () => {
  assert.equal(trafficLightOf("🟠 Hello"), "orange");
  assert.equal(trafficLightOf("🟢  Hello"), "green"); // two spaces, as seen in the real vault
  assert.equal(trafficLightOf("🔴 Hello"), "red");
  assert.equal(trafficLightOf("Hello"), null);
  assert.equal(trafficLightOf("🟠Hello"), null, "no space at all does not count");
  assert.equal(stripLightPrefix("🟠 Hello"), "Hello");
  assert.equal(stripLightPrefix("🟢  Hello"), "Hello", "all spaces after the emoji are stripped");
  assert.equal(stripLightPrefix("Hello"), "Hello");
});

test("traffic lights off: behaviour is unchanged from v1 (no stripping, no renames)", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Remote Note", "Remote body");
  vault.files.set(`${FOLDER}/Local Note.md`, "Local body");
  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown });
  assert.deepEqual(report.pulled, [`${FOLDER}/Remote Note.md`]);
  assert.deepEqual(report.created, [`${FOLDER}/Local Note.md`]);
  assert.equal(vault.files.has(`${FOLDER}/Local Note.md`), true, "not renamed");
  assert.equal(api.docs.get(state.links["d1"] ? "d1" : "")?.meta.title, "Remote Note");
});

test("traffic lights on: unprefixed notes and unprefixed subfolders are ignored, and block same-titled pulls", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "The death of CAPTCHA?", "Remote");
  api.seed("d2", "Brand new from Medium", "Draft");
  vault.files.set(`${FOLDER}/Plain Note.md`, "Plain body");
  vault.files.set(`${FOLDER}/CIVIC/The death of CAPTCHA.md`, "Local");
  vault.files.set(`${FOLDER}/CIVIC/🟠 Prefixed in plain folder.md`, "x");
  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.equal(api.createCount, 0, "nothing uploaded");
  assert.equal(vault.files.has(`${FOLDER}/Plain Note.md`), true, "not renamed");
  assert.deepEqual(report.pulled, [`${FOLDER}/${ORANGE_PREFIX}Brand new from Medium.md`], "unmatched TK note pulled as 🟠");
  assert.equal(state.links["d1"], undefined, "CAPTCHA not pulled: an ignored note has that title");
});

test("traffic lights on: a 🟠 subfolder passes its colour to an unprefixed note inside", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "The Ultimate Starter Guide to 3D Printing", "Body");
  const path = `${FOLDER}/🟠 The Ultimate Starter Guide to 3D Printing/The Ultimate Starter Guide to 3D Printing.md`;
  vault.files.set(path, "Body\n");
  vault.files.set(`${FOLDER}/🟠 Folder/🟢 Final inside.md`, "Final");
  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.equal(state.links["d1"].path, path, "linked by title, no duplicate");
  assert.equal(api.createCount, 0, "own 🟢 prefix overrides the folder's 🟠");
  assert.deepEqual(report.pulled, []);
});

test("traffic lights on: already-prefixed file keeps its exact spacing (never re-renamed)", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  const path = `${FOLDER}/🟢  Double Space.md`; // two spaces, as in the owner's real vault
  vault.files.set(path, "Body");
  await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.equal(vault.files.has(path), true, "untouched");
});

test("traffic lights on: push and create strip the prefix from the title sent to TK", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Original body");
  vault.files.set(`${FOLDER}/🟠 Hello.md`, "Edited body");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/🟠 Hello.md`, localHash: await sha256Hex("Original body"), remoteUpdatedAt: "t1" };

  const { report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown, trafficLights: true });

  assert.deepEqual(report.pushed, [`${FOLDER}/🟠 Hello.md`]);
  assert.equal(api.docs.get("d1")!.meta.title, "Hello", "title sent to TK has no prefix");
});

test("traffic lights on: a note pulled from TK is written with a '🟠 ' prefix", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "My New Note", "Some body");
  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.deepEqual(report.pulled, [`${FOLDER}/${ORANGE_PREFIX}My New Note.md`]);
  assert.equal(state.links["d1"].path, `${FOLDER}/${ORANGE_PREFIX}My New Note.md`);
});

test("traffic lights on: a 🔴 linked file is frozen (no push, no pull), link kept", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Remote edited body");
  vault.files.set(`${FOLDER}/🔴 Hello.md`, "Local edited body");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/🔴 Hello.md`, localHash: await sha256Hex("Original body"), remoteUpdatedAt: "stale" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown, trafficLights: true });

  assert.deepEqual(report, { pulled: [], pushed: [], created: [], conflicts: [], trashed: [], skipped: [], errors: [] });
  assert.equal(vault.files.get(`${FOLDER}/🔴 Hello.md`), "Local edited body", "local untouched");
  assert.equal(api.docs.get("d1")!.body, "Remote edited body", "remote untouched");
  assert.deepEqual(next.links["d1"], state.links["d1"], "link unchanged");
});

test("traffic lights on: a 🔴 file with an unlinked local file is never created in TK", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  vault.files.set(`${FOLDER}/🔴 Draft.md`, "Draft body");
  const { report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.deepEqual(report.created, []);
  assert.equal(api.createCount, 0);
  assert.equal(vault.files.get(`${FOLDER}/🔴 Draft.md`), "Draft body", "untouched, not renamed");
});

test("traffic lights on: a 🔴 doc deleted in TK while paused still follows the trash rule", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d2", "Keep", "Keep body");
  vault.files.set(`${FOLDER}/🟠 Keep.md`, "Keep body");
  const path = `${FOLDER}/🔴 Hello.md`;
  const hash = await sha256Hex("Unchanged body");
  vault.files.set(path, "Unchanged body");
  const state = emptyState();
  state.links["d1"] = { path, localHash: hash, remoteUpdatedAt: "t1" };
  state.links["d2"] = { path: `${FOLDER}/🟠 Keep.md`, localHash: await sha256Hex("Keep body"), remoteUpdatedAt: "t1" };

  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown, trafficLights: true });

  assert.deepEqual(report.trashed, [path]);
  assert.equal(next.links["d1"], undefined);
  assert.equal(vault.files.has(path), false);
});

test("traffic lights on: 🟢 file matching an unlinked TK doc blocks the pull (no duplicate), stays unlinked", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Same Title", "Remote body");
  vault.files.set(`${FOLDER}/🟢 Same Title.md`, "Final local body");

  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });

  assert.deepEqual(report.pulled, []);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.conflicts, []);
  assert.ok(report.skipped.some((s) => s.reason.includes("🟢 final edition")));
  assert.equal(Object.keys(state.links).length, 0, "neither side linked");
  assert.equal(vault.files.get(`${FOLDER}/🟢 Same Title.md`), "Final local body", "local untouched");
  assert.equal(api.docs.get("d1")!.body, "Remote body", "remote untouched, not overwritten");

  // second sync: still no-op, not added to `ignored` either.
  const again = await sync({ api, vault, folder: FOLDER, state, toMarkdown, trafficLights: true });
  assert.deepEqual(again.report.pulled, []);
  assert.deepEqual(again.state.ignored, []);
});

test("traffic lights on: 🔴 file matching an unlinked TK doc blocks the pull too", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Paused Title", "Remote body");
  vault.files.set(`${FOLDER}/🔴 Paused Title.md`, "Local body");

  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });

  assert.deepEqual(report.pulled, []);
  assert.deepEqual(report.created, []);
  assert.ok(report.skipped.some((s) => s.reason.includes("🔴 note")));
  assert.equal(Object.keys(state.links).length, 0);
});

test("traffic lights on: 🟢 file with no TK match creates nothing in TK", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  vault.files.set(`${FOLDER}/🟢 Published Already.md`, "Final body");
  const { report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.deepEqual(report.created, []);
  assert.equal(api.createCount, 0);
});

test("traffic lights on: linked file switched to 🟢 is frozen; switched back to 🟠 syncs again", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Hello", "Original body");
  vault.files.set(`${FOLDER}/🟠 Hello.md`, "Original body");
  let state = emptyState();
  state.links["d1"] = { path: `${FOLDER}/🟠 Hello.md`, localHash: await sha256Hex("Original body"), remoteUpdatedAt: "t1" };

  // User renames the file to 🟢 and edits both sides; nothing should move while frozen.
  await vault.rename(`${FOLDER}/🟠 Hello.md`, `${FOLDER}/🟢 Hello.md`);
  state = renamePath(state, `${FOLDER}/🟠 Hello.md`, `${FOLDER}/🟢 Hello.md`);
  vault.files.set(`${FOLDER}/🟢 Hello.md`, "Locally edited while frozen");
  api.bumpRemote("d1", "Remotely edited while frozen");

  const frozen = await sync({ api, vault, folder: FOLDER, state, toMarkdown, trafficLights: true });
  assert.deepEqual(frozen.report, { pulled: [], pushed: [], created: [], conflicts: [], trashed: [], skipped: [], errors: [] });
  assert.equal(vault.files.get(`${FOLDER}/🟢 Hello.md`), "Locally edited while frozen");
  assert.equal(api.docs.get("d1")!.body, "Remotely edited while frozen");

  // Switch back to 🟠: normal diffing resumes and the local edit (newer) wins as a push... but
  // both sides differ from the stale link, so this is a conflict, not silently dropped.
  await vault.rename(`${FOLDER}/🟢 Hello.md`, `${FOLDER}/🟠 Hello.md`);
  let resumed = renamePath(frozen.state, `${FOLDER}/🟢 Hello.md`, `${FOLDER}/🟠 Hello.md`);
  const after = await sync({ api, vault, folder: FOLDER, state: resumed, toMarkdown, trafficLights: true });
  assert.equal(after.report.conflicts.length, 1, "both sides changed while frozen, so this is a conflict");
  assert.equal(vault.files.get(`${FOLDER}/🟠 Hello.md`), "Locally edited while frozen", "local untouched");
});


test("title matching ignores case, spaces and punctuation (real duplicate: Darkside vs Dark Side?)", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Did Liquid Glass Push Me to the Dark Side?", "Body");
  api.seed("d2", "Was the internet ever great or was it just my ADHD?", "Final");
  vault.files.set(`${FOLDER}/\u{1F7E0} Did Liquid Glass push me to the Darkside.md`, "Body\n");
  vault.files.set(`${FOLDER}/\u{1F7E2}  Was the internet ever great or was it just my ADHD.md`, "Final\n");
  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, trafficLights: true });
  assert.equal(api.createCount, 0, "no duplicate created in TK");
  assert.deepEqual(report.pulled, [], "nothing pulled alongside the local copies");
  assert.equal(next.links["d1"].path, `${FOLDER}/\u{1F7E0} Did Liquid Glass push me to the Darkside.md`);
  assert.equal(next.links["d2"], undefined, "green stays unlinked");
});

test("relinking ignores TK's whitespace normalisation (trailing spaces, extra blank lines)", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Apple", "One.\n\nTwo.");
  vault.files.set(`${FOLDER}/Apple.md`, "One. \n\n\n\nTwo.\n\n");
  const { report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown });
  assert.deepEqual(report.conflicts, []);
  assert.equal(api.createCount, 0);
});

test("relinking ignores a leading '# <title>' heading that TK keeps as the title", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Apple have been lying to us", "One.");
  vault.files.set(`${FOLDER}/Apple have been lying to us.md`, "# Apple have been lying to us\n\nOne.\n");
  vault.files.set(`${FOLDER}/Other.md`, "# Different heading\n\nTwo.\n");
  api.seed("d2", "Other", "Two.");
  const { report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, now: fixedNow(2024, 1, 15, 9, 30) });
  assert.deepEqual(report.conflicts, [`${FOLDER}/Other (TK conflict 2024-01-15 0930).md`], "only a title heading is ignored");
});

test("never duplicates: two local files with one TK title, and two TK notes with one title", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Did Liquid Glass Push Me to the Dark Side?", "Body");
  api.seed("d2", "Everything is too complicated", "A");
  api.seed("d3", "Everything is too complicated", "B");
  vault.files.set(`${FOLDER}/Did Liquid Glass push me to the Darkside.md`, "Body\n");
  vault.files.set(`${FOLDER}/Did Liquid Glass Push Me to the Dark Side.md`, "Body\n");
  const { state, report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown });
  assert.equal(api.createCount, 0, "second local file is not uploaded as a new TK note");
  assert.equal(report.pulled.length, 1, "only one of the same-titled TK notes is downloaded");
  assert.ok(state.links["d1"]);
  const again = await sync({ api, vault, folder: FOLDER, state, toMarkdown });
  assert.equal(api.createCount + again.report.pulled.length, 0);
});

test("relinking ignores equivalent Markdown spellings (*x* vs _x_, __x__ vs **x**, * vs - bullets)", async () => {
  const vault = new FakeVault();
  const api = new FakeApi();
  api.seed("d1", "Glass", "Am I _really_ sure? It is **bold**.\n\n- one\n- two");
  vault.files.set(`${FOLDER}/Glass.md`, "# Glass\n\nAm I *really* sure? It is __bold__.\n\n* one\n* two\n");
  api.seed("d2", "Changed", "Am I _really_ sure?");
  vault.files.set(`${FOLDER}/Changed.md`, "Am I *truly* sure?\n");
  const { report } = await sync({ api, vault, folder: FOLDER, state: emptyState(), toMarkdown, now: fixedNow(2024, 1, 15, 9, 30) });
  assert.deepEqual(report.conflicts, [`${FOLDER}/Changed (TK conflict 2024-01-15 0930).md`], "real word changes still conflict");
});
