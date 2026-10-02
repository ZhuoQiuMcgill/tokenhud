// Codex rate-limit snapshots in cache.db: the layout the limits module (T8) reads, the
// newest-wins rule across passes, and a v1 cache upgraded in place.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CursorCache } from "../../src/ingest/cursors.ts";
import { guard } from "../guard.ts";
import { codexRoot, openCodexEngine } from "../sources/codex-helpers.ts";
import { cleanup, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

const snapshotLine = (ts: string, primary: number, secondary: number | null) =>
  `${JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: primary, window_minutes: 300, resets_at: 1_783_700_000 },
        secondary:
          secondary === null ? null : { used_percent: secondary, resets_at: 1_784_000_000 },
      },
    },
  })}\n`;

test("rows have T8's layout: identity, captured_at (s) and cc-usage's rate_limits JSON", () => {
  const path = join(tempDir(), "cache.db");
  const cache = CursorCache.open(path);
  cache.putCodexLimitSnapshots(
    new Map([
      [
        "id-a",
        {
          capturedAt: 1_783_666_000.5,
          primary: { usedPercentage: 12.5, resetsAt: 1_783_700_000, windowMinutes: 300 },
          secondary: { usedPercentage: 40, resetsAt: 1_784_000_000, windowMinutes: null },
        },
      ],
    ]),
  );
  cache.close();
  const db = new Database(path, { readonly: true });
  const columns = db.query("PRAGMA table_info(codex_limit_snapshots)").all() as { name: string }[];
  expect(columns.map((c) => c.name)).toEqual(["identity", "captured_at", "rate_limits"]);
  const row = db.query("SELECT * FROM codex_limit_snapshots").get() as Record<string, unknown>;
  db.close();
  expect(row.identity).toBe("id-a");
  expect(row.captured_at).toBe(1_783_666_000.5);
  expect(JSON.parse(row.rate_limits as string)).toEqual({
    codex_primary: { used_percentage: 12.5, resets_at: 1_783_700_000, window_minutes: 300 },
    codex_secondary: { used_percentage: 40, resets_at: 1_784_000_000 },
  });
  const reopened = CursorCache.open(path);
  expect(reopened.codexLimitSnapshots().get("id-a")?.secondary?.windowMinutes).toBeNull();
  reopened.close();
});

test("a newer (or equally new) snapshot replaces the stored one; an older one does not", async () => {
  const home = join(tempDir(), ".codex");
  const file = join(
    home,
    "sessions",
    "rollout-2026-07-10T08-00-00-00000000-0000-4000-8000-000000000001.jsonl",
  );
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(file, snapshotLine("2026-07-10T08:00:00Z", 10, 50));
  const engine = openCodexEngine([home]);
  await engine.fullPass();
  const id = codexRoot(engine, home).identity;
  const used = () => {
    const s = engine.cursors.codexLimitSnapshots().get(id);
    return [s?.primary?.usedPercentage, s?.secondary?.usedPercentage ?? null];
  };
  expect(used()).toEqual([10, 50]);
  appendFileSync(file, snapshotLine("2026-07-10T07:00:00Z", 99, 99));
  await engine.fullPass();
  expect(used()).toEqual([10, 50]);
  appendFileSync(file, snapshotLine("2026-07-10T08:00:00Z", 20, null));
  await engine.fullPass();
  expect(used()).toEqual([20, null]); // replaced whole
});

test("a v1 cache keeps its cursors and gains the snapshot table", () => {
  const path = join(tempDir(), "cache.db");
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE cursor (path TEXT PRIMARY KEY, dev TEXT NOT NULL, ino TEXT NOT NULL,
    size INTEGER NOT NULL, mtime_ms REAL NOT NULL, offset INTEGER NOT NULL, tail TEXT, state TEXT) WITHOUT ROWID`);
  db.exec("INSERT INTO cursor VALUES ('/x.jsonl', '1', '2', 10, 5.5, 10, NULL, NULL)");
  db.exec("PRAGMA application_id = 1416316995"); // "TkHC"
  db.exec("PRAGMA user_version = 1");
  db.close();
  const cache = CursorCache.open(path);
  expect(cache.note).toBe("opened");
  expect([...cache.all().keys()]).toEqual(["/x.jsonl"]);
  expect(cache.codexLimitSnapshots().size).toBe(0);
  cache.close();
});
