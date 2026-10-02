import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { classify, SchemeRefused, StoreCorrupt, StoreError } from "./errors.ts";
import { KEY_SCHEME } from "./key.ts";
import type { AccountRef, Store, UsageRow } from "./store.ts";

/**
 * One-shot, idempotent import of cc-usage's whole ledger history
 * (`~/.config/cc-usage/ledger.sqlite3`) into a tokenhud store.
 *
 * **cc-usage's files are only ever read, never written, not even SQLite's index files.**
 * Opening the ledger with SQLite, even read-only, is not good enough:
 * - on a ledger with no -wal/-shm (cc-usage not running) it creates both, or under
 *   macOS's system SQLite it fails to open;
 * - on one whose -shm was left by an earlier process, it rebuilds the -shm.
 *
 * A `readonly_shm` URI open avoids writing an existing -shm but not the first case. So
 * the import reads a snapshot instead:
 *
 * 1. Copy `ledger.sqlite3` and, if present, `ledger.sqlite3-wal` into a private scratch
 *    dir (in `.tokenhud-tmp/` beside the store). Copying only reads the source. The -shm is
 *    not copied: SQLite rebuilds the index from the WAL, so rows not yet checkpointed are
 *    included.
 * 2. The frozen Python app may write while we copy, so copy both files twice in a row and
 *    accept only if the two copies are byte-identical. Every byte then held the same
 *    value from its first read to its second, so all of them held it at one instant
 *    between the two copies: the accepted copy is the pair of files exactly as they were
 *    at that instant, which SQLite's WAL design makes a consistent database (a partly
 *    written transaction or checkpoint is invisible without its commit frame). Size and
 *    mtime are not enough: mtime moves in clock ticks, and a same-size rewrite within one
 *    tick is invisible to it. A copy that keeps changing is retried with back-off; if it
 *    never settles, the import is deferred with a warning and nothing is written. Import
 *    is idempotent, so the next run picks it up.
 * 3. `PRAGMA quick_check` the accepted copy, refuse a layout or key scheme other than
 *    cc-usage v2.6.1's, and merge every row through the store's upsert rules (tier 0).
 *    The rows are key scheme 1. Claude keys are the same under the store's scheme 2, and
 *    the imported Codex accounts are marked for the Codex re-key, which the next full
 *    ingest pass performs from their rollouts (scheme 1 also kept a child rollout's
 *    replay of its parent; only the rollout can tell which rows those are).
 * 4. Delete the scratch dir. A copy left by a crash is swept by a later store open.
 */

/** The record key scheme cc-usage v2.6.1 writes (its `parser.KEY_SCHEME`). */
export const CC_USAGE_KEY_SCHEME = 1;
/** The store scheme scheme-1 rows reach through the Codex re-key alone. */
const REKEYED_SCHEME = 2;
/** The ledger layout cc-usage v2.6.1 writes (its `ledger.SCHEMA_VERSION`). */
const CC_USAGE_SCHEMA_VERSION = 2;
/** Waits before each snapshot attempt; the first is immediate. */
const SNAPSHOT_BACKOFF_MS = [0, 25, 50, 100, 200];
const SQLITE_MAGIC = "SQLite format 3\0";
const MAX_COUNT = 2n ** 53n;
const CHUNK = 1 << 20;

export type ImportFailure =
  | "missing" // no ledger at that path
  | "unavailable" // the ledger or the scratch copy could not be read or made
  | "corrupt" // not a SQLite database, fails its integrity check, or holds non-text names
  | "incompatible"; // not a cc-usage v2.6.1 ledger layout or key scheme

/**
 * The cc-usage ledger could not be imported. A separate class from `StoreCorrupt` and
 * friends, so a caller never mistakes a problem with cc-usage's file for one with the
 * tokenhud store (which recovery would move aside). The store is left unchanged.
 */
export class ImportSourceError extends StoreError {
  override name = "ImportSourceError";
  readonly reason: ImportFailure;

