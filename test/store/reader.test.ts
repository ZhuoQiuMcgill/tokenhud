// Schema v2 (the long-context partial index) and the read-only opener the query commands
// and the MCP server use.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StoreCorrupt, StoreUnavailable } from "../../src/store/errors.ts";
import { LONG_CONTEXT_PREDICATE, SCHEMA_VERSION } from "../../src/store/schema.ts";
import { emptyStoreDatabase, openStore, openStoreReader } from "../../src/store/store.ts";
import { cleanup, row, T0, tempDir, track } from "./helpers.ts";

afterEach(cleanup);

const CC_USAGE_FIXTURE = join(
  import.meta.dir,
  "..",
  "fixtures",
  "store",
  "cc-usage-ledger.sqlite3",
);

function scalar(db: Database, sql: string): unknown {
  const first = db.query<Record<string, unknown>, []>(sql).get();
  return first === null ? undefined : Object.values(first)[0];
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("schema v2", () => {
  test("a new store has the long-context partial index", () => {
    const path = join(tempDir(), "tokenhud.db");
    track(openStore(path)).close();
    const db = new Database(path, { readonly: true });
    expect(SCHEMA_VERSION).toBe(4);
    expect(scalar(db, "PRAGMA user_version")).toBe(4);
    expect(scalar(db, "SELECT sql FROM sqlite_master WHERE name = 'usage_long'")).toBe(
      `CREATE INDEX usage_long ON usage (ts) WHERE ${LONG_CONTEXT_PREDICATE}`,
    );
    db.close();
  });

  test("a v1 store gains the index on open, its rows indexed", () => {
    const path = join(tempDir(), "tokenhud.db");
    const store = track(openStore(path));
    store.upsert([row(1n, { cr: 300_000 }), row(2n, { cr: 1000, ts: T0 + 1 })]);
    store.close();
    const v1 = new Database(path);
    v1.exec("DROP INDEX usage_long");
    v1.exec("DROP TABLE limit_events");
    v1.exec("DROP TABLE dropped_keys");
    v1.exec("PRAGMA user_version = 1");
    v1.close();

    track(openStore(path)).close();
    const db = new Database(path, { readonly: true });
    expect(scalar(db, "PRAGMA user_version")).toBe(4);
    const plan = db
      .query<{ detail: string }, []>(
        `EXPLAIN QUERY PLAN SELECT ts FROM usage WHERE ${LONG_CONTEXT_PREDICATE} AND ts >= 0`,
      )
      .all()
      .map((r) => r.detail)
      .join(" ");
    expect(plan).toContain("usage_long");
    expect(
      scalar(db, `SELECT count(*) FROM usage WHERE ${LONG_CONTEXT_PREDICATE} AND ts >= 0`),
    ).toBe(1);
    db.close();
  });
});

describe("openStoreReader", () => {
  test("is null when there is no store yet", () => {
    const dir = tempDir();
    expect(openStoreReader(join(dir, "missing.db"))).toBeNull();
    writeFileSync(join(dir, "empty.db"), "");
    expect(openStoreReader(join(dir, "empty.db"))).toBeNull();
  });

  test("reads a store without writing to its file", () => {
    const path = join(tempDir(), "tokenhud.db");
    const store = track(openStore(path));
    store.upsert([row(1n)]);
    store.close();
    const before = readFileSync(path);
    const db = openStoreReader(path) as Database;
    expect(scalar(db, "SELECT count(*) FROM usage")).toBe(1n);
    expect(() => db.exec("DELETE FROM usage")).toThrow();
    db.close();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("sees what a writer commits while it is open", () => {
    const path = join(tempDir(), "tokenhud.db");
    const store = track(openStore(path));
    const db = openStoreReader(path) as Database;
    expect(scalar(db, "SELECT count(*) FROM usage")).toBe(0n);
    store.upsert([row(1n)]);
    expect(scalar(db, "SELECT count(*) FROM usage")).toBe(1n);
    db.close();
  });

  test("refuses a foreign database untouched, and a newer store", () => {
    const dir = tempDir();
    const ledger = join(dir, "ledger.sqlite3");
    writeFileSync(ledger, readFileSync(CC_USAGE_FIXTURE));
    expect(caught(() => openStoreReader(ledger))).toBeInstanceOf(StoreUnavailable);
    expect(readFileSync(ledger).equals(readFileSync(CC_USAGE_FIXTURE))).toBe(true);

    const junk = join(dir, "junk.db");
    writeFileSync(junk, "not a database at all, just some bytes that go on for a while");
    expect(caught(() => openStoreReader(junk))).toBeInstanceOf(StoreCorrupt);

    const newer = join(dir, "tokenhud.db");
    track(openStore(newer)).close();
    const db = new Database(newer);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const error = caught(() => openStoreReader(newer));
    expect(error).toBeInstanceOf(StoreUnavailable);
    expect((error as Error).message).toContain("newer");
  });

  test("an older store is read as it is", () => {
    const path = join(tempDir(), "tokenhud.db");
    track(openStore(path)).close();
    const v1 = new Database(path);
    v1.exec("DROP INDEX usage_long");
    v1.exec("PRAGMA user_version = 1");
    v1.close();
    const db = openStoreReader(path) as Database;
    expect(scalar(db, "PRAGMA user_version")).toBe(1n);
    db.close();
  });
});

test("emptyStoreDatabase has the current schema and no rows", () => {
  const db = emptyStoreDatabase();
  expect(scalar(db, "PRAGMA user_version")).toBe(BigInt(SCHEMA_VERSION));
  expect(scalar(db, "SELECT count(*) FROM usage")).toBe(0n);
  db.close();
});
