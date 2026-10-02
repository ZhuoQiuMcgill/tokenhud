// `tokenhud mcp`: the stdio MCP server Claude Code launches (see src/mcp/server.ts). It
// takes no options: Claude Code passes the session's environment, which picks the account,
// and XDG_CONFIG_HOME, as everywhere, moves tokenhud's store and config.

import { WriterLock } from "../lock.ts";
import { runMcpServer } from "../mcp/server.ts";

export const MCP_HELP = `Usage:
  tokenhud mcp

Runs the tokenhud MCP server on stdin/stdout, for Claude Code. Tools: limits,
should_wait, wait_for_reset, usage, accounts. Install it once per Claude account
(each CLAUDE_CONFIG_DIR):
  claude mcp add -s user tokenhud -- tokenhud mcp
or install the tokenhud plugin, which also adds a skill that says when to use it.`;

export async function runMcp(args: readonly string[]): Promise<number> {
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
