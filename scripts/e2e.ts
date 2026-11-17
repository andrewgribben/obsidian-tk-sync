// Live end-to-end run of the real sync engine + client + converter against TK, with a plain
// directory standing in for the vault. Usage: node scripts/e2e.ts <scratch-dir> [editDocId]
// Pulls everything (read-only), checks a second sync is a no-op, then (if editDocId is given)
// edits that doc's local file, syncs (push) and checks the following sync is a no-op again.
// Tokens: spike/.tk-token.json, a local gitignored OAuth token file (never printed).
import { mkdir, readFile, readdir, rename, rm, writeFile, access } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import assert from "node:assert/strict";
import { emptyState, sync } from "../src/sync.ts";
import { docToMarkdown } from "../src/tiptap.ts";
import { TkClient } from "../src/tk-client.ts";
import type { HttpFn, SyncState, TkTokens, VaultIO } from "../src/types.ts";

const [root, editId] = process.argv.slice(2);
assert.ok(root, "usage: node scripts/e2e.ts <scratch-dir> [editDocId]");
const FOLDER = "TK";

const raw = JSON.parse(await readFile("spike/.tk-token.json", "utf8"));
let tokens: TkTokens = {
  client_id: raw.client_id,
  access_token: raw.access_token,
  refresh_token: raw.refresh_token,
  expires_at: raw.expires_at ?? (raw.obtained_at + raw.expires_in) * 1000,
};
const http: HttpFn = async (r) => {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
};
const api = new TkClient(http, () => tokens, async (t) => { tokens = t; });

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}
const vault: VaultIO = {
  listMarkdown: async (folder) => (await walk(join(root, folder))).map((p) => relative(root, p)),
  read: (p) => readFile(join(root, p), "utf8"),
  write: async (p, d) => { await mkdir(dirname(join(root, p)), { recursive: true }); await writeFile(join(root, p), d); },
  exists: (p) => access(join(root, p)).then(() => true, () => false),
  // No Obsidian trash here; a plain scratch-dir delete is close enough for this script.
  trash: (p) => rm(join(root, p)),
};

async function run(label: string, state: SyncState) {
  const { state: next, report } = await sync({ api, vault, folder: FOLDER, state, toMarkdown: docToMarkdown });
  const counts = Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.length]));
  console.log(label, JSON.stringify(counts), report.errors.length ? JSON.stringify(report.errors) : "");
  return { next, report };
}

const first = await run("sync 1 (initial pull):", emptyState());
assert.equal(first.report.errors.length, 0);
const second = await run("sync 2 (expect no-op):", first.next);
assert.equal(second.report.pulled.length + second.report.pushed.length + second.report.created.length, 0, "second sync must be a no-op");

if (editId) {
  const link = second.next.links[editId];
  assert.ok(link, "editDocId not linked");
  await writeFile(join(root, link.path), (await vault.read(link.path)) + "\nEdited locally by e2e.\n");
  const third = await run("sync 3 (expect 1 push):", second.next);
  assert.deepEqual(third.report.pushed, [link.path]);
  const fourth = await run("sync 4 (expect no-op):", third.next);
  assert.equal(fourth.report.pulled.length + fourth.report.pushed.length, 0, "post-push sync must be a no-op");
}
console.log("e2e OK");
