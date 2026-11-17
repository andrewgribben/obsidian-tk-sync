import { Notice, Plugin, TFile, normalizePath, requestUrl } from "obsidian";
import { signIn } from "./auth.ts";
import { emptyState, isConflictCopy, renamePath, sync } from "./sync.ts";
import { docToMarkdown } from "./tiptap.ts";
import { TkClient } from "./tk-client.ts";
import type { HttpFn, SyncReport, SyncState, TkTokens, VaultIO } from "./types.ts";
import { showSyncReport } from "./ui/notices.ts";
import { DEFAULT_SETTINGS, TkSyncSettingTab, type TkSyncHost, type TkSyncSettings } from "./ui/settings.ts";
import { SyncStatus } from "./ui/status.ts";

const AUTO_SYNC_DEBOUNCE_MS = 10_000;

interface PluginData {
  settings: TkSyncSettings;
  tokens: TkTokens | null;
  state: SyncState;
  lastSync: { at: string; report: SyncReport } | null;
  /** Folder the sync state belongs to; links from another folder would read as local deletes. */
  stateFolder?: string;
}

// requestUrl runs outside the renderer (no CORS); throw:false lets the client handle 401/404 itself.
const http: HttpFn = async (req) => {
  const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, text: res.text };
};

export default class TkSyncPlugin extends Plugin implements TkSyncHost {
  settings: TkSyncSettings = { ...DEFAULT_SETTINGS };
  private tokens: TkTokens | null = null;
  private state: SyncState = emptyState();
  private stateFolder = "";
  private last: { at: Date; report: SyncReport } | null = null;
  private syncing = false;
  // Renames seen while a sync runs; replayed onto its result so they are not lost.
  private renamesDuringSync: [string, string][] = [];
  // Paths this plugin wrote during the last sync; the next 'modify' event for one of them is our
  // own write settling, not a user edit, so it must not trigger another auto-sync.
  private writtenInLastSync = new Set<string>();
  private timer: number | null = null;
  private autoSyncTimer: number | null = null;
  private status!: SyncStatus;
  private client = new TkClient(
    http,
    () => this.tokens,
    async (t) => {
      this.tokens = t;
      await this.persist();
    },
  );

