import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StoreBusy, StoreCorrupt } from "../../src/store/errors.ts";
import {
  type ImportOutcome,
  ImportSourceError,
  type ImportSummary,
  importCcUsage,
} from "../../src/store/import-cc-usage.ts";
import { openStore, type Store, UNATTRIBUTED } from "../../src/store/store.ts";
import expected from "../fixtures/store/cc-usage-ledger.expected.json";
import { guard } from "../guard.ts";
import { cleanup, row, tempDir, track } from "./helpers.ts";

guard();

afterEach(cleanup);

const FIXTURE = join(import.meta.dir, "..", "fixtures", "store", "cc-usage-ledger.sqlite3");

/** A copy of the fixture ledger in its own dir, as cc-usage keeps it. */
function ledgerCopy(): string {
  const path = join(tempDir(), "ledger.sqlite3");
  copyFileSync(FIXTURE, path);
  return path;
}

function freshStore(busyTimeoutMs?: number): Store {
  const path = join(tempDir(), "tokenhud.db");
  return track(openStore(path, busyTimeoutMs === undefined ? {} : { busyTimeoutMs }));
}

function imported(outcome: ImportOutcome): ImportSummary {
  if (outcome.status !== "imported") throw new Error(`deferred: ${outcome.warning}`);
  return outcome;
}

/** Every row of the store, resolved to names, keyed and ordered like the expected JSON. */
function resolved(store: Store) {
  const accounts = store.accounts();
  const models = store.models();
  return store
    .rows([...store.keys()])
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((r) => {
      const account = accounts.get(r.acct);
      return {
        key: r.key.toString(),
        provider: account?.provider,
        identity: account?.identity,
        label: account?.label,
        ts: r.ts,
        model: models.get(r.model),
        inp: r.inp,
        outp: r.outp,
        cr: r.cr,
        cc: r.cc,
        e5: r.e5,
        e1: r.e1,
        tier: r.tier,
      };
    });
}

/** Name -> size and mtime of every file in `dir`. */
function listing(dir: string): Map<string, string> {
  return new Map(
    readdirSync(dir)
      .sort()
      .map((name) => {
        const st = statSync(join(dir, name), { bigint: true });
        return [name, `${st.size}@${st.mtimeNs}`];
      }),
  );
}

function scratchLeft(store: Store): string[] {
  return existsSync(store.scratchDir) ? readdirSync(store.scratchDir) : [];
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function edit(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("importing the fixture ledger", () => {
  test("copies every row, account and model, matching cc-usage's own read-back", () => {
    const store = freshStore();
    const summary = importCcUsage(store, ledgerCopy());
    expect(summary).toEqual({
      status: "imported",
      lineage: expected.lineage,
      read: 16,
      inserted: 16,
      merged: 0,
      unchanged: 0,
      tombstoned: 0,
      skipped: 0,
      accounts: 3,
      models: 6,
    });
    expect(expected.summary.rows).toBe(16);

    expect(resolved(store)).toEqual(expected.rows.map((r) => ({ ...r, tier: 0 })));

    const perAccount = new Map<number, number>();
    for (const r of store.rows([...store.keys()])) {
      perAccount.set(r.acct, (perAccount.get(r.acct) ?? 0) + 1);
    }
    const accounts = [...store.accounts().values()].map((a) => ({
      label: a.label,
      provider: a.provider,
      identity: a.identity,
      rows: perAccount.get(a.id) ?? 0,
    }));
    expect(accounts.sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label))).toEqual(
      expected.summary.accounts,
    );
    const byProvider: Record<string, number> = {};
    for (const a of accounts) byProvider[a.provider] = (byProvider[a.provider] ?? 0) + a.rows;
    expect(byProvider).toEqual(expected.summary.rows_by_provider);

    // All of the ledger's models, including the now-unused codex-unattributed and the
    // lone-surrogate name exactly as cc-usage stored it.
    expect([...store.models().values()].sort()).toEqual([...expected.models].sort());
    expect(expected.models).toContain("claude-���-odd");

    const [record, ...more] = store.meta.imports;
    expect(more).toEqual([]);
    expect(record).toEqual({
      at: expect.any(String),
      source: "cc-usage",
      lineage: expected.lineage,
      rows: 16,
      accounts: 3,
    });
    expect(Date.parse(record?.at ?? "")).toBeGreaterThan(0);
    expect(store.rollupConsistent()).toBe(true);
  });

  test("a second import changes nothing", () => {
    const store = freshStore();
    const ledger = ledgerCopy();
    importCcUsage(store, ledger);
    const before = resolved(store);
    const again = importCcUsage(store, ledger);
    expect(again).toMatchObject({ read: 16, inserted: 0, merged: 0, unchanged: 16, skipped: 0 });
    expect(resolved(store)).toEqual(before);
    expect(store.meta.imports.length).toBe(2);
    expect(store.rollupConsistent()).toBe(true);
  });

  test("keys beyond 2^53 survive exactly", () => {
    const store = freshStore();
    importCcUsage(store, ledgerCopy());
    const keys = new Set(store.keys());
    for (const key of [2n ** 63n - 1n, -(2n ** 63n), 2n ** 53n + 1n, -(2n ** 53n) - 1n]) {
      expect(keys.has(key)).toBe(true);
    }
    const big = expected.rows.filter((r) => {
      const k = BigInt(r.key);
      return k > 2n ** 53n || k < -(2n ** 53n);
    });
    expect(big.length).toBeGreaterThanOrEqual(14);
    for (const r of big) expect(keys.has(BigInt(r.key))).toBe(true);
  });

  test("scratch copies go in the store's .tokenhud-tmp dir and are removed", () => {
    const store = freshStore();
    expect(store.scratchDir).toBe(join(store.path, "..", ".tokenhud-tmp"));
    imported(importCcUsage(store, ledgerCopy()));
    expect(existsSync(store.scratchDir)).toBe(true);
    expect(scratchLeft(store)).toEqual([]);
  });
});

