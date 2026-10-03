// `tokenhud hook`: the Claude Code hook that delivers limit alerts (src/alerts/hook.ts).
// Claude Code runs it with the hook event as JSON on stdin. It always exits 0: a hook that
// failed must never block or fail the agent.

import { homedir } from "node:os";
import { hookLog, hookLogPath, runHook } from "../alerts/hook.ts";
import { procReader } from "../alerts/proc.ts";

export const HOOK_HELP = `Usage:
  tokenhud hook

The Claude Code hook that tells agents about the limit alerts they set with the MCP
server's set_alert tool. Claude Code runs it on PostToolBatch, UserPromptSubmit and
SessionEnd, with the event as JSON on stdin; it prints a hook reply only when an alert
fires. Install it with the tokenhud plugin, or with:
  tokenhud mcp install --hooks`;

/**
 * The clock tests run a fresh `tokenhud hook` process on: TOKENHUD_TEST_NOW (epoch ms), read
 * only under the test guard's TOKENHUD_TEST=1, which is never set outside tests.
 */
function testClock(env: Readonly<Record<string, string | undefined>>): number | null {
  if (env.TOKENHUD_TEST !== "1" || env.TOKENHUD_TEST_NOW === undefined) return null;
  const now = Number(env.TOKENHUD_TEST_NOW);
  return Number.isFinite(now) ? now : null;
}

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
    now: testClock(env) ?? Date.now(),
    ppid: process.ppid,
    readProc: procReader(),
    log: hookLog(hookLogPath(env, home), home),
  });
  if (out !== "") process.stdout.write(out);
  return 0;
}
