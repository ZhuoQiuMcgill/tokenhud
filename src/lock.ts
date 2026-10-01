import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./paths.ts";

/**
 * The single-writer ingest lock. Only the process holding it ingests into the store: the
 * TUI while it runs, else the MCP server (T9) or a refreshing command for one pass. Others
 * read the store as it is.
 *
 * The lock is a file, `<config dir>/ingest.lock`, holding JSON:
 * `{pid, host, owner, token, started_at, heartbeat_at}` (epoch ms). The holder rewrites
 * `heartbeat_at` every `HEARTBEAT_MS`. A lock is stale, and may be taken over, when its
 * process is gone (same host) or its heartbeat is older than `STALE_MS` (any host, so a
 * home directory shared over the network still works, and a suspended holder is replaced).
 *
 * Every step is atomic on the file system:
 * - A lock is created whole, by hard-linking a fully written temp file into place, which
 *   fails if a lock exists.
 * - A stale lock is cleared only by the process holding the takeover file
 *   (`ingest.lock.takeover`, created the same way), which checks again that the lock is
 *   stale, removes it and then competes for the empty slot like everyone else. So of any
 *   number of processes finding the same stale lock, exactly one ends up holding it.
 * - A holder that finds another token in the file on its next heartbeat has lost the lock
 *   (it was stale, e.g. suspended) and stops writing.
 *
 * Exclusivity saves duplicate work; it is not what keeps the store correct (SQLite
 * serialises writers and every upsert is an idempotent max-merge).
 */

export const LOCK_FILE_NAME = "ingest.lock";
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 30_000;
/** A takeover file this old was left by a process that died mid-takeover. */
const TAKEOVER_STALE_MS = 5000;

export type LockOwner = "tui" | "mcp" | "cli";

export interface LockHolder {
  pid: number;
  host: string;
  owner: string;
  token: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface LockOptions {
  /** The lock file; default `<config dir>/ingest.lock`. */
  path?: string;
  owner: LockOwner;
  now?: () => number;
  pid?: number;
  host?: string;
  staleMs?: number;
  /** Whether a process with this pid exists on this host. */
  isAlive?: (pid: number) => boolean;
}

export function lockPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), LOCK_FILE_NAME);
}

/** `process.kill(pid, 0)`: ESRCH means no such process; EPERM means it exists (another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type Read =
  | { kind: "missing" }
  | { kind: "invalid"; mtimeMs: number }
  | { kind: "held"; holder: LockHolder };

function readFile(path: string): Read {
  let text: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const { pid, host, owner, token, started_at, heartbeat_at } = raw;
    if (
      Number.isInteger(pid) &&
      typeof host === "string" &&
      typeof owner === "string" &&
      typeof token === "string" &&
      typeof started_at === "number" &&
      typeof heartbeat_at === "number"
    ) {
      return {
        kind: "held",
        holder: {
          pid: pid as number,
          host,
          owner,
          token,
          startedAt: started_at,
          heartbeatAt: heartbeat_at,
        },
      };
    }
  } catch {
    // fall through: unreadable JSON is a damaged lock
  }
  return { kind: "invalid", mtimeMs };
}

function serialise(holder: LockHolder): string {
  return `${JSON.stringify({
    pid: holder.pid,
    host: holder.host,
    owner: holder.owner,
    token: holder.token,
    started_at: holder.startedAt,
    heartbeat_at: holder.heartbeatAt,
  })}\n`;
}

interface Clock {
  now: () => number;
  host: string;
  staleMs: number;
  isAlive: (pid: number) => boolean;
}

function clockOf(options: Omit<LockOptions, "owner"> = {}): Clock {
  return {
    now: options.now ?? Date.now,
    host: options.host ?? hostname(),
    staleMs: options.staleMs ?? STALE_MS,
    isAlive: options.isAlive ?? processAlive,
  };
}

function stale(read: Read, clock: Clock): boolean {
  if (read.kind === "missing") return true;
  // A damaged file may be one being written by a filesystem without hard links: give it
  // the same grace as a heartbeat.
  if (read.kind === "invalid") return clock.now() - read.mtimeMs > clock.staleMs;
  const { holder } = read;
  if (holder.host === clock.host && !clock.isAlive(holder.pid)) return true;
  return clock.now() - holder.heartbeatAt > clock.staleMs;
}

/** The live holder of the lock at `path`, or null when it is free or stale. */
export function lockHolder(
  path: string = lockPath(),
  options: Omit<LockOptions, "owner"> = {},
): LockHolder | null {
  const read = readFile(path);
  if (read.kind !== "held" || stale(read, clockOf(options))) return null;
  return read.holder;
}

