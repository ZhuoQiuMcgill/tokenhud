// `tokenhud mcp`: the stdio MCP server Claude Code launches (see src/mcp/server.ts). It
// takes no options: Claude Code passes the session's environment, which picks the account,
// and XDG_CONFIG_HOME, as everywhere, moves tokenhud's store and config.
//
// `tokenhud mcp install --hooks` adds the Claude Code hooks that deliver limit alerts to a
// config dir's user settings (src/alerts/install.ts); it runs only when asked.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { editHooks, type HookCommand, SettingsError, selfHookCommand } from "../alerts/install.ts";
import { WriterLock } from "../lock.ts";
import { runMcpServer } from "../mcp/server.ts";
import { shortPath } from "./import-cc-usage.ts";

export const MCP_HELP = `Usage:
  tokenhud mcp
  tokenhud mcp install --hooks [--remove] [--config-dir DIR]

Runs the tokenhud MCP server on stdin/stdout, for Claude Code. Tools: limits,
should_wait, wait_for_reset, usage, accounts, set_alert, list_alerts, clear_alert.
Install it once per Claude account (each CLAUDE_CONFIG_DIR):
  claude mcp add -s user tokenhud -- tokenhud mcp
or install the tokenhud plugin, which also adds a skill that says when to use it, and
the hooks that deliver limit alerts.

tokenhud mcp install --hooks adds those hooks (PostToolBatch, UserPromptSubmit and
SessionEnd, each running this tokenhud's hook command) to the user settings of one Claude
config dir: --config-dir DIR, else CLAUDE_CONFIG_DIR, else ~/.claude. It keeps every
other hook and setting, backs the file up first, and prints what changed. --remove takes
tokenhud's hooks out again.`;

type Env = Readonly<Record<string, string | undefined>>;

export async function runMcp(args: readonly string[]): Promise<number> {
  if (args[0] === "install") return runInstall(args.slice(1));
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(`${MCP_HELP}\n`);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write(`tokenhud mcp: unexpected argument '${args[0]}'\n${MCP_HELP}\n`);
    return 2;
  }
  // The single-writer lock (src/lock.ts): with it free, a stale store is refreshed by one
  // pass here; while a TUI holds it, answers come from the store as it is, with stale_s.
  return runMcpServer({
    acquireWriterLock: () =>
      WriterLock.tryAcquire({
        owner: "mcp",
        log: (message) => process.stderr.write(`tokenhud mcp: ${message}\n`),
      }),
  });
}

export interface InstallContext {
  env: Env;
  home: string;
  now: number;
  /** The hook command to install: this tokenhud by default. */
  command: HookCommand;
}

/** `tokenhud mcp install --hooks [--remove] [--config-dir DIR]`. */
export function runInstall(
  args: readonly string[],
  ctx: InstallContext = {
    env: process.env,
    home: homedir(),
    now: Date.now(),
    command: selfHookCommand(),
  },
): number {
  const { env, home } = ctx;
  const fail = (message: string, code: number) => {
    process.stderr.write(`tokenhud mcp install: ${message}\n`);
    return code;
  };
  let values: { hooks?: boolean; remove?: boolean; "config-dir"?: string; help?: boolean };
  try {
    values = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        hooks: { type: "boolean" },
        remove: { type: "boolean" },
        "config-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (error) {
    return fail(`${(error as Error).message}\n${MCP_HELP}`, 2);
  }
  if (values.help) {
    process.stdout.write(`${MCP_HELP}\n`);
    return 0;
  }
  if (!values.hooks) {
    return fail(
      "pass --hooks, which installs the hooks that deliver limit alerts (the MCP server itself is added with `claude mcp add`, or the plugin)",
      2,
    );
  }
  const dir = resolve(values["config-dir"] ?? (env.CLAUDE_CONFIG_DIR || join(home, ".claude")));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return fail(`there is no Claude config dir at ${shortPath(dir, home)}`, 1);
  }
  const settings = join(dir, "settings.json");
  const shown = shortPath(settings, home);
  const remove = values.remove === true;
  let change: ReturnType<typeof editHooks>;
  try {
    change = editHooks(settings, ctx.command, { remove, now: ctx.now });
  } catch (error) {
    if (error instanceof SettingsError) {
      return fail(`${shown} was left as it is: ${error.message}`, 1);
    }
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
    return fail(`cannot write ${shown} (${code})`, 1);
  }
  const out: string[] = [];
  if (!change.changed) {
    out.push(
      remove
        ? `tokenhud: ${shown} has no tokenhud hooks; nothing changed`
        : `tokenhud: ${shown} already has tokenhud's alert hooks; nothing changed`,
    );
  } else {
    out.push(
      remove
        ? `tokenhud: took tokenhud's alert hooks out of ${shown}`
        : `tokenhud: ${change.created ? "created" : "updated"} ${shown} with tokenhud's alert hooks`,
    );
    for (const line of change.removed) out.push(`  - ${line}`);
    for (const line of change.added) out.push(`  + ${line}`);
    if (change.backup !== null) out.push(`  the file as it was: ${shortPath(change.backup, home)}`);
    out.push(
      remove
        ? "New Claude Code sessions no longer run them."
        : "New Claude Code sessions run them; `tokenhud doctor` shows each account's hooks.",
    );
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}
