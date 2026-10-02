import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "./paths.ts";

/**
 * The single-writer ingest lock. Only the process holding it ingests into the store: the
 * TUI while it runs, else the MCP server for one pass. Others read the store as it is.
 *
 * It is an operating-system lock, so the kernel releases it when its holder ends, however
 * it ends (`kill -9`, a crash, a power cut), and there is no stale-lock protocol to get
 * wrong: the holder keeps an exclusive SQLite lock on `<config dir>/ingest.lock.db`, taken
 * with `locking_mode=EXCLUSIVE` and a write, for as long as its connection stays open.
 * SQLite implements it with POSIX advisory locks on Unix and `LockFileEx` on Windows, both
 * per open file and dropped by the kernel with the process. A second connection, in this
 * process or another, gets SQLITE_BUSY at once.
 *
 * Two rules keep it sound:
 * - The lock file is never deleted: a waiter must lock the same file, not a new one. The
 *   one exception is a file no process of this user can lock at all (see `rebuild`).
 * - Nothing in the holding process opens the lock file another way (POSIX drops a
 *   process's locks when any of its descriptors for the file is closed).
 *
 * A damaged lock file never blocks ingest for good (critique r2): one SQLite can't read is
 * rebuilt, logged once, and taken.
 *
 * Who holds it, with a heartbeat, is written beside it in `ingest.lock.db.holder.json`
 * for display ("another tokenhud is ingesting"). That file decides nothing.
 */

export const LOCK_FILE_NAME = "ingest.lock.db";
/** How often the holder refreshes its holder record (display only). */
export const HEARTBEAT_MS = 10_000;

export type LockOwner = "tui" | "mcp" | "cli";

export interface LockHolder {
  pid: number;
  host: string;
  owner: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface LockOptions {
  /** The lock file; default `<config dir>/ingest.lock.db`. */
  path?: string;
  owner: LockOwner;
  now?: () => number;
  /** Told, once per lock file and process, that a damaged lock file was rebuilt. */
  log?: (message: string) => void;
}

export function lockPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), LOCK_FILE_NAME);
}

function holderPath(path: string): string {
  return `${path}.holder.json`;
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

function busy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** Lock files whose rebuild this process has logged. */
const rebuilt = new Set<string>();

/**
 * Makes a damaged lock file at `path` usable again, after `error` from trying to lock it.
 * Returns false when the error isn't about the file (or there is no file: an unwritable
 * config dir), or the file can't be fixed.
 *
 * - **Not a database, or a corrupt one** (`SQLITE_NOTADB`, `SQLITE_CORRUPT`): SQLite read
 *   its header, so it held a shared lock and nobody held the exclusive one. It is emptied in
 *   place (an empty file is an empty database) and keeps its inode, so every contender
 *   still meets on the same file, and one that took the lock meanwhile still holds it.
 * - **Not openable for writing** (`SQLITE_CANTOPEN`, `SQLITE_READONLY`, `SQLITE_PERM`):
 *   an exclusive lock needs write access, so no process of this user can hold one on it.
 *   It is moved aside to `<path>.damaged` and a new one is created. Another user's process
 *   (root's) holding it would then share the lock with us: duplicate work only, since the
 *   store stays correct under two writers.
 */
function rebuild(path: string, error: unknown, log?: (message: string) => void): boolean {
  const code = String((error as { code?: unknown }).code ?? "");
  const corrupt = /^SQLITE_(NOTADB|CORRUPT)/.test(code);
  const unwritable = /^SQLITE_(CANTOPEN|READONLY|PERM)/.test(code);
  if (!(corrupt || unwritable) || !existsSync(path)) return false;
  try {
    if (corrupt) {
      truncateSync(path, 0);
    } else {
      try {
        // Another contender may have replaced it already: then it is ours to lock (or busy).
        accessSync(path, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        rmSync(`${path}.damaged`, { recursive: true, force: true });
        renameSync(path, `${path}.damaged`);
      }
    }
  } catch {
    return false;
  }
  if (!rebuilt.has(path)) {
    rebuilt.add(path);
    log?.(
      corrupt
        ? `the ingest lock file was damaged (${code}); emptied it and took the lock`
        : `the ingest lock file could not be written (${code}); moved it to ${LOCK_FILE_NAME}.damaged and made a new one`,
    );
  }
  return true;
}

/**
 * A connection to the lock file holding its exclusive lock, or null when another connection
 * holds it. Throws when the file can't be locked at all.
 */
function lockDatabase(path: string, token: string): Database | null {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    // The write takes the exclusive lock; in EXCLUSIVE mode it is kept after COMMIT.
    db.exec("BEGIN EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY, token TEXT NOT NULL)");
    db.query("INSERT OR REPLACE INTO lock (id, token) VALUES (1, $token)").run({ token });
    db.exec("COMMIT");
  } catch (error) {
    db.close();
    if (busy(error)) return null;
    throw error;
  }
  return db;
}

/** Who holds the lock at `path`, from the holder's record; null if there is none. Display only. */
export function lockHolder(path: string = lockPath()): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(holderPath(path), "utf8")) as Record<string, unknown>;
    const { pid, host, owner, started_at, heartbeat_at } = raw;
    if (
      !Number.isInteger(pid) ||
      typeof host !== "string" ||
      typeof owner !== "string" ||
      typeof started_at !== "number" ||
      typeof heartbeat_at !== "number"
    ) {
      return null;
    }
    return { pid: pid as number, host, owner, startedAt: started_at, heartbeatAt: heartbeat_at };
  } catch {
    return null;
  }
}

