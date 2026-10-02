// Backups and recovery as the ingest engine runs them (src/ingest/engine.ts with
// src/store/durability.ts), ported from cc-usage's tests/test_ledger.py: each test names
// its Python original. cc-usage's "views" compare its aggregates; here the store's rows
// are compared, since every view is computed from them. Store-level ports are in
// test/store/durability.test.ts.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { type IngestMessage, startIngestWorker } from "../../src/ingest/client.ts";
import type { EngineOptions, IngestEngine } from "../../src/ingest/engine.ts";
import type { ChangedEvent } from "../../src/ingest/pass.ts";
import { BACKUP_INTERVAL_MS, backup, backupPaths, moveAside } from "../../src/store/durability.ts";
import { ledgerKey } from "../../src/store/key.ts";
import { openStore, type Store, type UsageRow } from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { corruptUsageLeaf } from "../store/damage.ts";
import { row } from "../store/helpers.ts";
import { claudeLine, cleanup, makeRoot, openEngine, storedRows, tempDir } from "./helpers.ts";

guard();

afterEach(cleanup);

const D1 = "2026-06-01T00:00:00Z";

/** A machine with one Claude root of 6 records in 3 transcripts, and a state dir. */
function world() {
  const dir = tempDir();
  const root = makeRoot(dir, "personal");
  const proj = join(root, "projects", "proj");
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(
    join(proj, "s1.jsonl"),
    claudeLine("1", "1", 1000, 5) +
      claudeLine("1", "1", 1000, 500) + // a streaming pair: the final count wins
      claudeLine("2", "2", 300, 40, { model: "claude-sonnet-4-6" }) +
      claudeLine("3", "3", 50, 5, { model: "claude-mystery-1" }),
  );
  writeFileSync(join(proj, "sub", "agent-1.jsonl"), claudeLine("4", "4", 700, 70));
  writeFileSync(
    join(proj, "s2.jsonl"),
    claudeLine("5", "5", 2000, 200) + claudeLine("6", "6", 800, 80),
  );
  const state = join(dir, "state");
  const storePath = join(state, "tokenhud.db");
  const logs: string[] = [];
  const events: ChangedEvent[] = [];
  const engine = (cache = "cache.db", over: Partial<EngineOptions> = {}): IngestEngine =>
    openEngine([root], {
      storePath,
      cachePath: join(state, cache),
      log: (level, message) => logs.push(`${level}: ${message}`),
      onChanged: (event) => events.push(event),
      ...over,
    });
  /** As the Worker starts: open, recover, then a full pass. */
  const scanned = async (cache?: string, over?: Partial<EngineOptions>): Promise<IngestEngine> => {
    const e = engine(cache, over);
    e.recover();
    await e.fullPass();
    return e;
  };
  return { dir, root, proj, state, storePath, logs, events, engine, scanned };
}

type World = ReturnType<typeof world>;

/** Every stored row as text, account and model by name: what every view is built from. */
function contents(store: Store): string[] {
  return [...storedRows(store).values()]
    .map((r) =>
      [r.key, r.identity, r.model, r.ts, r.inp, r.outp, r.cr, r.cc, r.e5, r.e1, r.tier].join("|"),
    )
    .sort();
}

/** `n` rows of history whose transcripts are gone (a separate account, as an old root). */
function history(n: number, start = 0, over: Partial<UsageRow> = {}): UsageRow[] {
  return Array.from({ length: n }, (_, j) =>
    row(ledgerKey(`h${start + j}`), {
      identity: "id-history",
      label: "history",
      ts: Date.parse(D1) - (start + j) * 60_000,
      inp: 10 + j,
      ...over,
    }),
  );
}

