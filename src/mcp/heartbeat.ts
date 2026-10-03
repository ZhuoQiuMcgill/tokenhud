import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, relative } from "node:path";
import { processAlive } from "../lock.ts";
import { MCP_DIR_NAME, mcpDir } from "../paths.ts";

export { MCP_DIR_NAME, mcpDir };

/**
 * The MCP heartbeat file the TUI reads for its footer ("MCP ● 2 agents") and the Overview's
 * agents card. Each running `tokenhud mcp` (one per Claude Code session) keeps
 * `<config dir>/mcp/<pid>.json`:
 *
 *     {"pid", "host", "project", "session", "started_at", "updated_at",
 *      "calls": [{"at", "tool", "account"}]}
 *
 * Times are epoch ms; `account` is the label a call resolved to, or null. `project` is the
 * name of the directory the server runs in, as Claude Code starts it in its session's
 * project (`projectOf`), or null. `session` is the Claude Code session it serves, or null:
 * a session alert (src/alerts/store.ts) lives while its session shows activity. The file
 * is rewritten atomically on start, after each tool call and at least every minute; it
 * keeps only the calls of the last 10 minutes (at most 20) and is removed on exit. It
 * holds tool names, account labels, that one directory name and the session id, never a
 * path. The TUI reads it with `readMcpActivity` below; `tokenhud json` never does.
 */

export const MCP_BEAT_MS = 60_000;
export const AGENT_WINDOW_MS = 10 * 60_000;
const MAX_CALLS = 20;

export interface McpCall {
  at: number;
  tool: string;
  account: string | null;
}

/**
 * The project a session runs in, as the agents card names it: the basename of `cwd`, never
 * the path, which would show the user's name and where their work is. Null for the home
 * directory, whose name is the user's, and for a filesystem root, which has none.
 */
export function projectOf(cwd: string, home: string): string | null {
  if (relative(home, cwd) === "") return null;
  const name = basename(cwd);
  return name === "" ? null : name;
}

export class Heartbeat {
  readonly #path: string;
  readonly #dir: string;
  readonly #pid: number;
  readonly #host: string;
  readonly #project: string | null;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #log: (message: string) => void;
  readonly #session: () => string | null;
  #calls: McpCall[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #failed = false;

  constructor(
    dir: string,
    options: {
      pid?: number;
      /** The server's working directory (tests pass a made-up one). */
      cwd?: string;
      now?: () => number;
      log?: (message: string) => void;
      /** The Claude Code session the server serves now. */
      session?: () => string | null;
    } = {},
  ) {
    this.#dir = dir;
    this.#pid = options.pid ?? process.pid;
    this.#path = join(dir, `${this.#pid}.json`);
    this.#host = hostname();
    this.#project = projectOf(options.cwd ?? process.cwd(), homedir());
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#log = options.log ?? (() => {});
    this.#session = options.session ?? (() => null);
  }

  get path(): string {
    return this.#path;
  }

  /** Writes the file now and every minute; the timer never keeps the process alive. */
  start(): void {
    this.write();
    this.#timer = setInterval(() => this.write(), MCP_BEAT_MS);
    this.#timer.unref();
  }

  record(tool: string, account: string | null): void {
    this.#calls.push({ at: this.#now(), tool, account });
    this.write();
  }

  write(): void {
    const now = this.#now();
    this.#calls = this.#calls.filter((c) => now - c.at <= AGENT_WINDOW_MS).slice(-MAX_CALLS);
    const tmp = `${this.#path}.tmp`;
    try {
      mkdirSync(this.#dir, { recursive: true });
      writeFileSync(
        tmp,
        `${JSON.stringify({
          pid: this.#pid,
          host: this.#host,
          project: this.#project,
          session: this.#session(),
          started_at: this.#startedAt,
          updated_at: now,
          calls: this.#calls,
        })}\n`,
      );
      renameSync(tmp, this.#path);
      this.#failed = false;
    } catch (error) {
      removeQuietly(tmp);
      // Once per failure streak: a read-only config dir must not flood the log.
      if (!this.#failed) {
        this.#log(`cannot write the heartbeat file (${(error as NodeJS.ErrnoException).code})`);
      }
      this.#failed = true;
    }
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    removeQuietly(this.#path);
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // a read-only or vanished config dir: nothing to clean up
  }
}

// ── reading (the TUI's footer and agents card) ──────────────────────────────────

export interface McpActivity {
  /** Servers with a heartbeat in the last 10 minutes (on this host: whose process runs). */
  servers: number;
  /** Servers (agent sessions) with a tool call in the last 10 minutes. */
  agents: number;
  /** The latest calls of any server, newest first, at most 20. */
  recent: McpCall[];
  /** Each agent session's (server's) latest call in the last 10 minutes, newest first. */
  latest: AgentLatest[];
}

/** An agent session's latest call, with the project the session runs in. */
export interface AgentLatest extends McpCall {
  /** Its directory's name (`projectOf`); null when the heartbeat names none. */
  project: string | null;
}

interface Beat {
  pid: number;
  host: string;
  project: string | null;
  updatedAt: number;
  calls: McpCall[];
}

/**
 * The heartbeat's project as the TUI may show it: a name, never a path, even from a file
 * some other writer made, and without control characters, which would drive the terminal.
 */
function projectName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = basename(value).replace(/\p{Cc}/gu, "");
  return name === "" ? null : name;
}

function parse(text: string): Beat | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const { pid, host, project, updated_at, calls } = raw;
    if (
      !Number.isInteger(pid) ||
      typeof host !== "string" ||
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
    return {
      pid: pid as number,
      host,
      project: projectName(project),
      updatedAt: updated_at,
      calls: valid,
    };
  } catch {
    return null;
  }
}

/**
 * What the MCP servers are doing, from their heartbeat files. A server counts while its
 * file was rewritten in the last 10 minutes (and, on this host, its process still runs:
 * one that crashed left its file behind). A missing directory or a damaged file reads as
 * no activity; nothing here throws.
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
    return { servers: 0, agents: 0, recent: [], latest: [] };
  }
  let servers = 0;
  let agents = 0;
  const recent: McpCall[] = [];
  const latest: AgentLatest[] = [];
  for (const name of names) {
    let beat: Beat | null;
    try {
      beat = parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (beat === null) continue;
    const fresh = now - beat.updatedAt <= AGENT_WINDOW_MS;
    if (fresh && (beat.host !== host || isAlive(beat.pid))) servers++;
    const calls = beat.calls.filter((c) => now - c.at <= AGENT_WINDOW_MS);
    if (calls.length > 0) {
      agents++;
      // Calls are kept in the order made: on a tie the later one is the latest.
      latest.push({ ...calls.reduce((a, b) => (b.at >= a.at ? b : a)), project: beat.project });
    }
    recent.push(...calls);
  }
  recent.sort((a, b) => b.at - a.at);
  latest.sort((a, b) => b.at - a.at);
  return { servers, agents, recent: recent.slice(0, MAX_CALLS), latest };
}