describe("cc-usage's files are never written", () => {
  test("a ledger at rest: no file changes and no -wal/-shm appear", () => {
    const ledger = ledgerCopy();
    const dir = join(ledger, "..");
    const before = listing(dir);
    expect([...before.keys()]).toEqual(["ledger.sqlite3"]);
    const bytes = readFileSync(ledger);
    imported(importCcUsage(freshStore(), ledger));
    expect(listing(dir)).toEqual(before);
    expect(readFileSync(ledger).equals(bytes)).toBe(true);
  });

  test("a live ledger: rows still in its WAL are imported, and nothing changes", () => {
    const ledger = ledgerCopy();
    const dir = join(ledger, "..");
    // The frozen Python app, mid-session: it holds the file open, and its last commit
    // sits uncheckpointed in the WAL.
    const writer = new Database(ledger, { safeIntegers: true });
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer.exec(`INSERT INTO usage (key, acct, ts, model, inp, outp, cr, cc, e5, e1)
        SELECT 4242, a.id, 1780000000000, m.id, 9, 9, 0, 0, NULL, NULL
        FROM accounts a, models m WHERE a.label = 'personal' AND m.name = 'claude-opus-4-8'`);
      const before = listing(dir);
      expect([...before.keys()]).toEqual([
        "ledger.sqlite3",
        "ledger.sqlite3-shm",
        "ledger.sqlite3-wal",
      ]);
      expect(statSync(`${ledger}-wal`).size).toBeGreaterThan(0);

      const store = freshStore();
      const summary = importCcUsage(store, ledger);
      expect(summary).toMatchObject({ status: "imported", read: 17, inserted: 17, skipped: 0 });
      expect(store.rows([4242n])[0]?.inp).toBe(9);
      expect(listing(dir)).toEqual(before);
    } finally {
      writer.close();
    }
  });
});

