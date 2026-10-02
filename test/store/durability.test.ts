// Backups, corruption and recovery of the store (src/store/durability.ts), ported from
// cc-usage's tests/test_ledger.py. Each ported test names its Python original. Engine-level
// ports (passes, cursors, the Worker) are in test/ingest/durability.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  BACKUP_INTERVAL_MS,
  BackupUnverified,
  backup,
  backupDue,
  backupPaths,
  moveAside,
  openDurableStore,
  processPending,
  queueOrphans,
  type RecoveryReport,
  readSource,
  replaceCorruptStore,
} from "../../src/store/durability.ts";
import { StoreCorrupt, StoreUnavailable } from "../../src/store/errors.ts";
import { KEY_SCHEME, ledgerKey } from "../../src/store/key.ts";
import { fileIdOf, openStore, type Store, type UsageRow } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { corruptUsageLeaf, scribblePage, usagePages } from "./damage.ts";
import { cleanup, row, T0, tempDir, track } from "./helpers.ts";

guard();

afterEach(cleanup);

/** `n` rows with real-looking (hashed, spread) keys `k<start>`.. and `inp` = 100 + i. */
function rows(n: number, start = 0, over: Partial<UsageRow> = {}): UsageRow[] {
  return Array.from({ length: n }, (_, j) => {
    const i = start + j;
    return row(ledgerKey(`k${i}`), { ts: T0 + i, inp: 100 + i, ...over });
  });
}

function storePath(): string {
  return join(tempDir(), "tokenhud.db");
}

/** A closed store at `path` holding `contents`. */
function make(path: string, contents: readonly UsageRow[]): void {
  const store = openStore(path);
  store.upsert(contents);
  store.close();
}

function count(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return Number(db.query<{ n: number }, []>("SELECT count(*) AS n FROM usage").get()?.n);
  } finally {
    db.close();
  }
}

function metaOf(path: string, key: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ v: string }, [string]>("SELECT v FROM meta WHERE k = ?1").get(key)?.v ?? null;
  } finally {
    db.close();
  }
}

/** Runs `sql` on a plain connection to `path`. */
function exec(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** key -> inp of every stored row. */
function stored(store: Store): Map<bigint, number> {
  return new Map(store.rows([...store.keys()]).map((r) => [r.key, r.inp]));
}

/**
 * A store whose damage the open does not see, found as the engine's daily check finds it
 * (`quick_check`) and replaced: moved aside, a fresh store opened, the moved file queued.
 */
function replaceDamaged(path: string): { store: Store; movedTo: string | null } {
  const store = track(openStore(path));
  let check: string;
  try {
    check = store.quickCheck();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreCorrupt); // too damaged to even run the check
    check = "unreadable";
  }
  expect(check).not.toBe("ok");
  return { store, movedTo: replaceCorruptStore(store) };
}

function scratchIn(dir: string): () => string {
  return () => mkdtempSync(join(dir, "salvage-"));
}

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

const enospc = () =>
  Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });

// ── salvage ────────────────────────────────────────────────────────────────────────

