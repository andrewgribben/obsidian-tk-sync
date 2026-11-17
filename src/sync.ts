// Sync engine: two-way sync between a vault folder and TK.
// Pure module: no 'obsidian' import. TK access via TkApi, vault access via VaultIO,
// both injected so this runs under `node --test` with in-memory fakes.
//
// v1 shortcuts (agreed with owner):
// - TK title renames do not rename the local file (the link just keeps tracking the old path).
// - Tags are not synced.
// - Subfolder structure is not reflected in TK; new remote docs always land in the folder root.
//
// v2 additions:
// - Rule 1: a doc deleted in TK trashes the local file if it has no unsynced edits, otherwise
//   the file is kept and the user is told why (see the "remote missing" branch below).
// - Traffic-light filename/folder prefixes (optional, see lightOfPath/isPaused below).

import type {
  SyncState,
  SyncLink,
  SyncReport,
  TkApi,
  TkDoc,
  TkDocMeta,
  VaultIO,
} from "./types.ts";
import { TkSharedDocError } from "./types.ts";

export function emptyState(): SyncState {
  return { version: 1, links: {}, ignored: [], localOnly: [] };
}

// Matches conflict-copy file names, with an optional ' 2', ' 3', ... disambiguator.
const CONFLICT_RE = /\(TK conflict \d{4}-\d{2}-\d{2} \d{4}\)( \d+)?\.md$/;

export function isConflictCopy(path: string): boolean {
  return CONFLICT_RE.test(path);
}

function basenameNoExt(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// --- Traffic lights ----------------------------------------------------
// Filename-only prefixes: emoji + one or more spaces at the start of the basename. Codepoints
// are plain (no variation selector). Owner's real vault has both single- and double-space
// variants; any run of spaces counts as "already prefixed" so we never re-rename to normalise it.
export type TrafficLight = "red" | "orange" | "green";

const RED_EMOJI = "\u{1F534}"; // 🔴
const ORANGE_EMOJI = "\u{1F7E0}"; // 🟠
const GREEN_EMOJI = "\u{1F7E2}"; // 🟢
export const ORANGE_PREFIX = `${ORANGE_EMOJI} `;
const LIGHT_EMOJI: [string, TrafficLight][] = [
  [RED_EMOJI, "red"],
  [ORANGE_EMOJI, "orange"],
  [GREEN_EMOJI, "green"],
];

/** The light a basename is prefixed with, or null if unprefixed. */
export function trafficLightOf(basename: string): TrafficLight | null {
  for (const [emoji, light] of LIGHT_EMOJI) {
    if (!basename.startsWith(emoji)) continue;
    if (/^\s+/.test(basename.slice(emoji.length))) return light;
  }
  return null;
}

/** Strips a recognised emoji prefix and all the spaces after it. No-op if unprefixed. */
export function stripLightPrefix(basename: string): string {
  for (const [emoji] of LIGHT_EMOJI) {
    if (!basename.startsWith(emoji)) continue;
    const rest = basename.slice(emoji.length);
    const m = /^(\s+)/.exec(rest);
    if (m) return rest.slice(m[1].length);
  }
  return basename;
}

/** A note's light: its own filename prefix, else the prefix of the folder it sits in. Any
 * unprefixed subfolder between the sync folder and the note means the note is ignored (null). */
export function lightOfPath(path: string, folder: string): TrafficLight | null {
  const dirs = path.slice(folder.length + 1).split("/").slice(0, -1);
  let folderLight: TrafficLight | null = null;
  for (const d of dirs) {
    folderLight = trafficLightOf(d);
    if (!folderLight) return null;
  }
  return trafficLightOf(basenameNoExt(path)) ?? folderLight;
}

/**
 * Owner decision (2026-11-17), kept in this one spot so it is easy to change later:
 * only 🟠 syncs. 🔴, 🟢 (final edition) and no prefix are all "paused": a linked paused file is
 * frozen (no push, no pull), an unlinked one is never pushed or created, and a same-titled TK doc
 * is never pulled (see pausedTitleLight below), so no duplicate appears in the vault.
 */
function isPaused(light: TrafficLight | null): boolean {
  return light !== "orange";
}

function lightLabel(light: TrafficLight | null): string {
  return light === "green" ? "🟢 final edition" : light === "red" ? "🔴 note" : "note without a prefix";
}

/** Title to use with TK: the basename, minus the traffic-light prefix when that feature is on. */
function effectiveTitle(path: string, trafficLights: boolean): string {
  const base = basenameNoExt(path);
  return trafficLights ? stripLightPrefix(base) : base;
}

// A leading YAML frontmatter block: '---' line, body, closing '---' line, optional trailing newline.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[0], body: content.slice(m[0].length) };
}