describe("a ledger cc-usage is writing to", () => {
  const FIRST = 1_000_000n;
  const PER = 5n;

  async function startWriter(ledger: string, mode: "bursty" | "aggressive", ms: number) {
    const writer = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "ledger-writer.ts"),
        ledger,
        String(FIRST),
        String(PER),
        String(ms),
        mode,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const lines = writer.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let out = "";
    while (!out.includes("ready")) {
      const next = await lines.read();
      if (next.done) throw new Error(`writer stopped: ${await new Response(writer.stderr).text()}`);
      out += next.value;
    }
    return writer;
  }

  /**
   * Imports into fresh stores until `ms` pass. An accepted snapshot must hold exactly the
   * rows of the commits its counter row says were made, and nothing of a deferred import
   * may reach the store.
   */
  function importRepeatedly(ledger: string, ms: number) {
    const tally = { imported: 0, deferred: 0, inconsistent: 0 };
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const store = freshStore();
      const outcome = importCcUsage(store, ledger);
      if (outcome.status === "deferred") {
        expect([...store.keys()]).toEqual([]);
        expect(store.meta.imports).toEqual([]);
        tally.deferred++;
        continue;
      }
      const commits = BigInt(store.rows([FIRST - 1n])[0]?.outp ?? -1);
      const written = [...store.keys()]
        .filter((k) => k >= FIRST && k < FIRST + 1_000_000_000n)
        .sort((a, b) => (a < b ? -1 : 1));
      const wanted = Array.from({ length: Number(commits * PER) }, (_, i) => FIRST + BigInt(i));
      const consistent =
        commits >= 0n &&
        JSON.stringify(written.map(String)) === JSON.stringify(wanted.map(String)) &&
        outcome.read === 16 + 1 + wanted.length &&
        store.rollupConsistent();
      if (consistent) tally.imported++;
      else tally.inconsistent++;
    }
    return tally;
  }

  test("a bursty writer: imports succeed and every one is a consistent snapshot", async () => {
    const ledger = ledgerCopy();
    const writer = await startWriter(ledger, "bursty", 2500);
    const tally = importRepeatedly(ledger, 1500);
    expect(await writer.exited).toBe(0);
    console.log(`imports during bursty writes: ${JSON.stringify(tally)}`);
    expect(tally.inconsistent).toBe(0);
    expect(tally.imported).toBeGreaterThan(0);
  }, 30_000);

  test("a writer that checkpoints on every commit: no inconsistent import is ever accepted", async () => {
    const ledger = ledgerCopy();
    const writer = await startWriter(ledger, "aggressive", 4500);
    const tally = importRepeatedly(ledger, 3500);
    expect(await writer.exited).toBe(0);
    console.log(`imports during aggressive writes: ${JSON.stringify(tally)}`);
    expect(tally.inconsistent).toBe(0);
    expect(tally.imported + tally.deferred).toBeGreaterThan(0);
  }, 30_000);
});

describe("merging into a store that already has rows", () => {
  test("rows go through the upsert rules: raised, re-attributed, never lowered", () => {
    const store = freshStore();
    const streaming = expected.rows.find((r) => r.outp === 500);
    const codex = expected.rows.find((r) => r.provider === "codex" && r.outp === 50);
    const work = expected.rows.find((r) => r.label === "work" && r.outp === 200);
    if (streaming === undefined || codex === undefined || work === undefined) {
      throw new Error("fixture changed");
    }
    const same = (r: typeof streaming) => ({
      provider: r.provider,
      identity: r.identity,
      label: r.label,
      ts: r.ts,
      inp: r.inp,
      cr: r.cr,
      cc: r.cc,
      e5: r.e5,
      e1: r.e1,
    });
    store.upsert([
      // parsed before its final streaming line: the import raises it
      row(BigInt(streaming.key), { ...same(streaming), model: streaming.model, outp: 5 }),
      // seen before its model resolved: the import re-attributes it
      row(BigInt(codex.key), { ...same(codex), model: UNATTRIBUTED, outp: codex.outp }),
      // already higher, and a priority-tier row: the import lowers nothing
      row(BigInt(work.key), { ...same(work), model: work.model, outp: 999, tier: 1 }),
    ]);
    const summary = importCcUsage(store, ledgerCopy());
    expect(summary).toMatchObject({ read: 16, inserted: 13, merged: 2, unchanged: 1 });
    const byKey = new Map(resolved(store).map((r) => [r.key, r]));
    expect(byKey.get(streaming.key)?.outp).toBe(500);
    expect(byKey.get(codex.key)?.model).toBe("gpt-5.5");
    expect(byKey.get(work.key)).toMatchObject({ outp: 999, tier: 1 });
    expect(store.rollupConsistent()).toBe(true);
  });
});

