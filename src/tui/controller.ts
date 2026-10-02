// The UI thread's state: which view is showing, the view models the Worker last sent, the
// account scope, overlays and the ingest status. Keys and Worker messages go in; React
// renders what comes out. It never queries the store (that is the view-model Worker's
// job) and does no I/O itself: saving config and talking to Workers go through `Ports`.

import { type Config, WINDOW_CHOICES } from "../config.ts";
import type { McpActivity } from "../mcp/heartbeat.ts";
import {
  initialSettings,
  SETTINGS_ROWS,
  type SettingsState,
  settingsKey,
  toggleEnabled,
  toggleHistoryOnly,
} from "./settings.ts";
import { VIEWS } from "./views/index.ts";
import { type ViewCommand, viewAnswer } from "./views/types.ts";
import {
  type AccountInfo,
  type IngestMode,
  type RootInfo,
  VIEW_IDS,
  type ViewId,
  type ViewModels,
  type VmMessage,
  type VmSettings,
  vmSettingsOf,
} from "./vm/types.ts";

export type Overlay = "none" | "help" | "settings";

/** Ingest as the header reports it: live only when this process ingests and is caught up. */
export type IngestStatus = "starting" | "live" | "error";

export interface UiState {
  readonly view: ViewId;
  readonly views: ViewModels;
  readonly viewState: Readonly<Record<ViewId, unknown>>;
  readonly accounts: readonly AccountInfo[];
  readonly scope: number | null;
  readonly config: Config;
  readonly mode: IngestMode;
  readonly ingest: IngestStatus;
  readonly mcp: McpActivity | null;
  readonly overlay: Overlay;
  readonly settings: SettingsState;
  readonly roots: readonly RootInfo[];
  /** A problem to show above the view (the store can't be read, settings not saved). */
  readonly error: string | null;
  /**
   * Set while the view-model Worker is down (it died and is restarting): the numbers on
   * screen have stopped updating. One clean line.
   */
  readonly vmDown: string | null;
  /** Set while the ingest Worker is down and restarting. One clean line. */
  readonly ingestDown: string | null;
  /** Why this process is read-only when no other process holds the lock. */
  readonly readOnlyReason: string | null;
}

export interface Key {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
}

export interface Ports {
  /** Saves config; throws if it can't. */
  saveConfig(config: Config): void;
  /** View-model settings changed (zone, window, scope). */
  vmSettings(settings: VmSettings): void;
  /** The roots in config changed (enable, rename, history-only). */
  vmConfig(config: Config): void;
  /** The settings screen opened: rediscover roots for its account list. */
  vmRoots(): void;
  /** Settings closed after account edits: ingest should restart with the new config. */
  accountsEdited(): void;
  quit(): void;
}

/**
 * A key as views and the global keys see it: a printable one as typed ("W", "/"), so a
 * shifted letter is its own key; any other by name ("return", "up", "space").
 */
export function typedName(key: Key): string {
  const printable = key.sequence.length === 1 && key.sequence > " " && key.sequence !== "\u007f";
  return printable ? key.sequence : key.name;
}

export function initialState(config: Config, mode: IngestMode): UiState {
  return {
    view: "overview",
    views: {},
    viewState: Object.fromEntries(VIEW_IDS.map((id) => [id, VIEWS[id].initial])) as Record<
      ViewId,
      unknown
    >,
    accounts: [],
    scope: null,
    config,
    mode,
    ingest: "starting",
    mcp: null,
    overlay: "none",
    settings: initialSettings(),
    roots: [],
    error: null,
    vmDown: null,
    ingestDown: null,
    readOnlyReason: null,
  };
}

const VIEW_KEYS: Readonly<Record<string, ViewId>> = {
  "1": "overview",
  "2": "history",
  "3": "models",
  "4": "accounts",
};

export class Controller {
  #state: UiState;
  readonly #ports: Ports;
  readonly #listeners = new Set<() => void>();
  #accountsEdited = false;
  /** Settings opened on a rename from a view: finishing it goes back to the view. */
  #renameFromView = false;
  /** performance.now() of the last view-switch key, until its frame is drawn. */
  switchStartedAt: number | null = null;
  readonly zones: readonly string[];
  readonly systemZone: string;

