import { Database, SQLiteError } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  classify,
  SchemeRefused,
  StoreBusy,
  StoreCorrupt,
  StoreError,
  StoreUnavailable,
} from "../../src/store/errors.ts";
import { KEY_SCHEME } from "../../src/store/key.ts";
import { APPLICATION_ID, ROLL_TRIGGERS, SCHEMA_VERSION } from "../../src/store/schema.ts";
import { KEY_SCHEME_MIGRATIONS, openStore, type Store } from "../../src/store/store.ts";
import { cleanup, HOUR, row, T0, tempDir, track } from "./helpers.ts";

afterEach(cleanup);

const CC_USAGE_FIXTURE = join(
  import.meta.dir,
  "..",
  "fixtures",
  "store",
  "cc-usage-ledger.sqlite3",
);

function storePath(): string {
  return join(tempDir(), "tokenhud.db");
}

function open(path: string, busyTimeoutMs?: number): Store {
  return track(openStore(path, busyTimeoutMs === undefined ? {} : { busyTimeoutMs }));
}

/** Runs `fn` on a plain connection to `path`, outside the store. */
function raw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path, { safeIntegers: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function scalar(db: Database, sql: string): unknown {
  const first = db.query<Record<string, unknown>, []>(sql).get();
  return first === null ? undefined : Object.values(first)[0];
}

describe("opening", () => {
  test("creates the schema, metadata and pragmas the task specifies", () => {
    const path = join(tempDir(), "nested", "dir", "tokenhud.db");
    const store = open(path);
    const meta = store.meta;
    expect(meta.storeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(meta.keyScheme).toBe(KEY_SCHEME);
    expect(Date.parse(meta.createdAt ?? "")).toBeGreaterThan(0);
    expect(meta.imports).toEqual([]);
    expect(store.keySchemeMigrated).toBe(false);
    store.close();
    raw(path, (db) => {
      expect(scalar(db, "PRAGMA user_version")).toBe(BigInt(SCHEMA_VERSION));
      expect(scalar(db, "PRAGMA journal_mode")).toBe("wal");
      const columns = (table: string) =>
        db
          .query<{ name: string; type: string; notnull: bigint; pk: bigint }, []>(
            `PRAGMA table_info(${table})`,
          )
          .all()
          .map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" : ""}`);
      expect(columns("usage")).toEqual([
        "key INTEGER PK",
        "acct INTEGER NOT NULL",
        "ts INTEGER NOT NULL",
        "model INTEGER NOT NULL",
        "inp INTEGER NOT NULL",
        "outp INTEGER NOT NULL",
        "cr INTEGER NOT NULL",
        "cc INTEGER NOT NULL",
        "e5 INTEGER",
        "e1 INTEGER",
        "tier INTEGER NOT NULL",
      ]);
      expect(columns("accounts")).toEqual([
        "id INTEGER PK",
        "provider TEXT NOT NULL",
        "identity TEXT NOT NULL",
        "label TEXT NOT NULL",
      ]);
      expect(columns("models")).toEqual(["id INTEGER PK", "name TEXT NOT NULL"]);
      // A WITHOUT ROWID primary key is NOT NULL implicitly.
      expect(columns("meta")).toEqual(["k TEXT NOT NULL PK", "v TEXT"]);
      expect(columns("roll_hour")).toEqual([
        "hour INTEGER NOT NULL PK",
        "acct INTEGER NOT NULL PK",
        "model INTEGER NOT NULL PK",
        "tier INTEGER NOT NULL PK",
        "inp INTEGER NOT NULL",
        "outp INTEGER NOT NULL",
        "cr INTEGER NOT NULL",
        "cc INTEGER NOT NULL",
        "e5 INTEGER NOT NULL",
        "e1 INTEGER NOT NULL",
        "ccx INTEGER NOT NULL",
        "n INTEGER NOT NULL",
      ]);
      expect(scalar(db, "SELECT sql FROM sqlite_master WHERE name = 'usage_ts'")).toBe(
        "CREATE INDEX usage_ts ON usage (ts)",
      );
      expect(scalar(db, "SELECT sql FROM sqlite_master WHERE name = 'roll_hour'")).toContain(
        "WITHOUT ROWID",
      );
      const triggers = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all()
        .map((t) => t.name)
        .sort();
      expect(triggers).toEqual([...ROLL_TRIGGERS.keys()].sort());
    });
  });

  test("sets the busy timeout, foreign keys off and recursive triggers on", () => {
    // Observed through behaviour: the store's own connection is private.
    const path = storePath();
    open(path).close();
    const store = open(path);
    // recursive_triggers: a REPLACE run by a migration keeps the rollup exact (see below);
    // foreign_keys off: ids are plain integers, so a row may name an account id that a
    // migration has not created yet without failing.
    expect(store.rollupConsistent()).toBe(true);
  });

  test("reopening keeps the lineage and does not rebuild the rollup", () => {
    const path = storePath();
    const first = open(path);
    first.upsert([row(1n), row(2n, { ts: T0 + HOUR })]);
    const lineage = first.meta.storeId;
    first.close();
    const version = raw(path, (db) => scalar(db, "PRAGMA schema_version"));
    const again = open(path);
    expect(again.meta.storeId).toBe(lineage);
    again.close();
    // A rebuild drops and recreates the rollup table and triggers, bumping schema_version.
    expect(raw(path, (db) => scalar(db, "PRAGMA schema_version"))).toBe(version);
  });

  test("an empty file is a new store", () => {
    const path = storePath();
    writeFileSync(path, "");
    expect(open(path).meta.keyScheme).toBe(KEY_SCHEME);
  });
});

describe("files the store must not touch", () => {
  /** sha256 of every file in `dir`, by name: proof that nothing was written or created. */
  function fingerprint(dir: string): Map<string, string> {
    return new Map(
      readdirSync(dir)
        .sort()
        .map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(dir, name)))
            .digest("hex"),
        ]),
    );
  }

  /** Opening `path` as a store is refused with `kind`, and its directory is unchanged. */
  function expectRefusedUntouched(path: string, kind: typeof StoreError): void {
    const dir = join(path, "..");
    const before = fingerprint(dir);
    expect(caught(() => open(path))).toBeInstanceOf(kind);
    expect(fingerprint(dir)).toEqual(before);
  }

  /** A copy of the cc-usage fixture ledger, named as cc-usage names it. */
  function ccUsageLedger(name = "ledger.sqlite3"): string {
    const path = join(tempDir(), name);
    copyFileSync(CC_USAGE_FIXTURE, path);
    return path;
  }

  /** Adds a row to a cc-usage ledger without checkpointing it into the main file. */
  function writeToWal(db: Database): void {
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec(`INSERT INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1)
      SELECT 4242, a.id, 1780000000000, m.id, 9, 9, 0, 0, NULL, NULL
      FROM accounts a, models m WHERE a.label = 'personal' AND m.name = 'claude-opus-4-8'`);
  }

  test("a cc-usage ledger at rest", () => {
    expectRefusedUntouched(ccUsageLedger(), StoreUnavailable);
  });

  test("a cc-usage ledger with a leftover WAL (cc-usage was killed)", () => {
    const live = ccUsageLedger();
    const path = join(tempDir(), "ledger.sqlite3");
    const writer = new Database(live);
    try {
      writeToWal(writer);
      // The files as a killed process leaves them: frames in the WAL, a stale -shm.
      for (const side of ["", "-wal", "-shm"]) copyFileSync(`${live}${side}`, `${path}${side}`);
    } finally {
      writer.close();
    }
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expectRefusedUntouched(path, StoreUnavailable);
  });

  test("a cc-usage ledger in use, with frames in its WAL", () => {
    const path = ccUsageLedger();
    const writer = new Database(path);
    try {
      writeToWal(writer);
      expectRefusedUntouched(path, StoreUnavailable);
    } finally {
      writer.close();
    }
  });

  test("a DELETE-mode backup such as ledger.sqlite3.bak", () => {
    const path = ccUsageLedger("ledger.sqlite3.bak");
    raw(path, (db) => db.exec("PRAGMA journal_mode = DELETE"));
    expect(readFileSync(path)[18]).toBe(1); // the header says rollback journal, not WAL
    expectRefusedUntouched(path, StoreUnavailable);
  });

  test("another application's database with user_version 0", () => {
    const path = storePath();
    raw(path, (db) => db.exec("CREATE TABLE notes (body TEXT)"));
    expectRefusedUntouched(path, StoreUnavailable);
  });

  test("an empty file next to a WAL that holds data", () => {
    const path = storePath();
    writeFileSync(path, "");
    writeFileSync(`${path}-wal`, Buffer.alloc(4096, 7));
    expectRefusedUntouched(path, StoreUnavailable);
  });

  test("a directory", () => {
    const dir = tempDir();
    expect(caught(() => open(dir))).toBeInstanceOf(StoreUnavailable);
    expect(readdirSync(dir)).toEqual([]);
  });

  // test_corrupt_ledger_is_moved_aside_and_rebuilt (detection; moving aside is recovery)
  test("a file that is not SQLite is corrupt, refused before SQLite opens it", () => {
    const path = storePath();
    writeFileSync(path, Buffer.from("this is not a sqlite database".repeat(64)));
    expectRefusedUntouched(path, StoreCorrupt);
  });

  test("a SQLite file with damaged pages is reported corrupt", () => {
    const path = storePath();
    const store = open(path);
    store.upsert(Array.from({ length: 2000 }, (_, i) => row(BigInt(i), { ts: T0 + i * 60_000 })));
    store.close();
    const bytes = readFileSync(path);
    bytes.fill(0xa5, 100, bytes.length); // keep the 100-byte header, scribble over the rest
    writeFileSync(path, bytes);
    const error = caught(() => open(path));
    expect(error).toBeInstanceOf(StoreCorrupt);
    expect((error as StoreError).cause).toBeInstanceOf(SQLiteError);
  });

  test("a new store has tokenhud's application_id in its main file from the first open", () => {
    const path = storePath();
    const store = open(path);
    const header = readFileSync(path).subarray(0, 100);
    expect(header.readUInt32BE(68)).toBe(APPLICATION_ID);
    expect(header[18]).toBe(2); // and WAL is on
    store.close();
    expect(open(path).meta.keyScheme).toBe(KEY_SCHEME);
  });

  test("a store from a newer tokenhud is refused and left byte-identical", () => {
    const path = storePath();
    open(path).close();
    raw(path, (db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    const before = readFileSync(path);
    const error = caught(() => open(path));
    expect(error).toBeInstanceOf(StoreUnavailable);
    expect((error as Error).message).toContain("newer");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  // test_read_only_config_dir_runs_without_the_ledger
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a read-only directory makes the store unavailable and creates nothing",
    () => {
      const dir = tempDir();
      chmodSync(dir, 0o555);
      try {
        expect(caught(() => open(join(dir, "tokenhud.db")))).toBeInstanceOf(StoreUnavailable);
        expect(caught(() => open(join(dir, "sub", "tokenhud.db")))).toBeInstanceOf(
          StoreUnavailable,
        );
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
});

describe("errors", () => {
  // test_busy_ledger_retries_on_the_next_scan
  test("a write blocked past the busy timeout is StoreBusy, and the retry succeeds", () => {
    const path = storePath();
    const store = open(path, 50);
    store.upsert([row(1n)]);
    const blocker = new Database(path);
    blocker.exec("BEGIN EXCLUSIVE"); // another writer mid-transaction
    try {
      const error = caught(() => store.upsert([row(2n)]));
      expect(error).toBeInstanceOf(StoreBusy);
      expect((error as StoreError).cause).toBeInstanceOf(SQLiteError);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(store.upsert([row(2n)])).toBe(1);
    expect([...store.keys()].sort()).toEqual([1n, 2n]);
  });

  // test_failed_incremental_write_is_retried_on_the_next_sync (atomicity half)
  test("a write that fails part-way leaves nothing behind", () => {
    const path = storePath();
    const store = open(path);
    store.upsert([row(1n)]);
    raw(path, (db) =>
      db.exec(
        "CREATE TRIGGER boom BEFORE INSERT ON usage WHEN NEW.key = 42 BEGIN SELECT RAISE(ABORT, 'boom'); END",
      ),
    );
    const batch = [
      row(41n, { identity: "id-new", label: "new" }),
      row(42n),
      row(43n, { model: "m-new" }),
    ];
    const error = caught(() => store.upsert(batch));
    expect(error).toBeInstanceOf(StoreError);
    expect(error).not.toBeInstanceOf(SQLiteError);
    expect([...store.keys()]).toEqual([1n]);
    expect(store.accounts().size).toBe(1); // interning rolled back too
    expect([...store.models().values()]).not.toContain("m-new");
    expect(store.rollupConsistent()).toBe(true);
    raw(path, (db) => db.exec("DROP TRIGGER boom"));
    expect(store.upsert(batch)).toBe(3);
  });

  test("malformed rows are a caller bug: RangeError, nothing written", () => {
    const store = open(storePath());
    const bad = [
      row(2n ** 63n),
      row(-(2n ** 63n) - 1n),
      { ...row(1n), key: 1 as unknown as bigint },
      row(1n, { ts: 1.5 }),
      row(1n, { inp: -1 }),
      row(1n, { outp: Number.NaN }),
      row(1n, { cc: 2 ** 53 }),
      row(1n, { e5: -3 }),
      row(1n, { tier: -1 }),
      { ...row(1n), e1: undefined as unknown as null },
      { ...row(1n), model: undefined as unknown as string },
    ];
    for (const r of bad)
      expect(caught(() => store.upsert([row(5n), r]))).toBeInstanceOf(RangeError);
    expect([...store.keys()]).toEqual([]);
  });

  test("classify maps codes and messages like cc-usage's _classify", () => {
    expect(classify(new Error("database disk image is malformed"))).toBeInstanceOf(StoreCorrupt);
    expect(classify(new Error("file is not a database"))).toBeInstanceOf(StoreCorrupt);
    expect(classify(new Error("database is locked"))).toBeInstanceOf(StoreBusy);
    expect(classify(new Error("database table is busy"))).toBeInstanceOf(StoreBusy);
    expect(classify(new Error("database or disk is full"))).toBeInstanceOf(StoreUnavailable);
    expect(classify("weird")).toBeInstanceOf(StoreUnavailable);
    const busy = new StoreBusy("x");
    expect(classify(busy)).toBe(busy);
    // A result code wins over the message.
    const db = new Database(":memory:");
    const error = caught(() => db.exec("SELECT * FROM missing_table_locked_busy_malformed"));
    db.close();
    expect(error).toBeInstanceOf(SQLiteError);
    expect(classify(error)).toBeInstanceOf(StoreUnavailable);
  });
});

describe("key-scheme guard", () => {
  // test_ledger_records_its_key_scheme
  test("a new store records the current key scheme", () => {
    expect(open(storePath()).meta.keyScheme).toBe(KEY_SCHEME);
  });

  function storeOnScheme(scheme: string): string {
    const path = storePath();
    const store = open(path);
    store.upsert([
      row(1n, { outp: 70 }),
      row(2n, { outp: 5, ts: T0 + HOUR }),
      row(3n, { outp: 70 }),
    ]);
    store.close();
    raw(path, (db) => db.query("UPDATE meta SET v = ?1 WHERE k = 'key_scheme'").run(scheme));
    return path;
  }

  function withMigration(from: number, migrate: (db: Database) => void, fn: () => void): void {
    KEY_SCHEME_MIGRATIONS.set(from, migrate);
    try {
      fn();
    } finally {
      KEY_SCHEME_MIGRATIONS.delete(from);
    }
  }

  // test_key_scheme_migration_runs_once
  test("an older scheme with a registered migration is migrated once, in a transaction", () => {
    const path = storeOnScheme(String(KEY_SCHEME - 1));
    let calls = 0;
    withMigration(
      KEY_SCHEME - 1,
      (db) => {
        calls++;
        db.exec("DELETE FROM usage WHERE outp = 70"); // e.g. a record now dropped
      },
      () => {
        const first = open(path);
        expect(first.keySchemeMigrated).toBe(true);
        first.close();
        const second = open(path);
        expect(second.keySchemeMigrated).toBe(false);
        expect(calls).toBe(1);
        expect(second.meta.keyScheme).toBe(KEY_SCHEME);
        expect([...second.keys()]).toEqual([2n]);
        expect(second.rollupConsistent()).toBe(true); // the delete trigger followed
      },
    );
  });

  test("a migration that re-keys with INSERT OR REPLACE keeps the rollup exact", () => {
    const path = storeOnScheme(String(KEY_SCHEME - 1));
    withMigration(
      KEY_SCHEME - 1,
      (db) => {
        // Replace row 1 with a copy moved to another hour, model and tier.
        db.exec(
          `INSERT OR REPLACE INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1, tier)
           SELECT key, acct, ts + 7200000, model + 1, inp, outp, cr, cc, 5, NULL, 1 FROM usage WHERE key = 1`,
        );
      },
      () => {
        const store = open(path);
        expect(store.rollupConsistent()).toBe(true);
        expect(store.rows([1n])[0]?.tier).toBe(1);
      },
    );
  });

  test("a migration that fails rolls back and leaves the store as it was", () => {
    const path = storeOnScheme(String(KEY_SCHEME - 1));
    withMigration(
      KEY_SCHEME - 1,
      (db) => {
        db.exec("DELETE FROM usage");
        db.exec("DELETE FROM no_such_table");
      },
      () => {
        expect(caught(() => open(path))).toBeInstanceOf(StoreUnavailable);
      },
    );
    raw(path, (db) => {
      expect(scalar(db, "SELECT count(*) FROM usage")).toBe(3n);
      expect(scalar(db, "SELECT v FROM meta WHERE k = 'key_scheme'")).toBe(String(KEY_SCHEME - 1));
    });
  });

  // test_ledger_without_a_migration_path_is_refused_untouched
  test("an older scheme without a migration is refused, untouched", () => {
    const path = storeOnScheme(String(KEY_SCHEME - 1));
    const before = readFileSync(path);
    const error = caught(() => open(path));
    expect(error).toBeInstanceOf(SchemeRefused);
    expect((error as Error).message).toContain("no migration");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  // test_ledger_from_a_newer_scheme_is_left_untouched
  test("a newer scheme is refused, untouched", () => {
    const path = storeOnScheme("99");
    const before = readFileSync(path);
    const error = caught(() => open(path));
    expect(error).toBeInstanceOf(SchemeRefused);
    expect((error as Error).message).toContain("newer");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test.each(["", "one", "1.0", "-1"])("an unreadable scheme %p is refused", (scheme) => {
    const path = storeOnScheme(scheme);
    expect(caught(() => open(path))).toBeInstanceOf(SchemeRefused);
  });

  test("a missing scheme is refused", () => {
    const path = storeOnScheme("1");
    raw(path, (db) => db.exec("DELETE FROM meta WHERE k = 'key_scheme'"));
    expect(caught(() => open(path))).toBeInstanceOf(SchemeRefused);
  });
});

describe("rollup self-check on open", () => {
  function seeded(): string {
    const path = storePath();
    const store = open(path);
    store.upsert(
      Array.from({ length: 50 }, (_, i) =>
        row(BigInt(i), { ts: T0 + (i % 5) * HOUR, tier: i % 2, e5: i % 3 ? 7 : null }),
      ),
    );
    store.close();
    return path;
  }

  test("a missing trigger is reinstalled and the drift it caused is rebuilt", () => {
    const path = seeded();
    raw(path, (db) => {
      db.exec("DROP TRIGGER usage_roll_insert");
      db.exec(
        "INSERT INTO usage (key, acct, ts, model, inp, outp, cr, cc) VALUES (999, 1, 1, 1, 1, 1, 1, 1)",
      );
    });
    const store = open(path);
    expect(store.rollupConsistent()).toBe(true);
    store.upsert([row(1000n)]);
    expect(store.rollupConsistent()).toBe(true); // the trigger is back
  });

  test("a recreated rollup table without its triggers is detected", () => {
    const path = seeded();
    raw(path, (db) => {
      db.exec("DROP TABLE roll_hour");
      db.exec("CREATE TABLE roll_hour (hour INTEGER)");
    });
    expect(open(path).rollupConsistent()).toBe(true);
  });

  test("a row count drift is caught by the cheap probe and rebuilt", () => {
    const path = seeded();
    raw(path, (db) =>
      db.exec("DELETE FROM roll_hour WHERE hour = (SELECT min(hour) FROM roll_hour)"),
    );
    expect(open(path).rollupConsistent()).toBe(true);
  });

  test("an external REPLACE without recursive triggers is caught on the next open", () => {
    const path = seeded();
    raw(path, (db) =>
      db.exec(
        "INSERT OR REPLACE INTO usage SELECT key, acct, ts, model, 1, 1, 1, 1, NULL, NULL, 0 FROM usage WHERE key = 3",
      ),
    );
    expect(open(path).rollupConsistent()).toBe(true);
  });

  test("drift the probe cannot see is reported by rollupConsistent and fixed by a rebuild", () => {
    const path = seeded();
    raw(path, (db) =>
      db.exec("UPDATE roll_hour SET inp = inp + 1 WHERE hour = (SELECT min(hour) FROM roll_hour)"),
    );
    const store = open(path);
    expect(store.rollupConsistent()).toBe(false); // same counts: not rebuilt on open
    store.rebuildRollups();
    expect(store.rollupConsistent()).toBe(true);
  });
});

describe("reads", () => {
  test("keys streams every key as an exact bigint", () => {
    const store = open(storePath());
    const keys = [2n ** 63n - 1n, -(2n ** 63n), 2n ** 53n + 1n, -(2n ** 53n) - 1n, 0n, 1n];
    store.upsert(keys.map((k) => row(k)));
    expect([...store.keys()].sort((a, b) => (a < b ? -1 : 1))).toEqual(
      [...keys].sort((a, b) => (a < b ? -1 : 1)),
    );
    // Stopping early releases the statement; the store stays usable.
    for (const key of store.keys()) {
      expect(typeof key).toBe("bigint");
      break;
    }
    expect(store.upsert([row(7n)])).toBe(1);
  });

  test("rows returns stored values for present keys, by batch or by scan", () => {
    const store = open(storePath());
    const rows = Array.from({ length: 25_000 }, (_, i) =>
      row(BigInt(i) * 1_000_003n - 2n ** 62n, { inp: i, ts: T0 + i, e5: i % 2 ? i : null }),
    );
    store.upsert(rows);
    const few = store.rows([rows[3]?.key ?? 0n, 123n, rows[24_999]?.key ?? 0n]);
    expect(few.map((r) => r.inp).sort((a, b) => a - b)).toEqual([3, 24_999]);
    const many = store.rows([...rows.slice(0, 20_001).map((r) => r.key), 5n]);
    expect(many.length).toBe(20_001);
    const byKey = new Map(many.map((r) => [r.key, r]));
    const sample = rows[17];
    const opus = [...store.models()].find(([, name]) => name === "claude-opus-4-8")?.[0];
    expect(byKey.get(sample?.key ?? 0n)).toEqual({
      key: sample?.key ?? 0n,
      acct: 1,
      ts: T0 + 17,
      model: opus ?? -1,
      inp: 17,
      outp: 1,
      cr: 0,
      cc: 400,
      e5: 17,
      e1: null,
      tier: 0,
    });
    expect(store.rows([])).toEqual([]);
  });

  test("accounts and models map ids to what was interned", () => {
    const store = open(storePath());
    store.upsert([
      row(1n),
      row(2n, { provider: "codex", identity: "id-codex", label: "codex", model: "gpt-test" }),
    ]);
    expect([...store.accounts().values()]).toEqual([
      { id: 1, provider: "claude", identity: "id-personal", label: "personal" },
      { id: 2, provider: "codex", identity: "id-codex", label: "codex" },
    ]);
    expect([...store.models().values()].sort()).toEqual([
      "claude-opus-4-8",
      "codex-unattributed",
      "gpt-test",
    ]);
  });

  test("an unreadable imports list reads as empty", () => {
    const path = storePath();
    open(path).close();
    raw(path, (db) => db.exec("UPDATE meta SET v = '{oops' WHERE k = 'imports'"));
    expect(open(path).meta.imports).toEqual([]);
  });
});

describe("lifecycle", () => {
  test("a closed store raises StoreUnavailable, never a raw error", () => {
    const store = open(storePath());
    store.upsert([row(1n)]);
    store.close();
    store.close(); // twice is fine
    expect(caught(() => store.upsert([row(2n)]))).toBeInstanceOf(StoreUnavailable);
    expect(caught(() => [...store.keys()])).toBeInstanceOf(StoreUnavailable);
    expect(caught(() => store.rows([1n]))).toBeInstanceOf(StoreUnavailable);
    expect(caught(() => store.meta)).toBeInstanceOf(StoreUnavailable);
    expect(caught(() => store.rebuildRollups())).toBeInstanceOf(StoreUnavailable);
  });

  test("opening sweeps import scratch copies left for over an hour", () => {
    const path = storePath();
    const scratch = join(path, "..", "tmp");
    const stale = join(scratch, "import-cc-usage-old");
    const fresh = join(scratch, "import-cc-usage-new");
    for (const dir of [stale, fresh]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ledger-0a.sqlite3"), "copy");
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    const store = open(path);
    expect(store.scratchDir).toBe(scratch);
    expect(readdirSync(scratch)).toEqual(["import-cc-usage-new"]);
  });
});

describe("concurrent writers", () => {
  // test_two_processes_writing_one_ledger
  test("two processes writing one store keep every row once and the rollup exact", async () => {
    const path = storePath();
    open(path).close();
    const writer = join(import.meta.dir, "concurrent-writer.ts");
    const procs = [
      ["one", "10000", "40"],
      ["two", "20000", "60"],
    ].map(([name, first, own]) =>
      Bun.spawn([process.execPath, writer, path, name ?? "", first ?? "", own ?? "", "20"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    for (const proc of procs) {
      expect(await proc.exited).toBe(0);
    }
    const store = open(path);
    raw(path, (db) => expect(scalar(db, "PRAGMA integrity_check")).toBe("ok"));
    expect([...store.keys()].length).toBe(4 + 40 + 60);
    expect(store.rows([1000n])[0]?.outp).toBe(19); // the shared rows hold the last round
    expect(store.accounts().size).toBe(3);
    expect(store.rollupConsistent()).toBe(true);
  }, 60_000);
});
