// The settings screen as a pure state machine, ported from cc-usage's keyboard-driven
// settings (settings_screen.py) and adapted: every value is picked from a list (↑/↓,
// Enter, Esc), except an account's new label and the time-zone filter, which are typed.
// Keys in, new state and config out; the shell saves and applies.

import {
  type Config,
  REFRESH_CHOICES,
  SYSTEM_TIME_ZONE,
  THEME_CHOICES,
  WINDOW_CHOICES,
} from "../config.ts";
import type { RootInfo } from "./vm/types.ts";

export type SettingsRow = "refresh" | "window" | "cost" | "theme" | "tz" | "accounts";
export const SETTINGS_ROWS: readonly SettingsRow[] = [
  "refresh",
  "window",
  "cost",
  "theme",
  "tz",
  "accounts",
];

export const ROW_LABELS: Readonly<Record<SettingsRow, string>> = {
  refresh: "Refresh interval",
  window: "Default spend window",
  cost: "Show cost",
  theme: "Theme",
  tz: "Time zone",
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
    };

/** A key as the settings screen reads it: OpenTUI's name, and the text it typed. */
export interface SettingsKey {
  readonly name: string;
  readonly sequence: string;
}

export interface SettingsInput {
  readonly config: Config;
  readonly roots: readonly RootInfo[];
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
  /** Roots were enabled, disabled, renamed or marked: ingest should restart on close. */
  readonly accountsChanged?: boolean;
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

/** Switches a root off (its path joins `disabled_roots`) or back on. */
export function toggleEnabled(config: Config, root: RootInfo): Config {
  if (root.enabled) return { ...config, disabled_roots: [...config.disabled_roots, root.path] };
  const key = root.provider === "claude" ? "claude_roots" : "codex_roots";
  const entries = config[key].map((e, i) => {
    if (i !== root.configIndex || e.enabled !== false) return e;
    const { enabled: _, ...rest } = e;
    return rest;
  });
  return {
    ...config,
    disabled_roots: config.disabled_roots.filter((raw) => !root.disabledBy.includes(raw)),
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

/** Why `label` can't name `root`, or null when it can. */
export function labelProblem(
  label: string,
  root: RootInfo,
  roots: readonly RootInfo[],
): string | null {
  if (label === "") return "a label can't be empty";
  if (label.length > MAX_LABEL) return `a label is at most ${MAX_LABEL} characters`;
  if (label.toLowerCase() === "all") return "'all' is reserved for the all-accounts scope";
  if (roots.some((r) => r !== root && r.label === label)) return `'${label}' is taken`;
  return null;
}

// ── keys ─────────────────────────────────────────────────────────────────────────

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

function isText(key: SettingsKey): boolean {
  return key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\u007f";
}

function move(key: SettingsKey, pick: number, count: number): number | null {
  if (key.name === "up") return clamp(pick - 1, count - 1);
  if (key.name === "down") return clamp(pick + 1, count - 1);
  if (key.name === "pageup") return clamp(pick - 10, count - 1);
  if (key.name === "pagedown") return clamp(pick + 10, count - 1);
  if (key.name === "home") return 0;
  if (key.name === "end") return Math.max(0, count - 1);
  return null;
}

export function settingsKey(
  state: SettingsState,
  key: SettingsKey,
  input: SettingsInput,
): SettingsResult {
  const { config, roots } = input;
  const back = key.name === "escape";
  switch (state.screen) {
    case "main": {
      if (back || key.name === "q" || key.name === "s") return { state: null };
      const moved = move(key, state.cursor, SETTINGS_ROWS.length);
      if (moved !== null) return { state: { ...state, cursor: moved, message: null } };
      if (key.name !== "return" && key.name !== "enter") return { state };
      const row = SETTINGS_ROWS[state.cursor] as SettingsRow;
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
      if (back || key.name === "q")
        return { state: { screen: "main", cursor: state.cursor, message: null } };
      const moved = move(key, state.pick, list.length);
      if (moved !== null) return { state: { ...state, pick: moved } };
      if (key.name !== "return" && key.name !== "enter") return { state };
      const choice = list[state.pick] as Choice;
      return {
        state: { screen: "main", cursor: state.cursor, message: null },
        config: withValue(state.row, config, choice.value),
      };
    }
    case "tz": {
      const shown = filterZones(input.zones, state.filter);
      if (back) return { state: { screen: "main", cursor: state.cursor, message: null } };
      const moved = move(key, state.pick, shown.length);
      if (moved !== null) return { state: { ...state, pick: moved } };
      if (key.name === "backspace") {
        return { state: { ...state, filter: state.filter.slice(0, -1), pick: 0 } };
      }
      if (key.name === "return" || key.name === "enter") {
        const zone = shown[state.pick];
        if (zone === undefined) return { state: { ...state, message: "no zone matches" } };
        return {
          state: { screen: "main", cursor: state.cursor, message: null },
          config: { ...config, time_zone: zone },
        };
      }
      if (isText(key))
        return { state: { ...state, filter: state.filter + key.sequence, pick: 0, message: null } };
      return { state };
    }
    case "accounts": {
      if (back || key.name === "q")
        return { state: { screen: "main", cursor: state.cursor, message: null } };
      const moved = move(key, state.pick, roots.length);
      if (moved !== null) return { state: { ...state, pick: moved, message: null } };
      const root = roots[state.pick];
      if (root === undefined) return { state };
      if (
        key.name === "e" ||
        key.name === "return" ||
        key.name === "enter" ||
        key.name === "space"
      ) {
        return {
          state: { ...state, message: null },
          config: toggleEnabled(config, root),
          accountsChanged: true,
        };
      }
      if (key.name === "h") {
        return {
          state: { ...state, message: null },
          config: toggleHistoryOnly(config, root),
          accountsChanged: true,
        };
      }
      if (key.name === "l") {
        if (!root.renamable) {
          return {
            state: {
              ...state,
              message: `${root.source === "env" ? "an env-var" : "the default"} account's label is fixed`,
            },
          };
        }
        return {
          state: {
            screen: "rename",
            cursor: state.cursor,
            pick: state.pick,
            text: root.label,
            message: null,
          },
        };
      }
      return { state };
    }
    case "rename": {
      const root = roots[state.pick];
      const toList = {
        screen: "accounts" as const,
        cursor: state.cursor,
        pick: state.pick,
        message: null,
      };
      if (back || root === undefined) return { state: toList };
      if (key.name === "backspace")
        return { state: { ...state, text: state.text.slice(0, -1), message: null } };
      if (key.name === "return" || key.name === "enter") {
        const label = state.text.trim();
        if (label === root.label) return { state: toList };
        const problem = labelProblem(label, root, roots);
        if (problem !== null) return { state: { ...state, message: problem } };
        return { state: toList, config: renameRoot(config, root, label), accountsChanged: true };
      }
      if (isText(key))
        return { state: { ...state, text: state.text + key.sequence, message: null } };
      return { state };
    }
  }
}