  constructor(
    state: UiState,
    ports: Ports,
    systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {
    this.#state = state;
    this.#ports = ports;
    this.systemZone = systemZone;
    this.zones = ["system", ...Intl.supportedValuesOf("timeZone")];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getState = (): UiState => this.#state;

  #set(patch: Partial<UiState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  // ── Worker and runtime events ──────────────────────────────────────────────────

  vmMessage(message: VmMessage): void {
    if (message.type === "views") {
      this.#set({
        views: { ...this.#state.views, ...message.views },
        accounts: message.accounts,
        scope: message.scope,
        error: null,
        vmDown: null,
      });
    } else if (message.type === "mcp") {
      this.#set({ mcp: message.activity });
    } else if (message.type === "roots") {
      this.#set({ roots: message.roots });
    } else if (message.type === "error") {
      this.#set({ error: message.message });
    } else if (message.type === "down") {
      const s = Math.max(1, Math.round(message.retryInMs / 1000));
      this.#set({ vmDown: `view models stopped (${message.reason}); restarting in ${s} s` });
    }
  }

  setMode(mode: IngestMode): void {
    if (mode !== this.#state.mode) this.#set({ mode, ingest: "starting" });
  }

  setIngest(ingest: IngestStatus): void {
    if (ingest !== this.#state.ingest) this.#set({ ingest });
  }

  setIngestDown(text: string | null): void {
    if (text !== this.#state.ingestDown) this.#set({ ingestDown: text });
  }

  setReadOnlyReason(reason: string | null): void {
    this.#set({ readOnlyReason: reason });
  }

  // ── keys ─────────────────────────────────────────────────────────────────────

  key(key: Key): void {
    const s = this.#state;
    const name = typedName(key);
    if (key.ctrl && key.name === "c") {
      this.#ports.quit();
    } else if (s.overlay === "settings") {
      this.#settingsKey(key);
    } else if (s.overlay === "help") {
      if (name === "escape" || name === "?" || name === "q" || name === "return") {
        this.#set({ overlay: "none" });
      }
    } else if (VIEWS[s.view].capturing?.(s.viewState[s.view]) === true) {
      this.#viewKey(name);
    } else if (VIEW_KEYS[name] !== undefined) {
      const view = VIEW_KEYS[name] as ViewId;
      if (view !== s.view) {
        this.switchStartedAt = performance.now();
        this.#set({ view });
      }
    } else if (name === "q") {
      this.#ports.quit();
    } else if (name === "a") {
      this.#cycleScope();
    } else if (name === "s") {
      this.#ports.vmRoots();
      this.#set({ overlay: "settings", settings: initialSettings() });
    } else if (name === "?") {
      this.#set({ overlay: "help" });
    } else {
      this.#viewKey(name);
    }
  }

  /**
   * Hands a key to the active view (the key contract is described on `View`), and carries
   * out the command its answer may hold.
   */
  #viewKey(name: string): void {
    const s = this.#state;
    const answer = VIEWS[s.view].keys(name, s.viewState[s.view], s.views[s.view]);
    if (answer === undefined) return;
    const { state, command } = viewAnswer(answer);
    this.#set({ viewState: { ...s.viewState, [s.view]: state } });
    if (command !== null) this.#command(command);
  }

  #cycleScope(): void {
    const { accounts, scope } = this.#state;
    if (accounts.length === 0) return;
    const at = scope === null ? -1 : accounts.findIndex((a) => a.id === scope);
    this.#setScope(at + 1 >= accounts.length ? null : (accounts[at + 1] as AccountInfo).id);
  }

  #setScope(next: number | null): void {
    const { accounts, config } = this.#state;
    const label = next === null ? "all" : accounts.find((a) => a.id === next)?.label;
    if (label === undefined) return;
    const saved = { ...config, account_scope: label };
    this.#save(saved);
    this.#set({ scope: next, config: saved });
    this.#ports.vmSettings(vmSettingsOf(saved, next));
  }

  #command(command: ViewCommand): void {
    const s = this.#state;
    switch (command.type) {
      case "window": {
        const n = WINDOW_CHOICES.length;
        const at = WINDOW_CHOICES.indexOf(s.config.default_window);
        const window = WINDOW_CHOICES[(at + command.step + n) % n] as Config["default_window"];
        const config = { ...s.config, default_window: window };
        this.#save(config);
        this.#set({ config });
        this.#ports.vmSettings(vmSettingsOf(config, s.scope));
        return;
      }
      case "scope":
        // Asking for the scope already set goes back to every account.
        this.#setScope(command.account === s.scope ? null : command.account);
        return;
      case "settings":
        this.#ports.vmRoots();
        this.#set({
          overlay: "settings",
          settings: {
            screen: "accounts",
            cursor: SETTINGS_ROWS.indexOf("accounts"),
            pick: 0,
            message: null,
          },
        });
        return;
      case "root":
        this.#rootEdit(command);
        return;
    }
  }

  /** An account's root edited from a view, exactly as the settings account editor does it. */
  #rootEdit(command: Extract<ViewCommand, { type: "root" }>): void {
    const { roots, config } = this.#state;
    const pick = roots.findIndex((r) => r.identity === command.identity);
    const root = roots[pick];
    if (root === undefined) {
      this.#set({ error: `${command.label} has no root on this machine: nothing to change` });
      return;
    }
    if (command.edit === "rename") {
      this.#renameFromView = true;
      this.#set({
        overlay: "settings",
        settings: {
          screen: "rename",
          cursor: SETTINGS_ROWS.indexOf("accounts"),
          pick,
          text: root.label,
          message: null,
        },
      });
      return;
    }
    const after =
      command.edit === "enable" ? toggleEnabled(config, root) : toggleHistoryOnly(config, root);
    if (!this.#save(after)) return;
    this.#set({ config: after });
    this.#ports.vmConfig(after);
    this.#ports.accountsEdited();
  }

  #save(config: Config): boolean {
    try {
      this.#ports.saveConfig(config);
      return true;
    } catch (error) {
      this.#set({ error: `settings not saved: ${(error as Error).message}` });
      return false;
    }
  }

  #settingsKey(key: Key): void {
    const s = this.#state;
    const result = settingsKey(s.settings, key, {
      config: s.config,
      roots: s.roots,
      accounts: s.accounts,
      zones: this.zones,
      systemZone: this.systemZone,
    });
    if (result.accountsChanged) this.#accountsEdited = true;
    if (result.config !== undefined) {
      const before = s.config;
      const after = result.config;
      this.#save(after);
      this.#set({ config: after });
      if (after.time_zone !== before.time_zone || after.default_window !== before.default_window) {
        this.#ports.vmSettings(vmSettingsOf(after, s.scope));
      }
      if (result.accountsChanged) this.#ports.vmConfig(after);
    }
    // A rename started from a view ends back in it, saved or not.
    const back = this.#renameFromView && result.state?.screen !== "rename";
    if (back) this.#renameFromView = false;
    if (result.state === null || back) {
      this.#set({ overlay: "none", settings: initialSettings() });
      if (this.#accountsEdited) {
        this.#accountsEdited = false;
        this.#ports.accountsEdited();
      }
    } else {
      this.#set({ settings: result.state });
    }
  }
}
