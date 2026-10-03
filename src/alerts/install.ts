import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The Claude Code hooks that run `tokenhud hook` (T29). The plugin ships them in
 * `plugin/hooks/hooks.json`; for users who registered the MCP server by hand,
 * `tokenhud mcp install --hooks` merges them into a config dir's user-scope
 * `settings.json`, and `--remove` takes them out again.
 *
 * - **Harmless with any tokenhud.** The plugin is served from the repo while users may
 *   still run a tokenhud without `hook`, which answers "unknown command" with exit 2, and
 *   Claude Code treats exit 2 as "block the prompt". So the command is a shell line that
 *   always ends `; exit 0`: a missing binary, an old one or any failure exits 0 with
 *   nothing on stdout (errors go to stderr, which Claude Code doesn't add to the context).
 *   The line runs the same in each shell Claude Code uses: `sh -c` on Linux and macOS, Git
 *   Bash on Windows, and PowerShell on Windows without Git Bash. CI runs it, in each,
 *   against the released 0.1.3 binary and against this build (scripts/hook-compat.ts).
 * - **The installed command** names this binary by absolute path, quoted for the shell it
 *   runs in: `'<path>' hook; exit 0` for sh, and on Windows, where a quoted path needs
 *   PowerShell's `&`, `& '<path>' hook; exit 0` with `"shell": "powershell"`.
 * - **Merging** touches only the hooks it wrote, recognised by their exact command line
 *   (`isTokenhudHook`), on its three events. Every other hook, group and setting is kept.
 * - **Safety:** a settings file that isn't a JSON object is never rewritten. A symlinked
 *   settings.json is followed: its target is edited, never the link. Before a change, the
 *   target is copied to `<name>.tokenhud-<UTC time to the ms>.bak` beside it, with the
 *   same mode; the new content goes to a temp file in the target's directory with the
 *   target's mode (and owner, where it can be set), renamed onto it.
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

/** The plugin's command: `tokenhud` from PATH, as its `.mcp.json` starts the server. */
export const PLUGIN_COMMAND = "tokenhud hook; exit 0";

/** A hook's command line, and the shell it is written for (Claude Code's default when absent). */
export interface HookCommand {
  command: string;
  shell?: "powershell";
}

const posixQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
const pwshQuote = (word: string) => `'${word.replaceAll("'", "''")}'`;

/**
 * The tolerant command line that runs `words` (a tokenhud binary, or Bun and cli.ts) with
 * `hook`: for sh and Git Bash elsewhere, for PowerShell on Windows.
 */
export function hookCommand(
  words: readonly string[],
  platform: NodeJS.Platform = process.platform,
): HookCommand {
  if (platform === "win32") {
    return { command: `& ${words.map(pwshQuote).join(" ")} hook; exit 0`, shell: "powershell" };
  }
  return { command: `${words.map(posixQuote).join(" ")} hook; exit 0` };
}

/** This tokenhud's hook command: the binary itself, or Bun running cli.ts from source. */
export function selfHookCommand(
  execPath: string = process.execPath,
  main: string = Bun.main,
  platform: NodeJS.Platform = process.platform,
  compiled = /^(?:\/\$bunfs\/|[A-Za-z]:[/\\]~BUN[/\\])/.test(main),
): HookCommand {
  return hookCommand(compiled ? [execPath] : [execPath, main], platform);
}

/** One command hook, as settings.json and hooks.json spell it. */
export function hookEntry(event: HookEvent, cmd: HookCommand): Record<string, unknown> {
  return {
    type: "command",
    command: cmd.command,
    ...(cmd.shell === undefined ? {} : { shell: cmd.shell }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The quoted words of `'a' 'b' hook; exit 0` or `& 'a' 'b' hook; exit 0`, else null. */
function quotedWords(command: string): string[] | null {
  const posix = /^((?:'(?:[^']|'\\'')*' )+)hook; exit 0$/.exec(command);
  if (posix !== null) {
    return [...(posix[1] as string).matchAll(/'((?:[^']|'\\'')*)' /g)].map((m) =>
      (m[1] as string).replaceAll(`'\\''`, "'"),
    );
  }
  const pwsh = /^& ((?:'(?:[^']|'')*' )+)hook; exit 0$/.exec(command);
  if (pwsh !== null) {
    return [...(pwsh[1] as string).matchAll(/'((?:[^']|'')*)' /g)].map((m) =>
      (m[1] as string).replaceAll("''", "'"),
    );
  }
  return null;
}

