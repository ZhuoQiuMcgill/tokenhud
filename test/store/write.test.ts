// Store.write: removals and replacing writes (the Codex re-key), plus the re-key's meta.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore, type Store, UNATTRIBUTED } from "../../src/store/store.ts";
import { cleanup, HOUR, row, T0, tempDir, track } from "./helpers.ts";

afterEach(cleanup);

const open = (): Store => track(openStore(join(tempDir(), "tokenhud.db")));
const codex = { provider: "codex", identity: "id-codex", label: "codex" };

function byKey(store: Store) {
  const models = store.models();
  const accounts = store.accounts();
  return new Map(
    store
      .rows([...store.keys()])
      .map((r) => [
        r.key,
        { ...r, model: models.get(r.model), identity: accounts.get(r.acct)?.identity },
      ]),
  );
}

describe("write", () => {
  test("remove deletes the keys that exist and reports how many", () => {
    const store = open();
    store.upsert([row(1n), row(2n), row(3n, { ts: T0 + HOUR })]);
    expect(store.write({ remove: [1n, 3n, 99n] })).toEqual({ removed: 2, changed: 0 });
    expect([...store.keys()]).toEqual([2n]);
    expect(store.rollupConsistent()).toBe(true);
  });

  test("replace takes the given counts and tier, even lower; keeps account and timestamp", () => {
    const store = open();
    store.upsert([
      row(1n, { ...codex, model: "gpt-a", inp: 500, outp: 50, cr: 9, e5: 0, e1: 0, tier: 1 }),
    ]);
    const changed = store.write({
      replace: [
        row(1n, {
          provider: "codex",
          identity: "id-other",
          label: "x",
          ts: T0 + 2 * HOUR,
          model: "gpt-b",
          inp: 400,
          outp: 40,
          cr: 0,
          cc: 0,
          e5: 0,
          e1: 0,
          tier: 0,
        }),
        row(2n, { ...codex, model: "gpt-a", inp: 7 }),
      ],
    });
    expect(changed).toEqual({ removed: 0, changed: 2 });
    const rows = byKey(store);
    expect(rows.get(1n)).toMatchObject({
      inp: 400,
      outp: 40,
      cr: 0,
      tier: 0,
      model: "gpt-b",
      identity: "id-codex",
      ts: T0,
    });
    expect(rows.get(2n)).toMatchObject({ inp: 7, identity: "id-codex" });
    expect(store.rollupConsistent()).toBe(true);
  });

  test("replace never trades a model for codex-unattributed, and an equal row is no change", () => {
    const store = open();
    const stored = row(1n, { ...codex, model: "gpt-a" });
    store.upsert([stored]);
    expect(store.write({ replace: [{ ...stored, model: UNATTRIBUTED }] }).changed).toBe(0);
    expect(store.write({ replace: [stored] }).changed).toBe(0);
    expect(byKey(store).get(1n)?.model).toBe("gpt-a");
  });

  test("remove, replace and upsert apply in one transaction, with the re-key's meta", () => {
    const store = open();
    store.upsert([row(1n), row(2n, codex)]);
    store.importRows([], [], [], { at: "t", source: "x", lineage: null, rows: 0, accounts: 0 }, [
      "id-codex",
      "id-gone",
    ]);
    expect(store.meta.codexRekeyPending).toEqual(["id-codex", "id-gone"]);
    const report = { scheme: 2, at: "t", accounts: [] };
    store.write({
      remove: [2n],
      upsert: [row(1n, { outp: 9 })],
      rekeyed: ["id-codex"],
      migrationReport: report,
    });
    expect(store.meta.codexRekeyPending).toEqual(["id-gone"]);
    expect(store.meta.migrationReport).toEqual(report);
    expect(byKey(store).get(1n)?.outp).toBe(9);
    expect([...store.keys()]).toEqual([1n]);
  });

  test("an empty batch writes nothing", () => {
    const store = open();
    expect(store.write({})).toEqual({ removed: 0, changed: 0 });
    expect(store.meta.migrationReport).toBeNull();
  });
});
