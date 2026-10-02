// The settings screen as a pure state machine, ported from cc-usage's keyboard-driven
// settings (settings_screen.py) and adapted: every value is picked from a list (w/s,
// Enter, Esc) or stepped in place (a/d), except an account's new label and the time-zone
// filter, which are typed. An account's edits are the action menu's (menu.ts), the same as
// the Accounts view's; its "Same account as…" (T16) picks the other root from a list here.
// Keys in, new state and config out; the shell saves and applies.

import {
  type Config,
  REFRESH_CHOICES,
  SYSTEM_TIME_ZONE,
  THEME_CHOICES,
  WINDOW_CHOICES,
} from "../config.ts";
import { entryFor, type KeyHelp, MOVE_KEYS, TEXT } from "./keys.ts";
import type { RootInfo } from "./vm/types.ts";

export type SettingsRow = "refresh" | "window" | "cost" | "theme" | "tz" | "update" | "accounts";
export const SETTINGS_ROWS: readonly SettingsRow[] = [
  "refresh",
  "window",
  "cost",
  "theme",
  "tz",
  "update",
  "accounts",
];

export const ROW_LABELS: Readonly<Record<SettingsRow, string>> = {
  refresh: "Refresh interval",
  window: "Default spend window",
  cost: "Show cost",
  theme: "Theme",
  tz: "Time zone",
  update: "Check for updates",
  accounts: "Accounts",
};

export const WINDOW_NAMES: Readonly<Record<string, string>> = {
  today: "today",
  this_week: "this week",
  this_month: "this month",
  all: "all-time",
  "1h": "last 1h",
  "5h": "last 5h",
  "24h": "last 24h",
};

export const MAX_LABEL = 24;

export interface Choice {
  readonly value: unknown;
  readonly label: string;
}

export type SettingsState =
  | { readonly screen: "main"; readonly cursor: number; readonly message: string | null }
  | {
      readonly screen: "choice";
      readonly cursor: number;
      readonly row: Exclude<SettingsRow, "tz" | "accounts">;
      readonly pick: number;
      readonly message: string | null;
    }
  | {
      readonly screen: "tz";
      readonly cursor: number;
      readonly filter: string;
      readonly pick: number;
      readonly message: string | null;
    }
  | {
      readonly screen: "accounts";
      readonly cursor: number;
      readonly pick: number;
      readonly message: string | null;
    }
  | {
      readonly screen: "rename";
      readonly cursor: number;
      readonly pick: number;
      readonly text: string;
      readonly message: string | null;
    }
  /** "same account as…": which root the picked one (`pick`) shares its account with. */
  | {
      readonly screen: "link";
      readonly cursor: number;
      readonly pick: number;
      /** Index in `linkCandidates`. */
      readonly choice: number;
      readonly message: string | null;
    };

/** Whether `screen` is a text field: its keys come as typed (WASD are letters there). */
export function settingsCapturing(state: SettingsState): boolean {
  return state.screen === "tz" || state.screen === "rename";
}

export interface SettingsInput {
  readonly config: Config;
  readonly roots: readonly RootInfo[];
  /** The store's accounts by display label, store-only ones (imported, old) included. */
  readonly accounts?: readonly { readonly label: string }[];
  /** "system" first, then the IANA zones on offer. */
  readonly zones: readonly string[];
  /** The zone "system" means, for display. */
  readonly systemZone: string;
}

export interface SettingsResult {
  /** The next state; null closes the screen. */
  readonly state: SettingsState | null;
  /** A changed config to save and apply. */
  readonly config?: Config;
  /** Roots were enabled, disabled, renamed, marked or linked: ingest should restart on close. */
  readonly accountsChanged?: boolean;
  /** Open the action menu for this root (an index into `roots`). */
  readonly menu?: number;
}

export function initialSettings(): SettingsState {
  return { screen: "main", cursor: 0, message: null };
}

export function choices(row: Exclude<SettingsRow, "tz" | "accounts">): readonly Choice[] {
  switch (row) {
    case "refresh":
      return REFRESH_CHOICES.map((s) => ({ value: s, label: `${s} s` }));
    case "window":
      return WINDOW_CHOICES.map((w) => ({ value: w, label: WINDOW_NAMES[w] ?? w }));
    case "cost":
    case "update":
      return [
        { value: true, label: "on" },
        { value: false, label: "off" },
      ];
    case "theme":
      return THEME_CHOICES.map((t) => ({ value: t, label: t }));
  }
}

