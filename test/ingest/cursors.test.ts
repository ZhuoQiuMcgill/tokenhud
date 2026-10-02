// The cursor cache's tie to the store it was written for, its upgrade from version 2, and
// what `doctor` reads of it (src/ingest/cursors.ts).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Cursor, CursorCache, readCacheSummary } from "../../src/ingest/cursors.ts";
import { guard } from "../guard.ts";
import { cleanup, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

const cursor = (path: string): Cursor => ({
  path,
  dev: "1",
  ino: "2",
  size: 10,
  mtimeMs: 1,
  offset: 10,
  tail: null,
  state: null,
});

const snapshot = {
  capturedAt: 1_780_000_000,
  primary: { usedPercentage: 12, resetsAt: 1_780_000_100, windowMinutes: 300 },
  secondary: null,
};

describe("binding to the store", () => {
  test("cursors written for one store are dropped when the store is another", () => {
    const path = join(tempDir(), "cache.db");
    const cache = CursorCache.open(path);
    expect(cache.bind("store-a")).toBe(false); // nothing to drop
    cache.update([cursor("/r/a.jsonl"), cursor("/r/b.jsonl")]);
    expect(cache.bind("store-a")).toBe(false);
    expect(cache.all().size).toBe(2);
    cache.putCodexLimitSnapshots(new Map([["id-codex", snapshot]]));
    expect(cache.bind("store-b")).toBe(true); // a recovered or replaced store
    expect(cache.all().size).toBe(0);
    expect(cache.codexLimitSnapshots().get("id-codex")).toEqual(snapshot); // about the rollouts, kept
    cache.close();
    const reopened = CursorCache.open(path);
    reopened.update([cursor("/r/a.jsonl")]);
    expect(reopened.bind("store-b")).toBe(false); // the binding survives a restart
    reopened.close();
  });

  test("a version-2 cache keeps its cursors and snapshots, and is bound on first use", () => {
    const path = join(tempDir(), "cache.db");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE cursor (path TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms REAL NOT NULL, offset INTEGER NOT NULL, tail TEXT, state TEXT)
      WITHOUT ROWID`);
    db.exec(`CREATE TABLE codex_limit_snapshots (identity TEXT PRIMARY KEY,
      captured_at REAL NOT NULL, rate_limits TEXT NOT NULL)`);
    db.exec("INSERT INTO cursor VALUES ('/r/a.jsonl', '1', '2', 10, 1, 10, NULL, NULL)");
    db.exec(
      `INSERT INTO codex_limit_snapshots VALUES ('id-codex', 1780000000,
       '{"codex_primary":{"used_percentage":12,"resets_at":1780000100,"window_minutes":300}}')`,
    );
    db.exec(`PRAGMA application_id = ${0x546b4843}`);
    db.exec("PRAGMA user_version = 2");
    db.close();
    const cache = CursorCache.open(path);
    expect(cache.note).toBe("opened");
    expect([...cache.all().keys()]).toEqual(["/r/a.jsonl"]);
    expect(cache.codexLimitSnapshots().get("id-codex")?.primary?.usedPercentage).toBe(12);
    // Which store its cursors were written for is unknown: they are read again once.
    expect(cache.bind("store-a")).toBe(true);
    expect(cache.all().size).toBe(0);
    cache.close();
  });
});

describe("what doctor reads", () => {
  test("cursors per root and the last pass, read-only; none without a cache", () => {
    const dir = tempDir();
    const path = join(dir, "cache.db");
    expect(readCacheSummary(path, [])).toBeNull();
    const cache = CursorCache.open(path);
    const a = join(dir, "a", "projects");
    const b = join(dir, "b", "sessions");
    cache.update([
      cursor(join(a, "p", "1.jsonl")),
      cursor(join(a, "p", "2.jsonl")),
      cursor(join(b, "2026", "r.jsonl")),
      cursor(join(dir, "b", "archived_sessions", "old.jsonl")),
      cursor(join(dir, "a", "projects-other", "x.jsonl")), // a sibling, not under a's projects
    ]);
    cache.notePass(["id-a", "id-b"], 1_780_000_000_000);
    cache.notePass(["id-a"], 1_780_000_060_000);
    cache.close();
    const summary = readCacheSummary(path, [
      { identity: "id-a", dirs: [a] },
      { identity: "id-b", dirs: [b, join(dir, "b", "archived_sessions")] },
      { identity: "id-c", dirs: [join(dir, "c", "projects")] },
    ]);
    expect(summary?.cursors).toEqual(
      new Map([
        ["id-a", 2],
        ["id-b", 2],
        ["id-c", 0],
      ]),
    );
    expect(summary?.lastPass).toEqual(
      new Map([
        ["id-a", 1_780_000_060_000],
        ["id-b", 1_780_000_000_000],
      ]),
    );
  });

  test("a file that is not a cursor cache reads as none", () => {
    const path = join(tempDir(), "cache.db");
    writeFileSync(path, "not a cache");
    expect(readCacheSummary(path, [{ identity: "x", dirs: ["/"] }])).toBeNull();
  });
});
