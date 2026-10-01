import { closeSync, openSync, readSync } from "node:fs";
import { emptyStats, type FileEntry, type ReadStats, readClaudeFile } from "../sources/claude.ts";
import { type CodexLimitSnapshot, type ParentLookup, readCodexFile } from "../sources/codex.ts";
import type { Provider } from "../sources/roots.ts";

/**
 * Reading one transcript from a cursor, the same in a parse Worker and inline. Provider
 * neutral: each provider's reader turns new complete lines into per-key `FileEntry`s and
 * may carry state between reads (Codex: counters, model, tier and replay progress; Claude
 * has none).
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

/** What every task of one pass shares: a Codex session id -> its rollouts (to find parents). */
export interface ReadContext {
  codexSessions?: Readonly<Record<string, readonly string[]>>;
}

export interface ReadResult {
  path: string;
  /** Offset after the last complete line. */
  offset: number;
  tail: string | null;
  state: string | null;
  /** True when the file was read again from the start (its tail or state did not check out). */
  restarted: boolean;
  entries: FileEntry[];
  /** Keys that must not stay in the store (a Codex child's inherited usage). */
  drop: bigint[];
  /** Keys an earlier read reported in `drop` that this read counts after all. */
  restore: bigint[];
  /** The newest Codex rate-limit snapshot in the bytes read. */
  limits: CodexLimitSnapshot | null;
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

interface Read {
  offset: number;
  entries: FileEntry[];
  stats: ReadStats;
  state: string | null;
  drop: bigint[];
  restore: bigint[];
  limits: CodexLimitSnapshot | null;
  restarted: boolean;
}

type Reader = (path: string, start: number, state: string | null, context: ReadContext) => Read;

/** The first rollout of `sessionId` that is not `child` itself. */
function parentLookup(context: ReadContext): ParentLookup {
  return (sessionId, child) =>
    context.codexSessions?.[sessionId]?.find((path) => path !== child) ?? null;
}

const READERS: Record<Provider, Reader> = {
  claude: (path, start) => ({
    ...readClaudeFile(path, start),
    state: null,
    drop: [],
    restore: [],
    limits: null,
    restarted: false,
  }),
  codex: (path, start, state, context) =>
    readCodexFile(path, start, state, { parents: parentLookup(context) }),
};

/** Reads `task`; never throws (an I/O error comes back as `error`). */
export function readTask(task: ReadTask, context: ReadContext = {}): ReadResult {
  const t0 = performance.now();
  const reader = READERS[task.provider];
  try {
    let start = task.start;
    let restarted = false;
    // A file rewritten in place to at least its old size keeps its inode and grows, but
    // the bytes before the cursor are no longer the ones read: start over.
    if (start > 0 && tailHash(task.path, start) !== task.tail) {
      start = 0;
      restarted = true;
    }
    const read = reader(task.path, start, restarted ? null : task.state, context);
    return {
      path: task.path,
      offset: read.offset,
      tail: tailHash(task.path, read.offset),
      state: read.state,
      restarted: restarted || read.restarted,
      entries: read.entries,
      drop: read.drop,
      restore: read.restore,
      limits: read.limits,
      stats: read.stats,
      ms: performance.now() - t0,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "EIO";
    return {
      path: task.path,
      offset: task.start,
      tail: null,
      state: task.state,
      restarted: false,
      entries: [],
      drop: [],
      restore: [],
      limits: null,
      stats: emptyStats(),
      error: code,
      ms: performance.now() - t0,
    };
  }
}
