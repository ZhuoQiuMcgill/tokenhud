import { closeSync, openSync, readSync } from "node:fs";
import { emptyStats, type FileEntry, type ReadStats, readClaudeFile } from "../sources/claude.ts";
import type { Provider } from "../sources/roots.ts";

/**
 * Reading one transcript from a cursor, the same in a parse Worker and inline. Provider
 * neutral: each provider's reader turns new complete lines into per-key `FileEntry`s and
 * may carry state between reads (Codex counters, T5); Claude has none.
 */

export interface ReadTask {
  provider: Provider;
  path: string;
  /** Where to start; 0 for a new or rewritten file. */
  start: number;
  /** The cursor's tail hash at `start`, checked before reading on. */
  tail: string | null;
  state: string | null;
}

export interface ReadResult {
  path: string;
  /** Offset after the last complete line. */
  offset: number;
  tail: string | null;
  state: string | null;
  /** True when the tail check failed and the file was read again from the start. */
  restarted: boolean;
  entries: FileEntry[];
  stats: ReadStats;
  ms: number;
  /** An error code (ENOENT, EACCES, ...) when the file could not be read; nothing else is set. */
  error?: string;
}

/** Bytes before a cursor that its tail hash covers. */
const TAIL_BYTES = 64;

/** Hash of the up-to-64 bytes before `offset`, or null at offset 0. */
export function tailHash(path: string, offset: number): string | null {
  if (offset === 0) return null;
  const length = Math.min(TAIL_BYTES, offset);
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, length, offset - length);
    return n === length ? Bun.hash.wyhash(buf).toString(16) : null;
  } finally {
    closeSync(fd);
  }
}

const READERS: Partial<
  Record<
    Provider,
    (path: string, start: number) => { offset: number; entries: FileEntry[]; stats: ReadStats }
  >
> = {
  claude: (path, start) => readClaudeFile(path, start),
};

/** Whether tokenhud can read this provider's transcripts yet (Codex arrives in T5). */
export function canRead(provider: Provider): boolean {
  return READERS[provider] !== undefined;
}

/** Reads `task`; never throws (an I/O error comes back as `error`). */
export function readTask(task: ReadTask): ReadResult {
  const t0 = performance.now();
  const reader = READERS[task.provider];
  const base = {
    path: task.path,
    tail: null,
    state: task.state,
    restarted: false,
    entries: [],
    ms: 0,
  };
  if (reader === undefined) {
    return { ...base, offset: task.start, stats: emptyStats(), error: "ENOTSUP" };
  }
  try {
    let start = task.start;
    let restarted = false;
    // A file rewritten in place to at least its old size keeps its inode and grows, but
    // the bytes before the cursor are no longer the ones read: start over.
    if (start > 0 && tailHash(task.path, start) !== task.tail) {
      start = 0;
      restarted = true;
    }
    const read = reader(task.path, start);
    return {
      path: task.path,
      offset: read.offset,
      tail: tailHash(task.path, read.offset),
      state: restarted ? null : task.state,
      restarted,
      entries: read.entries,
      stats: read.stats,
      ms: performance.now() - t0,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "EIO";
    return {
      ...base,
      offset: task.start,
      stats: emptyStats(),
      error: code,
      ms: performance.now() - t0,
    };
  }
}
