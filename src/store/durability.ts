import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { classify, guard, StoreCorrupt, StoreError, StoreUnavailable } from "./errors.ts";
import { KEY_SCHEME } from "./key.ts";
import { APPLICATION_ID } from "./schema.ts";
import {
  type AccountRef,
  BACKUP_SUFFIX,
  emptyStoreDatabase,
  fileIdOf,
  type ImportRecord,
  KEY_SCHEME_MIGRATIONS,
  type OpenOptions,
  PREVIOUS_BACKUP_SUFFIX,
  type RecoveredData,
  type RecoveredLimitEvent,
  SALVAGE_SCRATCH_PREFIX,
  Store,
  type Tombstone,
  type UsageRow,
} from "./store.ts";

/**
 * Backups and recovery of the usage store, ported from cc-usage's ledger (`ledger.py`, its
 * module docstring's "Backups and recovery" and every backup and recovery function). The
 * store is the only copy of the usage of deleted transcripts, so it must survive a bad
 * disk, a crash or a stray write.
 *
 * Once a day the ingest worker writes `tokenhud.db.bak` with `VACUUM INTO` a temp file,
 * verifies it with `quick_check`, and rotates the previous one to `tokenhud.db.bak.prev`.
 * Every store has a random `store_id` (its *lineage*, copied into its backups) and records
 * in `meta.merged` the lineages whose rows it has fully absorbed. A backup slot is only
 * ever replaced when the file in it is *covered* (its lineage is this store's own or one it
 * merged), so the only good copy of some history is never overwritten.
 *
 * Recovery is a queue (`meta.pending`) that survives restarts. An unreadable store is
 * renamed aside (never deleted) and queued, together with the backups; so is a backup
 * found to be uncovered, and so are the backups when a store has to be created while they
 * exist (the store went missing). Each queued file is read from a scratch copy in
 * `.tokenhud-tmp/` beside the store (never TMPDIR, which may be a small RAM disk), salvaged
 * by key range around damaged pages, checked with `quick_check`, migrated to the current
 * key scheme, and merged by the same max rule. A file that cannot be read for an
 * environmental reason (disk full, permissions) stays queued and is retried; while
 * anything is queued no backup is rotated. A file whose key scheme is unknown, newer, or
 * cannot be migrated, or that is not a tokenhud store, is refused and kept.
 *
 * Besides usage rows, a salvage carries over what the store needs to keep counting right:
 * tombstones (`dropped_keys`), the Codex accounts still awaiting the scheme-2 re-key, the
 * import records (so cc-usage's history is not imported a second time) and limit events.
 *
 * All of it runs in the ingest worker (src/ingest/engine.ts), never on the UI thread.
 */

/** A backup is taken at most this often (and at once after a recovery or a key-scheme migration). */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A recovery source could not be read for an environmental reason (disk full,
 * permissions, I/O). It stays queued and is retried; nothing may treat it as merged.
 */
export class RecoveryFailed extends StoreError {
  override name = "RecoveryFailed";
}

/**
 * A backup copy failed its integrity check, so it replaced nothing. The store itself read
 * fine (the copy did), so this is not `StoreCorrupt`.
 */
export class BackupUnverified extends StoreError {
  override name = "BackupUnverified";
}

/**
 * A recovery source's rows cannot be merged safely: its key scheme is unknown, newer or
 * has no migration, or it is not a tokenhud store. The file is kept untouched.
 */
export class SourceRefused extends StoreError {
  override name = "SourceRefused";
}

/** The two backup slots beside the store at `storePath`. */
export function backupPaths(storePath: string): { bak: string; prev: string } {
  return { bak: `${storePath}${BACKUP_SUFFIX}`, prev: `${storePath}${PREVIOUS_BACKUP_SUFFIX}` };
}

// ── reports ──────────────────────────────────────────────────────────────────────

/** What happened to one queued recovery source. */
export interface SourceResult {
  file: string;
  /** "damaged" (the store moved aside), "missing" or "held" (a backup). */
  why: string;
  /** "merged", "unreadable", "failed" (retried), "refused" or "gone". */
  status: "merged" | "unreadable" | "failed" | "refused" | "gone";
  /** Rows read back and merged. */
  rows: number;
  /** Of those, rows this store did not have yet. */
  newRows: number;
  /** Every part of the file was readable (quick_check ok, no row dropped). */
  complete: boolean;
  reason: string;
  /** The file's modification time, epoch ms. */
  mtimeMs: number | null;
  /** A backup slot file set aside instead of merged, by its new name. */
  keptAs: string | null;
}

/** The outcome of one pass over the recovery queue, as kept in `meta.recovery_report`. */
export interface RecoveryReport {
  /** Epoch ms. */
  at: number;
  /** The store's directory, where the sources live. */
  directory: string;
  sources: SourceResult[];
  stillPending: string[];
  /** `describeRecovery` of this report. */
  summary: string;
}