  constructor(reason: ImportFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

export interface ImportSummary {
  status: "imported";
  /** The ledger's lineage (cc-usage's `meta.ledger_id`). */
  lineage: string | null;
  /** Usage rows read from the ledger. */
  read: number;
  /** Rows the store did not have. */
  inserted: number;
  /** Rows the store had, raised by the merge rules (higher counts, a resolved model). */
  merged: number;
  /** Rows the store already had at least as complete. */
  unchanged: number;
  /**
   * Rows left out because tokenhud removed their keys as not being usage (a Codex child
   * rollout's replay of its parent, which cc-usage counted): `dropped_keys`.
   */
  tombstoned: number;
  /** Rows naming an account or model the ledger does not hold, or with impossible values. */
  skipped: number;
  /** Accounts and models copied (all of the ledger's, used by a row or not). */
  accounts: number;
  models: number;
}

/** cc-usage kept writing through every snapshot attempt; nothing was imported. */
export interface ImportDeferred {
  status: "deferred";
  warning: string;
}

export type ImportOutcome = ImportSummary | ImportDeferred;

/**
 * Imports the cc-usage ledger at `ledgerPath` into `store`. Re-importing changes nothing
 * (keys dedupe and the merge is a max). Returns `deferred` when no stable snapshot could
 * be taken. Throws `ImportSourceError` for a problem with the ledger and `StoreError` for
 * one with the store; in every case but `imported` the store is unchanged.
 */
export function importCcUsage(store: Store, ledgerPath: string): ImportOutcome {
  if (KEY_SCHEME !== REKEYED_SCHEME) {
    // A later scheme must say how cc-usage's rows reach it, as cc-usage's recovery
    // migrates old rows; until it does, refuse rather than mix schemes.
    throw new SchemeRefused(
      `cannot import cc-usage key scheme v${CC_USAGE_KEY_SCHEME} into key scheme v${KEY_SCHEME}`,
    );
  }
  const scratch = store.newScratchDir();
  let source: Database | undefined;
  try {
    const copy = snapshotLedger(ledgerPath, scratch);
    if (copy === null) {
      return {
        status: "deferred",
        warning:
          "cc-usage was writing its ledger throughout the import, so no consistent copy " +
          "could be taken; nothing was imported, and the next run will try again",
      };
    }
    source = openChecked(copy, ledgerPath);
    const ledger = readLedger(source);
    const rows = ledger.rows;
    const record = {
      at: new Date().toISOString(),
      source: "cc-usage",
      lineage: ledger.lineage,
      rows: rows.length,
      accounts: ledger.accounts.length,
    };
    const codex = new Set(rows.filter((r) => r.provider === "codex").map((r) => r.identity));
    const { inserted, changed, tombstoned } = store.importRows(
      rows,
      ledger.accounts,
      ledger.models,
      record,
      [...codex],
    );
    return {
      status: "imported",
      lineage: ledger.lineage,
      read: ledger.read,
      inserted,
      merged: changed - inserted,
      unchanged: rows.length - changed - tombstoned,
      tombstoned,
      skipped: ledger.read - rows.length,
      accounts: ledger.accounts.length,
      models: ledger.models.length,
    };
  } finally {
    source?.close();
    removeScratch(scratch);
  }
}

/**
 * The key of every usage row in the cc-usage ledger at `ledgerPath`, read from a
 * snapshot taken exactly as `importCcUsage` takes it, in `scratch` (an empty directory
 * this removes afterwards). Null when cc-usage kept writing through every attempt. For
 * `doctor`, which counts the rows only cc-usage has. Throws `ImportSourceError` for a
 * missing, unreadable or incompatible ledger.
 */
export function readCcUsageKeys(ledgerPath: string, scratch: string): bigint[] | null {
  let source: Database | undefined;
  try {
    const copy = snapshotLedger(ledgerPath, scratch);
    if (copy === null) return null;
    source = openChecked(copy, ledgerPath);
    const db = source;
    try {
      checkLayout(db);
      return db
        .query<{ key: bigint }, []>("SELECT key FROM usage")
        .all()
        .map((r) => r.key);
    } catch (error) {
      throw sourceError(error, "the cc-usage ledger");
    }
  } finally {
    source?.close();
    removeScratch(scratch);
  }
}

function removeScratch(scratch: string): void {
  try {
    // Windows can hold a just-closed file for a moment; retry, and never let cleanup
    // mask the caller's own result. A leftover is swept by a later store open.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // left in the scratch dir
  }
}

// ── snapshot ─────────────────────────────────────────────────────────────────────

function sourceUnavailable(path: string, error: unknown): ImportSourceError {
  return new ImportSourceError("unavailable", `cannot read ${path}: ${(error as Error).message}`, {
    cause: error,
  });
}

/** Copies `from` to `to`; false if `from` does not exist (now). */
function copyIfPresent(from: string, to: string): boolean {
  try {
    copyFileSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw sourceUnavailable(from, error);
  }
}

/** Copies the ledger and its WAL to `to` and `${to}-wal`; returns which files existed. */
function copyLedger(ledgerPath: string, to: string): [db: boolean, wal: boolean] {
  return [copyIfPresent(ledgerPath, to), copyIfPresent(`${ledgerPath}-wal`, `${to}-wal`)];
}

/** Whether two copies hold the same bytes. */
function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  const fa = openSync(a, "r");
  const fb = openSync(b, "r");
  try {
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    for (let at = 0; ; at += CHUNK) {
      const na = readSync(fa, ba, 0, CHUNK, at);
      const nb = readSync(fb, bb, 0, CHUNK, at);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (na < CHUNK) return true;
    }
  } finally {
    closeSync(fa);
    closeSync(fb);
  }
}

/**
 * A consistent copy of the ledger (and WAL) in `scratch`, or null if cc-usage kept
 * changing it through every attempt. See step 2 of the module comment for why two
 * byte-identical consecutive copies are a consistent snapshot. Exported for the parity
 * harness (scripts/parity.ts), which reads the very copy it imports.
 */
export function snapshotLedger(ledgerPath: string, scratch: string): string | null {
  let isFile: boolean;
  try {
    isFile = statSync(ledgerPath).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImportSourceError("missing", `no cc-usage ledger at ${ledgerPath}`);
    }
    throw sourceUnavailable(ledgerPath, error);
  }
  if (!isFile) throw new ImportSourceError("unavailable", `${ledgerPath} is not a file`);
  for (const [attempt, wait] of SNAPSHOT_BACKOFF_MS.entries()) {
    if (wait > 0) Bun.sleepSync(wait);
    const first = join(scratch, `ledger-${attempt}a.sqlite3`);
    const second = join(scratch, `ledger-${attempt}b.sqlite3`);
    const [db1, wal1] = copyLedger(ledgerPath, first);
    const [db2, wal2] = copyLedger(ledgerPath, second);
    const stable =
      db1 &&
      db2 &&
      wal1 === wal2 &&
      sameBytes(first, second) &&
      (!wal1 || sameBytes(`${first}-wal`, `${second}-wal`));
    if (stable) return first;
  }
  return null;
}

