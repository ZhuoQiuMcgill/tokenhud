import { type Counts, mergeCounts } from "../sources/claude.ts";
import { comparePyPaths } from "../sources/pypath.ts";
import type { Root } from "../sources/roots.ts";
import { StoreError } from "../store/errors.ts";
import { type Store, type StoredRow, UNATTRIBUTED, type UsageRow } from "../store/store.ts";
import type { Cursor, CursorCache } from "./cursors.ts";
import { type FileStat, statFiles } from "./files.ts";
import { readAll } from "./pool.ts";
import { canRead, type ReadResult, type ReadTask } from "./read.ts";

/**
 * One ingest pass: stat the given transcripts, read what changed since each file's cursor
 * (on parse Workers when there is a lot), merge the results into usage events in
 * cc-usage's file order, write the store, then advance the cursors.
 *
 * Order matters twice. cc-usage reads files sorted as Python sorts paths and the first line
 * it sees with a timestamp fixes an event's timestamp, so results are applied in that order
 * whichever Worker read them. And the store commits before the cursors move: a crash in
 * between only means the same bytes are read again, which the store's max-merge absorbs.
 */

export type LogLevel = "info" | "warn" | "error";
export type Log = (level: LogLevel, message: string) => void;

export interface PassFile {
  path: string;
  root: Root;
  /** A stat taken by the caller (a poll); stat-ed here when absent. */
  stat?: FileStat | null;
}

export interface ChangedEvent {
  type: "changed";
  /** Identities of the accounts whose rows were inserted or raised. */
  accounts: string[];
  /** The span of those rows' timestamps (epoch ms, inclusive). */
  fromTs: number;
  toTs: number;
}

export interface RootStats {
  label: string;
  provider: string;
  identity: string;
  /** Transcripts considered and actually read. */
  files: number;
  read: number;
  bytes: number;
  lines: number;
  candidates: number;
  usageLines: number;
  malformed: number;
  unkeyed: number;
  /** Distinct events this pass produced. */
  records: number;
  /** Rows the store did not have, and stored rows this pass raised. */
  inserted: number;
  changed: number;
  /** Events the store cannot hold (negative or oversized counts, a ts before 1970). */
  unstorable: number;
  /** Files that could not be read (vanished or unreadable mid-pass). */
  errors: number;
  /** Time spent reading this root's files, summed over Workers. */
  readMs: number;
}

export interface PassReport {
  roots: RootStats[];
  wallMs: number;
  event: ChangedEvent | null;
  /** Set when the store write failed; nothing was stored and no cursor moved. */
  storeError: string | null;
}

export interface PassContext {
  store: Store;
  cursors: CursorCache;
  poolSize: number;
  log: Log;
}

interface Event {
  root: Root;
  ts: number;
  model: string;
  counts: Counts;
}

function newRootStats(root: Root): RootStats {
  return {
    label: root.label,
    provider: root.provider,
    identity: root.identity,
    files: 0,
    read: 0,
    bytes: 0,
    lines: 0,
    candidates: 0,
    usageLines: 0,
    malformed: 0,
    unkeyed: 0,
    records: 0,
    inserted: 0,
    changed: 0,
    unstorable: 0,
    errors: 0,
    readMs: 0,
  };
}

const isCount = (v: number) => Number.isSafeInteger(v) && v >= 0;

/** Whether the store can hold `row` (its own validation would reject the whole batch). */
function storable(row: UsageRow): boolean {
  return (
    isCount(row.ts) &&
    isCount(row.inp) &&
    isCount(row.outp) &&
    isCount(row.cr) &&
    isCount(row.cc) &&
    (row.e5 === null || isCount(row.e5)) &&
    (row.e1 === null || isCount(row.e1))
  );
}

