import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CursorCache } from "../../src/ingest/cursors.ts";
import { ledgerKey } from "../../src/store/key.ts";
import {
  claudeLine,
  cleanup,
  makeRoot,
  openEngine,
  storedRows,
  T0_MS,
  tempDir,
} from "./helpers.ts";

afterEach(cleanup);

const key = (n: string) => ledgerKey(`c\x1freq_FAKE${n}\x1fmsg_FAKE${n}`);

/** A root with one project dir; returns [root, project dir]. */
function rootWithProject(): [string, string] {
  const root = makeRoot(tempDir(), "root");
  const proj = join(root, "projects", "proj");
  mkdirSync(proj, { recursive: true });
  return [root, proj];
}

const sumInp = (rows: Map<bigint, { inp: number }>) =>
  [...rows.values()].reduce((a, r) => a + r.inp, 0);

// ── ported from cc-usage tests/test_incremental.py ─────────────────────────────

describe("test_incremental.py", () => {
  test("incremental_reads_only_appended_lines", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "session.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100));
    const engine = openEngine([root]);
    const first = await engine.fullPass();
    expect(first?.roots[0]?.lines).toBe(1);
    appendFileSync(file, claudeLine("2", "2", 200));
    const second = await engine.fullPass();
    expect(second?.roots[0]?.lines).toBe(1); // only the appended line
    expect(second?.roots[0]?.bytes).toBe(Buffer.byteLength(claudeLine("2", "2", 200)));
    const rows = storedRows(engine.store);
    expect(rows.size).toBe(2);
    expect(sumInp(rows)).toBe(300);
  });

  test("unchanged_file_is_skipped", async () => {
    const [root, proj] = rootWithProject();
    writeFileSync(join(proj, "s.jsonl"), claudeLine("1", "1", 100));
    const engine = openEngine([root]);
    await engine.fullPass();
    const again = await engine.fullPass();
    expect(again?.roots[0]).toMatchObject({ files: 1, read: 0, lines: 0 });
  });

  test("partial_trailing_line_not_lost", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "s.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100));
    const engine = openEngine([root]);
    await engine.fullPass();
    appendFileSync(file, claudeLine("2", "2", 200).trimEnd());
    await engine.fullPass();
    expect(storedRows(engine.store).size).toBe(1); // held back
    appendFileSync(file, "\n");
    await engine.fullPass();
    expect(storedRows(engine.store).size).toBe(2); // now ingested exactly once
  });

  test("streaming_merge_across_scans", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "session.jsonl");
    writeFileSync(file, claudeLine("r", "m", 1000, 7) + claudeLine("r", "m", 1000, 500));
    const engine = openEngine([root]);
    await engine.fullPass();
    const streamed = ledgerKey("c\x1freq_FAKEr\x1fmsg_FAKEm");
    expect(storedRows(engine.store).get(streamed)?.outp).toBe(500);
    appendFileSync(file, claudeLine("r", "m", 1000, 2000));
    const second = await engine.fullPass();
    const rows = storedRows(engine.store);
    expect(rows.size).toBe(1);
    expect(rows.get(streamed)?.outp).toBe(2000);
    expect(second?.roots[0]?.lines).toBe(1);
    expect(second?.roots[0]).toMatchObject({ inserted: 0, changed: 1 });
  });

  test("streaming_merge_across_files", async () => {
    const [root, proj] = rootWithProject();
    const sub = join(proj, "session", "subagents", "wf_1");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(proj, "session.jsonl"), claudeLine("r", "m", 1000, 7));
    writeFileSync(join(sub, "agent.jsonl"), claudeLine("r", "m", 1000, 2000));
    const engine = openEngine([root]);
    const report = await engine.fullPass();
    const rows = [...storedRows(engine.store).values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outp: 2000, inp: 1000 });
    expect(report?.roots[0]?.records).toBe(1);
  });

  test("truncation_is_handled (and history is kept)", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "s.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100) + claudeLine("2", "2", 200));
    const engine = openEngine([root]);
    await engine.fullPass();
    writeFileSync(file, claudeLine("3", "3", 50));
    await engine.fullPass();
    const rows = storedRows(engine.store);
    expect(rows.get(key("3"))?.inp).toBe(50);
    expect(rows.size).toBe(3); // the rows whose lines are gone stay as history
  });
});