/** cc-usage's `_history_world`: the store also holds `n` rows of deleted-transcript history, backed up. */
async function historyWorld(w: World, n = 3000, extra: UsageRow[] = []): Promise<string[]> {
  const e = await w.scanned();
  e.store.upsert([...history(n), ...extra]);
  const before = contents(e.store);
  expect(before).toHaveLength(6 + n + extra.length);
  backup(e.store);
  await e.stop();
  return before;
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

function exec(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function age(path: string): void {
  const old = (statSync(path).mtimeMs - BACKUP_INTERVAL_MS - 1000) / 1000;
  utimesSync(path, old, old);
}

/**
 * Makes the next full pass run the daily step: the backup a day old and no recent check of
 * the whole store, so a damaged page the pass itself does not touch is found.
 */
function dailyStepDue(w: World): void {
  exec(w.storePath, "DELETE FROM meta WHERE k = 'checked_at'");
  const { bak } = backupPaths(w.storePath);
  if (existsSync(bak)) age(bak);
}

/** The store's own files (the store, its WAL and SHM), not its backups. */
function removeStore(w: World): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${w.storePath}${suffix}`, { force: true });
}

const corruptFiles = (w: World) =>
  readdirSync(w.state).filter((f) => /^tokenhud\.db\.corrupt-\d{8}-\d{6}(-\d+)?$/.test(f));

const recoveryNotes = (w: World) => w.logs.filter((l) => l.includes("usage store recovery:"));

const enospc = () =>
  Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });

describe("an unreadable store", () => {
  // test_damaged_ledger_is_restored_from_the_backup
  test("is restored from the backup, with the history only it held", async () => {
    const w = world();
    const before = await historyWorld(w);
    dailyStepDue(w);
    corruptUsageLeaf(w.storePath);

    const e = await w.scanned("fresh.db");
    expect(contents(e.store)).toEqual(before); // nothing lost
    const moved = corruptFiles(w);
    expect(moved).toHaveLength(1);
    const note = recoveryNotes(w).find((l) => l.includes("damaged")) as string;
    expect(note).toContain(join(w.state, moved[0] as string));
    expect(note).toContain("rows from tokenhud.db.bak (from ");
    expect(note).toContain("may be lost");
    expect(note).not.toContain("history intact");
    await e.stop();

    // Even a store that is garbage from its first byte comes back from the backup.
    writeFileSync(w.storePath, Buffer.alloc(8192));
    const again = await w.scanned("fresh2.db");
    expect(contents(again.store)).toEqual(before);
  });

  // test_corrupt_ledger_is_moved_aside_and_rebuilt
  test("is moved aside, kept byte for byte, and rebuilt from the transcripts", async () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    const garbage = Buffer.from("this is not a sqlite database".repeat(64));
    writeFileSync(w.storePath, garbage);
    const e = await w.scanned();
    const moved = corruptFiles(w);
    expect(moved).toHaveLength(1);
    expect(readFileSync(join(w.state, moved[0] as string)).equals(garbage)).toBe(true);
    expect(storedRows(e.store).size).toBe(6);
    expect(w.logs.some((l) => l.includes(`moved to ${join(w.state, moved[0] as string)}`))).toBe(
      true,
    );
  });

  // test_damaged_ledger_moves_its_wal_and_shm_aside_too
  test("moves its WAL and SHM aside too", async () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    writeFileSync(w.storePath, Buffer.from("not a database".repeat(300)));
    writeFileSync(`${w.storePath}-wal`, Buffer.from("old wal frames".repeat(10)));
    writeFileSync(`${w.storePath}-shm`, Buffer.alloc(64));
    const e = await w.scanned();
    const moved = join(w.state, corruptFiles(w)[0] as string);
    expect(readFileSync(`${moved}-wal`).toString()).toBe("old wal frames".repeat(10));
    expect(existsSync(`${moved}-shm`)).toBe(true);
    expect(storedRows(e.store).size).toBe(6);
  });

  // test_damaged_old_scheme_ledger_is_migrated_before_its_rows_are_merged
  test("of an older key scheme has its rows migrated before they merge", async () => {
    const w = world();
    const codex = history(25, 5000, { provider: "codex", identity: "id-codex", label: "codex" });
    const before = await historyWorld(w, 3000, codex);
    for (const slot of Object.values(backupPaths(w.storePath))) rmSync(slot, { force: true });
    exec(w.storePath, "UPDATE meta SET v = '1' WHERE k = 'key_scheme'");
    dailyStepDue(w);
    corruptUsageLeaf(w.storePath);

    const e = await w.scanned("fresh.db");
    expect(corruptFiles(w)).toHaveLength(1);
    // Scheme 1 -> 2 ran on the salvaged rows: the Codex account awaits the re-key.
    expect(e.store.meta.codexRekeyPending).toEqual(["id-codex"]);
    const now = new Set(contents(e.store));
    expect(before.filter((r) => !now.has(r)).length).toBeLessThan(200); // about one page lost
    expect([...now].every((r) => before.includes(r))).toBe(true); // and nothing extra
  });

  // test_corrupt_ledger_never_takes_the_panel_down (here: the ingest Worker, the panel's source)
  test("never takes the ingest Worker down", async () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    writeFileSync(w.storePath, Buffer.from("\0garbage".repeat(512)));
    const messages: IngestMessage[] = [];
    const worker = startIngestWorker(
      {
        storePath: w.storePath,
        cachePath: join(w.state, "cache.db"),
        config: { ...defaultConfig(), claude_roots: [{ path: w.root }] },
        discover: { home: join(w.dir, "home"), env: {}, wslUsersDir: null },
        importLedger: null,
        poolSize: 1,
      },
      (message) => messages.push(message),
    );
    try {
      const deadline = Date.now() + 10_000;
      while (!messages.some((m) => m.type === "ready")) {
        if (Date.now() > deadline) throw new Error("the Worker never got ready");
        await Bun.sleep(10);
      }
    } finally {
      await worker.stop();
    }
    const logs = messages.flatMap((m) => (m.type === "log" ? [`${m.level}: ${m.message}`] : []));
    expect(
      logs.some((l) => l.startsWith("warn") && l.includes("corrupt-") && l.includes("moved to")),
    ).toBe(true);
    expect(messages.some((m) => m.type === "changed")).toBe(true);
    expect(corruptFiles(w)).toHaveLength(1);
    expect(count(w.storePath)).toBe(6);
  });

  test("found by the daily check while running is moved aside and recovered", async () => {
    const w = world();
    const e = await w.scanned();
    e.store.upsert(history(3000));
    const before = contents(e.store);
    // Damage the main file under the running engine; the daily step's commit (clearing the
    // last check) also drops the engine's page cache, so it reads the damaged page.
    exec(w.storePath, "PRAGMA wal_checkpoint(TRUNCATE)");
    corruptUsageLeaf(w.storePath);
    dailyStepDue(w);
    await e.fullPass();
    expect(corruptFiles(w)).toHaveLength(1);
    const now = new Set(contents(e.store));
    const lost = before.filter((r) => !now.has(r));
    expect(lost.length).toBeGreaterThan(0); // the scribbled page, newer than the backup
    expect(lost.length).toBeLessThan(200);
    expect(lost.every((r) => r.includes("|id-history|"))).toBe(true); // transcripts re-read
  });

  // test_engine_resyncs_everything_into_a_replaced_ledger
  test.skipIf(process.platform === "win32")(
    "replaced under the engine is followed, and everything read into the new file",
    async () => {
      const w = world();
      const e = await w.scanned();
      const other = openStore(w.storePath);
      const found = other.fileId;
      other.disconnect();
      expect(moveAside(w.storePath, found)).not.toBeNull();
      other.close();
      rmSync(w.storePath, { force: true });
      await e.fullPass(); // its old handle points at the moved file; it must follow
      expect(count(w.storePath)).toBe(6);
      expect(storedRows(e.store).size).toBe(6);
    },
  );
});

describe("a lost store", () => {
  // test_warm_start_backfills_a_lost_ledger
  test.each(["missing", "corrupt"])(
    "a warm start backfills a %s store with every transcript",
    async (damage) => {
      const w = world();
      await (await w.scanned()).stop();
      for (const f of readdirSync(w.state)) {
        if (f.startsWith("tokenhud.db")) unlinkSync(join(w.state, f)); // the store and its backups
      }
      if (damage === "corrupt") writeFileSync(w.storePath, "garbage".repeat(1000));
      const e = w.engine(); // the same read positions: nothing has changed on disk
      e.recover();
      await e.fullPass();
      expect(storedRows(e.store).size).toBe(6);
    },
  );

  // test_missing_ledger_is_restored_from_its_backup
  test("a missing store is restored from its backup", async () => {
    const w = world();
    const before = await historyWorld(w, 40);
    const { bak, prev } = backupPaths(w.storePath);
    const good = readFileSync(bak);
    removeStore(w);
    const e = w.engine();
    e.recover();
    await e.fullPass();
    expect(contents(e.store)).toEqual(before); // the 40 orphans came back from the backup
    const note = recoveryNotes(w).find((l) => l.includes("missing")) as string;
    expect(note).toContain("recovered 46 rows from tokenhud.db.bak (from ");
    // The UI is told to re-read everything recovery added.
    expect(w.events.some((ev) => ev.fromTs === 0 && ev.accounts.includes("id-history"))).toBe(true);
    // The history-less store never replaced the backup: it was merged, then rotated.
    expect(readFileSync(prev).equals(good)).toBe(true);
    expect(count(bak)).toBe(46);
  });

  // test_ledger_restored_from_an_older_backup_catches_up_with_the_parse
  test("a store restored from an older backup catches up with the transcripts", async () => {
    const w = world();
    const s3 = join(w.proj, "s3.jsonl");
    writeFileSync(s3, claudeLine("9", "9", 900, 7));
    const e = await w.scanned(); // the first pass also takes the daily backup (out = 7)
    appendFileSync(s3, claudeLine("9", "9", 900, 1500));
    await e.fullPass();
    await e.stop();
    writeFileSync(w.storePath, Buffer.alloc(4096)); // nothing salvageable

    const key = ledgerKey("c\x1freq_FAKE9\x1fmsg_FAKE9");
    const warm = w.engine(); // the record is not new to the read positions
    warm.recover();
    await warm.fullPass();
    expect(storedRows(warm.store).get(key)?.outp).toBe(1500);
    await warm.stop();
    unlinkSync(s3);
    const cold = await w.scanned("fresh.db");
    expect(storedRows(cold.store).get(key)?.outp).toBe(1500);
  });

  // test_old_scheme_backup_is_migrated_and_a_future_one_is_refused
  test("an old-scheme backup is migrated, and a future one is refused and kept", async () => {
    const w = world();
    const codex = history(10, 5000, { provider: "codex", identity: "id-codex", label: "codex" });
    await historyWorld(w, 40, codex);
    const { bak, prev } = backupPaths(w.storePath);
    exec(bak, "UPDATE meta SET v = '1' WHERE k = 'key_scheme'");
    removeStore(w);
    const e = await w.scanned();
    expect(storedRows(e.store).size).toBe(6 + 40 + 10); // the history back
    expect(e.store.meta.codexRekeyPending).toEqual(["id-codex"]); // its Codex rows await the re-key
    await e.stop();

    exec(bak, "UPDATE meta SET v = '99' WHERE k = 'key_scheme'");
    const future = readFileSync(bak);
    removeStore(w);
    rmSync(prev, { force: true });
    const again = await w.scanned("fresh.db");
    const note = recoveryNotes(w).at(-1) as string;
    expect(note).toContain("did not merge tokenhud.db.bak");
    expect(note).toContain("newer than this tokenhud");
    const kept = readdirSync(w.state).filter((f) => f.startsWith("tokenhud.db.bak.unmerged-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(w.state, kept[0] as string)).equals(future)).toBe(true);
    expect(storedRows(again.store).size).toBe(6);
  });

  // test_a_source_whose_key_scheme_is_unreadable_is_refused_and_kept
  test("a backup whose key scheme is unreadable is refused and kept", async () => {
    const w = world();
    await historyWorld(w, 40);
    const { bak, prev } = backupPaths(w.storePath);
    exec(bak, "DELETE FROM meta WHERE k = 'key_scheme'");
    const unknown = readFileSync(bak);
    rmSync(prev, { force: true });
    removeStore(w);
    const e = await w.scanned("fresh.db");
    const note = recoveryNotes(w).find((l) => l.includes("missing")) as string;
    expect(note).toContain("did not merge tokenhud.db.bak");
    expect(note).toContain("key scheme");
    expect(note).toContain("unreadable");
    const kept = readdirSync(w.state).filter((f) => f.startsWith("tokenhud.db.bak.unmerged-"));
    expect(readFileSync(join(w.state, kept[0] as string)).equals(unknown)).toBe(true);
    expect(storedRows(e.store).size).toBe(6); // none of its rows were guessed at
  });
});

describe("recovery and the cc-usage import", () => {
  // M2 (the T7 critique's sequence): recovery fails once, the import waits, recovery succeeds.
  test("the first-run import waits for recovery, so a replayed row tombstoned before never comes back", async () => {
    const w = world();
    const ledger = join(w.dir, "ledger.sqlite3");
    copyFileSync(
      join(import.meta.dir, "..", "fixtures", "store", "cc-usage-ledger.sqlite3"),
      ledger,
    );
    // The live store: cc-usage's history imported, one of its Codex rows then judged a
    // replay and tombstoned, and backed up. The backup lacks the import record, so the
    // import really runs again once recovery is done.
    const first = w.engine("cache.db", { importLedger: ledger });
    first.recover();
    expect(first.importIfFirstRun()?.status).toBe("imported");
    await first.fullPass();
    const codex = [...storedRows(first.store).values()].filter(
      (r) => r.identity !== undefined && r.label === "codex",
    );
    expect(codex.length).toBeGreaterThan(0);
    const replayed = codex[0]?.key as bigint;
    first.store.write({ drop: { keys: [replayed], reason: "codex-replay" } });
    const rows = storedRows(first.store).size;
    backup(first.store);
    await first.stop();
    exec(backupPaths(w.storePath).bak, "UPDATE meta SET v = '[]' WHERE k = 'imports'");
    // The store is lost: its first page is zeroed.
    const bytes = readFileSync(w.storePath);
    bytes.fill(0, 0, 4096);
    writeFileSync(w.storePath, bytes);

    let diskFull = true;
    const copyFile = (from: string, to: string) => {
      if (diskFull) throw enospc();
      copyFileSync(from, to);
    };
    const e = w.engine("fresh.db", { importLedger: ledger, recovery: { copyFile } });
    e.recover(); // cannot read anything yet
    expect(e.importIfFirstRun()).toBeNull(); // so the import waits
    await e.fullPass();
    expect(e.store.meta.imports).toEqual([]);
    expect(w.logs.some((l) => l.includes("the cc-usage import waits"))).toBe(true);

    diskFull = false;
    await e.fullPass(); // recovery succeeds, its tombstones are applied, then the import runs
    expect(e.store.meta.pending).toEqual([]);
    expect(e.store.meta.imports.map((i) => i.source)).toEqual(["cc-usage"]);
    expect(e.store.rows([replayed])).toEqual([]); // the replayed row stays out
    expect(e.store.droppedKeys().has(replayed)).toBe(true);
    expect(storedRows(e.store).size).toBe(rows); // and everything else is back
  });
});

describe("recovery that cannot finish", () => {
  // test_failed_salvage_copy_is_reported_retried_and_never_mistaken_for_empty
  test("a failed salvage copy is reported, retried, and never mistaken for empty", async () => {
    const w = world();
    const before = await historyWorld(w);
    const { bak, prev } = backupPaths(w.storePath);
    const good = readFileSync(bak);
    dailyStepDue(w);
    corruptUsageLeaf(w.storePath);
    let diskFull = true;
    const copyFile = (from: string, to: string) => {
      if (diskFull) throw enospc();
      copyFileSync(from, to);
    };
    const e = await w.scanned("fresh.db", { recovery: { copyFile } });
    const failed = recoveryNotes(w).at(-1) as string;
    expect(failed).toContain("could NOT read");
    expect(failed).toContain("no space left");
    expect(failed).toContain("recovery is NOT complete");
    expect(failed).not.toContain("recovered");
    for (let i = 0; i < 3; i++) await e.fullPass(); // later passes retry...
    expect(backup(e.store)).toBe(false); // ...and never rotate the only good backup away
    expect(readFileSync(bak).equals(good)).toBe(true);
    expect(e.store.pendingRecovery().length).toBeGreaterThan(0);

    diskFull = false; // space is back
    await e.fullPass();
    expect(contents(e.store)).toEqual(before); // every orphan is back
    const done = recoveryNotes(w).at(-1) as string;
    expect(done).toContain("recovered");
    expect(done).not.toContain("NOT complete");
    // ...and only now is the old backup rotated, into .bak.prev, not destroyed.
    expect(readFileSync(prev).equals(good)).toBe(true);
    expect(count(bak)).toBe(6 + 3000);
  });

  // test_no_backup_is_made_while_a_recovery_is_unfinished
  test("no backup is made while a recovery is unfinished", async () => {
    const w = world();
    await historyWorld(w);
    for (const slot of Object.values(backupPaths(w.storePath))) rmSync(slot, { force: true });
    corruptUsageLeaf(w.storePath); // the damaged file is the only copy now
    const e = await w.scanned("fresh.db", {
      recovery: {
        copyFile: () => {
          throw enospc();
        },
      },
    });
    await e.fullPass();
    expect(existsSync(backupPaths(w.storePath).bak)).toBe(false);
    expect(backup(e.store)).toBe(false);
  });
});

describe("backups", () => {
  // test_backup_is_daily_and_verified
  test("are daily", async () => {
    const w = world();
    const e = await w.scanned();
    const { bak } = backupPaths(w.storePath);
    expect(count(bak)).toBe(6);
    const stamp = statSync(bak).mtimeMs;
    appendFileSync(join(w.proj, "s1.jsonl"), claudeLine("7", "7", 10, 1));
    await e.fullPass();
    expect(statSync(bak).mtimeMs).toBe(stamp); // not again within the day
    age(bak);
    appendFileSync(join(w.proj, "s1.jsonl"), claudeLine("8", "8", 10, 1));
    await e.fullPass();
    expect(count(bak)).toBe(8); // refreshed once a day had passed
  });

  // test_backups_rotate_and_a_foreign_backup_is_merged_before_it_is_replaced
  test("rotate, and a foreign backup is merged before it is replaced", async () => {
    const w = world();
    const e = await w.scanned();
    const { bak, prev } = backupPaths(w.storePath);
    const first = readFileSync(bak);
    age(bak);
    appendFileSync(join(w.proj, "s1.jsonl"), claudeLine("7", "7", 10, 1));
    await e.fullPass();
    expect(readFileSync(prev).equals(first)).toBe(true); // rotated, not replaced
    expect(count(bak)).toBe(7);

    // A backup from another store lands in the slot (restored by hand, say).
    const otherPath = join(w.dir, "other", "tokenhud.db");
    const other = openStore(otherPath);
    other.upsert(history(50));
    backup(other);
    other.close();
    const foreign = readFileSync(backupPaths(otherPath).bak);
    writeFileSync(bak, foreign);
    age(bak);
    await e.fullPass();
    expect(readFileSync(bak).equals(foreign)).toBe(true); // held: its rows are not here yet
    await e.fullPass(); // the next pass merges it, then rotates
    expect(readFileSync(prev).equals(foreign)).toBe(true);
    expect(count(bak)).toBe(7 + 50);
    expect(storedRows(e.store).size).toBe(7 + 50); // its history is in every view
  });

  // test_a_key_scheme_migration_is_backed_up_at_once
  test("a key-scheme migration is backed up at once", async () => {
    const w = world();
    await (await w.scanned()).stop(); // the first pass took today's backup
    const { bak, prev } = backupPaths(w.storePath);
    expect(existsSync(prev)).toBe(false);
    exec(w.storePath, "UPDATE meta SET v = '1' WHERE k = 'key_scheme'"); // the same store, older scheme
    exec(bak, "UPDATE meta SET v = '1' WHERE k = 'key_scheme'");
    await (await w.scanned()).stop(); // migrates; the daily backup is not due, but is taken now
    expect(metaOf(bak, "key_scheme")).toBe("2");
    expect(metaOf(prev, "key_scheme")).toBe("1"); // the pre-migration backup is rotated, not lost
  });
});