describe("salvage", () => {
  // test_partially_damaged_ledger_is_salvaged_row_by_row
  test("a partially damaged store is salvaged row by row", () => {
    const path = storePath();
    const original = rows(5000);
    make(path, original);
    corruptUsageLeaf(path);

    const { store, movedTo } = replaceDamaged(path);
    expect(movedTo).not.toBeNull();
    const report = processPending(store) as RecoveryReport;
    const source = only(report.sources); // no backup existed
    expect(source).toMatchObject({ why: "damaged", status: "merged", complete: false });
    expect(source.rows).toBeGreaterThan(5000 - 200); // only the scribbled page is lost
    expect(source.rows).toBeLessThan(5000);
    expect(store.rowCounts().get(1)).toBe(source.rows);
    expect(report.summary).toContain("no usable backup");
    expect(report.summary).not.toContain("history intact");
    const inp = new Map(original.map((r) => [r.key, r.inp]));
    for (const [key, value] of stored(store)) expect(value).toBe(inp.get(key) as number); // values intact
  });

  // Acceptance criterion 2: corrupt pages -> aside file + queue + every readable row merged.
  test.each([
    ["the first", 0],
    ["a middle", 12],
    ["the last", -1],
  ])("with %s leaf page damaged, every row on an intact page is merged", (_name, index) => {
    const path = storePath();
    const original = rows(3000);
    make(path, original);
    const lost = new Set(corruptUsageLeaf(path, index));
    expect(lost.size).toBeGreaterThan(50);

    const { store, movedTo } = replaceDamaged(path);
    expect(existsSync(movedTo as string)).toBe(true); // set aside, never deleted
    expect(store.pendingRecovery()).toEqual([
      { file: basename(movedTo as string), why: "damaged" },
    ]);
    processPending(store);
    const expected = original.filter((r) => !lost.has(r.key));
    expect(stored(store)).toEqual(new Map(expected.map((r) => [r.key, r.inp])));
    expect(store.pendingRecovery()).toEqual([]);
  });

  // test_salvage_is_complete_only_when_nothing_is_missing
  test("a salvage is complete only when nothing is missing", () => {
    const dir = tempDir();
    const pristine = join(dir, "pristine.db");
    make(pristine, rows(3000));
    const { pageSize, root, leaves } = usagePages(pristine);
    const pages = [...leaves.keys()].filter((p) => p !== root).sort((a, b) => a - b);
    const base = readFileSync(pristine);
    let trials = 0;
    let lostQuietly = 0;
    for (const page of [pages.at(-1), pages.at(-7), pages[Math.floor(pages.length / 2)]]) {
      for (const [offset, hex] of [
        [0, "0d000000"],
        [3, "0005"],
        [5, "0ff0"],
        [8, "ff".repeat(8)],
        [12, "00".repeat(16)],
        [40, "07".repeat(4)],
        [pageSize - 8, "00".repeat(8)],
        [pageSize - 60, "ff".repeat(12)],
        [pageSize / 2, "81818181"],
        [pageSize - 200, "000000"],
      ] as const) {
        const data = Buffer.from(base);
        Buffer.from(hex, "hex").copy(data, ((page as number) - 1) * pageSize + offset);
        const trial = join(dir, `trial-${trials}.db`);
        writeFileSync(trial, data);
        const source = readSource(trial, scratchIn(dir));
        // (Bytes changed inside one record's payload, with the page structure intact,
        // alter a value without losing a row; no integrity check can see that. What must
        // never happen is rows going missing unannounced.)
        if (source.raw.length < 3000) {
          expect(source.complete).toBe(false);
          lostQuietly++;
        }
        trials++;
      }
    }
    expect(lostQuietly).toBeGreaterThanOrEqual(10); // the damage patterns really do lose rows
  });

  // test_salvage_loses_only_about_one_page
  test("a salvage loses only the damaged page", () => {
    const dir = tempDir();
    const path = join(dir, "tokenhud.db");
    make(path, rows(40_000));
    const lost = corruptUsageLeaf(path);
    const source = readSource(path, scratchIn(dir));
    // A leaf holds about 120 of these rows; one of the 64 top-level key ranges ~625.
    expect(source.raw.length).toBeGreaterThan(40_000 - 300);
    expect(source.raw.length).toBe(40_000 - lost.length); // and with edge refinement, exactly it
    expect(source.complete).toBe(false);
  });

  // test_salvage_validates_cell_sizes_before_reading_rows
  test("the salvage validates cell sizes before it reads rows", () => {
    const dir = tempDir();
    const pristine = join(dir, "pristine.db");
    make(pristine, rows(3000));

    // White box: the pragma is on before the usage table is read.
    const order: string[] = [];
    const realExec = Database.prototype.exec;
    const realQuery = Database.prototype.query;
    Database.prototype.exec = function (this: Database, sql: string, ...rest: unknown[]) {
      order.push(sql);
      return (realExec as (...a: unknown[]) => unknown).call(this, sql, ...rest);
    } as typeof realExec;
    Database.prototype.query = function (this: Database, sql: string) {
      order.push(sql);
      return realQuery.call(this, sql);
    } as typeof realQuery;
    try {
      readSource(pristine, scratchIn(dir));
    } finally {
      Database.prototype.exec = realExec;
      Database.prototype.query = realQuery;
    }
    const firstUsage = order.findIndex((sql) => sql.includes("FROM usage"));
    expect(firstUsage).toBeGreaterThan(0);
    expect(order.slice(0, firstUsage).some((sql) => sql.includes("cell_size_check = ON"))).toBe(
      true,
    );

    // Behaviour: on damage where it matters it recovers more rows. Found by a seeded search
    // over this layout (usage leaf index, offset, bytes); cc-usage picked its own the same way.
    const { pageSize, root, leaves } = usagePages(pristine);
    const pages = [...leaves.keys()].filter((p) => p !== root).sort((a, b) => a - b);
    const base = readFileSync(pristine);
    const salvaged = (trial: string, check: boolean): number => {
      if (check) return readSource(trial, scratchIn(dir)).raw.length;
      Database.prototype.exec = function (this: Database, sql: string, ...rest: unknown[]) {
        if (sql.includes("cell_size_check")) return undefined;
        return (realExec as (...a: unknown[]) => unknown).call(this, sql, ...rest);
      } as typeof realExec;
      try {
        return readSource(trial, scratchIn(dir)).raw.length;
      } finally {
        Database.prototype.exec = realExec;
      }
    };
    const gains: number[] = [];
    for (const [leaf, offset, hex] of [
      [1, 184, "0000000000400040"],
      [11, 200, "00000000"],
      [3, 216, "c000"],
      [2, 216, "0000"],
    ] as const) {
      const data = Buffer.from(base);
      Buffer.from(hex, "hex").copy(data, ((pages[leaf] as number) - 1) * pageSize + offset);
      const trial = join(dir, `t${leaf}-${offset}.db`);
      writeFileSync(trial, data);
      const withCheck = salvaged(trial, true);
      const without = salvaged(trial, false);
      expect(withCheck).toBeGreaterThanOrEqual(without);
      gains.push(withCheck - without);
    }
    expect(Math.max(...gains)).toBeGreaterThan(0);
  });

  test("a file that is not a database is unreadable, and one that is not a tokenhud store is refused", () => {
    const dir = tempDir();
    const garbage = join(dir, "garbage");
    writeFileSync(garbage, Buffer.alloc(8192, 0x5a));
    expect(readSource(garbage, scratchIn(dir)).unreadable).toBe(true);
    const foreign = join(dir, "foreign.db");
    exec(foreign, "CREATE TABLE usage (key INTEGER PRIMARY KEY, acct INTEGER)");
    expect(readSource(foreign, scratchIn(dir)).foreign).toBe(true);
    // No scratch copy is left behind.
    expect(readdirSync(dir).filter((f) => f.startsWith("salvage-"))).toEqual([]);
  });
});

