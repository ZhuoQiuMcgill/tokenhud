import { type Counts, mergeCounts } from "../sources/claude.ts";
import { type CodexLimitSnapshot, codexSessionId, newerLimits } from "../sources/codex.ts";
import { comparePyPaths } from "../sources/pypath.ts";
import type { Root } from "../sources/roots.ts";
import { StoreCorrupt, StoreError } from "../store/errors.ts";
import { KEY_SCHEME } from "../store/key.ts";
import { type Store, type StoredRow, UNATTRIBUTED, type UsageRow } from "../store/store.ts";
import type { Cursor, CursorCache } from "./cursors.ts";
import { type FileStat, statFiles } from "./files.ts";
import { readAll } from "./pool.ts";
import type { ReadResult, ReadTask } from "./read.ts";

/**
 * One ingest pass: stat the given transcripts, read what changed since each file's cursor
 * (on parse Workers when there is a lot), merge the results into usage events in
 * cc-usage's file order, write the store, then advance the cursors.
 *
 * Order matters twice. cc-usage reads files sorted as Python sorts paths and the first line
 * it sees with a timestamp fixes an event's timestamp, so results are applied in that order
 * whichever Worker read them. And the store commits before the cursors move: a crash in
 * between only means the same bytes are read again, which the store's max-merge absorbs.
 *
 * Codex adds two things. Keys a rollout reports as inherited usage are removed from the
 * store and tombstoned (`dropped_keys`), so no later write or import brings them back;
 * keys a trigger turn gives back are un-tombstoned. And a Codex account awaiting the
 * scheme-2 re-key (`rekey`) has every rollout read from the start, whatever its cursor; in
 * the pass's one write, the scheme-1 rows of those rollouts are deleted and their scheme-2
 * records written with replace semantics, and the account's re-key is recorded with a
 * report.
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
  /**
   * Identities of the accounts whose rows were inserted, raised or removed, or whose limit
   * events were recorded (the Worker's limits schedule).
   */
  accounts: string[];
  /** The span of those rows' timestamps (epoch ms, inclusive). */
  fromTs: number;
  toTs: number;
}

export interface RootStats {
  /** The account's label in the store (the root's own label until it has rows). */
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
  /** Rows the store did not have, and stored rows this pass raised (or, re-keying, replaced). */
  inserted: number;
  changed: number;
  /** Codex: events judged inherited from a parent rollout, and stored rows removed for that. */
  inherited: number;
  removed: number;
  /** Rows not written because their key is tombstoned (removed earlier as not being usage). */
  tombstoned: number;
  /** Codex: records at the fast tier (from the rollout's own settings events). */
  fast: number;
  /** Events the store cannot hold (negative or oversized counts, a ts before 1970). */
  unstorable: number;
  /** Files that could not be read (vanished or unreadable mid-pass). */
  errors: number;
  /** Time spent reading this root's files, summed over Workers. */
  readMs: number;
}

/** What the Codex re-key did to one account's stored rows. */
export interface RekeyAccountReport {
  identity: string;
  /** Rollouts read. */
  rollouts: number;
  /** Rows of inherited usage deleted. */
  deleted: number;
  /** Rows whose counts, tier or model were replaced, and rows newly written. */
  changed: number;
  inserted: number;
  unchanged: number;
  /** Rows left as they were because no rollout on disk produces their key. */
  untouched: number;
}

export interface RekeyReport {
  scheme: number;
  at: string;
  accounts: RekeyAccountReport[];
}

export interface PassReport {
  roots: RootStats[];
  wallMs: number;
  event: ChangedEvent | null;
  /**
   * Set when the store write failed; nothing was stored and no cursor moved. (An unreadable
   * store throws `StoreCorrupt` instead, for the engine to recover.)
   */
  storeError: string | null;
  /** The accounts this pass re-keyed, or null. */
  rekey: RekeyReport | null;
}