function hasSqliteMagic(path: string): boolean {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = openSync(path, "r");
  try {
    return (
      readSync(fd, head, 0, head.length, 0) === head.length &&
      head.toString("latin1") === SQLITE_MAGIC
    );
  } finally {
    closeSync(fd);
  }
}

/** Opens the accepted copy and checks its integrity. */
function openChecked(copy: string, ledgerPath: string): Database {
  let db: Database | undefined;
  try {
    if (!hasSqliteMagic(copy)) {
      throw new ImportSourceError("corrupt", `${ledgerPath} is not a SQLite database`);
    }
    // Read-write, though nothing is written: the copy is private, and a read-only
    // connection cannot create the copy's WAL index under macOS's system SQLite.
    db = new Database(copy, { readwrite: true, safeIntegers: true });
    const check = db
      .query<{ quick_check: string }, []>("PRAGMA quick_check")
      .all()
      .map((r) => r.quick_check)
      .join("; ");
    if (check !== "ok") {
      throw new ImportSourceError(
        "corrupt",
        `${ledgerPath} failed its integrity check: ${check.slice(0, 200)}`,
      );
    }
    return db;
  } catch (error) {
    db?.close();
    throw sourceError(error, ledgerPath);
  }
}

function sourceError(error: unknown, ledgerPath: string): ImportSourceError {
  if (error instanceof ImportSourceError) return error;
  const classified = classify(error);
  const reason = classified instanceof StoreCorrupt ? "corrupt" : "unavailable";
  return new ImportSourceError(reason, `cannot read ${ledgerPath}: ${classified.message}`, {
    cause: error,
  });
}

