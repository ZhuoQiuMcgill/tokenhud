import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { release } from "node:os";
import { win32 } from "node:path";
import type { Config, RootEntry } from "../config.ts";
import { byCodePoint } from "../store/store.ts";
import { nodeRealpathFs, pyExpandUser, pyNormPath, pyRealpath, type RealpathFs } from "./pypath.ts";

/**
 * Account roots, ported from cc-usage's `accounts.py`. Neither Claude transcripts nor Codex
 * rollouts name an account, so an account is a provider config dir (a "root"). Every root
 * is read-only; nothing here writes under one.
 *
 * Claude precedence (deduplicated by resolved path, first wins):
 *   1. `~/.claude` (label `personal`), always listed, even before it exists;
 *   2. `$CLAUDE_CONFIG_DIR`;
 *   3. config `claude_roots`;
 *   4. `~/.claude-*` directories (new in tokenhud);
 *   5. under WSL, `/mnt/c/Users/<user>/.claude*` directories (new in tokenhud).
 * Codex mirrors it with `~/.codex` (label `codex`), `$CODEX_HOME`, `codex_roots` and, under
 * WSL, `/mnt/c/Users/<user>/.codex*`. Explicit sources come before the globbed ones, so a
 * configured label wins for a root found both ways.
 */

export type Provider = "claude" | "codex";

/** How a root was found: the default dir, the env override, config, `~/.claude-*`, or the Windows side under WSL. */
export type RootSource = "auto" | "env" | "config" | "home" | "wsl";

export const CLAUDE_PROVIDER: Provider = "claude";
export const CODEX_PROVIDER: Provider = "codex";
export const DEFAULT_LABEL = "personal";
export const CODEX_ACCOUNT = "codex";
const ALL_SCOPE = "all";
const CLAUDE_RESERVED: readonly string[] = [CODEX_ACCOUNT, ALL_SCOPE];

export interface Root {
  provider: Provider;
  label: string;
  /** The config dir as discovered: `~` expanded and normalised, symlinks not resolved. */
  path: string;
  /** Where the transcripts live: `<path>/projects` (Claude) or `<path>/sessions` (Codex). */
  projects: string;
  source: RootSource;
  enabled: boolean;
  /** `sha256(resolved path)[:32]`, the same account identity cc-usage stores. */
  identity: string;
  /** Listed in `history_only_roots`: shown for history, no limits fetched (later tasks). */
  historyOnly: boolean;
}

export interface DiscoverOptions {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /**
   * The Windows `Users` dir to search for `<user>/.claude*` and `<user>/.codex*`, or null
   * for none. Defaults to `/mnt/c/Users` under WSL (overridable through
   * `TOKENHUD_WSL_USERS`, empty to disable) and null elsewhere.
   */
  wslUsersDir?: string | null;
  platform?: NodeJS.Platform;
  fs?: RealpathFs;
}

// ── paths and identity ───────────────────────────────────────────────────────────

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** A configured path as Python's `Path(raw).expanduser()` spells it. */
export function expandPath(raw: string, home: string, platform = process.platform): string {
  if (isWindows(platform)) {
    const expanded = raw === "~" || /^~[\\/]/.test(raw) ? home + raw.slice(1) : raw;
    return win32.normalize(expanded).replace(/(?<=[^:\\])\\+$/, "");
  }
  return pyExpandUser(raw, home);
}

function joinPath(dir: string, name: string, platform: NodeJS.Platform): string {
  return isWindows(platform) ? win32.join(dir, name) : pyNormPath(`${dir}/${name}`);
}

/** `str(Path(path).resolve())`: absolute, symlinks resolved, the way cc-usage dedupes roots. */
export function resolvePath(
  path: string,
  platform = process.platform,
  fs: RealpathFs = nodeRealpathFs,
): string {
  if (isWindows(platform)) {
    // cc-usage's Windows identities are not a parity target (its users ran it in WSL);
    // this is just a stable resolution for native Windows.
    const absolute = win32.resolve(path);
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  }
  return pyNormPath(pyRealpath(pyNormPath(path), fs));
}