/** Writes `text` to a fresh temp file beside `path` and returns its name. */
function writeTemp(path: string, text: string): string {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  return tmp;
}

/** Creates the lock file with `text`, failing (false) if one exists. */
function createExclusive(path: string, text: string): boolean {
  const tmp = writeTemp(path, text);
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    // No hard links here: create it in place. A reader may briefly see an empty file,
    // which counts as held until it is STALE_MS old.
    try {
      writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw fallback;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Removes `path`; false when it can't be removed now (Windows: open in another process). */
function remove(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes the takeover file, the right to clear a stale lock. One left behind by a process
 * that died holding it is cleared once it is TAKEOVER_STALE_MS old (by the file's age).
 */
function takeTurn(path: string, token: string): boolean {
  const text = `${JSON.stringify({ token })}\n`;
  if (createExclusive(path, text)) return true;
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return createExclusive(path, text); // released meanwhile
  }
  if (Date.now() - mtime <= TAKEOVER_STALE_MS || !remove(path)) return false;
  return createExclusive(path, text);
}

export class WriterLock {
  readonly path: string;
  readonly token: string;
  readonly #clock: Clock;
  readonly #holder: LockHolder;
  #held = true;

  private constructor(path: string, holder: LockHolder, clock: Clock) {
    this.path = path;
    this.token = holder.token;
    this.#holder = holder;
    this.#clock = clock;
  }

  /**
   * Takes the lock if it is free or stale. Null when a live process holds it. Throws only
   * when the config directory itself cannot be written.
   */
  static tryAcquire(options: LockOptions): WriterLock | null {
    const path = options.path ?? lockPath();
    const clock = clockOf(options);
    mkdirSync(dirname(path), { recursive: true });
    const now = clock.now();
    const holder: LockHolder = {
      pid: options.pid ?? process.pid,
      host: clock.host,
      owner: options.owner,
      token: randomUUID(),
      startedAt: now,
      heartbeatAt: now,
    };
    const text = serialise(holder);
    if (createExclusive(path, text)) return new WriterLock(path, holder, clock);
    const current = readFile(path);
    if (current.kind !== "missing" && !stale(current, clock)) return null;
    // Stale (or just released): clear it only while holding the takeover file, after
    // checking again, then compete for the empty slot with whoever else is trying.
    const turn = `${path}.takeover`;
    if (!takeTurn(turn, holder.token)) return null;
    try {
      const again = readFile(path);
      if (again.kind !== "missing" && (!stale(again, clock) || !remove(path))) return null;
      return createExclusive(path, text) ? new WriterLock(path, holder, clock) : null;
    } finally {
      remove(turn);
    }
  }

  get held(): boolean {
    return this.#held;
  }

  /**
   * Refreshes the heartbeat. Returns false, and stops holding, when another process has
   * taken the lock over (this one was stale, e.g. suspended for longer than STALE_MS).
   */
  heartbeat(): boolean {
    if (!this.#held) return false;
    const current = readFile(this.path);
    if (current.kind !== "held" || current.holder.token !== this.token) {
      this.#held = false;
      return false;
    }
    this.#holder.heartbeatAt = this.#clock.now();
    const tmp = writeTemp(this.path, serialise(this.#holder));
    try {
      renameSync(tmp, this.path);
    } catch {
      // Windows refuses to replace a file another process has open; the next beat retries,
      // and STALE_MS allows for a few missed ones.
      rmSync(tmp, { force: true });
    }
    return true;
  }

  /** Gives the lock up, if this process still holds it. Safe to call more than once. */
  release(): void {
    if (!this.#held) return;
    this.#held = false;
    const current = readFile(this.path);
    // If it can't be removed now (Windows, a reader has it open), it is stale once this
    // process has exited, and the next instance takes it over at once.
    if (current.kind === "held" && current.holder.token === this.token) remove(this.path);
  }
}
