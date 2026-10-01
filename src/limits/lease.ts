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
 * Whether `error` means another process has the file right now. On Windows, opening or
 * deleting a file that another process has open, or is deleting (a "delete pending"
 * file), fails with EPERM or EBUSY instead of EEXIST or success: that is contention, to
 * retry, never a failure. Elsewhere those codes are real permission errors.
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

function create(path: string, holder: Holder): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || isContention(error)) return false;
    throw error;
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

/**
 * Runs `fn` while holding the lock file `path`, waiting for another holder (a short
 * read-modify-write elsewhere) for up to `ttlMs`, after which its lock is stale.
 */
export function withLock<T>(path: string, fn: () => T, ttlMs = 5_000): T {
  const deadline = Date.now() + ttlMs + 1_000;
  let lease = tryLease(path, ttlMs);
  while (lease === null && Date.now() < deadline) {
    Bun.sleepSync(2);
    lease = tryLease(path, ttlMs);
  }
  try {
    // Past the deadline the holder is stuck, not dead; proceeding beats hanging the caller.
    return fn();
  } finally {
    lease?.release();
  }
}