export class WriterLock {
  readonly path: string;
  readonly token: string;
  readonly #db: Database;
  readonly #holder: LockHolder;
  readonly #now: () => number;
  #held = true;

  private constructor(
    path: string,
    db: Database,
    holder: LockHolder,
    token: string,
    now: () => number,
  ) {
    this.path = path;
    this.#db = db;
    this.#holder = holder;
    this.token = token;
    this.#now = now;
    this.#writeHolder();
  }

  /**
   * Takes the lock, or returns null at once when another connection holds it. A damaged
   * lock file is rebuilt first. Throws when the lock file can't be created, opened or
   * rebuilt (an unwritable config directory).
   */
  static tryAcquire(options: LockOptions): WriterLock | null {
    const path = options.path ?? lockPath();
    const now = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true });
    const token = randomUUID();
    let db: Database | null;
    try {
      db = lockDatabase(path, token);
    } catch (error) {
      if (!rebuild(path, error, options.log)) throw error;
      db = lockDatabase(path, token);
    }
    if (db === null) return null;
    const at = now();
    const holder: LockHolder = {
      pid: process.pid,
      host: hostname(),
      owner: options.owner,
      startedAt: at,
      heartbeatAt: at,
    };
    return new WriterLock(path, db, holder, token, now);
  }

  get held(): boolean {
    return this.#held;
  }

  #writeHolder(): void {
    const h = this.#holder;
    const path = holderPath(this.path);
    const tmp = `${path}.${this.token}.tmp`;
    try {
      writeFileSync(
        tmp,
        `${JSON.stringify({
          pid: h.pid,
          host: h.host,
          owner: h.owner,
          token: this.token,
          started_at: h.startedAt,
          heartbeat_at: h.heartbeatAt,
        })}\n`,
      );
      renameSync(tmp, path);
    } catch {
      // Display only: without a record, others show a generic notice.
      rmSync(tmp, { force: true });
    }
  }

  /**
   * Refreshes the holder record's heartbeat. The lock itself can't be lost while this
   * process holds it, so this is true until `release()`.
   */
  heartbeat(): boolean {
    if (!this.#held) return false;
    this.#holder.heartbeatAt = this.#now();
    this.#writeHolder();
    return true;
  }

  /** Gives the lock up. Safe to call more than once. */
  release(): void {
    if (!this.#held) return;
    this.#held = false;
    // The record first: once the lock is free, a new holder writes its own.
    try {
      const raw = JSON.parse(readFileSync(holderPath(this.path), "utf8")) as { token?: unknown };
      if (raw.token === this.token) rmSync(holderPath(this.path), { force: true });
    } catch {
      // no record, or not ours
    }
    this.#db.close();
  }
}
