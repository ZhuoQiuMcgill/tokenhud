import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * The Claude Code hooks that run `tokenhud hook` (T29), for users who registered the MCP
 * server by hand: `tokenhud mcp install --hooks` merges them into a config dir's
 * user-scope `settings.json`, and `--remove` takes them out again. The plugin ships the
 * same hooks in `plugin/hooks/hooks.json`.
 *
 * - **The command** is this tokenhud binary by absolute path, in exec form (`command` and
 *   `args`, no shell), so the hook works whatever PATH Claude Code starts with, and its
 *   parent is Claude Code itself.
 * - **Merging** touches only tokenhud's own hook entries (`isTokenhudHook`): they are taken
 *   out wherever they are and added again, one matcher group per event. Every other hook,
 *   group and setting is kept as it is.
 * - **Safety:** a settings file that isn't a JSON object is never rewritten. Before a
 *   change, the file is copied to `settings.json.tokenhud-<UTC time>.bak`; it is then
 *   replaced atomically.
 */

/** Where tokenhud's hooks run, and how long PostToolBatch and UserPromptSubmit may take. */
export const HOOK_EVENTS = ["PostToolBatch", "UserPromptSubmit", "SessionEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
/**
 * Seconds. The hook takes tens of milliseconds; this bounds a stuck one, which would
 * otherwise hold the agent for Claude Code's default of 600 s (30 s on UserPromptSubmit).
 * SessionEnd keeps Claude Code's own 1.5 s budget: a longer timeout would raise it.
 */
export const HOOK_TIMEOUT_S = 10;

export interface HookCommand {
  command: string;
  args: string[];
}

/** One command hook, as settings.json and hooks.json spell it. */
export function hookEntry(event: HookEvent, cmd: HookCommand): Record<string, unknown> {
  return {
    type: "command",
    command: cmd.command,
    args: cmd.args,
    ...(event === "SessionEnd" ? {} : { timeout: HOOK_TIMEOUT_S }),
  };
}

/**
 * The `hooks` tokenhud adds: per event, one matcher group with its hook. None of the three
 * events filters on a matcher, so the groups have none (SessionEnd's would filter on why
 * the session ended, and every reason ends it).
 */
export function tokenhudHooks(cmd: HookCommand): Record<HookEvent, unknown[]> {
  return Object.fromEntries(
    HOOK_EVENTS.map((event) => [event, [{ hooks: [hookEntry(event, cmd)] }]]),
  ) as Record<HookEvent, unknown[]>;
}

/** This tokenhud's hook command: the binary itself, or Bun running cli.ts from source. */
export function selfHookCommand(
  execPath: string = process.execPath,
  main: string = Bun.main,
  compiled = /^(?:\/\$bunfs\/|[A-Za-z]:[/\\]~BUN[/\\])/.test(main),
): HookCommand {
  return compiled
    ? { command: execPath, args: ["hook"] }
    : { command: execPath, args: [main, "hook"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A command hook that runs `tokenhud … hook`: exec form or a shell command line. */
export function isTokenhudHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") {
    return false;
  }
  const args = Array.isArray(hook.args) ? hook.args : [];
  const words = [hook.command, ...args].filter((w): w is string => typeof w === "string");
  const line = words.join(" ").trim();
  const named = words.some((w) => /^tokenhud(\.exe)?$/i.test(basename(w.replaceAll("\\", "/"))));
  return (named || /tokenhud/i.test(line)) && /(^|\s)hook$/.test(line);
}

/** Whether `settings` runs tokenhud's hook on `event`. */
function hasHook(settings: Record<string, unknown>, event: HookEvent): boolean {
  const hooks = settings.hooks;
  if (!isRecord(hooks) || !Array.isArray(hooks[event])) return false;
  return (hooks[event] as unknown[]).some(
    (group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isTokenhudHook),
  );
}

/** Whether a parsed settings.json runs tokenhud's hook where alerts are delivered. */
export function hooksInstalled(settings: unknown): boolean {
  return (
    isRecord(settings) &&
    hasHook(settings, "PostToolBatch") &&
    hasHook(settings, "UserPromptSubmit")
  );
}

/** What a hook entry runs, for the report: `<command> <args...>`. */
function describe(hook: unknown): string {
  if (!isRecord(hook)) return "?";
  const args = Array.isArray(hook.args) ? hook.args.filter((a) => typeof a === "string") : [];
  return [hook.command, ...args].join(" ");
}

/**
 * Takes tokenhud's hooks out of `settings` (in place). A matcher group left without hooks
 * goes, then an event left without groups, then `hooks` left empty. Returns what went.
 */
function takeOut(settings: Record<string, unknown>): string[] {
  const removed: string[] = [];
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return removed;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const ours = group.hooks.filter(isTokenhudHook);
      if (ours.length === 0) {
        kept.push(group);
        continue;
      }
      for (const hook of ours) removed.push(`${event}: ${describe(hook)}`);
      const rest = group.hooks.filter((h: unknown) => !isTokenhudHook(h));
      if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

export interface HooksChange {
  /** The settings file was written. */
  changed: boolean;
  /** The file did not exist and was created. */
  created: boolean;
  /** The copy of the file as it was, or null (nothing changed, or no file before). */
  backup: string | null;
  /** `<event>: <command line>` of each hook added, and of each taken out. */
  added: string[];
  removed: string[];
}

export class SettingsError extends Error {
  override name = "SettingsError";
}

/** `settings.json.tokenhud-20261003T164500Z.bak`, beside it. */
export function backupPath(settingsPath: string, now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${settingsPath}.tokenhud-${stamp}.bak`;
}

/**
 * Installs tokenhud's hooks into the settings file at `path` (or, with `remove`, takes them
 * out), leaving everything else as it was. A file that already has exactly these hooks is
 * left alone. Throws `SettingsError` for a file that can't be read as a JSON object, and
 * the file system's error when it can't be written.
 */
export function editHooks(
  path: string,
  cmd: HookCommand,
  options: { remove: boolean; now: number },
): HooksChange {
  const exists = existsSync(path);
  let settings: Record<string, unknown> = {};
  let before = "";
  if (exists) {
    before = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = before.trim() === "" ? {} : JSON.parse(before);
    } catch (error) {
      throw new SettingsError(`it is not valid JSON (${(error as Error).message})`);
    }
    if (!isRecord(parsed)) throw new SettingsError("it is not a JSON object");
    settings = parsed;
  }
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
    throw new SettingsError('its "hooks" is not an object');
  }
  const removed = takeOut(settings);
  const added: string[] = [];
  if (!options.remove) {
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    for (const [event, groups] of Object.entries(tokenhudHooks(cmd))) {
      const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      hooks[event] = [...current, ...groups];
      added.push(`${event}: ${[cmd.command, ...cmd.args].join(" ")}`);
    }
    settings.hooks = hooks;
  }
  const same = [...removed].sort().join("\n") === [...added].sort().join("\n");
  if ((options.remove && removed.length === 0) || (!options.remove && same && exists)) {
    return { changed: false, created: false, backup: null, added: [], removed: [] };
  }
  let backup: string | null = null;
  if (exists) {
    backup = backupPath(path, options.now);
    copyFileSync(path, backup);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return {
    changed: true,
    created: !exists,
    backup,
    added: added.filter((line) => !removed.includes(line)),
    removed: removed.filter((line) => !added.includes(line)),
  };
}