// ── backups ────────────────────────────────────────────────────────────────────────

describe("backups", () => {
  test("a backup is a verified, self-contained copy with the store's lineage", () => {
    const path = storePath();
    const store = track(openStore(path));
    store.upsert(rows(50));
    const { bak, prev } = backupPaths(path);
    expect(backupDue(store)).toBe(true);
    expect(backup(store)).toBe(true);
    expect(count(bak)).toBe(50);
    expect(metaOf(bak, "store_id")).toBe(store.storeId);
    const header = readFileSync(bak).subarray(0, 100);
    expect([header[18], header[19]]).toEqual([1, 1]); // a rollback-journal file, no WAL
    expect(existsSync(prev)).toBe(false);
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(backupDue(store)).toBe(false);
    const old = (Date.now() - BACKUP_INTERVAL_MS - 1000) / 1000;
    utimesSync(bak, old, old);
    expect(backupDue(store)).toBe(true);
  });

  test("backups rotate: the previous one moves to .bak.prev", () => {
    const path = storePath();
    const store = track(openStore(path));
    store.upsert(rows(10));
    backup(store);
    const { bak, prev } = backupPaths(path);
    const first = readFileSync(bak);
    store.upsert(rows(5, 10));
    expect(backup(store)).toBe(true);
    expect(readFileSync(prev).equals(first)).toBe(true);
    expect(count(bak)).toBe(15);
  });

  // test_backup_that_fails_its_check_never_replaces_the_good_one
  test("a backup that fails its check never replaces the good one", () => {
    const path = storePath();
    const store = track(openStore(path));
    store.upsert(rows(20));
    backup(store);
    const { bak } = backupPaths(path);
    const good = readFileSync(bak);
    store.upsert(rows(5, 20));
    const verify = () => "row 3 missing from index usage_ts";
    expect(() => backup(store, { verify })).toThrow(BackupUnverified);
    expect(() => backup(store, { verify })).toThrow(/integrity check/);
    expect(readFileSync(bak).equals(good)).toBe(true);
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // test_backup_is_daily_and_verified (the damaged-store half)
  test("a damaged store cannot be backed up, and the good backup stays", () => {
    const path = storePath();
    const store = openStore(path);
    store.upsert(rows(3000));
    backup(store);
    store.close();
    const { bak } = backupPaths(path);
    const good = readFileSync(bak);
    corruptUsageLeaf(path);
    const damaged = track(openStore(path));
    expect(() => backup(damaged)).toThrow(StoreCorrupt);
    expect(readFileSync(bak).equals(good)).toBe(true);
    expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // Acceptance criterion 2: a backup slot with a foreign lineage is never overwritten.
  test("a backup slot holding another store's history is held, merged, and only then rotated", () => {
    const dir = tempDir();
    const path = join(dir, "tokenhud.db");
    const store = track(openStore(path));
    store.upsert(rows(10));
    backup(store);
    const other = join(tempDir(), "tokenhud.db");
    const foreignStore = openStore(other);
    foreignStore.upsert(rows(50, 1000));
    backup(foreignStore);
    foreignStore.close();
    const { bak, prev } = backupPaths(path);
    const foreign = readFileSync(backupPaths(other).bak);
    writeFileSync(bak, foreign); // restored by hand, say

    expect(backup(store)).toBe(false); // held: its rows are not in this store yet
    expect(readFileSync(bak).equals(foreign)).toBe(true);
    expect(store.pendingRecovery()).toEqual([{ file: "tokenhud.db.bak", why: "held" }]);
    expect(backup(store)).toBe(false); // and held again while queued

    const report = processPending(store) as RecoveryReport;
    expect(only(report.sources)).toMatchObject({ status: "merged", newRows: 50, complete: true });
    expect(report.summary).toContain(
      "a backup file held history this store did not have, and it is merged now",
    );
    expect(report.summary).not.toContain("may be lost");
    expect(store.mergedLineages().size).toBe(1);
    expect(backup(store)).toBe(true); // covered now: rotated, not destroyed
    expect(readFileSync(prev).equals(foreign)).toBe(true);
    expect(count(bak)).toBe(60);
  });

  test("an unreadable or foreign file in a backup slot is set aside, never overwritten", () => {
    const path = storePath();
    const store = track(openStore(path));
    store.upsert(rows(10));
    const { bak } = backupPaths(path);
    const junk = Buffer.alloc(4096, 0x33);
    writeFileSync(bak, junk);
    expect(backup(store)).toBe(false);
    const report = processPending(store) as RecoveryReport;
    const source = only(report.sources);
    expect(source.status).toBe("unreadable");
    expect(source.keptAs).toMatch(/^tokenhud\.db\.bak\.damaged-\d{8}-\d{6}$/);
    expect(readFileSync(join(dirname(path), source.keptAs as string)).equals(junk)).toBe(true);
    expect(backup(store)).toBe(true);
    expect(count(bak)).toBe(10);
  });

  // test_no_backup_is_made_while_a_recovery_is_unfinished (the store's rule)
  test("no backup is made while anything is queued", () => {
    const path = storePath();
    const store = track(openStore(path));
    store.upsert(rows(10));
    store.updateRecovery({
      addPending: [{ file: "tokenhud.db.corrupt-20260101-000000", why: "damaged" }],
    });
    writeFileSync(join(dirname(path), "tokenhud.db.corrupt-20260101-000000"), "x");
    expect(backup(store)).toBe(false);
    expect(existsSync(backupPaths(path).bak)).toBe(false);
  });
});

// ── the recovery queue ─────────────────────────────────────────────────────────────

describe("recovery", () => {
  // Acceptance criterion 2: a disk-full failure leaves the item queued.
  // test_failed_salvage_copy_is_reported_retried_and_never_mistaken_for_empty (the store's part)
  test("a salvage copy that fails is reported, retried, and never mistaken for nothing", () => {
    const dir = tempDir();
    const path = join(dir, "tokenhud.db");
    const original = rows(3000);
    const before = openStore(path);
    before.upsert(original);
    backup(before);
    before.close();
    const { bak, prev } = backupPaths(path);
    const good = readFileSync(bak);
    corruptUsageLeaf(path);

    const { store, movedTo } = replaceDamaged(path);
    const destinations: string[] = [];
    const fullDisk = (_from: string, to: string) => {
      destinations.push(to);
      throw enospc();
    };
    for (let i = 0; i < 3; i++) {
      const report = processPending(store, { copyFile: fullDisk }) as RecoveryReport;
      expect(report.sources.map((s) => s.status)).toEqual(["failed", "failed"]);
      expect(report.summary).toContain("could NOT read");
      expect(report.summary).toContain("no space left");
      expect(report.summary).toContain("recovery is NOT complete");
      expect(report.summary).not.toContain("recovered");
      expect(report.stillPending).toEqual([basename(movedTo as string), "tokenhud.db.bak"]);
    }
    // The scratch copies are made beside the store, not in TMPDIR.
    expect(destinations.length).toBeGreaterThan(0);
    for (const d of destinations) expect(dirname(dirname(d))).toBe(join(dir, ".tokenhud-tmp"));
    expect(backup(store)).toBe(false); // never rotate the only good backup away
    expect(readFileSync(bak).equals(good)).toBe(true);
    expect(store.meta.recoveryReport).toMatchObject({
      stillPending: [basename(movedTo as string), "tokenhud.db.bak"],
    });

    const report = processPending(store) as RecoveryReport; // space is back
    expect(report.summary).toContain("recovered");
    expect(report.summary).not.toContain("NOT complete");
    expect(report.stillPending).toEqual([]);
    expect(stored(store)).toEqual(new Map(original.map((r) => [r.key, r.inp]))); // every row back
    expect(backup(store)).toBe(true); // and only now is the old backup rotated
    expect(readFileSync(prev).equals(good)).toBe(true);
  });

  test("the queue survives a restart", () => {
    const path = storePath();
    const store = openStore(path);
    store.updateRecovery({ addPending: [{ file: "x.corrupt", why: "damaged" }] });
    store.updateRecovery({
      addPending: [
        { file: "y.bak", why: "held" },
        { file: "x.corrupt", why: "damaged" },
      ],
    });
    store.close();
    expect(track(openStore(path)).pendingRecovery()).toEqual([
      { file: "y.bak", why: "held" },
      { file: "x.corrupt", why: "damaged" },
    ]);
  });

  test("a queued file that is gone leaves the queue", () => {
    const store = track(openStore(storePath()));
    store.updateRecovery({ addPending: [{ file: "tokenhud.db.corrupt-1", why: "damaged" }] });
    const report = processPending(store) as RecoveryReport;
    expect(only(report.sources).status).toBe("gone");
    expect(store.pendingRecovery()).toEqual([]);
    expect(processPending(store)).toBeNull();
  });

  // test_missing_ledger_is_restored_from_its_backup (the store's part)
  test("a store that went missing is restored from its backups", () => {
    const path = storePath();
    const store = openStore(path);
    store.upsert(rows(40));
    backup(store);
    store.upsert(rows(9, 40));
    backup(store);
    store.close();
    const { bak, prev } = backupPaths(path);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });

    const fresh = track(openStore(path));
    expect(fresh.pendingRecovery()).toEqual([
      { file: "tokenhud.db.bak", why: "missing" },
      { file: "tokenhud.db.bak.prev", why: "missing" },
    ]);
    const good = readFileSync(bak);
    const report = processPending(fresh) as RecoveryReport;
    expect(report.summary).toContain("the usage store was missing, so a new one was started");
    expect(report.summary).toContain("recovered 49 rows from tokenhud.db.bak (from ");
    expect(fresh.rowCounts().get(1)).toBe(49);
    expect(fresh.mergedLineages().size).toBe(1); // the old store's lineage
    expect(backup(fresh)).toBe(true); // the history-less store never replaced the backup
    expect(readFileSync(prev).equals(good)).toBe(true);
    expect(count(bak)).toBe(49);
  });

  // test_damaged_ledger_moves_its_wal_and_shm_aside_too (the store's part)
  test("a damaged store's WAL and SHM move aside with it", () => {
    const path = storePath();
    writeFileSync(path, Buffer.from("not a database".repeat(300)));
    writeFileSync(`${path}-wal`, Buffer.from("old wal frames".repeat(10)));
    writeFileSync(`${path}-shm`, Buffer.alloc(64));
    const { store, movedTo } = openDurableStore(path);
    track(store);
    const moved = movedTo as string;
    expect(basename(moved)).toMatch(/^tokenhud\.db\.corrupt-\d{8}-\d{6}$/);
    expect(readFileSync(`${moved}-wal`).toString()).toBe("old wal frames".repeat(10));
    expect(existsSync(`${moved}-shm`)).toBe(true);
    expect(readFileSync(moved).toString()).toBe("not a database".repeat(300));
    const report = processPending(store) as RecoveryReport;
    expect(only(report.sources)).toMatchObject({ why: "damaged", status: "unreadable" });
    expect(report.summary).toContain(`moved to ${moved}`);
    expect(report.summary).toContain("there was no usable backup");
  });

  test("moving aside never touches a file another process has already replaced", () => {
    const path = storePath();
    make(path, rows(3));
    const found = fileIdOf(path);
    // Another process moved the file aside and put a fresh one in its place. The moved file
    // keeps its inode, so the new one cannot reuse it (a deleted file's could be).
    const moved = `${path}.moved`;
    renameSync(path, moved);
    copyFileSync(moved, path);
    expect(fileIdOf(path)).not.toBe(found);
    expect(moveAside(path, found)).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  // test_second_process_reopens_after_the_ledger_is_moved_aside
  test.skipIf(process.platform === "win32")(
    "a second process follows the store to its new file",
    () => {
      const path = storePath();
      make(path, rows(9));
      const a = track(openStore(path));
      const b = track(openStore(path));
      b.upsert(rows(1, 100)); // b holds an open handle
      const moved = replaceCorruptStore(a) as string;
      processPending(a);
      expect(b.ensureCurrent()).toBe(true); // noticed the swap
      b.upsert(rows(1, 200));
      a.close();
      b.close();
      expect(count(moved)).toBe(10); // nothing more went into the moved-aside file
      expect(count(path)).toBe(11);
    },
  );

  // test_a_source_whose_key_scheme_is_unreadable_is_refused_and_kept (the store's part)
  test("a source whose key scheme is unreadable is refused and kept", () => {
    const path = storePath();
    const store = openStore(path);
    store.upsert(rows(40));
    backup(store);
    store.close();
    const { bak } = backupPaths(path);
    exec(bak, "DELETE FROM meta WHERE k = 'key_scheme'");
    const unknown = readFileSync(bak);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });

    const fresh = track(openStore(path));
    const report = processPending(fresh) as RecoveryReport;
    const source = only(report.sources);
    expect(source.status).toBe("refused");
    expect(report.summary).toContain("did not merge tokenhud.db.bak");
    expect(report.summary).toContain("key scheme");
    expect(report.summary).toContain("unreadable");
    expect(source.keptAs).toMatch(/^tokenhud\.db\.bak\.unmerged-/);
    expect(readFileSync(join(dirname(path), source.keptAs as string)).equals(unknown)).toBe(true);
    expect(fresh.rowCounts().size).toBe(0); // none of its rows were guessed at
  });

  // test_old_scheme_backup_is_migrated_and_a_future_one_is_refused (the store's part)
  test("an old-scheme source is migrated first; a newer-scheme one is refused and kept", () => {
    const path = storePath();
    const store = openStore(path);
    store.upsert([
      ...rows(30),
      ...rows(10, 500, {
        provider: "codex",
        identity: "id-codex",
        label: "codex",
        model: "gpt-5.5",
      }),
    ]);
    backup(store);
    store.close();
    const { bak } = backupPaths(path);
    exec(bak, "UPDATE meta SET v = '1' WHERE k = 'key_scheme'");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });

    const fresh = openStore(path);
    processPending(fresh);
    expect(fresh.rowCounts().get(1)).toBe(30); // Claude history back as it was
    expect(fresh.meta.codexRekeyPending).toEqual(["id-codex"]); // scheme 1 -> 2 ran on it
    fresh.close();

    exec(bak, `UPDATE meta SET v = '${KEY_SCHEME + 97}' WHERE k = 'key_scheme'`);
    const future = readFileSync(bak);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const again = track(openStore(path));
    const report = processPending(again) as RecoveryReport;
    expect(report.summary).toContain("did not merge tokenhud.db.bak");
    expect(report.summary).toContain("newer than this tokenhud");
    const kept = readdirSync(dirname(path)).filter((f) =>
      f.startsWith("tokenhud.db.bak.unmerged-"),
    );
    expect(readFileSync(join(dirname(path), only(kept))).equals(future)).toBe(true);
    expect(again.rowCounts().size).toBe(0);
  });

  // test_damaged_ledger_restored... part: a damaged store's id tables come from a same-lineage backup.
  test("a source whose account and model tables are damaged borrows them from a same-lineage backup", () => {
    const path = storePath();
    const store = openStore(path);
    store.upsert(rows(2000));
    backup(store);
    store.close();
    // Damage the accounts table's only page, leaving usage intact.
    const db = new Database(path, { readonly: true });
    const accountsRoot = Number(
      db
        .query<{ p: number }, []>("SELECT rootpage AS p FROM sqlite_master WHERE name = 'accounts'")
        .get()?.p,
    );
    db.close();
    scribblePage(path, accountsRoot, usagePages(path).pageSize);
    const { store: fresh } = replaceDamaged(path);
    const report = processPending(fresh) as RecoveryReport;
    const damaged = report.sources.find((s) => s.why === "damaged");
    expect(damaged).toMatchObject({ status: "merged", rows: 2000, complete: false });
    expect(fresh.rowCounts().get(1)).toBe(2000);
  });
});

