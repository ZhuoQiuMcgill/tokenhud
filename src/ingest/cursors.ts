import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { configDir } from "../paths.ts";
import type { CodexLimitSnapshot, CodexLimitWindow } from "../sources/codex.ts";

/**
 * Per-file read positions, in the derived `~/.config/tokenhud/cache.db`, kept apart from
 * the content-free store because they hold paths. The file is safe to delete: without it
 * every transcript is read again from the start, and the store's max-merge makes that
 * re-read change nothing. So a damaged cache.db is deleted and rebuilt, and one that
 * cannot be opened is replaced by an in-memory cache for the session.
 *
 * It also keeps the newest Codex rate-limit snapshot found in each Codex account's
 * rollouts (`codex_limit_snapshots`, numbers only), which a re-read recreates.
 *
 * Cursors are only valid for the store they were written against: they say "the store
 * already holds everything up to here". So the cache records that store's lineage
 * (`store_id`), and `bind` drops every cursor when the store is a different one (it was
 * recovered from a backup, or replaced by a fresh one), which makes the next pass read
 * every transcript again and backfill it. It also notes when each root was last ingested
 * (`root_pass`), for `doctor`.
 */

/** "TkHC": marks a tokenhud cursor cache, so a mistyped --cache path is never deleted. */
const APPLICATION_ID = 0x546b4843;
/**
 * v2 added `codex_limit_snapshots`; v3 added `cache_meta` and `root_pass`. An older cache
 * keeps what it has.
 */
const VERSION = 3;
const SQLITE_MAGIC = "SQLite format 3\0";
const HEADER_BYTES = 100;
const BUSY_TIMEOUT_MS = 2000;

export function cachePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDir(env, home), "cache.db");
}

export interface Cursor {
  path: string;
  /** Device and inode as decimal strings (an inode can exceed 2^53). */
  dev: string;
  ino: string;
  /** Size and mtime when the file was last read; equal values mean nothing to read. */
  size: number;
  mtimeMs: number;
  /** Where the next read starts: just after the last complete line. */
  offset: number;
  /** Hash of the bytes just before `offset`, to notice a file rewritten in place. */
  tail: string | null;
  /** Provider parser state carried between reads (JSON of numbers and ids only), or null. */
  state: string | null;
}

const CURSOR_SCHEMA = `CREATE TABLE cursor (
  path TEXT PRIMARY KEY,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  offset INTEGER NOT NULL,
  tail TEXT,
  state TEXT
) WITHOUT ROWID`;

/**
 * One row per Codex account: cc-usage's `latest_rate_limits_by_account` capture, in the
 * layout the limits module (T8, `src/limits/snapshots.ts`) reads:
 * - `identity`: the account's identity (sha256 of the Codex home's resolved path, 32 hex);
 * - `captured_at`: epoch seconds of the token_count event that carried it (0 when it had
 *   no usable timestamp); a newer or equally new capture replaces the whole row;
 * - `rate_limits`: JSON `{"codex_primary": {"used_percentage", "resets_at" (epoch s),
 *   "window_minutes"?}, "codex_secondary": {...}}`, numbers only, a window present only if
 *   the capture had it.
 */
const LIMITS_SCHEMA = `CREATE TABLE codex_limit_snapshots (
  identity TEXT PRIMARY KEY,
  captured_at REAL NOT NULL,
  rate_limits TEXT NOT NULL
)`;

const CACHE_META_SCHEMA =
  "CREATE TABLE cache_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID";
/** When a pass last covered each root: account identity -> epoch ms. */
const ROOT_PASS_SCHEMA =
  "CREATE TABLE root_pass (identity TEXT PRIMARY KEY, at REAL NOT NULL) WITHOUT ROWID";

type Bucket = { used_percentage: number; resets_at: number; window_minutes?: number };

function toBucket(window: CodexLimitWindow): Bucket {
  const bucket: Bucket = { used_percentage: window.usedPercentage, resets_at: window.resetsAt };
  if (window.windowMinutes !== null) bucket.window_minutes = window.windowMinutes;
  return bucket;
}

function fromBucket(value: unknown): CodexLimitWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Partial<Bucket>;
  if (typeof b.used_percentage !== "number" || typeof b.resets_at !== "number") return null;
  return {
    usedPercentage: b.used_percentage,
    resetsAt: b.resets_at,
    windowMinutes: typeof b.window_minutes === "number" ? b.window_minutes : null,
  };
}

interface Row {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtime_ms: number;
  offset: number;
  tail: string | null;
  state: string | null;
}

/** What `CursorCache.open` did, for the log. */
export type CacheOpenNote = "opened" | "created" | "rebuilt" | "in-memory";

