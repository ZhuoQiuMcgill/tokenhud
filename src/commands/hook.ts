// `tokenhud hook`: the Claude Code hook that delivers limit alerts (src/alerts/hook.ts).
// Claude Code runs it with the hook event as JSON on stdin. It always exits 0: a hook that
// failed must never block or fail the agent.

import { homedir } from "node:os";
import { hookLog, hookLogPath, runHook } from "../alerts/hook.ts";

export const HOOK_HELP = `Usage:
  tokenhud hook

The Claude Code hook that tells agents about the limit alerts they set with the MCP
server's set_alert tool. Claude Code runs it on PostToolBatch, UserPromptSubmit and
SessionEnd, with the event as JSON on stdin; it prints a hook reply only when an alert
fires. Install it with the tokenhud plugin, or with:
  tokenhud mcp install --hooks`;

export async function runHookCommand(args: readonly string[]): Promise<number> {
  if (args.length > 0 || process.stdin.isTTY) {
    const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
    (help || args.length === 0 ? process.stdout : process.stderr).write(`${HOOK_HELP}\n`);
    return help || args.length === 0 ? 0 : 2;
  }
  const env = process.env;
  const home = homedir();
  let input = "";
  try {
    input = await Bun.stdin.text();
  } catch {
    // An unreadable stdin reads as no event: runHook logs it.
  }
  const out = runHook(input, {
    env,
    home,
    now: Date.now(),
    ppid: process.ppid,
    log: hookLog(hookLogPath(env, home), home),
  });
  if (out !== "") process.stdout.write(out);
  return 0;
}