function current(row: Exclude<SettingsRow, "tz" | "accounts">, config: Config): unknown {
  switch (row) {
    case "refresh":
      return config.refresh_interval;
    case "window":
      return config.default_window;
    case "cost":
      return config.show_cost;
    case "theme":
      return config.theme;
    case "update":
      return config.update_check;
  }
}

function withValue(
  row: Exclude<SettingsRow, "tz" | "accounts">,
  config: Config,
  value: unknown,
): Config {
  switch (row) {
    case "refresh":
      return { ...config, refresh_interval: value as number };
    case "window":
      return { ...config, default_window: value as Config["default_window"] };
    case "cost":
      return { ...config, show_cost: value as boolean };
    case "theme":
      return { ...config, theme: value as Config["theme"] };
    case "update":
      return { ...config, update_check: value as boolean };
  }
}

/** The value shown beside each row of the main list. */
export function rowValue(row: SettingsRow, input: SettingsInput): string {
  const { config } = input;
  switch (row) {
    case "tz":
      return config.time_zone === SYSTEM_TIME_ZONE
        ? `system (${input.systemZone})`
        : config.time_zone;
    case "accounts": {
      const enabled = input.roots.filter((r) => r.enabled).length;
      return `${enabled} of ${input.roots.length} enabled`;
    }
    default:
      return choices(row).find((c) => c.value === current(row, config))?.label ?? "";
  }
}

/** Zones whose name contains the filter, case-insensitively; "system" always matches "". */
export function filterZones(zones: readonly string[], filter: string): string[] {
  const f = filter.toLowerCase();
  return zones.filter((z) => z.toLowerCase().includes(f));
}

// ── account edits ────────────────────────────────────────────────────────────────

/**
 * Whether `config` switches the root off: its path (or an entry that named it when the
 * roots were discovered) in `disabled_roots`, or its config entry's `enabled: false`.
 * Read from the config, not from `root.enabled`, which is only as new as the last
 * discovery.
 */
export function rootDisabled(config: Config, root: RootInfo): boolean {
  const entries = root.provider === "claude" ? config.claude_roots : config.codex_roots;
  return (
    config.disabled_roots.some((raw) => raw === root.path || root.disabledBy.includes(raw)) ||
    (root.configIndex !== null && entries[root.configIndex]?.enabled === false)
  );
}

/**
 * Switches a root off (its path joins `disabled_roots`) or back on, by what the config says
 * now: pressing it twice before the roots are discovered again restores the config.
 */
export function toggleEnabled(config: Config, root: RootInfo): Config {
  if (!rootDisabled(config, root)) {
    return { ...config, disabled_roots: [...config.disabled_roots, root.path] };
  }
  const key = root.provider === "claude" ? "claude_roots" : "codex_roots";
  const entries = config[key].map((e, i) => {
    if (i !== root.configIndex || e.enabled !== false) return e;
    const { enabled: _, ...rest } = e;
    return rest;
  });
  return {
    ...config,
    disabled_roots: config.disabled_roots.filter(
      (raw) => raw !== root.path && !root.disabledBy.includes(raw),
    ),
    [key]: entries,
  };
}

export function toggleHistoryOnly(config: Config, root: RootInfo): Config {
  const list = config.history_only_roots;
  return {
    ...config,
    history_only_roots: list.includes(root.identity)
      ? list.filter((id) => id !== root.identity)
      : [...list, root.identity],
  };
}

/** Gives a root a configured label: its config entry's, or a new entry for its path. */
export function renameRoot(config: Config, root: RootInfo, label: string): Config {
  const key = root.provider === "claude" ? "claude_roots" : "codex_roots";
  const entries =
    root.configIndex === null
      ? [...config[key], { path: root.path, label }]
      : config[key].map((e, i) => (i === root.configIndex ? { ...e, label } : e));
  return { ...config, [key]: entries };
}

/**
 * Why `label` can't name `root`, or null when it can. Labels are unique across the roots
 * found here and every account in the store (critique m9): a store-only account keeps its
 * label, and the saved scope is a label.
 */