  async onload() {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.tokens = data.tokens ?? null;
    this.state = { ...emptyState(), ...data.state };
    this.stateFolder = data.stateFolder ?? this.settings.folder;
    this.last = data.lastSync ? { at: new Date(data.lastSync.at), report: data.lastSync.report } : null;

    this.status = new SyncStatus(this.addStatusBarItem(), this);
    this.refreshStatus();
    this.addSettingTab(new TkSyncSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync with TK now", callback: () => void this.syncNow() });
    // Forgets links and "deleted here" marks so the next sync relinks by title; deletes nothing.
    this.addCommand({ id: "reset-sync", name: "Reset sync", callback: () => void this.resetSync() });

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.syncing) this.renamesDuringSync.push([oldPath, file.path]);
        this.state = renamePath(this.state, oldPath, file.path);
        void this.persist();
        if (!this.syncing && file instanceof TFile && file.extension === "md" && this.inSyncFolder(file.path)) {
          this.scheduleAutoSync();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!this.syncing && file instanceof TFile && file.extension === "md" && this.inSyncFolder(file.path) && !isConflictCopy(file.path)) {
          this.scheduleAutoSync();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!this.inSyncFolder(file.path) || isConflictCopy(file.path)) return;
        if (this.syncing) return;
        if (this.writtenInLastSync.delete(file.path)) return; // our own write settling
        this.scheduleAutoSync();
      }),
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshStatusVisibility()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshStatusVisibility()));
    this.app.workspace.onLayoutReady(() => this.refreshStatusVisibility());

    this.schedule();
  }

  onunload() {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.autoSyncTimer !== null) window.clearTimeout(this.autoSyncTimer);
  }

  private async persist() {
    const data: PluginData = {
      settings: this.settings,
      tokens: this.tokens,
      state: this.state,
      stateFolder: this.stateFolder,
      lastSync: this.last ? { at: this.last.at.toISOString(), report: this.last.report } : null,
    };
    await this.saveData(data);
  }

  async resetSync() {
    if (this.syncing) {
      new Notice("TK Sync: a sync is running; try again when it finishes.");
      return;
    }
    this.state = emptyState();
    this.last = null;
    await this.persist();
    this.refreshStatus();
    new Notice("TK Sync: reset. Run \"Sync with TK now\" to relink and download notes.");
  }

  async saveSettings() {
    // A new folder starts from fresh records; old links would otherwise mark every TK note
    // "deleted locally, never sync" and stop title matching, so 🟠 notes would be duplicated.
    if (this.settings.folder !== this.stateFolder) {
      this.state = emptyState();
      this.stateFolder = this.settings.folder;
    }
    await this.persist();
    this.schedule();
    this.refreshStatusVisibility();
  }

  private schedule() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.settings.autoSyncMinutes > 0) {
      this.timer = this.registerInterval(
        window.setInterval(() => void this.syncNow(), this.settings.autoSyncMinutes * 60_000),
      );
    }
  }

  private scheduleAutoSync() {
    if (!this.settings.syncOnSave) return;
    if (this.autoSyncTimer !== null) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.syncNow();
    }, AUTO_SYNC_DEBOUNCE_MS);
  }

  private inSyncFolder(path: string): boolean {
    const folder = normalizePath(this.settings.folder.trim());
    if (!folder || folder === "/") return false;
    return path.startsWith(folder + "/");
  }

  private refreshStatusVisibility() {
    const file = this.app.workspace.getActiveFile();
    this.status.setVisible(file !== null && this.inSyncFolder(file.path));
  }

  private refreshStatus() {
    if (!this.isConnected()) this.status.set({ kind: "not-connected" });
    else if (!this.last) this.status.set({ kind: "ready" });
    else if (this.last.report.conflicts.length) this.status.set({ kind: "conflicts", count: this.last.report.conflicts.length });
    else this.status.set({ kind: "synced", at: this.last.at });
    this.refreshStatusVisibility();
  }

  isConnected() {
    return this.tokens !== null;
  }

  lastSync() {
    return this.last;
  }

  async connect() {
    this.tokens = await signIn(http, (url) => window.open(url));
    await this.persist();
    this.refreshStatus();
  }

  async disconnect() {
    this.tokens = null;
    await this.persist();
    this.refreshStatus();
  }

  async syncNow() {
    if (this.syncing) return;
    if (!this.isConnected()) {
      new Notice("TK Sync: connect to TK in the plugin settings first.");
      return;
    }
    const folder = normalizePath(this.settings.folder.trim());
    // An empty or root folder would push the whole vault into TK.
    if (!folder || folder === "/") {
      new Notice("TK Sync: choose a folder in the plugin settings first.");
      return;
    }
    this.syncing = true;
    const startFolder = this.stateFolder;
    this.status.set({ kind: "syncing" });
    try {
      const { state, report } = await sync({
        api: this.client,
        vault: this.vaultIO(),
        folder,
        state: this.state,
        toMarkdown: docToMarkdown,
        trafficLights: this.settings.trafficLights,
      });
      // Folder changed mid-sync: this result belongs to the old folder, so drop it.
      this.state = startFolder !== this.stateFolder ? this.state
        : this.renamesDuringSync.reduce((s, [from, to]) => renamePath(s, from, to), state);
      this.writtenInLastSync = new Set([...report.pulled, ...report.created, ...report.conflicts]);
      this.last = { at: new Date(), report };
      await this.persist();
      this.refreshStatus();
      showSyncReport(this.app, report);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.status.set({ kind: "error", message });
      new Notice(`TK Sync failed: ${message}`);
    } finally {
      this.syncing = false;
      this.renamesDuringSync = [];
    }
  }

  private vaultIO(): VaultIO {
    const vault = this.app.vault;
    return {
      listMarkdown: async (folder) =>
        vault
          .getMarkdownFiles()
          .map((f) => f.path)
          .filter((p) => p.startsWith(folder + "/")),
      read: async (path) => {
        const f = vault.getFileByPath(path);
        if (!f) throw new Error(`File not found: ${path}`);
        return vault.read(f);
      },
      write: async (path, data) => {
        const f = vault.getAbstractFileByPath(path);
        if (f instanceof TFile) return vault.modify(f, data);
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
        await vault.create(path, data);
      },
      exists: async (path) => vault.getAbstractFileByPath(path) !== null,
      trash: async (path) => {
        const f = vault.getFileByPath(path);
        if (!f) return;
        await this.app.fileManager.trashFile(f);
      },
    };
  }
}