/** Whether upserting `row` changes `stored`: the store's merge condition. */
function raises(stored: StoredRow, row: UsageRow, unattributedId: number | undefined): boolean {
  return (
    row.inp > stored.inp ||
    row.outp > stored.outp ||
    row.cr > stored.cr ||
    row.cc > stored.cc ||
    (row.e5 !== null && (stored.e5 === null || row.e5 > stored.e5)) ||
    (row.e1 !== null && (stored.e1 === null || row.e1 > stored.e1)) ||
    (stored.model === unattributedId && row.model !== UNATTRIBUTED) ||
    row.tier > stored.tier
  );
}

function toRow(
  key: bigint,
  account: { provider: string; identity: string; label: string },
  ts: number,
  model: string,
  counts: Counts,
): UsageRow {
  return {
    key,
    provider: account.provider,
    identity: account.identity,
    label: account.label,
    ts,
    model,
    ...counts,
  };
}

/** Runs one pass over `files`. With `full`, cursors of files not listed are dropped. */
export async function runPass(
  ctx: PassContext,
  files: readonly PassFile[],
  full: boolean,
): Promise<PassReport> {
  const t0 = performance.now();
  const perRoot = new Map<Root, RootStats>();
  const statsOf = (root: Root) => {
    let s = perRoot.get(root);
    if (s === undefined) {
      s = newRootStats(root);
      perRoot.set(root, s);
    }
    return s;
  };

  // Stat what the caller did not.
  const missing = files.filter((f) => f.stat === undefined);
  const fresh = await statFiles(missing.map((f) => f.path));
  const stats = new Map<string, FileStat | null>();
  missing.forEach((f, i) => {
    stats.set(f.path, fresh[i] ?? null);
  });
  for (const f of files) if (f.stat !== undefined) stats.set(f.path, f.stat);

  // Plan: what to read, from where.
  const known = ctx.cursors.all();
  const tasks: ReadTask[] = [];
  const taskRoots: Root[] = [];
  const taskStats: FileStat[] = [];
  const bytes: number[] = [];
  const removals: string[] = [];
  const listed = new Set<string>();
  for (const file of files) {
    listed.add(file.path);
    const st = stats.get(file.path) ?? null;
    if (st === null) {
      if (known.has(file.path)) removals.push(file.path);
      continue;
    }
    if (!st.isFile || !canRead(file.root.provider)) continue;
    statsOf(file.root).files++;
    const cursor = known.get(file.path);
    let start = 0;
    if (cursor !== undefined) {
      const sameFile = cursor.dev === st.dev && cursor.ino === st.ino;
      if (sameFile && cursor.size === st.size && cursor.mtimeMs === st.mtimeMs) continue;
      // Shrunk below the cursor, or a different file at this path: read it from the start.
      if (sameFile && st.size >= cursor.offset) start = cursor.offset;
    }
    tasks.push({
      provider: file.root.provider,
      path: file.path,
      start,
      tail: start > 0 ? (cursor?.tail ?? null) : null,
      state: start > 0 ? (cursor?.state ?? null) : null,
    });
    taskRoots.push(file.root);
    taskStats.push(st);
    bytes.push(st.size - start);
  }
  if (full) for (const path of known.keys()) if (!listed.has(path)) removals.push(path);

  const results = await readAll(tasks, bytes, ctx.poolSize);

  // Apply in cc-usage's file order.
  const order = results
    .map((_, i) => i)
    .sort((a, b) => comparePyPaths(tasks[a]?.path ?? "", tasks[b]?.path ?? ""));
  const events = new Map<bigint, Event>();
  const preOnly = new Map<bigint, { root: Root; counts: Counts }>();
  const done: number[] = [];
  const unreadable = new Map<Root, string[]>();
  for (const i of order) {
    const result = results[i] as ReadResult;
    const root = taskRoots[i] as Root;
    const rs = statsOf(root);
    rs.readMs += result.ms;
    if (result.error !== undefined) {
      rs.errors++;
      unreadable.set(root, [...(unreadable.get(root) ?? []), result.error]);
      continue;
    }
    done.push(i);
    rs.read++;
    rs.bytes += result.stats.bytes;
    rs.lines += result.stats.lines;
    rs.candidates += result.stats.candidates;
    rs.usageLines += result.stats.usageLines;
    rs.malformed += result.stats.malformed;
    rs.unkeyed += result.stats.unkeyed;
    for (const entry of result.entries) {
      const event = events.get(entry.key);
      if (event !== undefined) {
        mergeCounts(event.counts, entry.pre);
        mergeCounts(event.counts, entry.post);
      } else if (entry.ts !== null && entry.post !== null) {
        events.set(entry.key, {
          root,
          ts: entry.ts,
          model: entry.model,
          counts: { ...entry.post },
        });
      } else if (entry.pre !== null) {
        const seen = preOnly.get(entry.key);
        preOnly.set(entry.key, {
          root: seen?.root ?? root,
          counts: mergeCounts(seen?.counts ?? null, entry.pre) as Counts,
        });
      }
    }
  }
  for (const [root, codes] of unreadable) {
    ctx.log(
      "warn",
      `${codes.length} transcript(s) of '${root.label}' could not be read (${[...new Set(codes)].join(", ")})`,
    );
  }

  // Decide which rows change the store, and for the changed event, where they sit.
  const rows: UsageRow[] = [];
  const touched = new Set<string>();
  let fromTs = Number.POSITIVE_INFINITY;
  let toTs = Number.NEGATIVE_INFINITY;
  let storeError: string | null = null;
  try {
    const keys = [...events.keys()];
    for (const key of preOnly.keys()) if (!events.has(key)) keys.push(key);
    const stored = new Map(ctx.store.rows(keys).map((r) => [r.key, r]));
    const accounts = keys.length > 0 ? ctx.store.accounts() : new Map();
    const models = keys.length > 0 ? ctx.store.models() : new Map<number, string>();
    let unattributedId: number | undefined;
    for (const [id, name] of models) if (name === UNATTRIBUTED) unattributedId = id;
    const consider = (row: UsageRow, root: Root, s: StoredRow | undefined) => {
      const rs = statsOf(root);
      if (!storable(row)) {
        rs.unstorable++;
        return;
      }
      if (s !== undefined && !raises(s, row, unattributedId)) return;
      rows.push(row);
      if (s === undefined) rs.inserted++;
      else rs.changed++;
      const ts = s?.ts ?? row.ts;
      fromTs = Math.min(fromTs, ts);
      toTs = Math.max(toTs, ts);
      touched.add(
        s === undefined ? row.identity : (accounts.get(s.acct)?.identity ?? row.identity),
      );
    };
    for (const [key, event] of events) {
      statsOf(event.root).records++;
      consider(
        toRow(key, event.root, event.ts, event.model, event.counts),
        event.root,
        stored.get(key),
      );
    }
    for (const [key, { root, counts }] of preOnly) {
      const s = stored.get(key);
      if (events.has(key) || s === undefined) continue;
      const account = accounts.get(s.acct);
      const model = models.get(s.model);
      if (account === undefined || model === undefined) continue;
      consider(toRow(key, account, s.ts, model, counts), root, s);
    }
    if (rows.length > 0) ctx.store.upsert(rows);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    storeError = error.message;
    ctx.log("error", `could not write the store: ${error.message}`);
  }

  if (storeError === null) {
    const put: Cursor[] = done.map((i) => {
      const result = results[i] as ReadResult;
      const st = taskStats[i] as FileStat;
      return {
        path: result.path,
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        mtimeMs: st.mtimeMs,
        offset: result.offset,
        tail: result.tail,
        state: result.state,
      };
    });
    try {
      ctx.cursors.update(put, removals);
    } catch (error) {
      ctx.log("warn", `could not save read positions: ${(error as Error).message}`);
    }
  }

  const event: ChangedEvent | null =
    storeError === null && rows.length > 0
      ? { type: "changed", accounts: [...touched], fromTs, toTs }
      : null;
  return { roots: [...perRoot.values()], wallMs: performance.now() - t0, event, storeError };
}
