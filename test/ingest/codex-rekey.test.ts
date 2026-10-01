// The Codex re-key (key scheme 1 -> 2): a store whose Codex rows were written under scheme
// 1 must end up exactly as a fresh scheme-2 ingest of the same rollouts, with the rows of
// deleted rollouts kept as they were.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { walk } from "../../src/ingest/files.ts";
import { extractCodexV1 } from "../../src/sources/codex.ts";
import { comparePyPaths } from "../../src/sources/pypath.ts";
import { importCcUsage } from "../../src/store/import-cc-usage.ts";
import { openStore, type UsageRow } from "../../src/store/store.ts";
import { codexRoot, materialize, openCodexEngine } from "../sources/codex-helpers.ts";
import { cleanup, storedRows, tempDir } from "./helpers.ts";

afterEach(cleanup);

const ORPHAN = 4242n;

/** Content of every row, without the store-local account id. */
function content(rows: ReturnType<typeof storedRows>) {
  return new Map([...rows].map(([key, { acct: _acct, ...row }]) => [key, row]));
}

/** Rewrites the store at `path` back to key scheme 1 with no re-key pending. */
function asSchemeOne(path: string): void {
  const db = new Database(path);
  db.exec("UPDATE meta SET v = '1' WHERE k = 'key_scheme'");
  db.exec("DELETE FROM meta WHERE k IN ('codex_rekey', 'migration_report')");
  db.close();
}

/**
 * A store as cc-usage's ledger (or a scheme-1 tokenhud) would hold the rollouts of `home`:
 * every scheme-1 record at tier 0, plus a row whose rollout is gone, and a Claude row.
 */
function schemeOneStore(home: string, identity: string): string {
  const path = join(tempDir(), "tokenhud.db");
  const store = openStore(path);
  const account = { provider: "codex", identity, label: "codex", derivedLabel: true };
  const files = [
    ...walk(join(home, "sessions")).files,
    ...walk(join(home, "archived_sessions")).files,
  ];
  const rows: UsageRow[] = [];
  for (const file of files.sort((a, b) => comparePyPaths(a, b))) {
    for (const e of extractCodexV1(file)) {
      const post = e.post;
      if (post === null || e.ts === null || !Number.isSafeInteger(post.inp)) continue;
      rows.push({ key: e.key, ...account, ts: e.ts, model: e.model, ...post, tier: 0 });
    }
  }
  const orphan = {
    key: ORPHAN,
    ...account,
    ts: Date.parse("2026-06-01T00:00:00Z"),
    model: "gpt-test",
  };
  rows.push({ ...orphan, inp: 5, outp: 5, cr: 0, cc: 0, e5: 0, e1: 0, tier: 0 });
  rows.push({
    key: 77n,
    provider: "claude",
    identity: "id-claude",
    label: "personal",
    ts: Date.parse("2026-06-01T00:00:00Z"),
    model: "claude-opus-4-8",
    inp: 1,
    outp: 2,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
  });
  store.upsert(rows);
  store.close();
  asSchemeOne(path);
  return path;
}

/** The identity the engine gives the Codex home `home` (from a throwaway engine). */
async function identityOf(home: string): Promise<string> {
  const probe = openCodexEngine([home]);
  await probe.fullPass();
  return codexRoot(probe, home).identity;
}

describe("the key-scheme step", () => {
  test("opening a scheme-1 store marks its Codex accounts for the re-key and keeps every row", () => {
    const home = materialize();
    const path = schemeOneStore(home, "id-codex");
    const before = new Database(path, { readonly: true, safeIntegers: true });
    const count = before.query("SELECT count(*) AS n FROM usage").get() as { n: bigint };
    before.close();
    const store = openStore(path);
    expect(store.keySchemeMigrated).toBe(true);
    expect(store.meta.keyScheme).toBe(2);
    expect(store.meta.codexRekeyPending).toEqual(["id-codex"]);
    expect(BigInt([...store.keys()].length)).toBe(count.n);
    store.close();
  });

  test("an import of cc-usage's ledger marks the imported Codex accounts", () => {
    const store = openStore(join(tempDir(), "tokenhud.db"));
    const outcome = importCcUsage(
      store,
      join(import.meta.dir, "../fixtures/store/cc-usage-ledger.sqlite3"),
    );
    expect(outcome.status).toBe("imported");
    const codex = [...store.accounts().values()].filter((a) => a.provider === "codex");
    expect(codex.length).toBeGreaterThan(0);
    expect(store.meta.codexRekeyPending.sort()).toEqual(codex.map((a) => a.identity).sort());
    store.close();
  });
});

