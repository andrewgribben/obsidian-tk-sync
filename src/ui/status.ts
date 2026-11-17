// Status bar item for TK Sync. Obsidian API only.

import type { TkSyncHost } from "./settings.ts";

export type SyncStatusState =
  | { kind: "not-connected" }
  | { kind: "ready" }
  | { kind: "syncing" }
  | { kind: "synced"; at: Date }
  | { kind: "conflicts"; count: number }
  | { kind: "error"; message: string };

/** Wraps a plugin status bar item and renders one of the sync states. */
export class SyncStatus {
  private el: HTMLElement;
  private host: TkSyncHost;

  constructor(el: HTMLElement, host: TkSyncHost) {
    this.el = el;
    this.host = host;
    this.el.addClass("mod-clickable");
    this.el.setAttribute("role", "button");
    this.el.setAttribute("tabindex", "0");
    this.el.addEventListener("click", () => {
      void this.host.syncNow();
    });
    this.el.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        void this.host.syncNow();
      }
    });
    this.set({ kind: "not-connected" });
  }

  /** Shown only while the active file is inside the sync folder. */
  setVisible(visible: boolean): void {
    this.el.toggle(visible);
  }

  set(state: SyncStatusState): void {
    this.el.empty();
    const text = this.textFor(state);
    this.el.setText(text);
    this.el.setAttribute("aria-label", `${text}. Click to sync now.`);
  }

  private textFor(state: SyncStatusState): string {
    switch (state.kind) {
      case "not-connected":
        return "TK: not connected";
      case "ready":
        return "TK: not synced yet";
      case "syncing":
        return "TK: syncing…";
      case "synced": {
        const time = state.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `TK: synced ${time}`;
      }
      case "conflicts":
        return `TK: ${state.count} conflict${state.count === 1 ? "" : "s"}`;
      case "error":
        return "TK: error";
    }
  }
}
