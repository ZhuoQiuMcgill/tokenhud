import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "../paths.ts";

/**
 * Per-file read positions, in the derived `~/.config/tokenhud/cache.db`, kept apart from
 * the content-free store because they hold paths. The file is safe to delete: without it
 * every transcript is read again from the start, and the store's max-merge makes that
 * re-read change nothing. So a damaged cache.db is deleted and rebuilt, and one that
 * cannot be opened is replaced by an in-memory cache for the session.
 */

/** "TkHC": marks a tokenhud cursor cache, so a mistyped --cache path is never deleted. */
const APPLICATION_ID = 0x546b4843;
const VERSION = 1;
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

const SCHEMA = `CREATE TABLE cursor (
  path TEXT PRIMARY KEY,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  offset INTEGER NOT NULL,
  tail TEXT,
  state TEXT
) WITHOUT ROWID`;

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
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE IF EXISTS cursor");
    db.exec(SCHEMA);
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

  close(): void {
    this.#db.close();
  }
}