/** Whether any source added rows the store did not have. */
export function mergedAny(report: RecoveryReport): boolean {
  return report.sources.some((s) => s.newRows > 0);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYYMMDD-HHMMSS` in local time, as cc-usage's `time.strftime("%Y%m%d-%H%M%S")`. */
function stamp(now: Date): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** `YYYY-MM-DD HH:MM` in local time. */
function minute(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const n = (x: number) => x.toLocaleString("en-US");

/**
 * One plain sentence about a recovery: what happened and whether history is intact,
 * partly lost, or not recovered yet (cc-usage's `RecoveryReport.describe`).
 */
export function describeRecovery(report: Pick<RecoveryReport, "directory" | "sources">): string {
  const { sources } = report;
  const damaged = sources.filter((s) => s.why === "damaged");
  const parts: string[] = [];
  const first = damaged[0];
  if (first !== undefined) {
    parts.push(`the usage store was damaged and moved to ${join(report.directory, first.file)}`);
  } else if (sources.some((s) => s.why === "missing")) {
    parts.push("the usage store was missing, so a new one was started");
  }
  for (const s of sources) {
    const when = s.mtimeMs !== null && s.why !== "damaged" ? ` (from ${minute(s.mtimeMs)})` : "";
    if (s.status === "merged") {
      const extent = s.complete ? "all of it" : "parts of it were unreadable";
      parts.push(`recovered ${n(s.rows)} rows from ${s.file}${when}, ${extent}`);
    } else if (s.status === "unreadable") {
      parts.push(`nothing in ${s.file} was readable`);
    } else if (s.status === "failed") {
      parts.push(
        `could NOT read ${s.file} yet (${s.reason}); its history is safe in that file, ` +
          "tokenhud retries on every full ingest pass and makes no backup until it succeeds",
      );
    } else if (s.status === "refused") {
      parts.push(`did not merge ${s.file} (${s.reason}); the file is kept`);
    }
    if (s.keptAs !== null) parts.push(`${s.file} was set aside as ${s.keptAs}`);
  }
  if (sources.some((s) => s.status === "failed")) {
    parts.push("recovery is NOT complete");
  } else if (damaged.length > 0 && damaged.every((s) => s.status === "merged" && s.complete)) {
    parts.push("history intact");
  } else if (sources.some((s) => s.status === "merged" && s.why !== "damaged")) {
    parts.push(
      damaged.length === 0
        ? "usage recorded after that backup for transcripts already deleted may be lost"
        : "usage recorded only in the unreadable part after that backup, for transcripts " +
            "already deleted, may be lost",
    );
  } else if (damaged.length > 0) {
    parts.push(
      "there was no usable backup: history of deleted transcripts in the unreadable part is lost",
    );
  }
  return parts.join("; ");
}

// ── an unreadable store ──────────────────────────────────────────────────────────

/**
 * Renames an unreadable store (and its WAL and SHM) to `<name>.corrupt-<timestamp>`.
 * Never deletes anything. Returns the new path, or null when the file at `path` is no
 * longer the one found unreadable (`found`, from `fileIdOf`): another tokenhud already
 * moved it and started a fresh one, which is left alone. Throws `StoreUnavailable` if the
 * rename itself fails (Windows refuses while another process has the file open).
 */
export function moveAside(path: string, found: string | null, now = new Date()): string | null {
  const current = fileIdOf(path);
  if (current === null || (found !== null && current !== found)) return null;
  const base = `${path}.corrupt-${stamp(now)}`;
  let target = base;
  for (let i = 2; existsSync(target); i++) target = `${base}-${i}`;
  try {
    renameSync(path, target);
  } catch (error) {
    throw new StoreUnavailable(
      `the store ${path} is unreadable and could not be moved aside: ${(error as Error).message}`,
      { cause: error },
    );
  }
  // The WAL belongs to the damaged file: left behind, SQLite could replay it into the
  // fresh store. Moved alongside, it stays readable for the salvage.
  for (const suffix of ["-wal", "-shm"]) {
    if (!existsSync(`${path}${suffix}`)) continue;
    try {
      renameSync(`${path}${suffix}`, `${target}${suffix}`);
    } catch {
      // best effort, as cc-usage
    }
  }
  return target;
}

/** Renames `path` to `<name>.<label>-<timestamp>` (never deletes it); its new name, or null. */
function setAside(path: string, label: string): string | null {
  const base = `${path}.${label}-${stamp(new Date())}`;
  let target = base;
  for (let i = 2; existsSync(target); i++) target = `${base}-${i}`;
  try {
    renameSync(path, target);
  } catch {
    return null;
  }
  return basename(target);
}

/**
 * Opens the store at `path`. An unreadable file is moved aside (never deleted), a fresh
 * store is created in its place (which queues the backups), and the moved file is queued
 * first; `movedTo` names it. Nothing is recovered here: `processPending` does that.
 *
 * With `verify` (see `OpenOptions`), a store that opens but fails `quick_check` counts as
 * unreadable too. tokenhud's passes touch only the rows they write, so without it a damaged
 * page of old history could go unnoticed for long (cc-usage's full diff read every row).
 * The check reads the whole file: about 30 ms for 140k rows, 200 ms for 1M.
 *
 * Throws `StoreError` when no store can be opened.
 */
export function openDurableStore(
  path: string,
  options: OpenOptions = {},
): { store: Store; movedTo: string | null } {
  let movedTo: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const found = fileIdOf(path);
    try {
      const store = Store.open(path, options);
      if (movedTo !== null) queueDamaged(store, movedTo);
      return { store, movedTo };
    } catch (error) {
      if (!(error instanceof StoreCorrupt) || attempt >= 2) throw error;
      movedTo = moveAside(path, found) ?? movedTo;
    }
  }
}

/**
 * For a store found unreadable while in use: moves its file aside (only if the path still
 * names the file this store has open), reconnects to a fresh store at the path and queues
 * the moved file. Returns where it went, or null if another process had already moved it.
 */
export function replaceCorruptStore(store: Store): string | null {
  const found = store.fileId;
  store.disconnect();
  const moved = moveAside(store.path, found);
  store.reconnect();
  if (moved !== null) queueDamaged(store, moved);
  return moved;
}

function queueDamaged(store: Store, moved: string): void {
  store.updateRecovery({ addPending: [{ file: basename(moved), why: "damaged" }] });
}

// ── the recovery queue ───────────────────────────────────────────────────────────

export interface RecoveryOptions {
  /** How sources are copied to scratch; tests inject failures (a full disk). */
  copyFile?: (from: string, to: string) => void;
  now?: () => number;
}

/**
 * Merges every queued recovery source that can be read now (cc-usage's `process_pending`).
 * Null when nothing is queued.
 *
 * A source read successfully leaves the queue; a damaged or refused backup slot is
 * renamed aside (kept) so the slot can hold a new backup; a complete source's lineage is
 * recorded as merged. A source that could not be read for an environmental reason stays
 * queued. Write errors propagate (the queue is kept). The report is saved for `doctor`.
 */
export function processPending(store: Store, options: RecoveryOptions = {}): RecoveryReport | null {
  const entries = store.pendingRecovery();
  if (entries.length === 0) return null;
  const copy = options.copyFile ?? copyFileSync;
  const directory = dirname(store.path);
  const { bak, prev } = backupPaths(store.path);
  const slots = new Set([basename(bak), basename(prev)]);
  const results: SourceResult[] = [];
  const done = new Set<string>();
  const merged = new Set<string>();
  for (const { file, why } of entries) {
    const path = join(directory, file);
    const result: SourceResult = {
      file,
      why,
      status: "gone",
      rows: 0,
      newRows: 0,
      complete: false,
      reason: "",
      mtimeMs: null,
      keptAs: null,
    };
    if (!existsSync(path)) {
      results.push(result);
      done.add(file);
      continue;
    }
    let lineage: string | null = null;
    try {
      lineage = mergeSource(store, path, result, copy);
    } catch (error) {
      if (error instanceof RecoveryFailed) {
        results.push({ ...result, status: "failed", reason: error.message });
        continue;
      }
      if (!(error instanceof SourceRefused)) throw error;
      Object.assign(result, { status: "refused", reason: error.message });
    }
    done.add(file);
    const fully = result.status === "merged" && result.complete;
    if (fully && lineage !== null) merged.add(lineage);
    if (slots.has(file) && !(fully && lineage !== null)) {
      // A slot may only keep a file a later backup can recognise as covered; anything
      // else is renamed aside (kept) so it can never block, or be overwritten by, a
      // rotation.
      const label = result.status === "refused" ? "unmerged" : fully ? "merged" : "damaged";
      result.keptAs = setAside(path, label);
    }
    results.push(result);
  }
  const queue = store.updateRecovery({ dropPending: done, addMerged: merged });
  const partial = { directory, sources: results };
  const report: RecoveryReport = {
    at: (options.now ?? Date.now)(),
    directory,
    sources: results,
    stillPending: queue.map((e) => e.file),
    summary: describeRecovery(partial),
  };
  store.saveRecoveryReport(report);
  return report;
}

/** Salvages `path` and merges it into `store`, filling in `result`; returns the source's lineage. */
function mergeSource(
  store: Store,
  path: string,
  result: SourceResult,
  copy: (from: string, to: string) => void,
): string | null {
  const name = basename(path);
  const source = readSource(path, () => store.newScratchDir(SALVAGE_SCRATCH_PREFIX), copy);
  try {
    result.mtimeMs = statSync(path).mtimeMs;
  } catch {
    result.mtimeMs = null;
  }
  if (source.unreadable) {
    result.status = "unreadable";
    return null;
  }
  if (source.accounts === null || source.models === null) {
    // Its id tables are damaged: a backup of the same lineage can stand in.
    const { bak, prev } = backupPaths(store.path);
    for (const slot of [bak, prev]) {
      if (slot === path || !existsSync(slot)) continue;
      const tables = readTables(slot);
      if (tables !== null && source.lineage !== null && tables.lineage === source.lineage) {
        source.accounts = new Map([...tables.accounts, ...(source.accounts ?? [])]);
        source.models = new Map([...tables.models, ...(source.models ?? [])]);
        break;
      }
    }
  }
  const ready = migrated(source, name);
  const data = recovered(ready);
  const { newRows } = store.mergeRecovered(data);
  Object.assign(result, {
    status: "merged",
    rows: data.rows.length,
    newRows,
    complete: ready.complete,
  });
  return source.lineage;
}

// ── backups ──────────────────────────────────────────────────────────────────────

/** Whether the daily backup is due: none yet, or the newest is a day old. */
export function backupDue(store: Store, now: number = Date.now()): boolean {
  try {
    return now - statSync(backupPaths(store.path).bak).mtimeMs >= BACKUP_INTERVAL_MS;
  } catch {
    return true;
  }
}

export interface BackupOptions {
  /** The integrity check of the copy, "ok" when sound; tests inject a failing one. */
  verify?: (copy: Database) => string;
}

function quickCheck(db: Database): string {
  return db
    .query<{ quick_check: string }, []>("PRAGMA quick_check")
    .all()
    .map((r) => r.quick_check)
    .join("; ");
}

/**
 * Rotates the backups (cc-usage's `Ledger.backup`): writes and verifies a fresh copy,
 * moves `.bak` to `.bak.prev`, installs the copy as `.bak`. False when it had to hold off.
 *
 * It holds off while the recovery queue is not empty, and when a backup slot holds a file
 * that is not covered (its lineage is neither this store's nor one it merged, or it is
 * unreadable): that file is queued for merging instead, and the rotation happens on a
 * later pass once it is covered. So the only good copy of any history is never
 * overwritten. A copy that fails its check never replaces anything (`BackupUnverified`);
 * a store that cannot be read whole throws `StoreCorrupt`.
 */
export function backup(store: Store, options: BackupOptions = {}): boolean {
  if (store.pendingRecovery().length > 0) return false;
  const covered = new Set([store.storeId, ...store.mergedLineages()]);
  const { bak, prev } = backupPaths(store.path);
  const held = [bak, prev].filter((slot) => {
    if (!existsSync(slot)) return false;
    const lineage = readTables(slot)?.lineage ?? null;
    return lineage === null || !covered.has(lineage);
  });
  if (held.length > 0) {
    store.updateRecovery({
      addPending: held.map((slot) => ({ file: basename(slot), why: "held" })),
    });
    return false;
  }
  const verify = options.verify ?? quickCheck;
  const tmp = `${bak}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { force: true }); // a crash's leftover: VACUUM INTO needs a new file
    store.vacuumInto(tmp);
    const copy = guard(() => new Database(tmp, { readwrite: true, strict: true }));
    let check: string;
    try {
      check = guard(() => {
        copy.exec("PRAGMA journal_mode = DELETE"); // one self-contained file
        return verify(copy);
      });
    } finally {
      copy.close();
    }
    if (check !== "ok") {
      throw new BackupUnverified(
        `the backup copy failed its integrity check: ${check.slice(0, 200)}`,
      );
    }
    // VACUUM INTO does not sync its output; the copy must be on disk before it replaces
    // the only good backup.
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(bak)) renameSync(bak, prev);
    renameSync(tmp, bak);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreUnavailable(`cannot write ${bak}: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

// ── reading another copy of a store ──────────────────────────────────────────────

const SQLITE_MAGIC = "SQLite format 3\0";
const HEADER_BYTES = 100;
const APPLICATION_ID_OFFSET = 68;

/** Whether `path` starts with a SQLite header carrying tokenhud's application_id. */
function isTokenhudFile(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const got = readSync(fd, head, 0, HEADER_BYTES, 0);
    return (
      got === HEADER_BYTES &&
      head.toString("latin1", 0, SQLITE_MAGIC.length) === SQLITE_MAGIC &&
      head.readUInt32BE(APPLICATION_ID_OFFSET) === APPLICATION_ID
    );
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

interface Tables {
  lineage: string | null;
  accounts: Map<bigint, AccountRef>;
  models: Map<bigint, string>;
}

/**
 * The lineage, accounts and models of an intact store copy (a backup), read-only; null if
 * any of it cannot be read or the file is not a tokenhud store. Backups are rollback-journal
 * files, so a read-only connection leaves no side files.
 */
function readTables(path: string): Tables | null {
  if (!isTokenhudFile(path)) return null;
  let db: Database;
  try {
    db = new Database(path, { readonly: true, safeIntegers: true, strict: true });
  } catch {
    return null;
  }
  try {
    const lineage =
      db.query<{ v: string | null }, []>("SELECT v FROM meta WHERE k = 'store_id'").get()?.v ??
      null;
    const accounts = new Map<bigint, AccountRef>();
    for (const a of db
      .query<{ id: bigint; provider: unknown; identity: unknown; label: unknown }, []>(
        "SELECT id, provider, identity, label FROM accounts",
      )
      .all()) {
      const ref = accountRef(a.provider, a.identity, a.label);
      if (ref !== null) accounts.set(a.id, ref);
    }
    const models = new Map<bigint, string>();
    for (const m of db
      .query<{ id: bigint; name: unknown }, []>("SELECT id, name FROM models")
      .all()) {
      if (typeof m.name === "string") models.set(m.id, m.name);
    }
    return { lineage: typeof lineage === "string" ? lineage : null, accounts, models };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function accountRef(provider: unknown, identity: unknown, label: unknown): AccountRef | null {
  return typeof provider === "string" && typeof identity === "string" && typeof label === "string"
    ? { provider, identity, label }
    : null;
}

// ── salvage ──────────────────────────────────────────────────────────────────────

const KEY_MIN = -(2n ** 63n);
const KEY_MAX = 2n ** 63n - 1n;
/** 2100-01-01 in ms: anything later is not a real record. */
const TS_MAX = 4_102_444_800_000n;
const COUNT_MAX = 2n ** 53n;
// Salvage narrows an unreadable key range down to this width before giving up on it, and
// stops splitting after this many failed reads (a wholly unreadable table would otherwise
// cost about a million probes).
const SALVAGE_MIN_WIDTH = 2n ** 46n;
const SALVAGE_MAX_FAILURES = 20_000;

type Raw = unknown[];

/** What a (possibly damaged) store copy still yields. Exported for tests. */
export interface Salvaged {
  /** Usage rows: key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier. */
  raw: Raw[];
  tombstones: Tombstone[];
  limitEvents: Raw[];
  accounts: Map<bigint, AccountRef> | null;
  models: Map<bigint, string> | null;
  lineage: string | null;
  /** null: unknown (its meta could not be read). */
  keyScheme: number | null;
  rekey: string[];
  imports: ImportRecord[];
  complete: boolean;
  unreadable: boolean;
  /** A SQLite file without tokenhud's application_id. */
  foreign: boolean;
}

function emptySalvage(over: Partial<Salvaged>): Salvaged {
  return {
    raw: [],
    tombstones: [],
    limitEvents: [],
    accounts: null,
    models: null,
    lineage: null,
    keyScheme: null,
    rekey: [],
    imports: [],
    complete: false,
    unreadable: false,
    foreign: false,
    ...over,
  };
}

const isCount = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < COUNT_MAX;

/** Rejects rows a damaged page could have produced that no real record can have. */
function plausible(row: Raw): boolean {
  if (row.length !== 11) return false;
  const [key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier] = row;
  if (typeof key !== "bigint" || typeof acct !== "bigint" || typeof model !== "bigint") {
    return false;
  }
  if (typeof ts !== "bigint" || ts <= 0n || ts >= TS_MAX) return false;
  if (![inp, outp, cr, cc, tier].every(isCount)) return false;
  return [e5, e1].every((v) => v === null || isCount(v));
}

/**
 * Reads whatever the store copy at `path` still yields. Works on a scratch copy in a new
 * directory from `makeScratch` (recovery uses the store's `.tokenhud-tmp/`), so the source
 * is never modified, and removes it afterwards. Any failure to make or open that copy is
 * environmental and raises `RecoveryFailed`: the caller must not mistake it for "nothing
 * to recover". Exported for tests.
 */
export function readSource(
  path: string,
  makeScratch: () => string,
  copy: (from: string, to: string) => void = copyFileSync,
): Salvaged {
  const name = basename(path);
  let scratch: string;
  try {
    scratch = makeScratch();
  } catch (error) {
    throw new RecoveryFailed(`cannot make a scratch copy of ${name}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  try {
    const target = join(scratch, "source.db");
    try {
      copy(path, target);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${path}${suffix}`)) copy(`${path}${suffix}`, `${target}${suffix}`);
      }
    } catch (error) {
      throw new RecoveryFailed(`could not copy ${name}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    let db: Database;
    try {
      // Read-write, though nothing is written to the source: the copy is private, and
      // opening it replays the copied WAL, whose frames hold the newest rows.
      db = new Database(target, { readwrite: true, safeIntegers: true, strict: true });
    } catch (error) {
      if (classify(error) instanceof StoreCorrupt) return emptySalvage({ unreadable: true });
      throw new RecoveryFailed(`could not open a copy of ${name}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    try {
      return salvageConnection(db, name);
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Damage is expected and survivable; anything else (I/O, disk full, out of memory) means
 * the read itself failed and must be retried later.
 */
function damageOrRaise(error: unknown, name: string): void {
  if (!(classify(error) instanceof StoreCorrupt)) {
    throw new RecoveryFailed(`reading ${name} failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function salvageConnection(db: Database, name: string): Salvaged {
  let tables: Set<string>;
  let applicationId: bigint;
  try {
    // Validate each cell's size as it is read, so a damaged page raises instead of
    // silently yielding fewer rows.
    db.exec("PRAGMA cell_size_check = ON");
    db.query("SELECT count(*) FROM sqlite_master").get();
    tables = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master")
        .all()
        .map((r) => r.name),
    );
    applicationId =
      db.query<{ application_id: bigint }, []>("PRAGMA application_id").get()?.application_id ?? 0n;
  } catch (error) {
    damageOrRaise(error, name);
    return emptySalvage({ unreadable: true });
  }
  if (applicationId !== BigInt(APPLICATION_ID)) return emptySalvage({ foreign: true });
  let complete = true;
  const read = <T>(sql: string): T[] | null => {
    try {
      return db.query<T, []>(sql).all();
    } catch (error) {
      damageOrRaise(error, name);
      complete = false;
      return null;
    }
  };
  const readValues = (sql: string): Raw[] | null => {
    try {
      return db.query<Raw, []>(sql).values() as Raw[];
    } catch (error) {
      damageOrRaise(error, name);
      complete = false;
      return null;
    }
  };

  const accountRows = tables.has("accounts")
    ? read<{ id: bigint; provider: unknown; identity: unknown; label: unknown }>(
        "SELECT id, provider, identity, label FROM accounts",
      )
    : null;
  const modelRows = tables.has("models")
    ? read<{ id: bigint; name: unknown }>("SELECT id, name FROM models")
    : null;
  const metaRows = tables.has("meta")
    ? read<{ k: unknown; v: unknown }>("SELECT k, v FROM meta")
    : null;
  let accounts: Map<bigint, AccountRef> | null = null;
  if (accountRows !== null) {
    accounts = new Map();
    for (const a of accountRows) {
      const ref = accountRef(a.provider, a.identity, a.label);
      if (ref === null) complete = false;
      else accounts.set(a.id, ref);
    }
  }
  let models: Map<bigint, string> | null = null;
  if (modelRows !== null) {
    models = new Map();
    for (const m of modelRows) {
      if (typeof m.name === "string") models.set(m.id, m.name);
      else complete = false;
    }
  }
  const meta = metaRows === null ? null : new Map(metaRows.map((m) => [m.k, m.v]));
  const text = (key: string) => {
    const v = meta?.get(key);
    return typeof v === "string" ? v : null;
  };
  const scheme = text("key_scheme");
  const json = (key: string): unknown => {
    try {
      return JSON.parse(text(key) ?? "null");
    } catch {
      return null;
    }
  };
  const rekey = json("codex_rekey");
  const imports = json("imports");

  const raw: Raw[] = [];
  if (tables.has("usage")) {
    complete =
      scanByKey(
        db,
        "SELECT key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier FROM usage",
        name,
        (row) => {
          if (!plausible(row)) return false;
          raw.push(row);
          return true;
        },
      ) && complete;
  }
  const tombstones: Tombstone[] = [];
  if (tables.has("dropped_keys")) {
    complete =
      scanByKey(db, "SELECT key, reason, at FROM dropped_keys", name, ([key, reason, at]) => {
        if (typeof key !== "bigint" || typeof reason !== "string" || !isCount(at)) return false;
        tombstones.push({ key, reason, at: Number(at) });
        return true;
      }) && complete;
  }
  const limitEvents = tables.has("limit_events")
    ? (readValues(
        "SELECT acct, kind, window, label, resets_at, at, resumed_at FROM limit_events",
      ) ?? [])
    : [];

  // A range scan can skip cells on some damaged pages without any error. Only a clean
  // integrity check lets the salvage call itself complete.
  let check = "";
  try {
    check = quickCheck(db);
  } catch (error) {
    damageOrRaise(error, name);
  }
  if (check !== "ok") complete = false;
  return {
    raw,
    tombstones,
    limitEvents,
    accounts,
    models,
    lineage: text("store_id"),
    keyScheme: scheme !== null && /^\d+$/.test(scheme) ? Number(scheme) : null,
    rekey: Array.isArray(rekey) ? rekey.filter((id): id is string => typeof id === "string") : [],
    imports: Array.isArray(imports) ? imports : [],
    complete,
    unreadable: false,
    foreign: false,
  };
}

/**
 * Reads a table by INTEGER PRIMARY KEY range around its damaged pages (`select` is the
 * query without a WHERE clause). `keep` returns false for a row it rejects. Returns
 * whether every range was read and every row kept.
 *
 * As cc-usage: 64 top-level ranges over the signed 64-bit key space, each split in 16 on
 * an error, down to SALVAGE_MIN_WIDTH. Unlike cc-usage, the edges of each span left
 * unreadable are then refined, so every row on an intact page is recovered. An ascending
 * scan that includes the last row before a damaged page always fails (SQLite steps into
 * the damaged page after it), and a descending one fails on the first row after it, so
 * the good rows at a span's low end are found by binary search with descending scans, and
 * those at its high end with ascending ones: at most 64 probes each.
 */
function scanByKey(
  db: Database,
  select: string,
  name: string,
  keep: (row: Raw) => boolean,
): boolean {
  const ascending = `${select} WHERE key BETWEEN ?1 AND ?2`;
  const descending = `${ascending} ORDER BY key DESC`;
  /** The rows of [lo, hi], or null when a damaged page is in the way. */
  const probe = (sql: string, lo: bigint, hi: bigint): Raw[] | null => {
    try {
      return db.query<Raw, [bigint, bigint]>(sql).values(lo, hi) as Raw[];
    } catch (error) {
      damageOrRaise(error, name);
      return null;
    }
  };
  let complete = true;
  const take = (rows: readonly Raw[]) => {
    for (const row of rows) if (!keep(row)) complete = false;
  };

  const step = 2n ** 58n;
  const pending: [bigint, bigint][] = [];
  for (let lo = KEY_MIN; lo < KEY_MAX; lo += step) {
    pending.push([lo, lo + step - 1n < KEY_MAX ? lo + step - 1n : KEY_MAX]);
  }
  const unreadable: [bigint, bigint][] = [];
  let failures = 0;
  for (;;) {
    const range = pending.pop();
    if (range === undefined) break;
    const [lo, hi] = range;
    const part = probe(ascending, lo, hi);
    if (part !== null) {
      take(part);
      continue;
    }
    failures++;
    complete = false;
    const width = hi - lo + 1n;
    if (width <= SALVAGE_MIN_WIDTH || failures > SALVAGE_MAX_FAILURES) {
      unreadable.push(range); // this range sits on an unreadable page
      continue;
    }
    const sub = width / 16n;
    for (let i = 0n; i < 16n; i++) {
      pending.push([lo + i * sub, i === 15n ? hi : lo + (i + 1n) * sub - 1n]);
    }
  }

  // Adjacent unreadable ranges form one span: refine only its two edges.
  unreadable.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const spans: [bigint, bigint][] = [];
  for (const [lo, hi] of unreadable) {
    const last = spans.at(-1);
    if (last !== undefined && last[1] + 1n === lo) last[1] = hi;
    else spans.push([lo, hi]);
  }
  let budget = SALVAGE_MAX_FAILURES;
  for (const [a, b] of spans) {
    if (budget <= 0) break;
    // The low end: the largest h such that [a, h] reads descending.
    let good = a - 1n;
    let bad = b + 1n;
    let low: Raw[] = [];
    while (bad - good > 1n && budget-- > 0) {
      const mid = good + (bad - good) / 2n;
      const rows = probe(descending, a, mid);
      if (rows === null) bad = mid;
      else {
        good = mid;
        low = rows;
      }
    }
    take(low);
    if (good >= b) continue; // the whole span read after all
    // The high end: the smallest l such that [l, b] reads ascending.
    let badLow = good;
    let goodHigh = b + 1n;
    let high: Raw[] = [];
    while (goodHigh - badLow > 1n && budget-- > 0) {
      const mid = badLow + (goodHigh - badLow) / 2n;
      const rows = probe(ascending, mid, b);
      if (rows === null) badLow = mid;
      else {
        goodHigh = mid;
        high = rows;
      }
    }
    take(high);
  }
  return complete;
}

/**
 * The source's rows under the *current* key scheme, or `SourceRefused`. Rows from an
 * older scheme are rebuilt in a clean in-memory store and run through
 * `KEY_SCHEME_MIGRATIONS` exactly as a live store would be (scheme 1 -> 2 marks the Codex
 * accounts for the re-key), so recovery can never bring back rows the compatibility rule
 * says must be re-keyed or dropped.
 */
function migrated(source: Salvaged, name: string): Salvaged {
  if (source.foreign) throw new SourceRefused(`${name} is not a tokenhud store`);
  const scheme = source.keyScheme;
  if (scheme === null) throw new SourceRefused(`the record key scheme of ${name} is unreadable`);
  if (scheme > KEY_SCHEME) {
    throw new SourceRefused(`${name} uses key scheme v${scheme}, newer than this tokenhud`);
  }
  if (scheme === KEY_SCHEME) return source;
  for (let v = scheme; v < KEY_SCHEME; v++) {
    if (!KEY_SCHEME_MIGRATIONS.has(v)) {
      throw new SourceRefused(`${name} uses key scheme v${v} and there is no migration`);
    }
  }
  let mem: Database | undefined;
  try {
    mem = emptyStoreDatabase();
    const db = mem;
    const account = db.query(
      "INSERT INTO accounts (id, provider, identity, label) VALUES (?1, ?2, ?3, ?4)",
    );
    for (const [id, a] of source.accounts ?? []) account.run(id, a.provider, a.identity, a.label);
    const model = db.query("INSERT INTO models (id, name) VALUES (?1, ?2)");
    for (const [id, m] of source.models ?? []) model.run(id, m);
    const usage = db.query(
      `INSERT OR IGNORE INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    );
    db.exec("BEGIN");
    for (const row of source.raw) usage.run(...(row as Parameters<typeof usage.run>));
    const tombstone = db.query(
      "INSERT OR IGNORE INTO dropped_keys (key, reason, at) VALUES (?1, ?2, ?3)",
    );
    for (const t of source.tombstones) tombstone.run(t.key, t.reason, t.at);
    db.query("INSERT OR REPLACE INTO meta (k, v) VALUES ('codex_rekey', ?1)").run(
      JSON.stringify(source.rekey),
    );
    for (let v = scheme; v < KEY_SCHEME; v++) KEY_SCHEME_MIGRATIONS.get(v)?.(db);
    db.exec("COMMIT");
    const rekey = JSON.parse(
      db.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'codex_rekey'").get()?.v ?? "[]",
    ) as unknown;
    return {
      ...source,
      raw: db
        .query<Raw, []>("SELECT key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier FROM usage")
        .values() as Raw[],
      tombstones: db
        .query<{ key: bigint; reason: string; at: bigint }, []>(
          "SELECT key, reason, at FROM dropped_keys",
        )
        .all()
        .map((t) => ({ key: t.key, reason: t.reason, at: Number(t.at) })),
      rekey: Array.isArray(rekey) ? rekey.filter((id): id is string => typeof id === "string") : [],
    };
  } catch (error) {
    throw new RecoveryFailed(`migrating the rows of ${name} failed: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    mem?.close();
  }
}

/**
 * The salvage as the store merges it. A row or limit event naming an account or model
 * the source's id tables do not hold cannot be placed: it is left out, and the salvage is
 * not complete.
 */
function recovered(source: Salvaged): RecoveredData {
  const accounts = source.accounts ?? new Map<bigint, AccountRef>();
  const models = source.models ?? new Map<bigint, string>();
  const rows: UsageRow[] = [];
  for (const [key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier] of source.raw) {
    const account = accounts.get(acct as bigint);
    const name = models.get(model as bigint);
    if (account === undefined || name === undefined) {
      source.complete = false;
      continue;
    }
    rows.push({
      key: key as bigint,
      ...account,
      ts: Number(ts),
      model: name,
      inp: Number(inp),
      outp: Number(outp),
      cr: Number(cr),
      cc: Number(cc),
      e5: e5 === null ? null : Number(e5),
      e1: e1 === null ? null : Number(e1),
      tier: Number(tier),
    });
  }
  const limitEvents: RecoveredLimitEvent[] = [];
  for (const [acct, kind, window, label, resetsAt, at, resumedAt] of source.limitEvents) {
    const account = accounts.get(acct as bigint);
    if (
      account === undefined ||
      typeof kind !== "string" ||
      typeof window !== "string" ||
      typeof label !== "string" ||
      !isCount(resetsAt) ||
      !isCount(at) ||
      !(resumedAt === null || isCount(resumedAt))
    ) {
      source.complete = false;
      continue;
    }
    limitEvents.push({
      account,
      kind,
      window,
      label,
      resetsAt: Number(resetsAt),
      at: Number(at),
      resumedAt: resumedAt === null ? null : Number(resumedAt),
    });
  }
  return {
    rows,
    tombstones: source.tombstones,
    rekey: source.rekey,
    imports: source.imports,
    limitEvents,
  };
}
