import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { processAlive } from "./lock.ts";
import { configDir } from "./paths.ts";

/**
 * MCP activity for the TUI's footer ("MCP ● 2 agents") and the Overview's agents card.
 *
 * Each running `tokenhud mcp` (one per Claude Code session, so one per agent) keeps one
 * small file, `<config dir>/mcp/<pid>.json`:
 * `{pid, host, started_at, updated_at, calls: [{at, tool, account}]}` (epoch ms; `account`
 * is the account label the call resolved to, or null). The server rewrites it atomically on
 * start, after each tool call and at least every `MCP_BEAT_MS`, keeps only calls from the
 * last `AGENT_WINDOW_MS`, and removes it on exit. Nothing in it is content: tool names and
 * account labels only.
 *
 * T10 defines the format and both sides; T9's server is the writer.
 */

export const MCP_DIR_NAME = "mcp";
export const MCP_BEAT_MS = 60_000;
/** A file not rewritten for this long belongs to a server that is gone (another host's). */
export const MCP_ALIVE_MS = 3 * MCP_BEAT_MS;
/** "Agents that queried the MCP server in the last 10 min." */
export const AGENT_WINDOW_MS = 10 * 60_000;

export interface McpCall {
  at: number;
  tool: string;
  account: string | null;
}

export interface McpHeartbeat {
  pid: number;
  host: string;
  startedAt: number;
  updatedAt: number;
  calls: McpCall[];
}

export interface McpActivity {
  /** MCP servers running now. */
  servers: number;
  /** Servers (agent sessions) with a tool call in the last 10 minutes. */
  agents: number;
  /** The latest call of any server, newest first, at most 20. */
  recent: McpCall[];
}

export function mcpDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), MCP_DIR_NAME);
}

/** Writes a server's heartbeat atomically, keeping only calls inside the agent window. */
export function writeMcpHeartbeat(dir: string, beat: McpHeartbeat): void {
  mkdirSync(dir, { recursive: true });
  const calls = beat.calls.filter((c) => beat.updatedAt - c.at <= AGENT_WINDOW_MS).slice(-20);
  const path = join(dir, `${beat.pid}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({
      pid: beat.pid,
      host: beat.host,
      started_at: beat.startedAt,
      updated_at: beat.updatedAt,
      calls,
    })}\n`,
  );
  renameSync(tmp, path);
}

export function removeMcpHeartbeat(dir: string, pid: number): void {
  rmSync(join(dir, `${pid}.json`), { force: true });
}

function parse(text: string): McpHeartbeat | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const { pid, host, started_at, updated_at, calls } = raw;
    if (
      !Number.isInteger(pid) ||
      typeof host !== "string" ||
      typeof started_at !== "number" ||
      typeof updated_at !== "number" ||
      !Array.isArray(calls)
    ) {
      return null;
    }
    const valid = calls.filter(
      (c): c is McpCall =>
        typeof c === "object" &&
        c !== null &&
        typeof c.at === "number" &&
        typeof c.tool === "string" &&
        (typeof c.account === "string" || c.account === null),
    );
    return { pid: pid as number, host, startedAt: started_at, updatedAt: updated_at, calls: valid };
  } catch {
    return null;
  }
}

/**
 * What the MCP servers are doing, from their heartbeat files. A missing directory or a
 * damaged file reads as no activity; nothing here throws.
 */
export function readMcpActivity(
  dir: string,
  now: number,
  options: { host?: string; isAlive?: (pid: number) => boolean } = {},
): McpActivity {
  const host = options.host ?? hostname();
  const isAlive = options.isAlive ?? processAlive;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return { servers: 0, agents: 0, recent: [] };
  }
  let servers = 0;
  let agents = 0;
  const recent: McpCall[] = [];
  for (const name of names) {
    let beat: McpHeartbeat | null;
    try {
      beat = parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (beat === null) continue;
    const running = beat.host === host ? isAlive(beat.pid) : now - beat.updatedAt <= MCP_ALIVE_MS;
    if (running) servers++;
    const calls = beat.calls.filter((c) => now - c.at <= AGENT_WINDOW_MS);
    if (calls.length > 0) agents++;
    recent.push(...calls);
  }
  recent.sort((a, b) => b.at - a.at);
  return { servers, agents, recent: recent.slice(0, 20) };
}