function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

async function sha256Hex(content: string): Promise<string> {
  // Line endings are normalised so CRLF/LF churn never counts as an edit.
  const data = new TextEncoder().encode(content.replace(/\r\n/g, "\n"));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Strip characters illegal in filenames, leading dots, collapse whitespace, cap length. */
/** Loose key for matching a vault filename to a TK title: case, spaces and punctuation are
 * ignored, so "Darkside" matches "Dark Side?" and filename-unsafe characters do not matter. */
export function titleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function sanitiseTitle(title: string): string {
  let s = title.replace(/[/\\:*?"<>|]/g, "");
  s = s.replace(/^\.+/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || "Untitled";
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatConflictStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Finds a path under dir/base(ext) that doesn't already exist, adding ' 2', ' 3', ... as needed. */
async function findFreePath(vault: VaultIO, dir: string, base: string, ext: string): Promise<string> {
  let n = 0;
  while (true) {
    const candidate = n === 0 ? joinPath(dir, `${base}${ext}`) : joinPath(dir, `${base} ${n + 1}${ext}`);
    if (!(await vault.exists(candidate))) return candidate;
    n += 1;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function sync(opts: {
  api: TkApi;
  vault: VaultIO;
  folder: string;
  state: SyncState;
  toMarkdown: (doc: TkDoc) => string;
  now?: () => Date;
  /** Filename-prefix feature; see trafficLightOf/isPaused. Default off (= v1 behaviour). */
  trafficLights?: boolean;
}): Promise<{ state: SyncState; report: SyncReport }> {
  const { api, vault, folder, toMarkdown } = opts;
  const now = opts.now ?? (() => new Date());
  const trafficLights = opts.trafficLights ?? false;

  const report: SyncReport = {
    pulled: [],
    pushed: [],
    created: [],
    conflicts: [],
    trashed: [],
    skipped: [],
    errors: [],
  };

  // Work on copies throughout; opts.state is never mutated.
  const newLinks: Record<string, SyncLink> = {};
  for (const [id, link] of Object.entries(opts.state.links)) {
    newLinks[id] = { ...link };
  }
  const ignored = new Set(opts.state.ignored);
  const localOnly = new Set(opts.state.localOnly);

  // If this fails, nothing above has mutated any state yet; let it throw so the whole sync fails.
  const remoteList = await api.listDocuments();
  const remoteById = new Map<string, TkDocMeta>();
  for (const d of remoteList) remoteById.set(d.id, d);

  // Safety guard: if TK looks like it returned a truncated/empty list, stop before anything is
  // trashed. Nothing has been written anywhere yet at this point.
  {
    const linkedIds = Object.keys(opts.state.links);
    if (linkedIds.length > 0) {
      const missing = linkedIds.filter((id) => !remoteById.has(id));
      const emptyButLinksExist = remoteList.length === 0;
      const tooManyMissing = missing.length >= 3 && missing.length > linkedIds.length / 2;
      if (emptyButLinksExist || tooManyMissing) {
        throw new Error("TK returned far fewer notes than expected; sync stopped so no files are trashed");
      }
    }
  }

  const localPaths = await vault.listMarkdown(folder);
  const localPathSet = new Set(localPaths);


  // 1. Linked docs: deterministic order by local path.
  const linkEntries = Object.entries(newLinks).sort((a, b) => a[1].path.localeCompare(b[1].path));
  for (const [id, link] of linkEntries) {
    try {
      const fileExists = localPathSet.has(link.path);
      const remote = remoteById.get(id);

      if (!fileExists) {
        // Rule 4: user deleted the local file. Never re-pull this doc.
        delete newLinks[id];
        ignored.add(id);
        continue;
      }

      if (!remote) {
        // Rule 1: doc deleted in TK. Trash the file if it has no unsynced edits; otherwise keep
        // it (this applies even to a paused 🔴/🟢 file, per the owner).
        delete newLinks[id];
        const content = await vault.read(link.path);
        const hash = await sha256Hex(content);
        if (hash === link.localHash) {
          await vault.trash(link.path);
          report.trashed.push(link.path);
        } else {
          localOnly.add(link.path);
          report.skipped.push({ path: link.path, reason: "deleted in TK; kept because it has unsynced edits" });
        }
        continue;
      }

      if (trafficLights && isPaused(lightOfPath(link.path, folder))) {
        // Frozen: no push, no pull, link kept.
        continue;
      }

      const content = await vault.read(link.path);
      const hash = await sha256Hex(content);
      const localChanged = hash !== link.localHash;
      const remoteChanged = remote.updated_at !== link.remoteUpdatedAt;

      if (!localChanged && !remoteChanged) {
        continue;
      }

      if (remoteChanged && !localChanged) {
        // Remote only: pull, keeping the local frontmatter block.
        const doc = await api.getDocument(id);
        const md = toMarkdown(doc);
        const { frontmatter } = splitFrontmatter(content);
        const written = (frontmatter ?? "") + md;
        await vault.write(link.path, written);
        const newHash = await sha256Hex(written);
        newLinks[id] = { path: link.path, localHash: newHash, remoteUpdatedAt: doc.updated_at };
        report.pulled.push(link.path);
        continue;
      }

      if (localChanged && !remoteChanged) {
        // Local only: push.
        const title = effectiveTitle(link.path, trafficLights);
        const body = stripFrontmatter(content);
        try {
          const resp = await api.updateDocument(id, title, body);
          newLinks[id] = { path: link.path, localHash: hash, remoteUpdatedAt: resp.updated_at };
          report.pushed.push(link.path);
        } catch (e) {
          if (e instanceof TkSharedDocError) {
            report.skipped.push({ path: link.path, reason: "shared in TK; edit it there" });
          } else {
            throw e;
          }
        }
        continue;
      }

      // Both changed.
      newLinks[id] = await reconcile(id, link.path, content, link.localHash);
    } catch (e) {
      report.errors.push({ path: link.path, error: errorMessage(e) });
    }
  }

  /** Both sides differ from the last sync (or were never linked). Identical content just links;
   * otherwise the remote version is written alongside as a conflict copy and the local file is
   * left untouched. Remote is then 'seen' and `staleHash` is kept so the next sync pushes local. */
  async function reconcile(id: string, path: string, content: string, staleHash: string): Promise<SyncLink> {
    const doc = await api.getDocument(id);
    const md = toMarkdown(doc);
    // TK drops trailing spaces and collapses blank-line runs, and the converter writes `_x_`,
    // `**x**` and `- ` where the vault may have `*x*`, `__x__` or `* `: none of these are edits.
    const norm = (s: string) =>
      s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
        .replace(/__(\S(?:[^_\n]*\S)?)__/g, "**$1**")
        .replace(/(^|[^\w*])\*(?!\*)(\S(?:[^*\n]*\S)?)\*(?![\w*])/gm, "$1_$2_")
        .replace(/^(\s*)[*+] /gm, "$1- ");
    // A leading "# <title>" in the vault note is TK's title, which toMarkdown leaves out.
    const local = norm(stripFrontmatter(content)).replace(/^# (.*)(\n+|$)/, (h, t: string) =>
      titleKey(t) === titleKey(doc.title) ? "" : h);
    if (local === norm(md)) {
      return { path, localHash: await sha256Hex(content), remoteUpdatedAt: doc.updated_at };
    }
    const stamp = formatConflictStamp(now());
    const conflictPath = await findFreePath(vault, dirname(path), `${basenameNoExt(path)} (TK conflict ${stamp})`, ".md");
    await vault.write(conflictPath, md);
    report.conflicts.push(conflictPath);
    return { path, localHash: staleHash, remoteUpdatedAt: doc.updated_at };
  }

  // 2. Unlinked local files: create in TK. Skip conflict copies, localOnly files, and (when
  // traffic lights are on) paused 🔴/🟢 files, which are never pushed or created.
  // A file whose name matches an unlinked TK note's title is linked to it instead of creating a
  // duplicate (covers a create whose response was lost, and vaults that already hold TK exports).
  const unlinkedRemoteByTitle = new Map<string, string>();
  for (const d of remoteList) {
    if (newLinks[d.id] || ignored.has(d.id)) continue;
    const key = titleKey(d.title);
    if (!unlinkedRemoteByTitle.has(key)) unlinkedRemoteByTitle.set(key, d.id);
  }
  // Owner rule: never a duplicate. No upload when any TK note (linked or not) has the title, and
  // no download when any note in the folder already has it.
  const remoteKeys = new Set(remoteList.map((d) => titleKey(d.title)));
  const localKeys = new Set(
    localPaths.filter((p) => !isConflictCopy(p)).map((p) => titleKey(effectiveTitle(p, trafficLights))),
  );
  const linkedPaths = new Set(Object.values(newLinks).map((l) => l.path));
  const unlinkedLocal = localPaths
    .filter((p) => !linkedPaths.has(p) && !localOnly.has(p) && !isConflictCopy(p))
    .filter((p) => !(trafficLights && isPaused(lightOfPath(p, folder))))
    .sort((a, b) => a.localeCompare(b));

  for (const path of unlinkedLocal) {
    try {
      const content = await vault.read(path);
      const title = effectiveTitle(path, trafficLights);
      const matchId = unlinkedRemoteByTitle.get(titleKey(title));
      if (matchId) {
        unlinkedRemoteByTitle.delete(titleKey(title));
        newLinks[matchId] = await reconcile(matchId, path, content, "");
        continue;
      }
      if (remoteKeys.has(titleKey(title))) {
        report.skipped.push({ path, reason: "TK already has a note with this title; not uploaded" });
        continue;
      }
      const body = stripFrontmatter(content);
      const resp = await api.createDocument(title, body);
      const hash = await sha256Hex(content);
      newLinks[resp.id] = { path, localHash: hash, remoteUpdatedAt: resp.updated_at };
      report.created.push(path);
    } catch (e) {
      report.errors.push({ path, error: errorMessage(e) });
    }
  }

  // Paused local files that are not linked block a same-titled remote doc from being pulled (this
  // is what stops a duplicate once a note is marked 🔴/🟢). Not added to `ignored`: switching the
  // file back to 🟠 lets the normal title-match adoption above link it on the next sync.
  const pausedTitleLight = new Map<string, TrafficLight | null>();
  if (trafficLights) {
    for (const path of localPaths) {
      if (linkedPaths.has(path) || isConflictCopy(path)) continue;
      const light = lightOfPath(path, folder);
      if (isPaused(light)) {
        pausedTitleLight.set(titleKey(stripLightPrefix(basenameNoExt(path))), light);
      }
    }
  }

  // 3. Unlinked remote docs (not ignored): pull into the folder root.
  const linkedIds = new Set(Object.keys(newLinks));
  const unlinkedRemote = remoteList
    .filter((d) => !linkedIds.has(d.id) && !ignored.has(d.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const meta of unlinkedRemote) {
    try {
      if (trafficLights) {
        const key = titleKey(meta.title);
        if (pausedTitleLight.has(key)) {
          const pausedLight = pausedTitleLight.get(key)!;
          report.skipped.push({
            path: joinPath(folder, meta.title),
            reason: `matches a ${lightLabel(pausedLight)}; not synced`,
          });
          continue;
        }
      }
      if (localKeys.has(titleKey(meta.title))) {
        report.skipped.push({
          path: joinPath(folder, meta.title),
          reason: "a note with this title is already in the folder; not downloaded",
        });
        continue;
      }
      localKeys.add(titleKey(meta.title));
      const doc = await api.getDocument(meta.id);
      const md = toMarkdown(doc);
      const base = sanitiseTitle(meta.title);
      const prefixedBase = trafficLights ? `${ORANGE_PREFIX}${base}` : base;
      const path = await findFreePath(vault, folder, prefixedBase, ".md");
      await vault.write(path, md);
      const hash = await sha256Hex(md);
      newLinks[meta.id] = { path, localHash: hash, remoteUpdatedAt: doc.updated_at };
      report.pulled.push(path);
    } catch (e) {
      report.errors.push({ path: joinPath(folder, `${meta.title}`), error: errorMessage(e) });
    }
  }

  const finalLinks: Record<string, SyncLink> = {};
  for (const id of Object.keys(newLinks).sort()) finalLinks[id] = newLinks[id];

  const newState: SyncState = {
    version: 1,
    links: finalLinks,
    ignored: Array.from(ignored).sort(),
    localOnly: Array.from(localOnly).sort(),
  };

  return { state: newState, report };
}

/** Updates a persisted link/localOnly entry after Obsidian reports a file rename. */
export function renamePath(state: SyncState, oldPath: string, newPath: string): SyncState {
  const links: Record<string, SyncLink> = {};
  for (const [id, link] of Object.entries(state.links)) {
    links[id] = link.path === oldPath ? { ...link, path: newPath } : { ...link };
  }
  const localOnly = state.localOnly.map((p) => (p === oldPath ? newPath : p));
  return {
    version: 1,
    links,
    ignored: [...state.ignored],
    localOnly,
  };
}