// ── reading ──────────────────────────────────────────────────────────────────────

interface Ledger {
  lineage: string | null;
  read: number;
  rows: UsageRow[];
  accounts: AccountRef[];
  models: string[];
}

type RawRow = [
  bigint,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
];

const isCount = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < MAX_COUNT;

/** A column that must be TEXT; a BLOB or a number there means a damaged ledger. */
function text(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  throw new ImportSourceError("corrupt", `the cc-usage ledger has a non-text ${what}`);
}

/** The ledger's meta table, once its layout and key scheme are known to be cc-usage v2.6.1's. */
function checkLayout(db: Database): Map<unknown, unknown> {
  const version = Number(
    db.query<{ user_version: bigint }, []>("PRAGMA user_version").get()?.user_version,
  );
  if (version !== CC_USAGE_SCHEMA_VERSION) {
    throw new ImportSourceError(
      "incompatible",
      `ledger schema v${version}; tokenhud imports cc-usage's v${CC_USAGE_SCHEMA_VERSION} (launch cc-usage v2.6.1 once to upgrade it)`,
    );
  }
  const meta = new Map(
    db
      .query<{ k: unknown; v: unknown }, []>("SELECT k, v FROM meta")
      .all()
      .map((m) => [m.k, m.v]),
  );
  // As cc-usage's read_summary: a missing scheme reads as 0.
  const scheme = Number(meta.get("key_scheme") || 0);
  if (scheme !== CC_USAGE_KEY_SCHEME) {
    throw new ImportSourceError(
      "incompatible",
      `ledger uses record key scheme v${scheme}; tokenhud imports v${CC_USAGE_KEY_SCHEME} only`,
    );
  }
  return meta;
}

function readLedger(db: Database): Ledger {
  try {
    const meta = checkLayout(db);
    const accountsById = new Map<unknown, AccountRef>(
      db
        .query<{ id: bigint; provider: unknown; identity: unknown; label: unknown }, []>(
          "SELECT id, provider, identity, label FROM accounts ORDER BY id",
        )
        .all()
        .map((a) => [
          a.id,
          {
            provider: text(a.provider, "account provider"),
            identity: text(a.identity, "account identity"),
            label: text(a.label, "account label"),
          },
        ]),
    );
    const modelsById = new Map<unknown, string>(
      db
        .query<{ id: bigint; name: unknown }, []>("SELECT id, name FROM models ORDER BY id")
        .all()
        .map((m) => [m.id, text(m.name, "model name")]),
    );
    const raw = db
      .query<Record<string, unknown>, []>(
        "SELECT key, acct, ts, model, inp, outp, cr, cc, e5, e1 FROM usage",
      )
      .values() as RawRow[];
    const rows: UsageRow[] = [];
    for (const [key, acct, ts, model, inp, outp, cr, cc, e5, e1] of raw) {
      const account = accountsById.get(acct);
      const name = modelsById.get(model);
      const plausible =
        isCount(ts) &&
        isCount(inp) &&
        isCount(outp) &&
        isCount(cr) &&
        isCount(cc) &&
        (e5 === null || isCount(e5)) &&
        (e1 === null || isCount(e1));
      if (account === undefined || name === undefined || !plausible) continue;
      rows.push({
        key,
        ...account,
        ts: Number(ts),
        model: name,
        inp: Number(inp),
        outp: Number(outp),
        cr: Number(cr),
        cc: Number(cc),
        e5: e5 === null ? null : Number(e5),
        e1: e1 === null ? null : Number(e1),
        tier: 0,
      });
    }
    const lineage = meta.get("ledger_id");
    return {
      lineage: typeof lineage === "string" ? lineage : null,
      read: raw.length,
      rows,
      accounts: [...accountsById.values()],
      models: [...modelsById.values()],
    };
  } catch (error) {
    throw sourceError(error, "the cc-usage ledger");
  }
}