/** Whether `path` may be (re)created as a cursor cache: missing, empty, or one of ours. */
function ownedOrNew(path: string): "new" | "ours" | "foreign" {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "new";
  }
  if (size === 0) return "new";
  const head = Buffer.alloc(HEADER_BYTES);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "foreign";
  }
  try {
    const n = readSync(fd, head, 0, HEADER_BYTES, 0);
    if (n < HEADER_BYTES || head.toString("latin1", 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) {
      return "foreign";
    }
    return head.readUInt32BE(68) === APPLICATION_ID ? "ours" : "foreign";
  } finally {
    closeSync(fd);
  }
}

function removeCache(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

function prepare(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA synchronous = NORMAL");
  const version = Number(
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (version !== VERSION) {
    // A version this build doesn't know (none, or a newer tokenhud's) is rebuilt whole.
    const known = version >= 1 && version < VERSION;
    db.exec("BEGIN IMMEDIATE");
    if (!known) {
      db.exec("DROP TABLE IF EXISTS cursor");
      db.exec(CURSOR_SCHEMA);
    }
    if (!known || version < 2) {
      db.exec("DROP TABLE IF EXISTS codex_limit_snapshots");
      db.exec(LIMITS_SCHEMA);
    }
    for (const [table, sql] of [
      ["cache_meta", CACHE_META_SCHEMA],
      ["root_pass", ROOT_PASS_SCHEMA],
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
      db.exec(sql as string);
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${VERSION}`);
    db.exec("COMMIT");
  }
  db.exec("PRAGMA journal_mode = WAL");
}

export class CursorCache {
  readonly note: CacheOpenNote;
  readonly #db: Database;

  private constructor(db: Database, note: CacheOpenNote) {
    this.#db = db;
    this.note = note;
  }

  /**
   * Opens the cache at `path`. A cache of ours that fails to open is deleted and rebuilt;
   * a file that is not ours, or a location that cannot be written, gets an in-memory cache
   * instead (every pass then re-reads from the start, which is correct, only slower).
   */
  static open(path: string): CursorCache {
    const owner = ownedOrNew(path);
    if (owner !== "foreign") {
      for (const attempt of [0, 1]) {
        let db: Database | undefined;
        try {
          mkdirSync(dirname(path), { recursive: true });
          db = new Database(path, { create: true, readwrite: true, strict: true });
          prepare(db);
          db.query("SELECT count(*) FROM cursor").get();
          db.query("SELECT count(*) FROM codex_limit_snapshots").get();
          db.query("SELECT count(*) FROM cache_meta").get();
          db.query("SELECT count(*) FROM root_pass").get();
          const note: CacheOpenNote =
            attempt === 1 ? "rebuilt" : owner === "new" ? "created" : "opened";
          return new CursorCache(db, note);
        } catch {
          db?.close();
          if (attempt === 1) break;
          try {
            removeCache(path);
          } catch {
            break;
          }
        }
      }
    }
    const db = new Database(":memory:", { strict: true });
    prepare(db);
    return new CursorCache(db, "in-memory");
  }

  /** Every cursor; none when the cache cannot be read (every file is then read again). */
  all(): Map<string, Cursor> {
    let rows: Row[];
    try {
      rows = this.#db.query<Row, []>("SELECT * FROM cursor").all();
    } catch {
      return new Map();
    }
    return new Map(
      rows.map((r) => [
        r.path,
        {
          path: r.path,
          dev: r.dev,
          ino: r.ino,
          size: r.size,
          mtimeMs: r.mtime_ms,
          offset: r.offset,
          tail: r.tail,
          state: r.state,
        },
      ]),
    );
  }

  /** Writes `put` and deletes `remove` in one transaction. */
  update(put: readonly Cursor[], remove: readonly string[] = []): void {
    if (put.length === 0 && remove.length === 0) return;
    const db = this.#db;
    const upsert = db.query(
      `INSERT INTO cursor (path, dev, ino, size, mtime_ms, offset, tail, state)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (path) DO UPDATE SET dev = excluded.dev, ino = excluded.ino,
         size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset,
         tail = excluded.tail, state = excluded.state`,
    );
    const del = db.query("DELETE FROM cursor WHERE path = ?1");
    db.transaction(() => {
      for (const c of put)
        upsert.run(c.path, c.dev, c.ino, c.size, c.mtimeMs, c.offset, c.tail, c.state);
      for (const path of remove) del.run(path);
    })();
  }

  /**
   * Ties the cursors to the store with lineage `storeId`. When they were written against
   * another store (or none is recorded), every cursor is dropped, so the next pass reads
   * every transcript from the start into this store. Returns whether cursors were dropped.
   */
  bind(storeId: string | null): boolean {
    const db = this.#db;
    try {
      const bound =
        db.query<{ v: string }, []>("SELECT v FROM cache_meta WHERE k = 'store_id'").get()?.v ??
        null;
      if (bound !== null && bound === storeId) return false;
      let dropped = 0;
      db.transaction(() => {
        dropped = db.query("DELETE FROM cursor").run().changes;
        if (storeId === null) db.query("DELETE FROM cache_meta WHERE k = 'store_id'").run();
        else {
          db.query(
            "INSERT INTO cache_meta (k, v) VALUES ('store_id', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
          ).run(storeId);
        }
      })();
      return dropped > 0;
    } catch {
      // An unusable cache reads as no cursors (`all`): every pass reads everything.
      return false;
    }
  }

  /** Records that a pass covered the roots `identities` at `at` (epoch ms). Best effort. */
  notePass(identities: Iterable<string>, at: number): void {
    const db = this.#db;
    try {
      const put = db.query(
        "INSERT INTO root_pass (identity, at) VALUES (?1, ?2) ON CONFLICT (identity) DO UPDATE SET at = excluded.at",
      );
      db.transaction(() => {
        for (const identity of identities) put.run(identity, at);
      })();
    } catch {
      // only doctor reads it
    }
  }

  /** The stored Codex rate-limit snapshot of each account identity; none when unreadable. */
  codexLimitSnapshots(): Map<string, CodexLimitSnapshot> {
    const out = new Map<string, CodexLimitSnapshot>();
    let rows: { identity: string; captured_at: number; rate_limits: string }[];
    try {
      rows = this.#db
        .query<{ identity: string; captured_at: number; rate_limits: string }, []>(
          "SELECT identity, captured_at, rate_limits FROM codex_limit_snapshots",
        )
        .all();
    } catch {
      return out;
    }
    for (const row of rows) {
      let buckets: Record<string, unknown>;
      try {
        buckets = JSON.parse(row.rate_limits) as Record<string, unknown>;
      } catch {
        continue;
      }
      out.set(row.identity, {
        capturedAt: row.captured_at,
        primary: fromBucket(buckets.codex_primary),
        secondary: fromBucket(buckets.codex_secondary),
      });
    }
    return out;
  }

  /** Replaces the snapshots of the given account identities, in one transaction. */
  putCodexLimitSnapshots(snapshots: ReadonlyMap<string, CodexLimitSnapshot>): void {
    if (snapshots.size === 0) return;
    const db = this.#db;
    const put = db.query(
      `INSERT OR REPLACE INTO codex_limit_snapshots (identity, captured_at, rate_limits)
       VALUES (?1, ?2, ?3)`,
    );
    db.transaction(() => {
      for (const [identity, { capturedAt, primary, secondary }] of snapshots) {
        const buckets: Record<string, Bucket> = {};
        if (primary !== null) buckets.codex_primary = toBucket(primary);
        if (secondary !== null) buckets.codex_secondary = toBucket(secondary);
        put.run(identity, capturedAt, JSON.stringify(buckets));
      }
    })();
  }

  close(): void {
    this.#db.close();
  }
}

/** What `doctor` shows of a cursor cache. */
export interface CacheSummary {
  /** Cursors (tracked transcripts) per root, by account identity. */
  cursors: Map<string, number>;
  /** When a pass last covered each root, epoch ms, by account identity. */
  lastPass: Map<string, number>;
}

/**
 * Reads the cache at `path` without writing it, for `doctor`: per root (identity, and
 * the directories its transcripts live in), how many transcripts have a cursor, and when
 * a pass last covered it. Null when there is no cache or it cannot be read.
 */
export function readCacheSummary(
  path: string,
  roots: readonly { identity: string; dirs: readonly string[] }[],
): CacheSummary | null {
  if (ownedOrNew(path) !== "ours") return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    const count = db.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM cursor WHERE substr(path, 1, length(?1)) = ?1",
    );
    const cursors = new Map<string, number>();
    for (const root of roots) {
      let n = 0;
      for (const dir of root.dirs) n += count.get(`${dir}${sep}`)?.n ?? 0;
      cursors.set(root.identity, n);
    }
    const lastPass = new Map<string, number>();
    const hasPasses =
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'root_pass'",
        )
        .get()?.n === 1;
    if (hasPasses) {
      for (const r of db
        .query<{ identity: string; at: number }, []>("SELECT identity, at FROM root_pass")
        .all())
        lastPass.set(r.identity, r.at);
    }
    return { cursors, lastPass };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
