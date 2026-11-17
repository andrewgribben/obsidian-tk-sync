// Settings tab for TK Sync. Obsidian API only; no custom colours or CSS.

import { App, Plugin, PluginSettingTab, Setting, AbstractInputSuggest, TFolder, Notice } from "obsidian";
import type { SyncReport } from "../types.ts";

export interface TkSyncSettings {
  folder: string;
  /** Minutes between automatic syncs; 0 = off. */
  autoSyncMinutes: number;
  /** Sync automatically ~10s after a note in the folder is edited, created or renamed into it. */
  syncOnSave: boolean;
  /** Filename prefixes '🔴 '/'🟠 '/'🟢 ' controlling whether and how a note is synced. See AGENTS.md. */
  trafficLights: boolean;
}

export const DEFAULT_SETTINGS: TkSyncSettings = {
  folder: "TK",
  autoSyncMinutes: 0,
  syncOnSave: true,
  trafficLights: false,
};

// These emoji are literal filename prefixes the feature looks for, not UI decoration.
// taste-skill-ignore
const TRAFFIC_LIGHT_HELP = "Only notes starting with \u{1F7E0} sync. \u{1F534}, \u{1F7E2} and unmarked notes are left alone.";

/**
 * The narrow surface the settings tab (and status bar) need from the plugin.
 * The coordinator's main.ts implements this.
 */
export interface TkSyncHost {
  app: App;
  settings: TkSyncSettings;
  saveSettings(): Promise<void>;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  syncNow(): Promise<void>;
  lastSync(): { at: Date; report: SyncReport } | null;
}

/** Suggests existing vault folders as the user types in the folder field. */
class FolderSuggest extends AbstractInputSuggest<string> {
  private onPick: (path: string) => void;

  constructor(app: App, textInputEl: HTMLInputElement, onPick: (path: string) => void) {
    super(app, textInputEl);
    this.onPick = onPick;
  }

  protected getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getAllFolders(true)
      .map((f: TFolder) => f.path)
      .filter((path) => path.toLowerCase().includes(q))
      .slice(0, 50);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value === "" ? "/" : value);
  }

  selectSuggestion(value: string): void {
    this.setValue(value);
    this.onPick(value);
    this.close();
  }
}

export class TkSyncSettingTab extends PluginSettingTab {
  plugin: Plugin & TkSyncHost;

  constructor(app: App, plugin: Plugin & TkSyncHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.render();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Account ---------------------------------------------------------
    const connected = this.plugin.isConnected();
    new Setting(containerEl)
      .setName("Account")
      .setDesc(connected ? "Connected." : "Not connected.")
      .addButton((btn) => {
        if (connected) {
          btn
            .setButtonText("Disconnect")
            .onClick(async () => {
              btn.setDisabled(true);
              try {
                await this.plugin.disconnect();
                new Notice("Disconnected from TK.");
              } catch (err) {
                new Notice(`Could not disconnect: ${(err as Error).message}`);
              } finally {
                this.render();
              }
            });
        } else {
          btn
            .setButtonText("Connect to TK")
            .setCta()
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText("Waiting for sign-in in your browser…");
              try {
                await this.plugin.connect();
                new Notice("Connected to TK.");
              } catch (err) {
                new Notice(`Could not connect to TK: ${(err as Error).message}`);
              } finally {
                this.render();
              }
            });
        }
      });

    // --- Folder ------------------------------------------------------------
    const folderSetting = new Setting(containerEl)
      .setName("Folder")
      .setDesc("Notes here sync with TK.")
      .addText((text) => {
        text.setValue(this.plugin.settings.folder).onChange(async (value) => {
          this.plugin.settings.folder = value.trim() || DEFAULT_SETTINGS.folder;
          await this.plugin.saveSettings();
        });
        new FolderSuggest(this.app, text.inputEl, async (path) => {
          this.plugin.settings.folder = path || DEFAULT_SETTINGS.folder;
          await this.plugin.saveSettings();
        });
      });
    folderSetting.settingEl.setAttribute("data-tk-setting", "folder");

    // --- Auto-sync -----------------------------------------------------
    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Sync in the background.")
      .addDropdown((dd) => {
        dd.addOption("0", "Off");
        dd.addOption("5", "Every 5 minutes");
        dd.addOption("15", "Every 15 minutes");
        dd.addOption("30", "Every 30 minutes");
        dd.addOption("60", "Every 60 minutes");
        dd.setValue(String(this.plugin.settings.autoSyncMinutes));
        dd.onChange(async (value) => {
          this.plugin.settings.autoSyncMinutes = Number(value);
          await this.plugin.saveSettings();
        });
      });

    // --- Sync on save ----------------------------------------------------
    new Setting(containerEl)
      .setName("Sync on save")
      .setDesc("Sync a few seconds after you edit a note.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
          this.plugin.settings.syncOnSave = value;
          await this.plugin.saveSettings();
        });
      });

    // --- Traffic lights ----------------------------------------------------
    new Setting(containerEl)
      .setName("Traffic lights")
      .setDesc(TRAFFIC_LIGHT_HELP)
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.trafficLights).onChange(async (value) => {
          this.plugin.settings.trafficLights = value;
          await this.plugin.saveSettings();
        });
      });

    // --- Sync now --------------------------------------------------------
    new Setting(containerEl)
      .setName("Sync now")
      .addButton((btn) => {
        btn.setButtonText("Sync now").setCta();
        btn.setDisabled(!connected);
        btn.onClick(async () => {
          btn.setDisabled(true);
          try {
            await this.plugin.syncNow();
          } catch (err) {
            new Notice(`Sync failed: ${(err as Error).message}`);
          } finally {
            this.render();
          }
        });
      });

    // --- Last sync ---------------------------------------------------------
    const last = this.plugin.lastSync();
    const lastSyncEl = containerEl.createDiv({ cls: "setting-item-description" });
    if (last) {
      const time = last.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const r = last.report;
      const counts: [number, string][] = [
        [r.pulled.length, "downloaded"], [r.pushed.length + r.created.length, "uploaded"],
        [r.conflicts.length, "conflicts"], [r.errors.length, "errors"],
      ];
      const parts = counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
      lastSyncEl.setText(`Last synced ${time}${parts.length ? `: ${parts.join(", ")}` : ""}.`);
    } else {
      lastSyncEl.setText("Not synced yet.");
    }
  }
}