// ── merging another copy ───────────────────────────────────────────────────────────

describe("mergeRecovered", () => {
  const event = (over = {}) => ({
    account: { provider: "claude", identity: "id-personal", label: "personal" },
    kind: "reached",
    window: "session",
    label: "5-HOUR",
    resetsAt: T0 + 3_600_000,
    at: T0,
    resumedAt: null as number | null,
    ...over,
  });

  test("tombstones are applied: their rows go and stay out; labels are not renamed", () => {
    const store = track(openStore(storePath()));
    store.upsert([row(1n, { label: "renamed" }), row(2n, { label: "renamed" })]);
    const { newRows, removed } = store.mergeRecovered({
      rows: [
        row(3n, { label: "old" }),
        row(4n, { label: "old" }),
        row(2n, { inp: 999, label: "old" }),
      ],
      tombstones: [
        { key: 1n, reason: "codex-replay", at: T0 },
        { key: 4n, reason: "codex-replay", at: T0 },
      ],
      rekey: ["id-codex"],
      imports: [],
      limitEvents: [],
    });
    expect(newRows).toBe(1); // key 3; key 4 is tombstoned
    expect(removed).toBe(1); // key 1's live row: the source judged it not usage
    expect(stored(store)).toEqual(
      new Map([
        [2n, 999],
        [3n, 10],
      ]),
    );
    expect(store.droppedKeys()).toEqual(new Set([1n, 4n]));
    store.upsert([row(1n), row(4n)]); // and nothing writes them back
    expect(stored(store).has(1n) || stored(store).has(4n)).toBe(false);
    expect([...store.accounts().values()].map((a) => a.label)).toEqual(["renamed"]);
    expect(store.meta.codexRekeyPending).toEqual(["id-codex"]);
  });

  test("import records and limit events are carried over once", () => {
    const store = track(openStore(storePath()));
    const record = {
      at: "2026-09-01T00:00:00.000Z",
      source: "cc-usage",
      lineage: "L",
      rows: 5,
      accounts: 1,
    };
    const data = {
      rows: [],
      tombstones: [],
      rekey: [],
      imports: [record],
      limitEvents: [event(), event({ kind: "passed80", window: "weekly_all", resetsAt: T0 + 7 })],
    };
    store.mergeRecovered(data);
    store.mergeRecovered(data);
    expect(store.meta.imports).toEqual([record]);
    store.mergeRecovered({ ...data, imports: [], limitEvents: [event({ resumedAt: T0 + 99 })] });
    const events = new Database(store.path, { readonly: true });
    try {
      expect(events.query("SELECT kind, resumed_at FROM limit_events ORDER BY id").all()).toEqual([
        { kind: "reached", resumed_at: T0 + 99 },
        { kind: "passed80", resumed_at: null },
      ]);
    } finally {
      events.close();
    }
  });
});

