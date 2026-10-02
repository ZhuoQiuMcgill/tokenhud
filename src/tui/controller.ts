// The UI thread's state: which view is showing, the view models the Worker last sent, the
// account scope, overlays and the ingest status. Keys and Worker messages go in; React
// renders what comes out. It never queries the store (that is the view-model Worker's
// job) and does no I/O itself: saving config and talking to Workers go through `Ports`.

import { type Config, WINDOW_CHOICES } from "../config.ts";
import type { McpActivity } from "../mcp/heartbeat.ts";
import { entryFor, GLOBAL_KEYS, HELP_KEYS, type Key, keyName, typedName } from "./keys.ts";
import {
  type MenuAction,
  type MenuState,
  type MenuTarget,
  menuItems,
  menuKey,
  menuRoot,
} from "./menu.ts";
import {
  initialSettings,
  SETTINGS_ROWS,
  type SettingsState,
  settingsCapturing,
  settingsKey,
  toggleEnabled,
  toggleHistoryOnly,
  unlinkRoot,
} from "./settings.ts";
import { VIEWS } from "./views/index.ts";
import { type ViewCommand, viewAnswer, viewKey } from "./views/types.ts";
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

export type { Key } from "./keys.ts";

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
  /** The action menu, over the view or the settings screen; null when closed. */
  readonly menu: MenuState | null;
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
  /** A newer release, from the once-a-day check (`update_check`), for the footer. */
  readonly update: string | null;
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
    menu: null,
    roots: [],
    error: null,
    vmDown: null,
    ingestDown: null,
    readOnlyReason: null,
    update: null,
  };
}

type RootEdit = Extract<ViewCommand, { type: "root" }>["edit"];

/**
 * The settings screen a root edit goes on to, the root being `pick` in the roots: the label
 * prompt for a rename, the list to pick from for a link (T16); null for an edit made at once.
 */
function editScreen(
  edit: RootEdit,
  pick: number,
  root: RootInfo,
  cursor: number,
): SettingsState | null {
  if (edit === "rename") return { screen: "rename", cursor, pick, text: root.label, message: null };
  if (edit === "link") return { screen: "link", cursor, pick, choice: 0, message: null };
  return null;
}

/** Whether settings have left the screens an edit goes on to: closed, or back to the list. */
function editEnded(state: SettingsState | null): boolean {
  return state?.screen !== "rename" && state?.screen !== "link";
}

/** The config an edit made at once leaves: the root switched on or off, marked, unlinked. */
function editedConfig(edit: RootEdit, config: Config, root: RootInfo): Config {
  if (edit === "enable") return toggleEnabled(config, root);
  if (edit === "history") return toggleHistoryOnly(config, root);
  return unlinkRoot(config, root);
}

export class Controller {
  #state: UiState;
  readonly #ports: Ports;
  readonly #listeners = new Set<() => void>();
  #accountsEdited = false;
  /** Settings opened on a rename or a link from a view: finishing it goes back to the view. */
  #editFromView = false;
  /** The sections the last frame drew of a view (`drawn`); unknown before one is drawn. */
  #drawn: { readonly view: ViewId; readonly ids: ReadonlySet<string> } | null = null;
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

  setUpdate(version: string | null): void {
    if (version !== this.#state.update) this.#set({ update: version });
  }

  // ── keys ─────────────────────────────────────────────────────────────────────

  /** Whether a text field has the keys: they come as typed, and WASD are letters. */
  #capturing(): boolean {
    const s = this.#state;
    if (s.menu !== null) return false;
    if (s.overlay === "settings") return settingsCapturing(s.settings);
    return s.overlay === "none" && VIEWS[s.view].capturing?.(s.viewState[s.view]) === true;
  }

  /** The key contract (keys.ts; described on `View`). */
  key(key: Key): void {
    const s = this.#state;
    if (key.ctrl && key.name === "c") {
      this.#ports.quit();
      return;
    }
    const name = this.#capturing() ? typedName(key) : keyName(key);
    if (s.menu !== null) {
      this.#menuKey(s.menu, name);
    } else if (s.overlay === "settings") {
      this.#settingsKey(name);
    } else if (s.overlay === "help") {
      if (entryFor(Object.values(HELP_KEYS), name) !== undefined) this.#set({ overlay: "none" });
    } else if (this.#capturing()) {
      this.#viewKey(name);
    } else {
      this.#globalKey(name);
    }
  }