describe("the re-key pass", () => {
  test("ends equal to a fresh scheme-2 ingest; rows of deleted rollouts stay; a rerun changes nothing", async () => {
    const home = materialize();
    const fresh = openCodexEngine([home]);
    await fresh.fullPass();
    const identity = codexRoot(fresh, home).identity;
    const want = content(storedRows(fresh.store));

    const storePath = schemeOneStore(home, identity);
    const engine = openCodexEngine([home], { storePath });
    expect(engine.store.meta.codexRekeyPending).toEqual([identity]);
    const report = await engine.fullPass();
    const got = content(storedRows(engine.store));

    // The orphan and the Claude row are untouched; everything else is the fresh ingest.
    expect(got.get(ORPHAN)).toMatchObject({ inp: 5, outp: 5, tier: 0, model: "gpt-test" });
    expect(got.get(77n)).toMatchObject({ inp: 1, outp: 2, identity: "id-claude" });
    got.delete(ORPHAN);
    got.delete(77n);
    for (const row of [...got.values(), ...want.values()]) {
      delete (row as { label?: string }).label;
    }
    expect(got).toEqual(want);
    expect(engine.store.meta.codexRekeyPending).toEqual([]);
    expect(engine.store.rollupConsistent()).toBe(true);

    // 9 replayed rows deleted; 2 rows of the parent move to tier 1 (its priority
    // settings); nothing new; the orphan is the one row left as it was.
    const account = report?.rekey?.accounts.find((a) => a.identity === identity);
    expect(account).toMatchObject({ deleted: 9, changed: 2, inserted: 0, untouched: 1 });
    expect(engine.store.meta.migrationReport).toEqual(report?.rekey);

    // The same re-key again (as a second import would ask): nothing changes.
    engine.close();
    const store = openStore(storePath);
    store.importRows([], [], [], { at: "x", source: "test", lineage: null, rows: 0, accounts: 0 }, [
      identity,
    ]);
    store.close();
    const again = openCodexEngine([home], { storePath });
    const second = await again.fullPass();
    expect(second?.rekey?.accounts[0]).toMatchObject({
      deleted: 0,
      changed: 0,
      inserted: 0,
      untouched: 1,
    });
    expect(second?.event).toBeNull();
    const after = content(storedRows(again.store));
    for (const row of after.values()) delete (row as { label?: string }).label;
    expect(after.size).toBe(want.size + 2);
  });

  test("values that went down are replaced, not max-merged; cursors are read again from 0", async () => {
    const home = materialize();
    const fresh = openCodexEngine([home]);
    await fresh.fullPass();
    const identity = codexRoot(fresh, home).identity;
    const found = [...storedRows(fresh.store)].find(([, r]) => r.inp > 0);
    if (found === undefined) throw new Error("fixture changed");
    const [key, row] = found;
    const cache = join(tempDir(), "cache.db");

    // A store and cache as an earlier tokenhud left them: cursors at the end of every file,
    // and one row higher than its rollout says (scheme 1's max kept it).
    const storePath = schemeOneStore(home, identity);
    const first = openCodexEngine([home], { storePath, cachePath: cache });
    await first.fullPass();
    first.close();
    const raised = openStore(storePath);
    raised.upsert([
      {
        key,
        provider: "codex",
        identity,
        label: "codex",
        ts: row.ts,
        model: row.model as string,
        inp: row.inp + 1000,
        outp: row.outp,
        cr: row.cr,
        cc: 0,
        e5: 0,
        e1: 0,
        tier: row.tier,
      },
    ]);
    raised.close();
    asSchemeOne(storePath);

    const engine = openCodexEngine([home], { storePath, cachePath: cache });
    const report = await engine.fullPass();
    expect(report?.roots[0]?.read).toBe(report?.roots[0]?.files); // every rollout again
    expect(storedRows(engine.store).get(key)?.inp).toBe(row.inp);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable rollout keeps the account pending",
    async () => {
      const home = materialize();
      const identity = await identityOf(home);
      const storePath = schemeOneStore(home, identity);
      const locked = walk(join(home, "sessions")).files[0] as string;
      chmodSync(locked, 0o000);
      try {
        const engine = openCodexEngine([home], { storePath });
        const report = await engine.fullPass();
        expect(report?.rekey).not.toBeNull();
        expect(engine.store.meta.codexRekeyPending).toEqual([identity]);
      } finally {
        chmodSync(locked, 0o644);
      }
    },
  );

  test("an account whose Codex home is not scanned stays pending", async () => {
    const home = materialize();
    const elsewhere = join(tempDir(), ".codex");
    mkdirSync(join(elsewhere, "sessions"), { recursive: true });
    copyFileSync(
      walk(join(home, "sessions")).files[0] as string,
      join(elsewhere, "sessions", "x.jsonl"),
    );
    const identity = await identityOf(home);
    const storePath = schemeOneStore(home, identity);
    const engine = openCodexEngine([elsewhere], { storePath });
    await engine.fullPass();
    expect(engine.store.meta.codexRekeyPending).toEqual([identity]);
  });
});