/**
 * cc-usage's `root_identity`: the first 32 hex digits of the SHA-256 of the root's
 * resolved path. Equal for the same path, so history imported from cc-usage attaches to
 * the same account; renaming a label never splits an account.
 */
export function rootIdentity(
  path: string,
  home: string,
  platform = process.platform,
  fs: RealpathFs = nodeRealpathFs,
): string {
  const resolved = resolvePath(expandPath(path, home, platform), platform, fs);
  return createHash("sha256").update(resolved, "utf8").digest("hex").slice(0, 32);
}

// ── labels ───────────────────────────────────────────────────────────────────────

function basename(path: string, platform: NodeJS.Platform): string {
  const parts = path.split(isWindows(platform) ? /[\\/]/ : "/");
  return parts[parts.length - 1] ?? "";
}

/**
 * cc-usage's `_derive_label`: the basename without the provider prefix (`.claude-work`
 * -> `work`) or else without a leading dot (`.codex` -> `codex`); never empty.
 */
export function deriveLabel(name: string, stripPrefix: string): string {
  let label = name;
  if (stripPrefix && label.startsWith(stripPrefix)) label = label.slice(stripPrefix.length);
  else if (label.startsWith(".")) label = label.slice(1);
  return label || name || "account";
}

/** cc-usage's `_dedupe_label`: `label`, or `label-2`, `label-3`, ... if taken. */
export function dedupeLabel(label: string, used: Set<string>): string {
  if (!used.has(label)) {
    used.add(label);
    return label;
  }
  let i = 2;
  while (used.has(`${label}-${i}`)) i++;
  const out = `${label}-${i}`;
  used.add(out);
  return out;
}

// ── discovery ────────────────────────────────────────────────────────────────────

/** True inside WSL, where the Windows drives are mounted under /mnt. */
export function isWsl(platform = process.platform): boolean {
  if (platform !== "linux") return false;
  return (
    existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") ||
    release().toLowerCase().includes("microsoft")
  );
}

function defaultWslUsersDir(options: DiscoverOptions, platform: NodeJS.Platform): string | null {
  if (options.wslUsersDir !== undefined) return options.wslUsersDir;
  const override = options.env.TOKENHUD_WSL_USERS;
  if (override !== undefined) return override === "" ? null : override;
  return isWsl(platform) ? "/mnt/c/Users" : null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Directory entries of `dir` whose name starts with `prefix`, sorted; [] if unreadable. */
function matchingDirs(dir: string, prefix: string, platform: NodeJS.Platform): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .sort(byCodePoint)
    .map((name) => joinPath(dir, name, platform))
    .filter(isDir);
}

/** `<users>/<user>/<prefix>*` directories, users and names sorted. */
function wslDirs(usersDir: string | null, prefix: string, platform: NodeJS.Platform): string[] {
  if (usersDir === null) return [];
  let users: string[];
  try {
    users = readdirSync(usersDir).sort(byCodePoint);
  } catch {
    return [];
  }
  return users.flatMap((user) =>
    matchingDirs(joinPath(usersDir, user, platform), prefix, platform),
  );
}

interface Candidate {
  path: string;
  source: RootSource;
  label: string | null;
  enabled: boolean | null;
}

interface ProviderSpec {
  provider: Provider;
  defaultName: string;
  defaultLabel: string;
  envVar: string;
  configKey: "claude_roots" | "codex_roots";
  projectsSubdir: string;
  stripPrefix: string;
  /** Glob prefix for `~/<prefix>*` roots, or null when this provider has none. */
  homePrefix: string | null;
  wslPrefix: string;
}

const CLAUDE_SPEC: ProviderSpec = {
  provider: CLAUDE_PROVIDER,
  defaultName: ".claude",
  defaultLabel: DEFAULT_LABEL,
  envVar: "CLAUDE_CONFIG_DIR",
  configKey: "claude_roots",
  projectsSubdir: "projects",
  stripPrefix: ".claude-",
  homePrefix: ".claude-",
  wslPrefix: ".claude",
};