describe("test_accounts.py", () => {
  test("records_tagged_by_root", async () => {
    const base = tempDir();
    const r1 = makeRoot(base, "work");
    const r2 = makeRoot(base, "company");
    writeFileSync(join(r1, "projects", "s.jsonl"), claudeLine("a", "a", 100));
    writeFileSync(join(r2, "projects", "s.jsonl"), claudeLine("b", "b", 200));
    const engine = openEngine([
      { path: r1, label: "work" },
      { path: r2, label: "company" },
    ]);
    await engine.fullPass();
    const byLabel = Object.fromEntries(
      [...storedRows(engine.store).values()].map((r) => [r.label, r.inp]),
    );
    expect(byLabel).toEqual({ work: 100, company: 200 });
    const identities = new Set([...storedRows(engine.store).values()].map((r) => r.identity));
    const claude = engine.roots.filter((r) => r.provider === "claude");
    expect(identities).toEqual(new Set(claude.slice(1).map((r) => r.identity)));
  });
});

// ── cursors and recovery ──────────────────────────────────────────────────────────

describe("re-reads", () => {
  test("without cache.db every file is read again and the store comes out identical", async () => {
    const [root, proj] = rootWithProject();
    writeFileSync(
      join(proj, "a.jsonl"),
      claudeLine("1", "1", 100, 5) + claudeLine("1", "1", 100, 9),
    );
    writeFileSync(join(proj, "b.jsonl"), claudeLine("2", "2", 200));
    const engine = openEngine([root]);
    await engine.fullPass();
    const before = storedRows(engine.store);
    engine.cursors.update([], [...engine.cursors.all().keys()]);
    const again = await engine.fullPass();
    expect(again?.roots[0]?.read).toBe(2);
    expect(again?.event).toBeNull();
    expect(storedRows(engine.store)).toEqual(before);
  });

  test("a different file at the same path (new inode) is read from the start", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "s.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100));
    const engine = openEngine([root]);
    await engine.fullPass();
    const replacement = join(proj, "tmp");
    writeFileSync(replacement, claudeLine("2", "2", 100));
    renameSync(replacement, file);
    await engine.fullPass();
    expect(storedRows(engine.store).get(key("2"))?.inp).toBe(100);
  });

  test("a file rewritten in place to a larger size is read from the start, without double counting", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "s.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100));
    const engine = openEngine([root]);
    await engine.fullPass();
    // Same inode, longer content, different bytes before the old cursor.
    writeFileSync(
      file,
      claudeLine("2", "2", 222) + claudeLine("1", "1", 100) + claudeLine("3", "3", 3),
    );
    const report = await engine.fullPass();
    const rows = storedRows(engine.store);
    expect(rows.get(key("2"))?.inp).toBe(222);
    expect(rows.get(key("3"))?.inp).toBe(3);
    expect(rows.get(key("1"))?.inp).toBe(100);
    expect(rows.size).toBe(3);
    expect(report?.roots[0]).toMatchObject({ inserted: 2, changed: 0 });
  });

  test("a vanished file loses its cursor but not its rows", async () => {
    const [root, proj] = rootWithProject();
    const file = join(proj, "s.jsonl");
    writeFileSync(file, claudeLine("1", "1", 100));
    const engine = openEngine([root]);
    await engine.fullPass();
    rmSync(file);
    await engine.fullPass();
    expect(engine.cursors.all().size).toBe(0);
    expect(storedRows(engine.store).size).toBe(1);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable file is logged and skipped, and read once it is readable",
    async () => {
      const [root, proj] = rootWithProject();
      writeFileSync(join(proj, "ok.jsonl"), claudeLine("1", "1", 100));
      const locked = join(proj, "locked.jsonl");
      writeFileSync(locked, claudeLine("2", "2", 200));
      chmodSync(locked, 0o000);
      const logs: string[] = [];
      const engine = openEngine([root], { log: (_level, message) => logs.push(message) });
      const report = await engine.fullPass();
      expect(report?.roots[0]).toMatchObject({ read: 1, errors: 1 });
      expect(logs.join("\n")).toContain("EACCES");
      expect(logs.join("\n")).not.toContain(proj); // logs carry no paths
      chmodSync(locked, 0o644);
      await engine.fullPass();
      expect(storedRows(engine.store).size).toBe(2);
    },
  );

  test("a timestamp-less line in a later pass raises the stored event", async () => {
    const [root, proj] = rootWithProject();
    writeFileSync(join(proj, "a.jsonl"), claudeLine("1", "1", 5));
    const engine = openEngine([root]);
    await engine.fullPass();
    const noTs = JSON.parse(claudeLine("1", "1", 9));
    delete noTs.timestamp;
    writeFileSync(join(proj, "b.jsonl"), `${JSON.stringify(noTs)}\n`);
    const report = await engine.fullPass();
    expect(storedRows(engine.store).get(key("1"))).toMatchObject({ inp: 9, ts: T0_MS });
    expect(report?.event).toMatchObject({ fromTs: T0_MS, toTs: T0_MS });
  });

  test("an event seen under two roots belongs to the first in Python path order", async () => {
    const base = tempDir();
    const a = makeRoot(base, "a-root");
    const b = makeRoot(base, "b-root");
    writeFileSync(
      join(b, "projects", "s.jsonl"),
      claudeLine("1", "1", 1, 1, { ts: "2026-06-01T00:00:00Z" }),
    );
    writeFileSync(
      join(a, "projects", "s.jsonl"),
      claudeLine("1", "1", 2, 2, { ts: "2026-06-02T00:00:00Z" }),
    );
    const engine = openEngine([
      { path: b, label: "b" },
      { path: a, label: "a" },
    ]);
    await engine.fullPass();
    expect(storedRows(engine.store).get(key("1"))).toMatchObject({
      label: "a",
      inp: 2,
      ts: Date.parse("2026-06-02T00:00:00Z"),
    });
  });

  test("when the store write fails, nothing moves and nothing is lost", async () => {
    const [root, proj] = rootWithProject();
    writeFileSync(join(proj, "s.jsonl"), claudeLine("1", "1", 100));
    const logs: string[] = [];
    const engine = openEngine([root], { log: (_level, message) => logs.push(message) });
    engine.store.close();
    const report = await engine.fullPass();
    expect(report?.storeError).not.toBeNull();
    expect(report?.event).toBeNull();
    expect(engine.cursors.all().size).toBe(0);
    expect(logs.join("\n")).toContain("could not write the store");
  });
});