  /** The global keys (keys.ts `GLOBAL_KEYS`); any other key goes to the view. */
  #globalKey(name: string): void {
    const s = this.#state;
    switch (entryFor(Object.values(GLOBAL_KEYS), name)) {
      case GLOBAL_KEYS.views:
        this.#switchTo(VIEW_IDS[Number(name) - 1] as ViewId);
        return;
      case GLOBAL_KEYS.next: {
        const n = VIEW_IDS.length;
        const at = VIEW_IDS.indexOf(s.view) + (name === "tab" ? 1 : -1);
        this.#switchTo(VIEW_IDS[(at + n) % n] as ViewId);
        return;
      }
      case GLOBAL_KEYS.scope:
        this.#cycleScope();
        return;
      case GLOBAL_KEYS.settings:
        this.#ports.vmRoots();
        this.#set({ overlay: "settings", settings: initialSettings() });
        return;
      case GLOBAL_KEYS.help:
        this.#set({ overlay: "help" });
        return;
      case GLOBAL_KEYS.quit:
        this.#ports.quit();
        return;
      default:
        this.#viewKey(name);
    }
  }

  /**
   * The renderer's report of the sections a frame drew of `view`: a key whose section is
   * left out does nothing (`KeyEntry.section`). Not state: it changes nothing on screen.
   */
  drawn(view: ViewId, ids: ReadonlySet<string>): void {
    this.#drawn = { view, ids };
  }

  #switchTo(view: ViewId): void {
    if (view === this.#state.view) return;
    this.switchStartedAt = performance.now();
    this.#set({ view });
  }

  /**
   * Hands a key to the active view (the key contract is described on `View`), and carries
   * out the command its answer may hold.
   */
  #viewKey(name: string): void {
    const s = this.#state;
    const drawn = this.#drawn?.view === s.view ? this.#drawn.ids : undefined;
    const answer = viewKey(VIEWS[s.view], name, s.viewState[s.view], s.views[s.view], drawn);
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
      case "open": {
        const to = VIEWS[command.view];
        const state = to.select?.(s.viewState[command.view], command.account);
        this.switchStartedAt = performance.now();
        this.#set({
          view: command.view,
          viewState: { ...s.viewState, [command.view]: state ?? s.viewState[command.view] },
        });
        return;
      }
      case "menu": {
        const account = s.accounts.find((a) => a.id === command.account);
        if (account === undefined) return;
        const { identity, label, provider, id } = account;
        this.#set({
          menu: { target: { identity, label, provider, account: id }, cursor: 0, from: "view" },
        });
        return;
      }
    }
  }

  // ── the action menu ──────────────────────────────────────────────────────────

  #menuKey(menu: MenuState, name: string): void {
    const { config, roots, scope } = this.#state;
    const items = menuItems(menu.target, { config, roots, scope });
    const { state, run } = menuKey(menu, name, items.length);
    this.#set({ menu: state });
    const item = run === undefined ? undefined : items[run];
    if (item !== undefined) this.#runMenu(menu, item.action);
  }

  /**
   * A menu item, run as the place the menu opened from always ran it: from a view, the
   * `scope` and `root` commands; from settings, the editor's own edits (saved now, ingest
   * restarted when settings close).
   */
  #runMenu(menu: MenuState, action: MenuAction): void {
    const { target } = menu;
    if (action === "scope") {
      if (target.account !== null) this.#command({ type: "scope", account: target.account });
      return;
    }
    if (menu.from === "view") {
      this.#command({ type: "root", identity: target.identity, label: target.label, edit: action });
      return;
    }
    const { roots, config, settings } = this.#state;
    const root = menuRoot(target, roots);
    if (root === undefined) return;
    const screen = editScreen(action, roots.indexOf(root), root, settings.cursor);
    if (screen !== null) {
      this.#set({ settings: screen });
      return;
    }
    const after = editedConfig(action, config, root);
    this.#save(after);
    this.#set({ config: after });
    this.#accountsEdited = true;
    this.#ports.vmConfig(after);
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
    const screen = editScreen(command.edit, pick, root, SETTINGS_ROWS.indexOf("accounts"));
    if (screen !== null) {
      this.#editFromView = true;
      this.#set({ overlay: "settings", settings: screen });
      return;
    }
    const after = editedConfig(command.edit, config, root);
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

  #settingsKey(name: string): void {
    const s = this.#state;
    const result = settingsKey(s.settings, name, {
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
    if (result.menu !== undefined) {
      const root = s.roots[result.menu];
      if (root !== undefined) {
        const account = s.accounts.find((a) => a.identity === root.identity)?.id ?? null;
        const target: MenuTarget = {
          identity: root.identity,
          label: root.label,
          provider: root.provider,
          account,
        };
        this.#set({ menu: { target, cursor: 0, from: "settings" } });
      }
    }
    // A rename or link started from a view ends back in it, made or not.
    const back = this.#editFromView && editEnded(result.state);
    if (back) this.#editFromView = false;
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