export function labelProblem(
  label: string,
  root: RootInfo,
  roots: readonly RootInfo[],
  accounts: readonly { readonly label: string }[] = [],
): string | null {
  if (label === "") return "a label can't be empty";
  if (label.length > MAX_LABEL) return `a label is at most ${MAX_LABEL} characters`;
  if (label.toLowerCase() === "all") return "'all' is reserved for the all-accounts scope";
  if (roots.some((r) => r !== root && r.label === label)) return `'${label}' is taken`;
  // The root's own account carries the root's current label.
  if (label !== root.label && accounts.some((a) => a.label === label)) {
    return `'${label}' is taken`;
  }
  return null;
}

// ── shared accounts (T16) ────────────────────────────────────────────────────────

/**
 * The roots `root` can be marked as sharing a subscription account with: the other enabled
 * roots of its provider not already on its account (a disabled root is in no group).
 */
export function linkCandidates(root: RootInfo, roots: readonly RootInfo[]): RootInfo[] {
  const linked = new Set(root.group?.others ?? []);
  return roots.filter(
    (r) =>
      r.enabled &&
      r.provider === root.provider &&
      r.identity !== root.identity &&
      !linked.has(r.identity),
  );
}

const pairOf = (entry: readonly string[], a: string, b: string) =>
  entry.includes(a) && entry.includes(b);

/** A root and the roots already on its account. */
const accountOf = (root: RootInfo) => [root.identity, ...(root.group?.others ?? [])];

/**
 * The `separate_accounts` pairs that keep `a`'s account and `b`'s apart: one root of each.
 * Linking the two drops them, since the two accounts are then one, roots and all.
 */
export function keptApart(config: Config, a: RootInfo, b: RootInfo): string[][] {
  const mine = accountOf(a);
  const theirs = accountOf(b);
  return config.separate_accounts.filter((p) =>
    mine.some((x) => theirs.some((y) => pairOf(p, x, y))),
  );
}

/**
 * `a` on the same subscription account as `b`: a `same_account` link (joining the entries
 * that already hold either), and no `separate_accounts` pair left between a root of `a`'s
 * account and one of `b`'s, which would keep them apart whichever way they are linked.
 */
export function linkRoots(config: Config, a: RootInfo, b: RootInfo): Config {
  const ids = [a.identity, b.identity];
  const holding = config.same_account.filter((e) => ids.some((id) => e.includes(id)));
  const merged = [...new Set([...holding.flat(), ...ids])];
  const apart = keptApart(config, a, b);
  return {
    ...config,
    same_account: [...config.same_account.filter((e) => !holding.includes(e)), merged],
    separate_accounts: config.separate_accounts.filter((p) => !apart.includes(p)),
  };
}

/**
 * `root` on its own account: out of every `same_account` entry, and a `separate_accounts`
 * pair with each root it was grouped with, so auto-detection doesn't link them again.
 */
export function unlinkRoot(config: Config, root: RootInfo): Config {
  const others = root.group?.others ?? [];
  const same = config.same_account
    .map((e) => e.filter((id) => id !== root.identity))
    .filter((e) => e.length >= 2);
  const added = others
    .filter((id) => !config.separate_accounts.some((p) => pairOf(p, root.identity, id)))
    .map((id) => [root.identity, id]);
  return {
    ...config,
    same_account: same,
    separate_accounts: [...config.separate_accounts, ...added],
  };
}

// ── keys ─────────────────────────────────────────────────────────────────────────

const PAGE: KeyHelp = {
  keys: ["pageup", "pagedown", "home", "end"],
  show: "pgup/pgdn",
  alias: "home/end",
  label: "page",
  does: "Move ten rows, or to the first or last",
  quiet: true,
};
const TYPE_BACK: KeyHelp = {
  keys: ["backspace"],
  show: "backspace",
  label: "delete",
  does: "Delete the last character",
  quiet: true,
};

const MAIN = {
  move: { ...MOVE_KEYS.select, label: "move", does: "Move" },
  step: {
    ...MOVE_KEYS.tabs,
    label: "change",
    does: "Step the selected setting's value in place (not the time zone or accounts)",
  },
  open: { ...MOVE_KEYS.open, label: "open", does: "Open the selected setting's list" },
  close: {
    keys: ["escape", "x", "q"],
    show: "esc",
    alias: "x",
    label: "close",
    does: "Back to the view",
  },
  page: PAGE,
} as const satisfies Record<string, KeyHelp>;