const fileName = (path: string) => basename(path.replaceAll("\\", "/"));

/**
 * Whether `hook` is one tokenhud writes: the plugin's line, or the installed one for a
 * tokenhud binary (or Bun running tokenhud's `src/cli.ts`). A user's own hook that merely
 * mentions tokenhud is not.
 */
export function isTokenhudHook(hook: unknown): boolean {
  if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") {
    return false;
  }
  if (hook.args !== undefined) return false;
  if (hook.command === PLUGIN_COMMAND) return hook.shell === undefined;
  const words = quotedWords(hook.command);
  const pwsh = hook.command.startsWith("& ");
  if (words === null || (pwsh ? hook.shell !== "powershell" : hook.shell !== undefined)) {
    return false;
  }
  if (words.length === 1) return /^tokenhud(\.exe)?$/i.test(fileName(words[0] as string));
  return (
    words.length === 2 &&
    /^bun(\.exe)?$/i.test(fileName(words[0] as string)) &&
    /[\\/]src[\\/]cli\.ts$/.test(words[1] as string)
  );
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

/**
 * Takes tokenhud's hooks out of `settings` (in place), on its three events only. A matcher
 * group left without hooks goes, then an event left without groups, then `hooks` left
 * empty. Returns `<event>: <command>` for each hook that went.
 */
function takeOut(settings: Record<string, unknown>): string[] {
  const removed: string[] = [];
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return removed;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
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
      for (const hook of ours) removed.push(`${event}: ${(hook as { command: string }).command}`);
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

/** `settings.json.tokenhud-20261003T164500123Z.bak`, beside it. */
export function backupPath(settingsPath: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, "");
  return `${settingsPath}.tokenhud-${stamp}.bak`;
}

/** The file a settings path names: a symlink's target, else the path itself. */
function resolveTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * Copies `target` to a backup beside it, overwriting no earlier one (two edits in one
 * millisecond get `-2`, `-3` …), with the target's mode.
 */
function backUp(target: string, now: number, st: Stats): string {
  const base = backupPath(target, now);
  const mode = st.mode & 0o7777;
  for (let n = 1; ; n++) {
    const path = n === 1 ? base : base.replace(/\.bak$/, `-${n}.bak`);
    let fd: number;
    try {
      fd = openSync(path, "wx", mode);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    closeSync(fd);
    copyFileSync(target, path);
    chmodSync(path, mode);
    return path;
  }
}

/**
 * Replaces `target`'s content with `text`: a temp file in its directory, with its mode and
 * owner, renamed onto it. When the owner can't be given to the temp file (another user's
 * file, writable to us through its group), the file is rewritten in place, keeping both.
 * A new file is created readable by its owner only: settings can hold secrets.
 */
function replace(target: string, text: string, st: Stats | null): void {
  const mode = st === null ? 0o600 : st.mode & 0o7777;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode });
    chmodSync(tmp, mode);
    if (st !== null && process.platform !== "win32") {
      const mine = statSync(tmp);
      if (mine.uid !== st.uid || mine.gid !== st.gid) {
        try {
          chownSync(tmp, st.uid, st.gid);
        } catch {
          rmSync(tmp, { force: true });
          writeFileSync(target, text, "utf8");
          return;
        }
      }
    }
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
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
  const target = resolveTarget(path);
  const exists = existsSync(target);
  const st = exists ? statSync(target) : null;
  let settings: Record<string, unknown> = {};
  if (exists) {
    const before = readFileSync(target, "utf8");
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
      added.push(`${event}: ${cmd.command}`);
    }
    settings.hooks = hooks;
  }
  const same = [...removed].sort().join("\n") === [...added].sort().join("\n");
  if ((options.remove && removed.length === 0) || (!options.remove && same && exists)) {
    return { changed: false, created: false, backup: null, added: [], removed: [] };
  }
  const backup = st === null ? null : backUp(target, options.now, st);
  replace(target, `${JSON.stringify(settings, null, 2)}\n`, st);
  return {
    changed: true,
    created: !exists,
    backup,
    added: added.filter((line) => !removed.includes(line)),
    removed: removed.filter((line) => !added.includes(line)),
  };
}
