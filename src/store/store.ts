import { Database } from "bun:sqlite";
import {
  closeSync,
  type Dirent,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { guard, SchemeRefused, StoreCorrupt, StoreUnavailable } from "./errors.ts";
import { KEY_SCHEME } from "./key.ts";
import {
  APPLICATION_ID,
  rebuildRollups,
  rollupCountsAgree,
  rollupMatchesUsage,
  rollupSchemaIntact,
  SCHEMA_MIGRATIONS,
  SCHEMA_VERSION,
  UNATTRIBUTED,
} from "./schema.ts";

/**
 * tokenhud's durable, content-free usage store, ported from cc-usage's ledger
 * (`cc_usage/ledger.py`, whose module docstring is the spec where this is silent).
 *
 * A row holds token counts only: the event's 64-bit key, its account (provider, a digest
 * of the root's resolved path, a label), epoch-ms timestamp, model id, input, output,
 * cache-read and cache-creation tokens, the 5m/1h cache-creation sub-buckets (NULL when
 * the transcript had none, which prices differently from 0) and the speed tier. No
 * prompt, path, project or cost is ever stored. Rows from deleted transcripts stay.
 *
 * Writes are one `BEGIN IMMEDIATE` transaction per call, merged per key by cc-usage's
 * rule. WAL plus a busy timeout let the UI, the MCP server and the ingest worker share
 * the file. Every failure surfaces as a `StoreError`, so callers degrade, never crash.
 *
 * Backups and recovery (daily verified `.bak` rotation, moving a corrupt file aside) are
 * a later task. They will rely on `meta.store_id` as the lineage, as cc-usage's
 * `ledger_id`, and on `keySchemeMigrated` to back up right after a migration.
 */

export { UNATTRIBUTED } from "./schema.ts";

export const BUSY_TIMEOUT_MS = 5000;
// Keep the WAL from lingering at the size of the first (backfill) transaction.
const JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024;
// `key IN (...)` batch size, well under SQLite's variable limit.
const IN_BATCH = 500;
// Past this many wanted rows, one sequential pass beats hundreds of batched lookups.
const SCAN_ALL_OVER = 20_000;
const SQLITE_MAGIC = "SQLite format 3\0";
// The database header is the first 100 bytes; application_id is a big-endian u32 at 68.
const HEADER_BYTES = 100;
const APPLICATION_ID_OFFSET = 68;
// Import scratch copies live in their own directories, named SCRATCH_PREFIX + random, in
// a dot-directory beside the store that only tokenhud uses. A store open sweeps such
// directories once they are this old (a crash left them); nothing else is ever touched.
const SCRATCH_DIR = ".tokenhud-tmp";
const SCRATCH_PREFIX = "import-cc-usage-";
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** One usage event as written: account and model by name, interned by the store. */
export interface UsageRow {
  key: bigint;
  provider: string;
  identity: string;
  label: string;
  /** See `AccountRef.derivedLabel`. */
  derivedLabel?: boolean;
  /** Epoch milliseconds. */
  ts: number;
  model: string;
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
  /** 0 standard, 1 fast/priority. */
  tier: number;
}

/** One stored row: account and model by id (see `accounts()` and `models()`). */
export interface StoredRow {
  key: bigint;
  acct: number;
  ts: number;
  model: number;
  inp: number;
  outp: number;
  cr: number;
  cc: number;
  e5: number | null;
  e1: number | null;
  tier: number;
}

export interface AccountRef {
  provider: string;
  identity: string;
  label: string;
  /**
   * True when `label` was derived (from a directory name) rather than configured by the
   * user: it names a new account but never renames an existing one. Absent or false is an
   * explicit label, which renames as cc-usage's ledger does.
   */
  derivedLabel?: boolean;
}

export interface Account extends AccountRef {
  id: number;
}

/** One entry of `meta.imports`. */
export interface ImportRecord {
  at: string;
  source: string;
  /** The source's own lineage (cc-usage's `ledger_id`), when it has one. */
  lineage: string | null;
  rows: number;
  accounts: number;
}

/** One stored limit event (schema.ts, "limit events"). Times are epoch ms. */
export interface LimitEventRow {
  id: number;
  kind: string;
  window: string;
  label: string;
  resetsAt: number;
  at: number;
  resumedAt: number | null;
}

/** What the limits module decided to record for one account. */
export interface LimitEventChanges {
  insert: Omit<LimitEventRow, "id" | "resumedAt">[];
  /** `reached` events, by id, that a later capture found usable again. */
  resume: { id: number; at: number }[];
}

export interface StoreMeta {
  /** A random UUID naming this store's lineage, as cc-usage's `ledger_id`. */
  storeId: string | null;
  keyScheme: number | null;
  createdAt: string | null;
  imports: ImportRecord[];
  /**
   * Codex account identities whose rows were written under key scheme 1 (before the
   * upgrade, or by an import from cc-usage) and still await the Codex re-key, which the
   * next full ingest pass that reads the account's rollouts performs.
   */
  codexRekeyPending: string[];
  /** The last Codex re-key's report per account (see `RekeyReport` in the ingest pass), or null. */
  migrationReport: unknown;
}

/**
 * One write transaction. Rows in `remove` are deleted first; `replace` rows then take the
 * given counts and tier outright (a value may go down), keeping a stored row's account and
 * timestamp and never trading a model for codex-unattributed; `upsert` rows merge by the
 * usual rules.
 */
export interface WriteBatch {
  upsert?: readonly UsageRow[];
  replace?: readonly UsageRow[];
  remove?: readonly bigint[];
  /** Codex account identities whose re-key this write completes. */
  rekeyed?: readonly string[];
  /** Stored as `meta.migration_report` when given. */
  migrationReport?: unknown;
}

export interface OpenOptions {
  /** How long a write waits for another writer. Tests shorten it. */
  busyTimeoutMs?: number;
}

/**
 * Upgrades a store written under one key scheme to the next. Runs inside the write
 * transaction that records the new scheme, so it is all-or-nothing and runs once per
 * store. It may delete, re-key or lower rows; the rollup triggers follow.
 */
export type KeySchemeMigration = (db: Database) => void;

/** Meta keys of the Codex re-key (scheme 1 -> 2). */
const CODEX_REKEY = "codex_rekey";
const MIGRATION_REPORT = "migration_report";
/** cc-usage's and tokenhud's provider name for Codex accounts. */
const CODEX = "codex";

/**
 * Scheme 1 -> 2: Codex rows of child rollouts that replayed their parent's history must
 * go, and only the rollouts can say which rows those are. So this step records every Codex
 * account as pending, and the next full ingest pass re-keys each one whose rollouts it
 * reads (`codexRekeyPending`), in one transaction with that pass's writes. Claude keys did
 * not change.
 */
function markCodexRekey(db: Database): void {
  const identities = db
    .query<{ identity: string }, [string]>("SELECT identity FROM accounts WHERE provider = ?1")
    .all(CODEX)
    .map((a) => a.identity);
  addRekeyPending(db, identities);
}

/**
 * `KEY_SCHEME_MIGRATIONS.get(n)` upgrades a store from key scheme n to n + 1, as
 * cc-usage's registry. A store whose scheme has no path to `KEY_SCHEME` is refused.
 */
export const KEY_SCHEME_MIGRATIONS = new Map<number, KeySchemeMigration>([[1, markCodexRekey]]);

/** Opens (creating if needed) the store at `path`. Throws a `StoreError`. */
export function openStore(path: string, options: OpenOptions = {}): Store {
  return Store.open(path, options);
}

/**
 * Opens the store at `path` for reading only, for `tokenhud json`, `doctor` and the MCP
 * server: it never migrates, repairs or writes, so they answer from the store exactly as
 * it is while the TUI or an import writes. Null when there is no store yet (no file, or
 * an empty one). A foreign file or a store from a newer tokenhud is refused with a
 * `StoreError`; an older schema is read as it is (the query layer only needs v1's
 * tables). The connection uses `safeIntegers`, as every store connection must.
 */
export function openStoreReader(path: string, options: OpenOptions = {}): Database | null {
  refuseForeign(path);
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw classifyFsError(error, path);
  }
  if (size === 0) return null;
  const db = guard(() => new Database(path, { readonly: true, safeIntegers: true, strict: true }));
  try {
    guard(() => db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? BUSY_TIMEOUT_MS}`));
    const version = pragmaInt(db, "user_version");
    if (version > SCHEMA_VERSION) {
      throw new StoreUnavailable(
        `store schema v${version} is newer than this tokenhud understands (v${SCHEMA_VERSION})`,
      );
    }
    if (version === 0) throw new StoreUnavailable("the store was never initialised");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** An empty store in memory, so queries can answer "nothing yet" before a store exists. */
export function emptyStoreDatabase(): Database {
  const db = new Database(":memory:", { safeIntegers: true, strict: true });
  for (const migrate of SCHEMA_MIGRATIONS) migrate(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export class Store {
  readonly path: string;
  /** Where imports keep their scratch copies: `.tokenhud-tmp/` beside the store file. */
  readonly scratchDir: string;
  /** Whether opening this store ran a key-scheme migration (a backup is due at once). */
  readonly keySchemeMigrated: boolean;
  readonly #connection: Database;
  #closed = false;

  private constructor(path: string, db: Database, keySchemeMigrated: boolean) {
    this.path = path;
    this.scratchDir = scratchDirOf(path);
    this.#connection = db;
    this.keySchemeMigrated = keySchemeMigrated;
  }

  /**
   * Opens the store at `path`, creating it if the file is missing or empty. Any other
   * file must already be a tokenhud store: that is decided from its header bytes before
   * SQLite opens it, so a foreign file (a cc-usage ledger, its WAL or backup, another
   * app's database) is refused without a single byte of it or its side files changing.
   */
  static open(path: string, options: OpenOptions = {}): Store {
    refuseForeign(path);
    guard(() => mkdirSync(dirname(path), { recursive: true }));
    const db = guard(
      () => new Database(path, { create: true, readwrite: true, safeIntegers: true, strict: true }),
    );
    try {
      guard(() => {
        db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? BUSY_TIMEOUT_MS}`);
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
        // Interned ids are plain integers, as in cc-usage: no foreign keys.
        db.exec("PRAGMA foreign_keys = OFF");
        // A REPLACE that deletes a conflicting row fires the delete trigger only with
        // recursive triggers on; without it the rollup would drift.
        db.exec("PRAGMA recursive_triggers = ON");
      });
      // A new store is created before WAL is switched on, so its first commit (which sets
      // application_id) lands in the main file itself; the header check relies on that.
      ensureSchema(db);
      guard(() => db.exec("PRAGMA journal_mode = WAL"));
      const migrated = ensureKeyScheme(db);
      ensureRollups(db);
      sweepScratch(scratchDirOf(path));
      return new Store(path, db, migrated);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * A new, empty scratch directory for an import, inside `scratchDir`. Refuses to work
   * through a `scratchDir` that is a symlink, so scratch copies only ever land in a
   * directory tokenhud made.
   */
  newScratchDir(): string {
    const dir = this.scratchDir;
    return guard(() => {
      mkdirSync(dir, { recursive: true });
      if (!lstatSync(dir).isDirectory()) {
        throw new StoreUnavailable(`${dir} is not a plain directory; leaving it alone`);
      }
      return mkdtempSync(join(dir, SCRATCH_PREFIX));
    });
  }

  /** Closes the connection. Later calls on this store throw `StoreUnavailable`. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    guard(() => this.#connection.close());
  }

  get #db(): Database {
    if (this.#closed) throw new StoreUnavailable("the store is closed");
    return this.#connection;
  }

  // ── writes ─────────────────────────────────────────────────────────────────────

  /**
   * Upserts `rows` in one transaction and returns how many distinct keys were inserted
   * or changed (a re-sent row that changes nothing writes nothing and is not counted).
   *
   * Merge per key, as cc-usage's `Ledger.write`: field-wise max of the token counts; a
   * NULL sub-bucket is kept only while both sides lack it; `codex-unattributed` gives
   * way to a real model, never the reverse; tier is the max. The key, account and ts of
   * a stored row never change. Each (provider, identity) is one account whose label
   * follows the latest write of an explicit label (a derived one only names a new
   * account; see `AccountRef.derivedLabel`). Throws `RangeError` for a malformed row (a caller bug)
   * before touching the database, and `StoreError` for everything else.
   */
  upsert(rows: readonly UsageRow[]): number {
    if (rows.length === 0) return 0;
    validate(rows);
    return writeTransaction(this.#db, () => merge(this.#db, rows, [], [])).changed;
  }

  /**
   * The import path: upserts `rows` exactly as `upsert`, also interns `accounts` and
   * `models` no row uses, and appends `record` to `meta.imports`, all in one
   * transaction, so an import is recorded if and only if its rows are stored.
   */
  importRows(
    rows: readonly UsageRow[],
    accounts: readonly AccountRef[],
    models: readonly string[],
    record: ImportRecord,
    rekey: readonly string[] = [],
  ): { inserted: number; changed: number } {
    validate(rows);
    const db = this.#db;
    return writeTransaction(db, () => {
      // Exact under the write lock: no other writer can insert in between.
      const before = countUsage(db);
      const { changed } = merge(db, rows, accounts, models);
      const inserted = countUsage(db) - before;
      const imports = parseImports(getMeta(db, "imports"));
      imports.push(record);
      setMeta(db, "imports", JSON.stringify(imports));
      addRekeyPending(db, rekey);
      return { inserted, changed };
    });
  }

  /**
   * Applies `batch` in one transaction (see `WriteBatch`). Returns how many rows were
   * removed, and how many distinct keys `replace` and `upsert` inserted or changed.
   */
  write(batch: WriteBatch): { removed: number; changed: number } {
    const replace = batch.replace ?? [];
    const upsert = batch.upsert ?? [];
    const remove = batch.remove ?? [];
    const rekeyed = batch.rekeyed ?? [];
    const report = batch.migrationReport;
    if (
      replace.length + upsert.length + remove.length + rekeyed.length === 0 &&
      report === undefined
    ) {
      return { removed: 0, changed: 0 };
    }
    validate(replace);
    validate(upsert);
    const db = this.#db;
    return writeTransaction(db, () => {
      const removed = removeKeys(db, remove);
      let changed = replaceRows(db, replace);
      if (upsert.length > 0) changed += merge(db, upsert, [], []).changed;
      if (rekeyed.length > 0) {
        const done = new Set(rekeyed);
        setMeta(db, CODEX_REKEY, JSON.stringify(rekeyPending(db).filter((id) => !done.has(id))));
      }
      if (report !== undefined) setMeta(db, MIGRATION_REPORT, JSON.stringify(report));
      return { removed, changed };
    });
  }

  // ── reads ──────────────────────────────────────────────────────────────────────

  /** Every stored key, streamed. */
  *keys(): Generator<bigint, void, undefined> {
    const stmt = guard(() => this.#db.prepare<{ key: bigint }, []>("SELECT key FROM usage"));
    try {
      const rows = stmt.iterate();
      for (;;) {
        const next = guard(() => rows.next());
        if (next.done) return;
        yield next.value.key;
      }
    } finally {
      stmt.finalize();
    }
  }

  /** The stored rows for `keys` (absent keys are skipped), in no particular order. */
  rows(keys: Iterable<bigint>): StoredRow[] {
    const wanted = [...keys];
    if (wanted.length === 0) return [];
    const db = this.#db;
    return guard(() => {
      const out: StoredRow[] = [];
      if (wanted.length > SCAN_ALL_OVER) {
        const set = new Set(wanted);
        for (const row of db.query<RawRow, []>(`SELECT ${ROW_COLUMNS} FROM usage`).iterate()) {
          if (set.has(row.key)) out.push(toStoredRow(row));
        }
        return out;
      }
      for (let start = 0; start < wanted.length; start += IN_BATCH) {
        const batch = wanted.slice(start, start + IN_BATCH);
        const stmt = db.prepare<RawRow, bigint[]>(
          `SELECT ${ROW_COLUMNS} FROM usage WHERE key IN (${batch.map(() => "?").join(", ")})`,
        );
        try {
          for (const row of stmt.all(...batch)) out.push(toStoredRow(row));
        } finally {
          stmt.finalize();
        }
      }
      return out;
    });
  }

  /** Account id -> its number of stored rows (accounts without rows are absent). */
  rowCounts(): Map<number, number> {
    return guard(
      () =>
        new Map(
          this.#db
            .query<{ acct: bigint; n: bigint }, []>(
              "SELECT acct, count(*) AS n FROM usage GROUP BY acct",
            )
            .all()
            .map((r) => [Number(r.acct), Number(r.n)]),
        ),
    );
  }

  /** Account id -> account (provider, identity, last label). */
  accounts(): Map<number, Account> {
    return guard(
      () =>
        new Map(
          this.#db
            .query<{ id: bigint; provider: string; identity: string; label: string }, []>(
              "SELECT id, provider, identity, label FROM accounts ORDER BY id",
            )
            .all()
            .map((a) => [Number(a.id), { ...a, id: Number(a.id) }]),
        ),
    );
  }

  /** Model id -> model name. */
  models(): Map<number, string> {
    return guard(
      () =>
        new Map(
          this.#db
            .query<{ id: bigint; name: string }, []>("SELECT id, name FROM models ORDER BY id")
            .all()
            .map((m) => [Number(m.id), m.name]),
        ),
    );
  }

  /** The store's metadata, read fresh. */
  get meta(): StoreMeta {
    return guard(() => {
      const db = this.#db;
      return {
        storeId: getMeta(db, "store_id"),
        keyScheme: parseScheme(getMeta(db, "key_scheme")),
        createdAt: getMeta(db, "created_at"),
        imports: parseImports(getMeta(db, "imports")),
        codexRekeyPending: rekeyPending(db),
        migrationReport: parseJson(getMeta(db, MIGRATION_REPORT)),
      };
    });
  }

  // ── limit events ───────────────────────────────────────────────────────────────

  /**
   * Records one account's limit events in one write transaction: interns the account
   * (labels as `upsert` treats them), hands `decide` the account's still-open `reached`
   * events plus every event whose window resets at or after `since` (epoch ms), and applies
   * the changes it returns. The rules live in the limits module; this only stores them.
   * Returns how many events were inserted or resumed.
   */
  recordLimitEvents(
    account: AccountRef,
    since: number,
    decide: (existing: LimitEventRow[]) => LimitEventChanges,
  ): number {
    const db = this.#db;
    return writeTransaction(db, () => {
      const acct = internAccounts(db, [account]).get(accountKey(account));
      if (acct === undefined) throw new Error("internal: the account was not interned");
      const existing = db
        .query<
          {
            id: bigint;
            kind: string;
            window: string;
            label: string;
            resets_at: bigint;
            at: bigint;
            resumed_at: bigint | null;
          },
          [number, number]
        >(
          `SELECT id, kind, window, label, resets_at, at, resumed_at FROM limit_events
           WHERE acct = ?1 AND ((kind = 'reached' AND resumed_at IS NULL) OR resets_at >= ?2)
           ORDER BY id`,
        )
        .all(acct, since)
        .map(
          (e): LimitEventRow => ({
            id: Number(e.id),
            kind: e.kind,
            window: e.window,
            label: e.label,
            resetsAt: Number(e.resets_at),
            at: Number(e.at),
            resumedAt: e.resumed_at === null ? null : Number(e.resumed_at),
          }),
        );
      const changes = decide(existing);
      const insert = db.query(
        `INSERT INTO limit_events (acct, kind, window, label, resets_at, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );
      for (const e of changes.insert) {
        insert.run(acct, e.kind, storedText(e.window), storedText(e.label), e.resetsAt, e.at);
      }
      const resume = db.query(
        "UPDATE limit_events SET resumed_at = ?2 WHERE id = ?1 AND acct = ?3 AND resumed_at IS NULL",
      );
      for (const r of changes.resume) resume.run(r.id, r.at, acct);
      return changes.insert.length + changes.resume.length;
    });
  }

  // ── rollups ────────────────────────────────────────────────────────────────────

  /** Whether `roll_hour` equals the rollup recomputed from every usage row. O(rows). */
  rollupConsistent(): boolean {
    return guard(() => rollupSchemaIntact(this.#db) && rollupMatchesUsage(this.#db));
  }

  /** Recreates `roll_hour` from `usage` and reinstalls its triggers, in one transaction. */
  rebuildRollups(): void {
    writeTransaction(this.#db, () => rebuildRollups(this.#db));
  }
}

// ── opening ──────────────────────────────────────────────────────────────────────

/** The bytes at the start of `path` (fewer if the file is shorter). */
function readHead(path: string, length: number): Buffer {
  const head = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    return head.subarray(0, readSync(fd, head, 0, length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws unless `path` may be opened as a tokenhud store: missing or empty (a new store),
 * or a SQLite file whose header carries tokenhud's application_id. This reads the header
 * directly, because opening with SQLite can already write: it converts a DELETE-mode file
 * to WAL, checkpoints a leftover WAL into the main file, rebuilds a stale -shm. A file
 * that is not SQLite at all is `StoreCorrupt` (recovery, a later task, moves a damaged
 * store aside); a SQLite file that is not a tokenhud store is `StoreUnavailable`.
 */
function refuseForeign(path: string): void {
  const untouched = "leaving it untouched";
  let st: Stats | undefined;
  try {
    st = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw classifyFsError(error, path);
  }
  if (st !== undefined && !st.isFile()) {
    throw new StoreUnavailable(`${path} is not a file; ${untouched}`);
  }
  const size = st?.size ?? 0;
  if (size === 0) {
    // A new store, unless a WAL is waiting next to it: SQLite would replay that WAL,
    // which belongs to some other, missing database, into the new file.
    let walSize = 0;
    try {
      walSize = statSync(`${path}-wal`).size;
    } catch {
      // no WAL: the usual case
    }
    if (walSize > 0) {
      throw new StoreUnavailable(
        `${path}-wal holds data for a database that is not there; ${untouched}`,
      );
    }
    return;
  }
  let head: Buffer;
  try {
    head = readHead(path, HEADER_BYTES);
  } catch (error) {
    throw classifyFsError(error, path);
  }
  if (
    head.length < HEADER_BYTES ||
    head.toString("latin1", 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC
  ) {
    throw new StoreCorrupt("file is not a database");
  }
  if (head.readUInt32BE(APPLICATION_ID_OFFSET) !== APPLICATION_ID) {
    throw new StoreUnavailable(`this file is not a tokenhud store; ${untouched}`);
  }
}

function classifyFsError(error: unknown, path: string): StoreUnavailable {
  return new StoreUnavailable(`cannot read ${path}: ${(error as Error).message}`, { cause: error });
}

function scratchDirOf(storePath: string): string {
  return join(dirname(storePath), SCRATCH_DIR);
}

/**
 * Deletes import scratch directories left by a crash, once they are an hour old. Only
 * real directories named like ours, directly inside our own scratch dir, are candidates:
 * a symlink (to the scratch dir or in it) is never followed, and any other file or
 * directory is left alone, whatever its age. Best effort.
 */
function sweepScratch(dir: string): void {
  let entries: Dirent[];
  try {
    if (!lstatSync(dir).isDirectory()) return;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no scratch dir yet
  }
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  for (const entry of entries) {
    // Dirent types come from lstat: a symlink is not a directory here.
    if (!entry.name.startsWith(SCRATCH_PREFIX) || !entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    try {
      // rm does not follow symlinks inside the directory it removes.
      if (lstatSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // in use or already gone; the next open tries again
    }
  }
}

function ensureSchema(db: Database): void {
  const version = pragmaInt(db, "user_version");
  if (version > SCHEMA_VERSION) {
    throw new StoreUnavailable(
      `store schema v${version} is newer than this tokenhud understands (v${SCHEMA_VERSION}); leaving it untouched`,
    );
  }
  if (version === SCHEMA_VERSION) return;
  writeTransaction(db, () => {
    // Re-check under the write lock: another process may have just done it.
    const current = pragmaInt(db, "user_version");
    for (let v = current; v < SCHEMA_VERSION; v++) SCHEMA_MIGRATIONS[v]?.(db);
    if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/**
 * Refuses a key scheme this build cannot bring to `KEY_SCHEME`: unknown, newer, or older
 * with a missing migration step. Mixing schemes would double count, so the store is left
 * untouched and the caller runs without it.
 */
function assertMigratable(stored: number | null): asserts stored is number {
  if (stored === null) {
    throw new SchemeRefused("store has no readable key scheme; leaving it untouched");
  }
  if (stored > KEY_SCHEME) {
    throw new SchemeRefused(
      `store uses key scheme v${stored}, newer than this tokenhud (v${KEY_SCHEME}); leaving it untouched`,
    );
  }
  for (let v = stored; v < KEY_SCHEME; v++) {
    if (!KEY_SCHEME_MIGRATIONS.has(v)) {
      throw new SchemeRefused(
        `store uses key scheme v${v} and there is no migration to v${v + 1}; leaving it untouched`,
      );
    }
  }
}

/** Runs the key-scheme migrations this store needs, once, atomically. True if it ran any. */
function ensureKeyScheme(db: Database): boolean {
  const stored = guard(() => parseScheme(getMeta(db, "key_scheme")));
  if (stored === KEY_SCHEME) return false;
  assertMigratable(stored);
  return writeTransaction(db, () => {
    // Re-read under the write lock: another process may have migrated it meanwhile.
    const current = parseScheme(getMeta(db, "key_scheme"));
    if (current === KEY_SCHEME) return false;
    assertMigratable(current);
    for (let v = current; v < KEY_SCHEME; v++) KEY_SCHEME_MIGRATIONS.get(v)?.(db);
    setMeta(db, "key_scheme", String(KEY_SCHEME));
    return true;
  });
}

/**
 * Rebuilds the rollup when its table or a trigger is missing or altered (an external
 * writer recreated a table without them), or when the cheap count probe finds drift. The
 * full row-for-row comparison is `Store.rollupConsistent()`, run on demand.
 */
function ensureRollups(db: Database): void {
  const healthy = guard(() => rollupSchemaIntact(db) && rollupCountsAgree(db));
  if (!healthy) writeTransaction(db, () => rebuildRollups(db));
}

// ── writing ──────────────────────────────────────────────────────────────────────

/** Runs `fn` in a `BEGIN IMMEDIATE` transaction; rolls back if anything throws. */
function writeTransaction<T>(db: Database, fn: () => T): T {
  return guard(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back (it does on some I/O errors); report the cause.
      }
      throw error;
    }
  });
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const COUNT_FIELDS = ["ts", "inp", "outp", "cr", "cc", "tier"] as const;
const TEXT_FIELDS = ["provider", "identity", "label", "model"] as const;

/** Checks every row before the write starts, so a caller bug cannot store a half batch. */
function validate(rows: readonly UsageRow[]): void {
  rows.forEach((row, i) => {
    const bad = (field: string, expected: string) =>
      new RangeError(`usage row ${i}: ${field} must be ${expected}`);
    if (typeof row.key !== "bigint" || row.key < INT64_MIN || row.key > INT64_MAX) {
      throw bad("key", "a signed 64-bit bigint");
    }
    for (const field of COUNT_FIELDS) {
      if (!isCount(row[field])) throw bad(field, "a non-negative safe integer");
    }
    for (const field of ["e5", "e1"] as const) {
      if (row[field] !== null && !isCount(row[field])) {
        throw bad(field, "null or a non-negative safe integer");
      }
    }
    for (const field of TEXT_FIELDS) {
      if (typeof row[field] !== "string") throw bad(field, "a string");
    }
  });
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The form of `value` SQLite can store, exactly as cc-usage's `_text`: transcripts are
 * JSON, and a JSON-escaped lone surrogate cannot be encoded as UTF-8. Python's
 * surrogatepass-encode then replace-decode turns each one into three U+FFFD, so this
 * does too, and a model or label interns to the same name in both stores.
 */
export function storedText(value: string): string {
  return value.isWellFormed() ? value : value.replace(LONE_SURROGATE, "���");
}

// Merge an incoming row into a stored one exactly as cc-usage's `_UPSERT`, plus tier
// (max). The WHERE clause skips no-op updates, so a re-sent unchanged row writes no
// page. RETURNING yields a row only for a row inserted or changed; Bun's `changes` would
// also count the rollup triggers' writes. ?12 is the interned id of codex-unattributed.
const UPSERT = `INSERT INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (key) DO UPDATE SET
  inp = max(usage.inp, excluded.inp),
  outp = max(usage.outp, excluded.outp),
  cr = max(usage.cr, excluded.cr),
  cc = max(usage.cc, excluded.cc),
  e5 = CASE WHEN usage.e5 IS NULL THEN excluded.e5
            WHEN excluded.e5 IS NULL THEN usage.e5
            ELSE max(usage.e5, excluded.e5) END,
  e1 = CASE WHEN usage.e1 IS NULL THEN excluded.e1
            WHEN excluded.e1 IS NULL THEN usage.e1
            ELSE max(usage.e1, excluded.e1) END,
  model = CASE WHEN usage.model = ?12 AND excluded.model != ?12
               THEN excluded.model ELSE usage.model END,
  tier = max(usage.tier, excluded.tier)
WHERE excluded.inp > usage.inp
   OR excluded.outp > usage.outp
   OR excluded.cr > usage.cr
   OR excluded.cc > usage.cc
   OR (excluded.e5 IS NOT NULL AND (usage.e5 IS NULL OR excluded.e5 > usage.e5))
   OR (excluded.e1 IS NOT NULL AND (usage.e1 IS NULL OR excluded.e1 > usage.e1))
   OR (usage.model = ?12 AND excluded.model != ?12)
   OR excluded.tier > usage.tier
RETURNING 1 AS hit`;

type Params = [
  key: bigint,
  acct: number,
  ts: number,
  model: number,
  inp: number,
  outp: number,
  cr: number,
  cc: number,
  e5: number | null,
  e1: number | null,
  tier: number,
];

// cc-usage writes its parameter tuples sorted, so this sorts the same way: by key (which
// turns a large backfill into appends), then account, ts and model id. When one batch
// holds a key twice, the copy with the lowest of those is inserted first and keeps its
// account, ts and real model; the counts merge by max either way. Ids are interned in
// cc-usage's order too (see internAccounts and internModels), so the same copy wins.
function byKeyThenFirstFields(a: Params, b: Params): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

/**
 * Interns accounts and models and upserts `rows`. Caller holds the write transaction.
 * Returns how many distinct keys were inserted or changed.
 */
function merge(
  db: Database,
  rows: readonly UsageRow[],
  extraAccounts: readonly AccountRef[],
  extraModels: readonly string[],
): { changed: number } {
  const { params, unattributed } = interned(db, rows, extraAccounts, extraModels);
  params.sort(byKeyThenFirstFields);
  const upsert = db.query<{ hit: bigint }, [...Params, number]>(UPSERT);
  const changed = new Set<bigint>();
  for (const p of params) {
    if (upsert.get(...p, unattributed) !== null) changed.add(p[0]);
  }
  return { changed: changed.size };
}

/** Interns the rows' accounts and models (and the extra ones) and returns the rows as parameters. */
function interned(
  db: Database,
  rows: readonly UsageRow[],
  extraAccounts: readonly AccountRef[],
  extraModels: readonly string[],
): { params: Params[]; unattributed: number } {
  const accounts = internAccounts(db, [...extraAccounts, ...rows]);
  const models = internModels(db, [...extraModels, ...rows.map((row) => row.model)]);
  const unattributed = models.get(UNATTRIBUTED);
  if (unattributed === undefined) throw new Error("internal: codex-unattributed was not interned");
  const params = rows.map((row): Params => {
    const acct = accounts.get(accountKey(row));
    const model = models.get(storedText(row.model));
    if (acct === undefined || model === undefined) {
      throw new Error("internal: a row's account or model was not interned");
    }
    return [
      row.key,
      acct,
      row.ts,
      model,
      row.inp,
      row.outp,
      row.cr,
      row.cc,
      row.e5,
      row.e1,
      row.tier,
    ];
  });
  return { params, unattributed };
}

// A replacing write (the Codex re-key): counts and tier as given, even lower; a stored
// row keeps its account and timestamp, and a real model is never traded for
// codex-unattributed (?12). RETURNING yields a row only for a row inserted or changed.
const REPLACE = `INSERT INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (key) DO UPDATE SET
  inp = excluded.inp, outp = excluded.outp, cr = excluded.cr, cc = excluded.cc,
  e5 = excluded.e5, e1 = excluded.e1, tier = excluded.tier,
  model = CASE WHEN excluded.model = ?12 THEN usage.model ELSE excluded.model END
WHERE usage.inp != excluded.inp
   OR usage.outp != excluded.outp
   OR usage.cr != excluded.cr
   OR usage.cc != excluded.cc
   OR usage.e5 IS NOT excluded.e5
   OR usage.e1 IS NOT excluded.e1
   OR usage.tier != excluded.tier
   OR (excluded.model != ?12 AND usage.model != excluded.model)
RETURNING 1 AS hit`;

/** Writes `rows` with replace semantics; returns how many keys were inserted or changed. */
function replaceRows(db: Database, rows: readonly UsageRow[]): number {
  if (rows.length === 0) return 0;
  const { params, unattributed } = interned(db, rows, [], []);
  params.sort(byKeyThenFirstFields);
  const replace = db.query<{ hit: bigint }, [...Params, number]>(REPLACE);
  const changed = new Set<bigint>();
  for (const p of params) {
    if (replace.get(...p, unattributed) !== null) changed.add(p[0]);
  }
  return changed.size;
}

/** Deletes the rows of `keys`; returns how many existed. */
function removeKeys(db: Database, keys: readonly bigint[]): number {
  let removed = 0;
  for (let start = 0; start < keys.length; start += IN_BATCH) {
    const batch = keys.slice(start, start + IN_BATCH);
    const stmt = db.prepare<{ hit: bigint }, bigint[]>(
      `DELETE FROM usage WHERE key IN (${batch.map(() => "?").join(", ")}) RETURNING 1 AS hit`,
    );
    try {
      removed += stmt.all(...batch).length;
    } finally {
      stmt.finalize();
    }
  }
  return removed;
}

/** One string per (provider, identity), as stored. */
function accountKey(ref: { provider: string; identity: string }): string {
  return JSON.stringify([storedText(ref.provider), storedText(ref.identity)]);
}

/**
 * Interns every (provider, identity) with its last label, new ones in order of first
 * appearance (cc-usage's dict order); returns accountKey -> id. The label is the one
 * current at the latest write: a rename updates it, while the account stays the same.
 * A derived label only names a new account, and an explicit label in the same batch
 * wins over it.
 */
function internAccounts(db: Database, refs: readonly AccountRef[]): Map<string, number> {
  const labels = new Map<string, AccountRef & { derivedLabel: boolean }>();
  for (const ref of refs) {
    const key = accountKey(ref);
    const derivedLabel = ref.derivedLabel === true;
    if (derivedLabel && labels.get(key)?.derivedLabel === false) continue;
    labels.set(key, {
      provider: storedText(ref.provider),
      identity: storedText(ref.identity),
      label: storedText(ref.label),
      derivedLabel,
    });
  }
  const rename = db.query(
    `INSERT INTO accounts (provider, identity, label) VALUES (?1, ?2, ?3)
     ON CONFLICT (provider, identity) DO UPDATE SET label = excluded.label
     WHERE accounts.label != excluded.label`,
  );
  const name = db.query(
    `INSERT INTO accounts (provider, identity, label) VALUES (?1, ?2, ?3)
     ON CONFLICT (provider, identity) DO NOTHING`,
  );
  for (const { provider, identity, label, derivedLabel } of labels.values()) {
    (derivedLabel ? name : rename).run(provider, identity, label);
  }
  return new Map(
    db
      .query<{ id: bigint; provider: string; identity: string }, []>(
        "SELECT id, provider, identity FROM accounts",
      )
      .all()
      .map((a) => [accountKey(a), Number(a.id)]),
  );
}

/** Orders strings by code point, as Python sorts str (not by UTF-16 code unit). */
export function byCodePoint(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/**
 * Interns `names` plus codex-unattributed (as cc-usage always does), new ones in
 * cc-usage's sorted order; returns name -> id.
 */
function internModels(db: Database, names: readonly string[]): Map<string, number> {
  const insert = db.query("INSERT OR IGNORE INTO models (name) VALUES (?1)");
  const unique = new Set(names.map(storedText));
  unique.add(UNATTRIBUTED);
  for (const name of [...unique].sort(byCodePoint)) insert.run(name);
  return new Map(
    db
      .query<{ id: bigint; name: string }, []>("SELECT id, name FROM models")
      .all()
      .map((m) => [m.name, Number(m.id)]),
  );
}

// ── small helpers ────────────────────────────────────────────────────────────────

const ROW_COLUMNS = "key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier";

interface RawRow {
  key: bigint;
  acct: bigint;
  ts: bigint;
  model: bigint;
  inp: bigint;
  outp: bigint;
  cr: bigint;
  cc: bigint;
  e5: bigint | null;
  e1: bigint | null;
  tier: bigint;
}

// Only keys need 64 bits; ids, timestamps and token counts are far below 2^53.
function toStoredRow(row: RawRow): StoredRow {
  return {
    key: row.key,
    acct: Number(row.acct),
    ts: Number(row.ts),
    model: Number(row.model),
    inp: Number(row.inp),
    outp: Number(row.outp),
    cr: Number(row.cr),
    cc: Number(row.cc),
    e5: row.e5 === null ? null : Number(row.e5),
    e1: row.e1 === null ? null : Number(row.e1),
    tier: Number(row.tier),
  };
}

function countUsage(db: Database): number {
  return Number(db.query<{ n: bigint }, []>("SELECT count(*) AS n FROM usage").get()?.n ?? 0n);
}

function pragmaInt(db: Database, name: "user_version" | "application_id"): number {
  return guard(() => {
    const row = db.query<Record<string, bigint>, []>(`PRAGMA ${name}`).get();
    return Number(row?.[name] ?? 0n);
  });
}

function getMeta(db: Database, key: string): string | null {
  return (
    db.query<{ v: string | null }, [string]>("SELECT v FROM meta WHERE k = ?1").get(key)?.v ?? null
  );
}

function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
  ).run(key, value);
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The Codex accounts awaiting the re-key; anything unreadable counts as none. */
function rekeyPending(db: Database): string[] {
  const value = parseJson(getMeta(db, CODEX_REKEY));
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function addRekeyPending(db: Database, identities: readonly string[]): void {
  if (identities.length === 0) return;
  const pending = new Set(rekeyPending(db));
  for (const id of identities) pending.add(id);
  setMeta(db, CODEX_REKEY, JSON.stringify([...pending]));
}

function parseScheme(raw: string | null): number | null {
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

/** `meta.imports` as a list; anything unreadable counts as empty, as cc-usage's `_json_list`. */
function parseImports(raw: string | null): ImportRecord[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