const PICK = {
  move: { ...MOVE_KEYS.select, label: "move", does: "Move" },
  pick: { ...MOVE_KEYS.open, label: "select", does: "Pick the value" },
  back: { keys: ["escape", "q"], show: "esc", label: "back", does: "Back to the list" },
  page: PAGE,
} as const satisfies Record<string, KeyHelp>;

const ZONE = {
  type: { keys: [TEXT], show: "type", label: "to filter", does: "Filter the zones" },
  move: { keys: ["up", "down"], show: "↑/↓", label: "move", does: "Move" },
  pick: { ...MOVE_KEYS.open, label: "select", does: "Pick the zone" },
  back: { ...MOVE_KEYS.back, label: "back", does: "Back to the list" },
  erase: TYPE_BACK,
  page: PAGE,
} as const satisfies Record<string, KeyHelp>;

const ACCOUNTS = {
  move: { ...MOVE_KEYS.select, label: "move", does: "Select a root" },
  open: { ...MOVE_KEYS.open, label: "actions", does: "Open the root's action menu" },
  back: { keys: ["escape", "q"], show: "esc", label: "back", does: "Back to the list" },
  page: PAGE,
} as const satisfies Record<string, KeyHelp>;

const LINK = {
  move: { ...MOVE_KEYS.select, label: "move", does: "Select the root it shares its account with" },
  pick: { ...MOVE_KEYS.open, label: "link", does: "Link the two" },
  cancel: { keys: ["escape", "q"], show: "esc", label: "cancel", does: "Back to the list" },
  page: PAGE,
} as const satisfies Record<string, KeyHelp>;

const RENAME = {
  type: { keys: [TEXT], show: "type", label: "a label", does: "Type the new label" },
  save: { ...MOVE_KEYS.open, label: "save", does: "Save the label" },
  cancel: { ...MOVE_KEYS.back, label: "cancel", does: "Keep the label as it was" },
  erase: TYPE_BACK,
} as const satisfies Record<string, KeyHelp>;

/** Each screen's keys, in the footer's order; a key its screen doesn't list does nothing. */
export const SETTINGS_KEYS: Readonly<Record<SettingsState["screen"], readonly KeyHelp[]>> = {
  main: Object.values(MAIN),
  choice: Object.values(PICK),
  tz: Object.values(ZONE),
  accounts: Object.values(ACCOUNTS),
  link: Object.values(LINK),
  rename: Object.values(RENAME),
};

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

function move(key: string, pick: number, count: number): number {
  if (key === "up") return clamp(pick - 1, count - 1);
  if (key === "down") return clamp(pick + 1, count - 1);
  if (key === "pageup") return clamp(pick - 10, count - 1);
  if (key === "pagedown") return clamp(pick + 10, count - 1);
  if (key === "home") return 0;
  return Math.max(0, count - 1);
}

/**
 * The settings screen's answer to `key`, named as the shell names it (keys.ts `keyName`;
 * `typedName` while a text field has the keys, `settingsCapturing`).
 */
