// The UI thread's state: which view is showing, the view models the Worker last sent, the
// account scope, overlays and the ingest status. Keys and Worker messages go in; React
// renders what comes out. It never queries the store (that is the view-model Worker's
// job) and does no I/O itself: saving config and talking to Workers go through `Ports`.

import type { Config } from "../config.ts";
import type { McpActivity } from "../mcp/heartbeat.ts";
import { initialSettings, type SettingsState, settingsKey } from "./settings.ts";
import { VIEWS } from "./views/index.ts";
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
      });
    } else if (message.type === "mcp") {
      this.#set({ mcp: message.activity });
    } else if (message.type === "roots") {
      this.#set({ roots: message.roots });
    } else if (message.type === "error") {
      this.#set({ error: message.message });
    }
  }

  setMode(mode: IngestMode): void {
    if (mode !== this.#state.mode) this.#set({ mode, ingest: "starting" });
  }

  setIngest(ingest: IngestStatus): void {
    if (ingest !== this.#state.ingest) this.#set({ ingest });
  }

  setReadOnlyReason(reason: string | null): void {
    this.#set({ readOnlyReason: reason });
  }

  // ── keys ─────────────────────────────────────────────────────────────────────

  key(key: Key): void {
    const s = this.#state;
    if (key.ctrl && key.name === "c") {
      this.#ports.quit();
    } else if (s.overlay === "settings") {
      this.#settingsKey(key);
    } else if (s.overlay === "help") {
      if (key.name === "escape" || key.name === "?" || key.name === "q" || key.name === "return") {
        this.#set({ overlay: "none" });
      }
    } else if (VIEW_KEYS[key.name] !== undefined) {
      const view = VIEW_KEYS[key.name] as ViewId;
      if (view !== s.view) {
        this.switchStartedAt = performance.now();
        this.#set({ view });
      }
    } else if (key.name === "q") {
      this.#ports.quit();
    } else if (key.name === "a") {
      this.#cycleScope();
    } else if (key.name === "s") {
      this.#ports.vmRoots();
      this.#set({ overlay: "settings", settings: initialSettings() });
    } else if (key.name === "?") {
      this.#set({ overlay: "help" });
    } else {
      const next = VIEWS[s.view].keys(key.name, s.viewState[s.view], s.views[s.view]);
      if (next !== undefined) this.#set({ viewState: { ...s.viewState, [s.view]: next } });
    }
  }

  #cycleScope(): void {
    const { accounts, scope, config } = this.#state;
    if (accounts.length === 0) return;
    const at = scope === null ? -1 : accounts.findIndex((a) => a.id === scope);
    const next = at + 1 >= accounts.length ? null : (accounts[at + 1] as AccountInfo).id;
    const label =
      next === null ? "all" : (accounts.find((a) => a.id === next) as AccountInfo).label;
    const saved = { ...config, account_scope: label };
    this.#save(saved);
    this.#set({ scope: next, config: saved });
    this.#ports.vmSettings(vmSettingsOf(saved, next));
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
    if (result.state === null) {
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
