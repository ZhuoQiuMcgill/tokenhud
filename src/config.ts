import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./paths.ts";

/**
 * App config, `~/.config/tokenhud/config.json`, ported from cc-usage's `config.py`. Every
 * value is checked against its allowed set on load; anything unexpected falls back to its
 * default, so a hand-edited or damaged file never crashes tokenhud.
 *
 * Keys keep cc-usage's snake_case spelling, so a cc-usage user recognises the file.
 */

export const REFRESH_CHOICES: readonly number[] = [2, 5, 10, 30];
export const WINDOW_CHOICES = [
  "today",
  "this_week",
  "this_month",
  "all",
  "1h",
  "5h",
  "24h",
] as const;
export const THEME_CHOICES = ["dark", "light", "high-contrast"] as const;

export type Window = (typeof WINDOW_CHOICES)[number];
export type Theme = (typeof THEME_CHOICES)[number];

/** A transcript root declared by hand, as in cc-usage's `claude_roots` / `codex_roots`. */
export interface RootEntry {
  path: string;
  label?: string;
  enabled?: boolean;
}

export interface Config {
  refresh_interval: number;
  default_window: Window;
  show_cost: boolean;
  theme: Theme;
  /** The last-selected scope: "all" or an account label (checked against live accounts at runtime). */
  account_scope: string;
  claude_roots: RootEntry[];
  codex_roots: RootEntry[];
  /** Root paths (either provider) the user switched off. */
  disabled_roots: string[];
  /**
   * Root identities shown for history only: no limits are fetched for them (an account
   * that now runs on another machine). See ARCHITECTURE.md, "history-only accounts".
   */
  history_only_roots: string[];
}

export function defaultConfig(): Config {
  return {
    refresh_interval: 5,
    default_window: "all",
    show_cost: true,
    theme: "dark",
    account_scope: "all",
    claude_roots: [],
    codex_roots: [],
    disabled_roots: [],
    history_only_roots: [],
  };
}

export function configPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T>(choices: readonly T[], value: unknown, fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}

/**
 * cc-usage's `_sanitize_roots`: keeps entries with a non-empty string `path`. Of the
 * optional fields only well-typed ones survive (a non-empty string `label`, a boolean
 * `enabled`); cc-usage kept the raw object and ignored bad fields when reading it, which
 * reads the same.
 */
function sanitizeRoots(value: unknown): RootEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RootEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path === "") continue;
    const root: RootEntry = { path: entry.path };
    if (typeof entry.label === "string" && entry.label !== "") root.label = entry.label;
    if (typeof entry.enabled === "boolean") root.enabled = entry.enabled;
    out.push(root);
  }
  return out;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** cc-usage's `_validate` over a parsed config object: every bad or missing value becomes its default. */
export function validateConfig(raw: unknown): Config {
  const config = defaultConfig();
  if (!isRecord(raw)) return config;
  config.refresh_interval = oneOf(REFRESH_CHOICES, raw.refresh_interval, 5);
  config.default_window = oneOf(WINDOW_CHOICES, raw.default_window, "all");
  if (typeof raw.show_cost === "boolean") config.show_cost = raw.show_cost;
  config.theme = oneOf(THEME_CHOICES, raw.theme, "dark");
  if (typeof raw.account_scope === "string" && raw.account_scope !== "") {
    config.account_scope = raw.account_scope;
  }
  config.claude_roots = sanitizeRoots(raw.claude_roots);
  config.codex_roots = sanitizeRoots(raw.codex_roots);
  config.disabled_roots = strings(raw.disabled_roots);
  config.history_only_roots = strings(raw.history_only_roots);
  return config;
}

/** The config at `path`; defaults if it is missing, unreadable or not valid JSON. */
export function loadConfig(path: string = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return defaultConfig();
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch {
    return defaultConfig();
  }
}

/**
 * Writes `config` (validated first) atomically: to `config.json.tmp`, then renamed over
 * the file, so a crash never leaves a half-written config.
 */
export function saveConfig(config: Config, path: string = configPath()): void {
  const valid = validateConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

// ── cc-usage ─────────────────────────────────────────────────────────────────────

/**
 * cc-usage's own config dir, `$XDG_CONFIG_HOME/cc-usage` else `~/.config/cc-usage`,
 * spelled exactly as cc-usage's `paths.py` (which, unlike tokenhud, takes a relative
 * XDG_CONFIG_HOME as it is). Its files are only ever read.
 */
export function ccUsageDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "cc-usage");
}

/** cc-usage's window choices that tokenhud renamed. */
const CC_USAGE_WINDOWS: Readonly<Record<string, Window>> = { "7d": "this_week" };

/**
 * tokenhud's config from cc-usage's parsed `config.json`: root labels and paths, disabled
 * roots, theme, show-cost, refresh interval and default window (`7d` becomes
 * `this_week`). The account scope is left at "all": labels can differ between the apps.
 */
export function configFromCcUsage(json: unknown): Config {
  if (!isRecord(json)) return defaultConfig();
  const window =
    typeof json.default_window === "string"
      ? (CC_USAGE_WINDOWS[json.default_window] ?? json.default_window)
      : undefined;
  return validateConfig({
    refresh_interval: json.refresh_interval,
    default_window: window,
    show_cost: json.show_cost,
    theme: json.theme,
    claude_roots: json.claude_roots,
    codex_roots: json.codex_roots,
    disabled_roots: json.disabled_roots,
  });
}

/**
 * The config ingest runs with: tokenhud's own file once it exists; before that,
 * cc-usage's `config.json` (only read, never copied), so a cc-usage user's extra roots,
 * labels and disabled roots apply from the first run; else the defaults.
 */
export function effectiveConfig(
  path: string = configPath(),
  ccUsageConfig: string = join(ccUsageDir(), "config.json"),
): Config {
  if (existsSync(path)) return loadConfig(path);
  try {
    return configFromCcUsage(JSON.parse(readFileSync(ccUsageConfig, "utf8")));
  } catch {
    return defaultConfig();
  }
}