export function settingsKey(
  state: SettingsState,
  key: string,
  input: SettingsInput,
): SettingsResult {
  const { config, roots } = input;
  const entry = entryFor(SETTINGS_KEYS[state.screen], key);
  switch (state.screen) {
    case "main": {
      if (entry === MAIN.close) return { state: null };
      if (entry === MAIN.move || entry === MAIN.page) {
        return {
          state: { ...state, cursor: move(key, state.cursor, SETTINGS_ROWS.length), message: null },
        };
      }
      const row = SETTINGS_ROWS[state.cursor] as SettingsRow;
      if (entry === MAIN.step) {
        if (row === "tz" || row === "accounts") return { state };
        const list = choices(row);
        const at = list.findIndex((c) => c.value === current(row, config));
        const next = list[(at + (key === "right" ? 1 : -1) + list.length) % list.length];
        return {
          state: { ...state, message: null },
          config: withValue(row, config, (next as Choice).value),
        };
      }
      if (entry !== MAIN.open) return { state };
      if (row === "accounts")
        return { state: { screen: "accounts", cursor: state.cursor, pick: 0, message: null } };
      if (row === "tz") {
        const at = input.zones.indexOf(config.time_zone);
        return {
          state: {
            screen: "tz",
            cursor: state.cursor,
            filter: "",
            pick: Math.max(0, at),
            message: null,
          },
        };
      }
      const list = choices(row);
      const at = list.findIndex((c) => c.value === current(row, config));
      return {
        state: {
          screen: "choice",
          cursor: state.cursor,
          row,
          pick: Math.max(0, at),
          message: null,
        },
      };
    }
    case "choice": {
      const list = choices(state.row);
      if (entry === PICK.back)
        return { state: { screen: "main", cursor: state.cursor, message: null } };
      if (entry === PICK.move || entry === PICK.page) {
        return { state: { ...state, pick: move(key, state.pick, list.length) } };
      }
      if (entry !== PICK.pick) return { state };
      const choice = list[state.pick] as Choice;
      return {
        state: { screen: "main", cursor: state.cursor, message: null },
        config: withValue(state.row, config, choice.value),
      };
    }
    case "tz": {
      const shown = filterZones(input.zones, state.filter);
      if (entry === ZONE.back)
        return { state: { screen: "main", cursor: state.cursor, message: null } };
      if (entry === ZONE.move || entry === ZONE.page) {
        return { state: { ...state, pick: move(key, state.pick, shown.length) } };
      }
      if (entry === ZONE.erase) {
        return { state: { ...state, filter: state.filter.slice(0, -1), pick: 0 } };
      }
      if (entry === ZONE.pick) {
        const zone = shown[state.pick];
        if (zone === undefined) return { state: { ...state, message: "no zone matches" } };
        return {
          state: { screen: "main", cursor: state.cursor, message: null },
          config: { ...config, time_zone: zone },
        };
      }
      if (entry === ZONE.type) {
        return { state: { ...state, filter: state.filter + typed(key), pick: 0, message: null } };
      }
      return { state };
    }
    case "accounts": {
      if (entry === ACCOUNTS.back) {
        return { state: { screen: "main", cursor: state.cursor, message: null } };
      }
      if (entry === ACCOUNTS.move || entry === ACCOUNTS.page) {
        return { state: { ...state, pick: move(key, state.pick, roots.length), message: null } };
      }
      if (entry === ACCOUNTS.open && roots[state.pick] !== undefined) {
        return { state: { ...state, message: null }, menu: state.pick };
      }
      return { state };
    }
    case "link": {
      const root = roots[state.pick];
      const toList = {
        screen: "accounts" as const,
        cursor: state.cursor,
        pick: state.pick,
        message: null,
      };
      if (entry === LINK.cancel || root === undefined) return { state: toList };
      const candidates = linkCandidates(root, roots);
      if (entry === LINK.move || entry === LINK.page) {
        return { state: { ...state, choice: move(key, state.choice, candidates.length) } };
      }
      if (entry !== LINK.pick) return { state };
      const other = candidates[state.choice];
      if (other === undefined) return { state: toList };
      // Say which pairs kept apart in config the link undoes: it is never a silent change.
      const labelOf = new Map(roots.map((r) => [r.identity, r.label]));
      const undone = keptApart(config, root, other).map((p) =>
        p.map((id) => labelOf.get(id) ?? "a root not found here").join(" | "),
      );
      return {
        state: {
          ...toList,
          message: undone.length === 0 ? null : `no longer kept apart: ${undone.join(", ")}`,
        },
        config: linkRoots(config, root, other),
        accountsChanged: true,
      };
    }
    case "rename": {
      const root = roots[state.pick];
      const toList = {
        screen: "accounts" as const,
        cursor: state.cursor,
        pick: state.pick,
        message: null,
      };
      if (entry === RENAME.cancel || root === undefined) return { state: toList };
      if (entry === RENAME.erase) {
        return { state: { ...state, text: state.text.slice(0, -1), message: null } };
      }
      if (entry === RENAME.save) {
        const label = state.text.trim();
        if (label === root.label) return { state: toList };
        const problem = labelProblem(label, root, roots, input.accounts);
        if (problem !== null) return { state: { ...state, message: problem } };
        return { state: toList, config: renameRoot(config, root, label), accountsChanged: true };
      }
      if (entry === RENAME.type) {
        return { state: { ...state, text: state.text + typed(key), message: null } };
      }
      return { state };
    }
  }
}

/** The text a typing key adds: its character as typed, a space for the space bar. */
function typed(key: string): string {
  return key === "space" ? " " : key;
}