export interface PassContext {
  store: Store;
  cursors: CursorCache;
  poolSize: number;
  log: Log;
  /** Codex session id -> its rollouts, to find a child rollout's parent. This pass's files are added. */
  codexSessions?: Readonly<Record<string, readonly string[]>>;
  /** Codex account identities to re-key in this pass (a full pass over their roots). */
  rekey?: ReadonlySet<string>;
  /** Tests: awaited once the transcripts are read, before anything is written. */
  beforeWrite?: () => Promise<void>;
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
    inherited: 0,
    removed: 0,
    tombstoned: 0,
    fast: 0,
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

/** Whether replacing `stored` with `row` changes it: the store's replace condition. */
function differs(stored: StoredRow, row: UsageRow, modelId: number | undefined): boolean {
  return (
    row.inp !== stored.inp ||
    row.outp !== stored.outp ||
    row.cr !== stored.cr ||
    row.cc !== stored.cc ||
    row.e5 !== stored.e5 ||
    row.e1 !== stored.e1 ||
    row.tier !== stored.tier ||
    (row.model !== UNATTRIBUTED && modelId !== stored.model)
  );
}

function toRow(
  key: bigint,
  account: { provider: string; identity: string; label: string },
  derivedLabel: boolean,
  ts: number,
  model: string,
  counts: Counts,
): UsageRow {
  return {
    key,
    provider: account.provider,
    identity: account.identity,
    label: account.label,
    derivedLabel,
    ts,
    model,
    ...counts,
  };
}

/** Whether a rollout sits in a Codex home's `archived_sessions` (ccusage prefers the active copy). */
const archived = (path: string) => path.split(/[\\/]/).includes("archived_sessions");

/**
 * Codex session id -> rollouts, active copies first, then in Python path order: `base`'s,
 * plus those among `files`.
 */
export function codexSessionIndex(
  files: readonly PassFile[],
  base: Readonly<Record<string, readonly string[]>> = {},
): Record<string, string[]> {
  const index = new Map<string, string[]>(
    Object.entries(base).map(([sid, paths]) => [sid, [...paths]]),
  );
  for (const file of files) {
    if (file.root.provider !== "codex") continue;
    const sid = codexSessionId(file.path);
    const paths = index.get(sid) ?? [];
    if (!paths.includes(file.path)) paths.push(file.path);
    index.set(sid, paths);
  }
  for (const paths of index.values()) {
    paths.sort((a, b) => Number(archived(a)) - Number(archived(b)) || comparePyPaths(a, b));
  }
  return Object.fromEntries(index);
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
  const rekeying = (root: Root) =>
    root.provider === "codex" && ctx.rekey?.has(root.identity) === true;

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
    if (!st.isFile) continue;
    statsOf(file.root).files++;
    // A re-keyed account's rollouts are all read from the start, under scheme 2.
    const cursor = rekeying(file.root) ? undefined : known.get(file.path);
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

  const results = await readAll(tasks, bytes, {
    poolSize: ctx.poolSize,
    log: ctx.log,
    context: { codexSessions: codexSessionIndex(files, ctx.codexSessions) },
  });
  await ctx.beforeWrite?.();

  // Apply in cc-usage's file order.
  const order = results
    .map((_, i) => i)
    .sort((a, b) => comparePyPaths(tasks[a]?.path ?? "", tasks[b]?.path ?? ""));
  const events = new Map<bigint, Event>();
  const preOnly = new Map<bigint, { root: Root; counts: Counts }>();
  const drops = new Map<bigint, Root>();
  const restored = new Set<bigint>();
  const limits = new Map<string, CodexLimitSnapshot>();
  /** Per re-keyed root: its rollouts read, its scheme-1 keys (own and inherited). */
  const rekeyed = new Map<Root, { rollouts: number; keys: Set<bigint>; failed: boolean }>();
  const rekeyOf = (root: Root) => {
    let r = rekeyed.get(root);
    if (r === undefined) {
      r = { rollouts: 0, keys: new Set(), failed: false };
      rekeyed.set(root, r);
    }
    return r;
  };
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
      if (rekeying(root)) rekeyOf(root).failed = true;
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
    rs.inherited += result.drop.length;
    const rekey = rekeying(root) ? rekeyOf(root) : null;
    if (rekey !== null) rekey.rollouts++;
    for (const entry of result.entries) {
      rekey?.keys.add(entry.key);
      const event = events.get(entry.key);
      if (event !== undefined) {
        mergeCounts(event.counts, entry.pre);
        mergeCounts(event.counts, entry.post);
        if (event.model === UNATTRIBUTED && entry.ts !== null) event.model = entry.model;
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
    for (const key of result.drop) {
      rekey?.keys.add(key);
      if (!drops.has(key)) drops.set(key, root);
    }
    for (const key of result.restore) restored.add(key);
    if (result.limits !== null && newerLimits(limits.get(root.identity), result.limits)) {
      limits.set(root.identity, result.limits);
    }
  }
  for (const [root, codes] of unreadable) {
    ctx.log(
      "warn",
      `${codes.length} transcript(s) of '${root.label}' could not be read (${[...new Set(codes)].join(", ")})`,
    );
  }

  for (const event of events.values()) {
    if (event.root.provider === "codex" && event.counts.tier === 1) statsOf(event.root).fast++;
  }

  // Decide which rows change the store, and for the changed event, where they sit.
  const rows: UsageRow[] = [];
  const replaced: UsageRow[] = [];
  const remove: bigint[] = [];
  const touched = new Set<string>();
  let fromTs = Number.POSITIVE_INFINITY;
  let toTs = Number.NEGATIVE_INFINITY;
  let storeError: string | null = null;
  let rekey: RekeyReport | null = null;
  const touch = (identity: string, ts: number) => {
    fromTs = Math.min(fromTs, ts);
    toTs = Math.max(toTs, ts);
    touched.add(identity);
  };
  try {
    const keys = [...events.keys()];
    for (const key of preOnly.keys()) if (!events.has(key)) keys.push(key);
    // A key one copy of a rollout still counts as its own wins over an inherited judgement.
    const dropKeys = [...drops.keys()].filter((key) => !events.has(key));
    keys.push(...dropKeys);
    const stored = new Map(ctx.store.rows(keys).map((r) => [r.key, r]));
    const accounts = keys.length > 0 ? ctx.store.accounts() : new Map();
    const models = keys.length > 0 ? ctx.store.models() : new Map<number, string>();
    const modelIds = new Map([...models].map(([id, name]) => [name, id]));
    const unattributedId = modelIds.get(UNATTRIBUTED);
    // Keys removed earlier as not being usage stay removed, unless a trigger turn gave
    // them back in this pass.
    const dead = ctx.store.droppedKeys();
    for (const key of restored) dead.delete(key);
    const identityOf = (s: StoredRow, fallback: string) =>
      (accounts.get(s.acct)?.identity as string | undefined) ?? fallback;
    const reports = new Map<Root, RekeyAccountReport>();
    for (const [root, r] of rekeyed) {
      reports.set(root, {
        identity: root.identity,
        rollouts: r.rollouts,
        deleted: 0,
        changed: 0,
        inserted: 0,
        unchanged: 0,
        untouched: 0,
      });
    }

    const consider = (row: UsageRow, root: Root, s: StoredRow | undefined) => {
      const rs = statsOf(root);
      if (!storable(row)) {
        rs.unstorable++;
        return;
      }
      if (dead.has(row.key)) {
        rs.tombstoned++;
        return;
      }
      const report = reports.get(root);
      if (report !== undefined) {
        // Re-keying: the scheme-2 record replaces whatever scheme 1 stored.
        if (s !== undefined && !differs(s, row, modelIds.get(row.model))) {
          report.unchanged++;
          return;
        }
        replaced.push(row);
        if (s === undefined) report.inserted++;
        else report.changed++;
      } else {
        if (s !== undefined && !raises(s, row, unattributedId)) return;
        rows.push(row);
      }
      if (s === undefined) rs.inserted++;
      else rs.changed++;
      touch(s === undefined ? row.identity : identityOf(s, row.identity), s?.ts ?? row.ts);
    };
    for (const [key, event] of events) {
      statsOf(event.root).records++;
      consider(
        toRow(key, event.root, !event.root.labelExplicit, event.ts, event.model, event.counts),
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
      // The stored account and its label, unchanged.
      consider(toRow(key, account, true, s.ts, model, counts), root, s);
    }
    for (const key of dropKeys) {
      const s = stored.get(key);
      if (s === undefined) continue;
      const root = drops.get(key) as Root;
      remove.push(key);
      statsOf(root).removed++;
      const report = reports.get(root);
      if (report !== undefined) report.deleted++;
      touch(identityOf(s, root.identity), s.ts);
    }

    let finished: string[] = [];
    if (reports.size > 0) {
      // Rows of a re-keyed account that no rollout on disk produces stay as they were.
      const counts = ctx.store.rowCounts();
      const idOf = new Map(
        [...accounts.values()]
          .filter((a) => a.provider === "codex")
          .map((a) => [a.identity as string, a.id as number]),
      );
      for (const [root, report] of reports) {
        const acct = idOf.get(root.identity);
        const total = acct === undefined ? 0 : (counts.get(acct) ?? 0);
        let covered = 0;
        for (const key of rekeyed.get(root)?.keys ?? []) {
          const s = stored.get(key);
          if (s !== undefined && s.acct === acct) covered++;
        }
        report.untouched = total - covered;
      }
      // An account with an unreadable rollout stays pending, to be re-keyed again in full.
      finished = [...rekeyed].filter(([, r]) => !r.failed).map(([root]) => root.identity);
      const now = new Set([...reports.keys()].map((root) => root.identity));
      const previous = ctx.store.meta.migrationReport as Partial<RekeyReport> | null;
      const kept = Array.isArray(previous?.accounts)
        ? previous.accounts.filter((a) => !now.has(a.identity))
        : [];
      rekey = {
        scheme: KEY_SCHEME,
        at: new Date().toISOString(),
        accounts: [...kept, ...reports.values()],
      };
    }
    const tombstone = dropKeys.filter((key) => !dead.has(key));
    if (rows.length + replaced.length + tombstone.length + restored.size > 0 || rekey !== null) {
      ctx.store.write({
        upsert: rows,
        replace: replaced,
        drop: { keys: tombstone, reason: "codex-replay" },
        restore: [...restored],
        rekeyed: finished,
        ...(rekey === null ? {} : { migrationReport: rekey }),
      });
    }
  } catch (error) {
    // An unreadable store is the engine's to move aside and recover (durability.ts).
    if (!(error instanceof StoreError) || error instanceof StoreCorrupt) throw error;
    storeError = error.message;
    rekey = null;
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
      const storedLimits = ctx.cursors.codexLimitSnapshots();
      for (const [identity, snapshot] of limits) {
        if (!newerLimits(storedLimits.get(identity), snapshot)) limits.delete(identity);
      }
      ctx.cursors.putCodexLimitSnapshots(limits);
    } catch (error) {
      ctx.log("warn", `could not save read positions: ${(error as Error).message}`);
    }
  }

  // Report each account under the label the store gives it.
  try {
    const labels = new Map(
      [...ctx.store.accounts().values()].map((a) => [`${a.provider}\0${a.identity}`, a.label]),
    );
    for (const rs of perRoot.values())
      rs.label = labels.get(`${rs.provider}\0${rs.identity}`) ?? rs.label;
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
  }

  const changes = rows.length + replaced.length + remove.length;
  const event: ChangedEvent | null =
    storeError === null && changes > 0
      ? { type: "changed", accounts: [...touched], fromTs, toTs }
      : null;
  return {
    roots: [...perRoot.values()],
    wallMs: performance.now() - t0,
    event,
    storeError,
    rekey,
  };
}