describe("the cursor cache", () => {
  test("a damaged cache is rebuilt, and the result is the same", async () => {
    const [root, proj] = rootWithProject();
    writeFileSync(join(proj, "s.jsonl"), claudeLine("1", "1", 100));
    const dir = tempDir();
    const cachePath = join(dir, "cache.db");
    const first = openEngine([root], { cachePath, storePath: join(dir, "t.db") });
    await first.fullPass();
    const rows = storedRows(first.store);
    await first.stop();
    // Keep the header (it says the file is ours) and damage the cursor table's page.
    const bytes = readFileSync(cachePath);
    expect(bytes.length).toBeGreaterThan(4096);
    bytes.fill(0x55, 4096);
    writeFileSync(cachePath, bytes);
    const logs: string[] = [];
    const second = openEngine([root], {
      cachePath,
      storePath: join(dir, "t.db"),
      log: (_l, m) => logs.push(m),
    });
    const report = await second.fullPass();
    expect(second.cursors.note).toBe("rebuilt");
    expect(logs.join("\n")).toContain("rebuilt");
    expect(report?.event).toBeNull();
    expect(storedRows(second.store)).toEqual(rows);
  });

  test("a file that is not a cursor cache is never deleted; an in-memory cache is used", () => {
    const dir = tempDir();
    const path = join(dir, "precious.db");
    writeFileSync(path, "my notes, not a database");
    const cache = CursorCache.open(path);
    expect(cache.note).toBe("in-memory");
    cache.close();
    expect(readFileSync(path, "utf8")).toBe("my notes, not a database");
  });

  test("the store file itself is refused as a cache", async () => {
    const [root] = rootWithProject();
    const dir = tempDir();
    const storePath = join(dir, "t.db");
    const engine = openEngine([root], { storePath, cachePath: storePath });
    expect(engine.cursors.note).toBe("in-memory");
    await engine.fullPass();
    expect(existsSync(storePath)).toBe(true);
  });
});

describe("first-run import of cc-usage's history", () => {
  const FIXTURE = join(import.meta.dir, "..", "fixtures", "store", "cc-usage-ledger.sqlite3");

  function ledgerCopy(): string {
    const path = join(tempDir(), "ledger.sqlite3");
    copyFileSync(FIXTURE, path);
    return path;
  }

  test("imports once, when the store has no cc-usage import", () => {
    const [root] = rootWithProject();
    const engine = openEngine([root], { importLedger: ledgerCopy() });
    const outcome = engine.importIfFirstRun();
    expect(outcome?.status).toBe("imported");
    expect(storedRows(engine.store).size).toBeGreaterThan(0);
    expect(engine.importIfFirstRun()).toBeNull();
  });

  test("never with importLedger null (--no-import), or without a ledger", () => {
    const [root] = rootWithProject();
    expect(openEngine([root]).importIfFirstRun()).toBeNull();
    expect(
      openEngine([root], { importLedger: join(tempDir(), "missing.sqlite3") }).importIfFirstRun(),
    ).toBeNull();
  });

  test("the ledger is not modified", () => {
    const [root] = rootWithProject();
    const ledger = ledgerCopy();
    const before = readFileSync(ledger);
    openEngine([root], { importLedger: ledger }).importIfFirstRun();
    expect(readFileSync(ledger).equals(before)).toBe(true);
    expect(existsSync(`${ledger}-wal`)).toBe(false);
  });
});
