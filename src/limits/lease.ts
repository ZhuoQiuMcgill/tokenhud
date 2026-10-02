import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-process exclusion through lease files, for the limits fetchers of the ingest
 * Worker and every MCP server process, which share `~/.config/tokenhud/`.
 *
 * A lease is a file created with O_CREAT | O_EXCL (`wx`), so exactly one process can hold
 * it. It records who holds it and since when. A holder that crashed leaves it behind, so a
 * lease older than its time-to-live is stale and may be taken over:
 * 1. the taker renames the lease file to a name of its own (atomic: one taker wins);
 * 2. if what it moved is the stale lease it judged, it deletes it and creates its own;
 * 3. if it moved a fresh lease (another taker got there first), it links that lease back
 *    and backs off.
 * Releasing deletes the file only while it still names this holder.
 */

interface Holder {
  pid: number;
  nonce: string;
  /** Epoch ms when it was taken. */
  at: number;
}

export interface Lease {
  readonly path: string;
  /** Deletes the lease file if this process still holds it. Never throws. */
  release(): void;
}

function readHolder(path: string): Holder | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { pid, nonce, at } = value as Record<string, unknown>;
    if (typeof pid !== "number" || typeof nonce !== "string" || typeof at !== "number") {
      return null;
    }
    return { pid, nonce, at };
  } catch {
    return null;
  }
}

/**
 * Whether `error` may mean another process has the file right now. On Windows, opening or
 * deleting a file that another process has open, or is deleting (a "delete pending"
 * file), fails with EPERM or EBUSY instead of EEXIST or success. Elsewhere those codes are
 * real permission errors. On Windows they can be real too (an ACL, a read-only folder), so
 * `create` treats them as contention only while the lease file is there, and otherwise
 * only for a moment (critique m6).
 */
export function isContention(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

/** How long a release keeps retrying a lease file another process has open (Windows). */
const RELEASE_RETRY_MS = 500;
/** How long a create retries EPERM/EBUSY with no lease file to show for it (Windows). */
export const CONTENTION_WINDOW_MS = 250;

/** Whether a lease file is at `path` (one being deleted, which stat refuses, is not). */
function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the lease file holding `holder`; false when another process has it. EPERM and
 * EBUSY (Windows) count as "another process has it" while the file is there; with no file
 * they are retried for `CONTENTION_WINDOW_MS` (one being deleted goes away), then thrown:
 * a permission error is never mistaken for a lease that is never released.
 */
function create(path: string, holder: Holder): boolean {
  const deadline = Date.now() + CONTENTION_WINDOW_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(path, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      if (!isContention(error)) throw error;
      if (present(path)) return false;
      if (Date.now() > deadline) throw error;
      Bun.sleepSync(2);
    }
  }
  try {
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Removes the stale lease `judged` (as read) from `path`. False when another process
 * renewed or took the lease in the meantime.
 */
function takeOver(path: string, judged: Holder | null, nonce: string): boolean {
  const moved = `${path}.${nonce}.takeover`;
  try {
    renameSync(path, moved);
  } catch {
    return true; // gone already: try to create it again
  }
  const found = readHolder(moved);
  const same =
    found === judged ||
    (found !== null && judged !== null && found.nonce === judged.nonce && found.at === judged.at);
  if (!same) {
    try {
      linkSync(moved, path); // put the fresh lease back, unless a third process holds one
    } catch {
      // that third process holds the lease now
    }
  }
  rmSync(moved, { force: true });
  return same;
}

/**
 * Deletes the lease file while it still names `nonce`. A file another process is reading
 * at that moment (Windows refuses then) is retried for a moment, so the next holder
 * doesn't wait out the time-to-live. Never throws.
 */
function release(path: string, nonce: string): void {
  const deadline = Date.now() + RELEASE_RETRY_MS;
  for (;;) {
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as { nonce?: unknown };
      if (held.nonce === nonce) rmSync(path, { force: true });
      return;
    } catch (error) {
      if (!isContention(error) || Date.now() > deadline) return; // gone, damaged, or not ours
      Bun.sleepSync(2);
    }
  }
}

/**
 * Takes the lease at `path`, or returns null when another live process holds it. A lease
 * older than `ttlMs` (or unreadable for that long) is stale and taken over.
 */
export function tryLease(path: string, ttlMs: number, now: () => number = Date.now): Lease | null {
  mkdirSync(dirname(path), { recursive: true });
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    const holder: Holder = { pid: process.pid, nonce, at: now() };
    if (create(path, holder)) {
      return { path, release: () => release(path, nonce) };
    }
    const current = readHolder(path);
    let since: number;
    if (current !== null) since = current.at;
    else {
      // Being written right now, or damaged: judged by the file's age instead.
      try {
        since = statSync(path).mtimeMs;
      } catch {
        continue; // released meanwhile: try again
      }
    }
    if (now() - since < ttlMs) return null;
    if (!takeOver(path, current, nonce)) return null;
  }
  return null;
}

/** `withLock` waited as long as a holder may live and the lock is still taken. */
export class LeaseTimeoutError extends Error {
  readonly code = "ELEASETIMEOUT";
  constructor(path: string, waitedMs: number) {
    super(`the lock ${path} stayed taken for ${waitedMs} ms`);
    this.name = "LeaseTimeoutError";
  }
}

/**
 * Runs `fn` while holding the lock file `path`, waiting for another holder (a short
 * read-modify-write elsewhere) for up to `ttlMs` and a second, after which its lock is
 * stale and taken over. `fn` never runs without the lock: a lock that stays taken past
 * that (a holder that is stuck, not dead, or a Windows lease file that can't be removed)
 * throws `LeaseTimeoutError`, and the caller does without its write.
 */
export function withLock<T>(path: string, fn: () => T, ttlMs = 5_000): T {
  const started = Date.now();
  const deadline = started + ttlMs + 1_000;
  let lease = tryLease(path, ttlMs);
  while (lease === null) {
    if (Date.now() >= deadline) throw new LeaseTimeoutError(path, Date.now() - started);
    Bun.sleepSync(2);
    lease = tryLease(path, ttlMs);
  }
  try {
    return fn();
  } finally {
    lease.release();
  }
}
