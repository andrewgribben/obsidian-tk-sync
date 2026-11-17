// Sync result notices for TK Sync. Obsidian API only.

import { Modal, Notice, App } from "obsidian";
import type { SyncReport } from "../types.ts";

/** Shows a concise Notice summarising a sync; a longer Notice or modal follows when there is more to say. */
export function showSyncReport(app: App, report: SyncReport): void {
  const parts: string[] = [];
  if (report.pulled.length) parts.push(`${report.pulled.length} pulled`);
  if (report.pushed.length) parts.push(`${report.pushed.length} pushed`);
  if (report.created.length) parts.push(`${report.created.length} created`);
  if (report.trashed.length) parts.push(`${report.trashed.length} trashed`);
  if (report.conflicts.length) parts.push(`${report.conflicts.length} conflicts`);
  if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
  if (report.errors.length) parts.push(`${report.errors.length} errors`);

  const summary = parts.length ? `TK sync: ${parts.join(", ")}.` : "TK sync: nothing to do.";
  new Notice(summary, 5000);

  if (report.conflicts.length || report.errors.length) {
    new SyncDetailModal(app, report).open();
  }
}

/** Lists conflict copy paths and error messages so the user can find and fix them. */
class SyncDetailModal extends Modal {
  private report: SyncReport;

  constructor(app: App, report: SyncReport) {
    super(app);
    this.report = report;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "TK sync details" });

    if (this.report.conflicts.length) {
      contentEl.createEl("h3", { text: "Conflicts" });
      contentEl.createEl("p", {
        text: "TK's version is saved next to your note.",
        cls: "setting-item-description",
      });
      const list = contentEl.createEl("ul");
      for (const path of this.report.conflicts) {
        list.createEl("li", { text: path });
      }
    }

    if (this.report.errors.length) {
      contentEl.createEl("h3", { text: "Errors" });
      const list = contentEl.createEl("ul");
      for (const err of this.report.errors) {
        list.createEl("li", { text: `${err.path}: ${err.error}` });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