describe("ledgers that are not imported", () => {
  function expectRefused(ledger: string, reason: ImportSourceError["reason"]): void {
    const store = freshStore();
    const error = caught(() => importCcUsage(store, ledger));
    expect(error).toBeInstanceOf(ImportSourceError);
    expect((error as ImportSourceError).reason).toBe(reason);
    expect(error).not.toBeInstanceOf(StoreCorrupt); // never mistaken for the store's own damage
    expect([...store.keys()]).toEqual([]);
    expect(store.meta.imports).toEqual([]);
    expect(scratchLeft(store)).toEqual([]);
  }

  test.each(["2", "0", "x"])("key scheme %p is refused", (scheme) => {
    const ledger = ledgerCopy();
    edit(ledger, `UPDATE meta SET v = '${scheme}' WHERE k = 'key_scheme'`);
    expectRefused(ledger, "incompatible");
  });

  test("a ledger with no key scheme recorded is refused", () => {
    const ledger = ledgerCopy();
    edit(ledger, "DELETE FROM meta WHERE k = 'key_scheme'");
    expectRefused(ledger, "incompatible");
  });

  test("another ledger layout is refused", () => {
    const ledger = ledgerCopy();
    edit(ledger, "PRAGMA user_version = 1");
    expectRefused(ledger, "incompatible");
  });

  test("a missing ledger is reported missing", () => {
    expectRefused(join(tempDir(), "ledger.sqlite3"), "missing");
  });

  test("a directory is reported unavailable", () => {
    expectRefused(tempDir(), "unavailable");
  });

  test("a file that is not SQLite is reported corrupt", () => {
    const ledger = join(tempDir(), "ledger.sqlite3");
    writeFileSync(ledger, "not a database".repeat(100));
    expectRefused(ledger, "corrupt");
  });

  test("a ledger with a damaged page is reported corrupt", () => {
    const ledger = ledgerCopy();
    const bytes = readFileSync(ledger);
    const pageSize = bytes.readUInt16BE(16);
    bytes.fill(0xa5, bytes.length - pageSize); // the last page: a usage or index leaf
    writeFileSync(ledger, bytes);
    expectRefused(ledger, "corrupt");
  });

  test.each([
    ["a BLOB model name", "UPDATE models SET name = x'6d6f64656c' WHERE id = 2"],
    ["a BLOB provider", "UPDATE accounts SET provider = x'636c61756465' WHERE id = 2"],
    ["a BLOB account label", "UPDATE accounts SET label = x'6c6162656c' WHERE id = 1"],
    ["a BLOB identity", "UPDATE accounts SET identity = x'00' WHERE id = 1"],
  ])("%s is a typed error, not a crash", (_name, sql) => {
    const ledger = ledgerCopy();
    edit(ledger, sql);
    expectRefused(ledger, "corrupt");
  });
});

describe("partly unusable ledgers", () => {
  test("rows naming an unknown account or model are skipped and counted; unused ones are copied", () => {
    const ledger = ledgerCopy();
    edit(
      ledger,
      `INSERT INTO usage VALUES (77, 99, 1780000000000, 1, 1, 1, 0, 0, NULL, NULL);
       INSERT INTO usage VALUES (78, 1, 1780000000000, 99, 1, 1, 0, 0, NULL, NULL);
       INSERT INTO usage VALUES (79, 1, -5, 1, 1, 1, 0, 0, NULL, NULL);
       INSERT INTO usage VALUES (80, 1, 'soon', 1, 1, 1, 0, 0, NULL, NULL);
       INSERT INTO models (name) VALUES ('unused-model');
       INSERT INTO accounts (provider, identity, label) VALUES ('claude', 'idle', 'idle');`,
    );
    const store = freshStore();
    const summary = importCcUsage(store, ledger);
    expect(summary).toMatchObject({ read: 20, inserted: 16, skipped: 4, accounts: 4, models: 7 });
    expect([...store.models().values()]).toContain("unused-model");
    expect([...store.accounts().values()].map((a) => a.label)).toContain("idle");
  });
});

describe("atomicity", () => {
  test("a store that stays busy gets no rows and no import record", () => {
    const store = freshStore(50);
    const blocker = new Database(store.path);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      expect(caught(() => importCcUsage(store, ledgerCopy()))).toBeInstanceOf(StoreBusy);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect([...store.keys()]).toEqual([]);
    expect(store.meta.imports).toEqual([]);
    expect(imported(importCcUsage(store, ledgerCopy())).inserted).toBe(16);
  });
});

describe("tombstones", () => {
  test("rows whose keys tokenhud removed as replays are left out, and counted", () => {
    const store = freshStore();
    const first = importCcUsage(store, ledgerCopy());
    if (first.status !== "imported") throw new Error("not imported");
    const codex = [...store.accounts().values()].find((a) => a.provider === "codex");
    const key = store.rows([...store.keys()]).find((r) => r.acct === codex?.id)?.key as bigint;
    store.write({ drop: { keys: [key], reason: "codex-replay" } });
    const again = importCcUsage(store, ledgerCopy());
    expect(again).toMatchObject({ read: 16, inserted: 0, tombstoned: 1, unchanged: 15 });
    expect(store.rows([key])).toEqual([]);
  });
});