test("statSync on a backup is unaffected by reading its lineage", () => {
  const path = storePath();
  const store = track(openStore(path));
  store.upsert(rows(3));
  backup(store);
  const { bak } = backupPaths(path);
  const before = statSync(bak).mtimeMs;
  store.upsert(rows(3, 3));
  backup(store); // reads .bak's lineage, then rotates it
  expect(statSync(backupPaths(path).prev).mtimeMs).toBe(before);
  expect(existsSync(`${bak}-wal`) || existsSync(`${bak}-shm`)).toBe(false);
});

// ── files no queue knows about, and leftovers ──────────────────────────────────────

describe("files beside the store", () => {
  /** A store moved aside whose queue entry was never written: a crash in between. */
  function crashedAfterMove(n = 1000): { path: string; moved: string } {
    const path = storePath();
    make(path, rows(n));
    const moved = moveAside(path, fileIdOf(path)) as string;
    expect(existsSync(path)).toBe(false);
    return { path, moved };
  }

  // M3: a crash between the rename and the queue write
  test("a store moved aside but never queued is found and recovered on the next open", () => {
    const { path, moved } = crashedAfterMove();
    const { store } = openDurableStore(path);
    track(store);
    expect(store.pendingRecovery()).toEqual([{ file: basename(moved), why: "damaged" }]);
    const report = processPending(store) as RecoveryReport;
    expect(only(report.sources)).toMatchObject({ status: "merged", rows: 1000, complete: true });
    expect(store.rowCounts().get(1)).toBe(1000);
  });

  // M3: the fresh store could not be created then (a full disk left an empty file)
  test("so is one whose fresh store could not be created at the time", () => {
    const { path, moved } = crashedAfterMove();
    writeFileSync(path, "");
    const { store } = openDurableStore(path);
    track(store);
    expect(store.pendingRecovery().map((e) => e.file)).toEqual([basename(moved)]);
    processPending(store);
    expect(store.rowCounts().get(1)).toBe(1000);
  });

  test("a file a store has processed is not queued again; a store that starts over looks again", () => {
    const { path, moved } = crashedAfterMove(10);
    const first = openDurableStore(path).store;
    processPending(first);
    expect(first.recoveredFiles()).toEqual(new Set([basename(moved)]));
    first.close();
    const again = openDurableStore(path).store;
    expect(again.pendingRecovery()).toEqual([]); // recorded as done
    again.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const lost = track(openDurableStore(path).store); // the store lost: start over
    expect(lost.pendingRecovery().map((e) => e.file)).toEqual([basename(moved)]);
    processPending(lost);
    expect(lost.rowCounts().get(1)).toBe(10);
  });

  test("only the names recovery itself gives are picked up", () => {
    const path = storePath();
    const dir = dirname(path);
    const store = track(openStore(path));
    for (const name of [
      "tokenhud.db.corrupt-notes.txt",
      "tokenhud.db.corrupt-20260101-000000-wal",
      "tokenhud.db.bak.4242.tmp",
      "other.db.corrupt-20260101-000000",
      "tokenhud.db.bak",
    ]) {
      writeFileSync(join(dir, name), "x");
    }
    expect(queueOrphans(store)).toEqual([]);
    for (const name of [
      "tokenhud.db.corrupt-20260101-000000",
      "tokenhud.db.corrupt-20260101-000000-2",
      "tokenhud.db.bak.unmerged-20260101-000000",
      "tokenhud.db.bak.prev.damaged-20260101-000000",
    ]) {
      writeFileSync(join(dir, name), "x");
    }
    expect(queueOrphans(store)).toEqual([
      "tokenhud.db.bak.prev.damaged-20260101-000000",
      "tokenhud.db.bak.unmerged-20260101-000000",
      "tokenhud.db.corrupt-20260101-000000",
      "tokenhud.db.corrupt-20260101-000000-2",
    ]);
    expect(store.pendingRecovery().find((e) => e.file.includes(".bak."))?.why).toBe("held");
    expect(queueOrphans(store)).toEqual([]); // queued already
  });

  // m3: a killed backup's temp file
  test("a killed backup's temp files are swept once an hour old, and nothing else", () => {
    const path = storePath();
    const dir = dirname(path);
    make(path, rows(3));
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    const names = {
      stale: "tokenhud.db.bak.4242.tmp",
      staleJournal: "tokenhud.db.bak.4242.tmp-journal",
      fresh: "tokenhud.db.bak.4243.tmp",
      other: "tokenhud.db.bak.notes.tmp",
      bak: "tokenhud.db.bak",
    };
    for (const name of Object.values(names)) writeFileSync(join(dir, name), "x");
    for (const name of [names.stale, names.staleJournal, names.other, names.bak]) {
      utimesSync(join(dir, name), old, old);
    }
    track(openStore(path));
    const left = new Set(readdirSync(dir));
    expect(left.has(names.stale) || left.has(names.staleJournal)).toBe(false);
    expect([names.fresh, names.other, names.bak].every((n) => left.has(n))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("the sweep never follows a symlink", () => {
    const path = storePath();
    const dir = dirname(path);
    make(path, rows(3));
    const target = join(tempDir(), "elsewhere.tmp");
    writeFileSync(target, "keep");
    const link = join(dir, "tokenhud.db.bak.4244.tmp");
    symlinkSync(target, link);
    track(openStore(path));
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});

describe("a damaged application_id", () => {
  /** Overwrites the header's application_id (bytes 68-71). */
  function damageApplicationId(file: string): void {
    const bytes = readFileSync(file);
    bytes.writeUInt32BE(0x01020304, 68);
    writeFileSync(file, bytes);
  }

  // m4: our own store, recognisable by its schema, is damaged, not foreign
  test("on our own store is damage: moved aside and recovered", () => {
    const path = storePath();
    make(path, rows(500));
    damageApplicationId(path);
    const before = readFileSync(path);
    const { store, movedTo } = openDurableStore(path);
    track(store);
    expect(readFileSync(movedTo as string).equals(before)).toBe(true); // moved as found
    const report = processPending(store) as RecoveryReport;
    expect(only(report.sources)).toMatchObject({ why: "damaged", status: "merged", rows: 500 });
    expect(store.rowCounts().get(1)).toBe(500);
  });

  test("on another app's database still means foreign: refused, untouched", () => {
    const dir = tempDir();
    const path = join(dir, "tokenhud.db");
    exec(
      path,
      "CREATE TABLE usage (key INTEGER PRIMARY KEY, acct INTEGER); CREATE TABLE meta (k TEXT, v TEXT)",
    );
    const before = readFileSync(path);
    expect(() => openDurableStore(path)).toThrow(StoreUnavailable);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(["tokenhud.db"]);
  });

  test("on a backup slot: merged, then set aside so a backup can take the slot", () => {
    const path = storePath();
    const store = track(openStore(path));
    store.upsert(rows(20));
    backup(store);
    store.upsert(rows(5, 20));
    const { bak } = backupPaths(path);
    damageApplicationId(bak);
    expect(backup(store)).toBe(false); // not recognisable as covered: held
    const report = processPending(store) as RecoveryReport;
    expect(only(report.sources)).toMatchObject({ status: "merged", rows: 20 });
    expect(only(report.sources).keptAs).toMatch(/^tokenhud\.db\.bak\.merged-/);
    expect(backup(store)).toBe(true);
    expect(count(bak)).toBe(25);
  });
});