const CODEX_SPEC: ProviderSpec = {
  provider: CODEX_PROVIDER,
  defaultName: ".codex",
  defaultLabel: CODEX_ACCOUNT,
  envVar: "CODEX_HOME",
  configKey: "codex_roots",
  projectsSubdir: "sessions",
  stripPrefix: ".codex-",
  homePrefix: null,
  wslPrefix: ".codex",
};

function candidates(
  spec: ProviderSpec,
  config: Config,
  options: DiscoverOptions,
  platform: NodeJS.Platform,
): Candidate[] {
  const { home, env } = options;
  const out: Candidate[] = [
    {
      path: joinPath(expandPath(home, home, platform), spec.defaultName, platform),
      source: "auto",
      label: spec.defaultLabel,
      enabled: null,
    },
  ];
  const envDir = env[spec.envVar];
  if (envDir) {
    out.push({
      path: expandPath(envDir, home, platform),
      source: "env",
      label: null,
      enabled: null,
    });
  }
  for (const entry of config[spec.configKey] as RootEntry[]) {
    out.push({
      path: expandPath(entry.path, home, platform),
      source: "config",
      label: entry.label ?? null,
      enabled: entry.enabled ?? null,
    });
  }
  if (spec.homePrefix !== null) {
    for (const path of matchingDirs(expandPath(home, home, platform), spec.homePrefix, platform)) {
      out.push({ path, source: "home", label: null, enabled: null });
    }
  }
  for (const path of wslDirs(defaultWslUsersDir(options, platform), spec.wslPrefix, platform)) {
    out.push({ path, source: "wsl", label: null, enabled: null });
  }
  return out;
}

/**
 * cc-usage's `_discover_roots`: dedupe by resolved path (first wins), list the default root
 * even when missing and every other one only if it is a directory, label each (explicit,
 * default, or derived; Windows-side roots get a `-win` suffix, an assumption of tokenhud's)
 * and dedupe labels against `reserved`. A root is enabled unless its config entry says
 * `enabled: false` or its path is in `disabled_roots`.
 */
function discover(
  spec: ProviderSpec,
  config: Config,
  options: DiscoverOptions,
  reserved: Iterable<string>,
): Root[] {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeRealpathFs;
  const disabled = new Set(
    config.disabled_roots
      .filter((raw) => raw !== "")
      .map((raw) => expandPath(raw, options.home, platform)),
  );
  const historyOnly = new Set(config.history_only_roots);
  const seen = new Set<string>();
  const used = new Set(reserved);
  const roots: Root[] = [];
  for (const candidate of candidates(spec, config, options, platform)) {
    const resolved = resolvePath(candidate.path, platform, fs);
    if (seen.has(resolved)) continue;
    if (candidate.source !== "auto" && !isDir(candidate.path)) continue;
    seen.add(resolved);
    const name = basename(candidate.path, platform);
    let label: string;
    if (candidate.label) label = candidate.label;
    else if (candidate.source === "wsl") label = `${deriveLabel(name, spec.stripPrefix)}-win`;
    else label = deriveLabel(name, spec.stripPrefix);
    const identity = createHash("sha256").update(resolved, "utf8").digest("hex").slice(0, 32);
    roots.push({
      provider: spec.provider,
      label: dedupeLabel(label, used),
      path: candidate.path,
      projects: joinPath(candidate.path, spec.projectsSubdir, platform),
      source: candidate.source,
      enabled: candidate.enabled !== false && !disabled.has(candidate.path),
      identity,
      historyOnly: historyOnly.has(identity),
    });
  }
  return roots;
}

/** Claude account roots in precedence order (see the module comment). */
export function discoverClaudeRoots(config: Config, options: DiscoverOptions): Root[] {
  return discover(CLAUDE_SPEC, config, options, CLAUDE_RESERVED);
}

/**
 * Codex account roots. Their labels are reserved against `all` and the Claude labels, so
 * the two providers share one unambiguous namespace (cc-usage T12).
 */
export function discoverCodexRoots(
  config: Config,
  options: DiscoverOptions,
  claudeRoots: readonly Root[] = discoverClaudeRoots(config, options),
): Root[] {
  return discover(CODEX_SPEC, config, options, [ALL_SCOPE, ...claudeRoots.map((r) => r.label)]);
}
