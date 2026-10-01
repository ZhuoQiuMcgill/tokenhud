import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { configDir } from "../paths.ts";

/**
 * The MCP heartbeat file the TUI reads for its footer ("MCP ● 2 agents") and the Overview's
 * agents card. Each running `tokenhud mcp` (one per Claude Code session) keeps
 * `<config dir>/mcp/<pid>.json`:
 *
 *     {"pid", "host", "started_at", "updated_at", "calls": [{"at", "tool", "account"}]}
 *
 * Times are epoch ms; `account` is the label a call resolved to, or null. The file is
 * rewritten atomically on start, after each tool call and at least every minute; it keeps
 * only the calls of the last 10 minutes (at most 20) and is removed on exit. It holds tool
 * names and account labels only. This is the format T10's reader (`src/mcp-heartbeat.ts`)
 * parses: a file not rewritten for 3 minutes, or whose pid is gone, is a stopped server.
 */

export const MCP_DIR_NAME = "mcp";
export const MCP_BEAT_MS = 60_000;
export const AGENT_WINDOW_MS = 10 * 60_000;
const MAX_CALLS = 20;

export interface McpCall {
  at: number;
  tool: string;
  account: string | null;
}

export function mcpDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), MCP_DIR_NAME);
}

export class Heartbeat {
  readonly #path: string;
  readonly #dir: string;
  readonly #pid: number;
  readonly #host: string;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #log: (message: string) => void;
  #calls: McpCall[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #failed = false;

  constructor(
    dir: string,
    options: { pid?: number; now?: () => number; log?: (message: string) => void } = {},
  ) {
    this.#dir = dir;
    this.#pid = options.pid ?? process.pid;
    this.#path = join(dir, `${this.#pid}.json`);
    this.#host = hostname();
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#log = options.log ?? (() => {});
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
