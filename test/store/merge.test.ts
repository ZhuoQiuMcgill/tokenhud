// The write rules of cc-usage's `Ledger.write`, ported from tests/test_ledger.py. Each
// test names the Python test it ports; the handoff lists the ones skipped and why.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  byCodePoint,
  openStore,
  type Store,
  type StoredRow,
  storedText,
  UNATTRIBUTED,
} from "../../src/store/store.ts";
import vectors from "../fixtures/store/key-vectors.json";
import { cleanup, HOUR, row, T0, tempDir, track } from "./helpers.ts";

afterEach(cleanup);

function fresh(): Store {
  return track(openStore(join(tempDir(), "tokenhud.db")));
}

function only(store: Store, key: bigint): StoredRow {
  const [stored, ...rest] = store.rows([key]);
  if (stored === undefined || rest.length > 0)
    throw new Error(`expected exactly one row for ${key}`);
  return stored;
}

const tokens = (r: StoredRow) => [r.inp, r.outp, r.cr, r.cc, r.e5, r.e1];
const modelName = (store: Store, r: StoredRow) => store.models().get(r.model);

describe("field-wise max merge", () => {
  // test_upsert_never_lowers_a_stored_value
  test("an upsert never lowers a stored value", () => {
    const store = fresh();
    const high = row(1n, { inp: 700, outp: 70, cr: 5000, cc: 40, e5: 30, e1: 10 });
    const low = row(1n, { inp: 0, outp: 0, cr: 0, cc: 0, e5: 0, e1: 0 });
    expect(store.upsert([high])).toBe(1);
    expect(store.upsert([low])).toBe(0);
    expect(tokens(only(store, 1n))).toEqual([700, 70, 5000, 40, 30, 10]);
    expect(store.upsert([row(1n, { inp: 800, outp: 60, cr: 5000, cc: 40, e5: 30, e1: 10 })])).toBe(
      1,
    );
    expect(tokens(only(store, 1n))).toEqual([800, 70, 5000, 40, 30, 10]); // field-wise max
    expect(store.rollupConsistent()).toBe(true);
  });

  // test_subbucket_null_and_zero_merge_like_the_parser
  test("a NULL sub-bucket is kept only while both sides lack it", () => {
    const store = fresh();
    const first = (key: bigint, e5: number | null, e1: number | null) =>
      row(key, { inp: 10, outp: 1, cr: 0, cc: 400, e5, e1 });
    // a later streaming line: more output, so the row updates
    const grown = (key: bigint, e5: number | null, e1: number | null) =>
      row(key, { inp: 10, outp: 99, cr: 0, cc: 400, e5, e1 });
    store.upsert([
      first(1n, null, null),
      first(2n, 300, 0),
      first(3n, null, null),
      first(4n, 500, 20),
    ]);
    store.upsert([
      grown(1n, 300, 100),
      grown(2n, null, null),
      grown(3n, null, null),
      grown(4n, 200, 90),
    ]);
    const stored = new Map(store.rows([1n, 2n, 3n, 4n]).map((r) => [r.key, [r.e5, r.e1]]));
    expect(stored).toEqual(
      new Map<bigint, (number | null)[]>([
        [1n, [300, 100]],
        [2n, [300, 0]],
        [3n, [null, null]],
        [4n, [500, 90]],
      ]),
    );
    expect(store.rollupConsistent()).toBe(true);
  });

  // test_ledger_rows_match_the_live_records (its NULL-vs-0 assertion)
  test("NULL and 0 sub-buckets are stored as written", () => {
    const store = fresh();
    store.upsert([row(1n, { e5: null, e1: null }), row(2n, { e5: 0, e1: 0 })]);
    expect([only(store, 1n).e5, only(store, 1n).e1]).toEqual([null, null]);
    expect([only(store, 2n).e5, only(store, 2n).e1]).toEqual([0, 0]);
  });

  // test_streaming_final_counts_stored_in_the_same_scan
  test("a streaming partial and its final line in one batch store the final count", () => {
    const store = fresh();
    const partial = row(1n, { inp: 1000, outp: 5, cc: 1200, e5: 1000, e1: 200 });
    const final = row(1n, { inp: 1000, outp: 500, cc: 1200, e5: 1000, e1: 200 });
    expect(store.upsert([partial, final])).toBe(1); // one key, inserted then raised
    expect(only(store, 1n).outp).toBe(500);
    expect([...store.keys()]).toEqual([1n]);
  });

  // test_streaming_final_counts_stored_in_a_later_scan
  test("a final count written later raises the stored row", () => {
    const store = fresh();
    store.upsert([row(9n, { inp: 900, outp: 7, e5: 0, e1: 0 })]);
    expect(only(store, 9n).outp).toBe(7);
    expect(store.upsert([row(9n, { inp: 900, outp: 1500, e5: 0, e1: 0, ts: T0 + 5000 })])).toBe(1);
    const stored = only(store, 9n);
    expect(stored.outp).toBe(1500);
    expect(stored.ts).toBe(T0); // the first-seen timestamp is kept
  });

  // test_resumed_copy_with_lower_counters_keeps_the_stored_max
  test("a resumed copy with zeroed counters never lowers the stored row", () => {
    const store = fresh();
    store.upsert([row(4n, { inp: 700, outp: 70, cr: 5000 })]);
    expect(store.upsert([row(4n, { inp: 0, outp: 0, cr: 0, cc: 0 })])).toBe(0);
    expect([only(store, 4n).inp, only(store, 4n).outp, only(store, 4n).cr]).toEqual([
      700, 70, 5000,
    ]);
  });

  // test_truncated_codex_rollout_is_not_counted_twice, test_rotated_transcript_is_not_counted_twice
  test("re-sending rows already stored changes nothing and counts nothing twice", () => {
    const store = fresh();
    const rows = [row(1n), row(2n, { outp: 5 }), row(3n, { model: UNATTRIBUTED })];
    expect(store.upsert(rows)).toBe(3);
    expect(store.upsert(rows)).toBe(0);
    expect(store.upsert([...rows].reverse())).toBe(0);
    expect([...store.keys()].length).toBe(3);
    expect(store.rollupConsistent()).toBe(true);
  });
});

describe("codex-unattributed", () => {
  // test_codex_unattributed_row_is_reattributed
  test("a resolved model replaces codex-unattributed, and the rollup follows", () => {
    const store = fresh();
    const codex = { provider: "codex", identity: "id-codex", label: "codex" };
    const unattributed = row(5n, { ...codex, model: UNATTRIBUTED, inp: 100, outp: 10, cr: 20 });
    store.upsert([unattributed]);
    expect(modelName(store, only(store, 5n))).toBe(UNATTRIBUTED);

    // Same counts, model now known: the row changes and moves to the model's bucket.
    expect(store.upsert([{ ...unattributed, model: "gpt-test" }])).toBe(1);
    expect(modelName(store, only(store, 5n))).toBe("gpt-test");
    expect(store.rollupConsistent()).toBe(true);

    // Never the reverse, and a known model is never replaced by another.
    expect(store.upsert([unattributed])).toBe(0);
    expect(store.upsert([{ ...unattributed, model: "gpt-other" }])).toBe(0);
    expect(modelName(store, only(store, 5n))).toBe("gpt-test");
    expect(tokens(only(store, 5n))).toEqual([100, 10, 20, 400, null, null]);
  });

  test("codex-unattributed is always interned, as cc-usage does", () => {
    const store = fresh();
    store.upsert([row(1n)]);
    expect([...store.models().values()]).toContain(UNATTRIBUTED);
  });
});

describe("tier", () => {
  test("tier merges by max and moves the row between rollup buckets", () => {
    const store = fresh();
    store.upsert([row(1n)]);
    expect(store.upsert([row(1n, { tier: 1 })])).toBe(1);
    expect(only(store, 1n).tier).toBe(1);
    expect(store.upsert([row(1n, { tier: 0 })])).toBe(0);
    expect(only(store, 1n).tier).toBe(1);
    expect(store.rollupConsistent()).toBe(true);
  });
});

describe("accounts", () => {
  // test_label_rename_keeps_one_account
  test("a label rename keeps one account and follows the latest write", () => {
    const store = fresh();
    const company = { identity: "id-company", label: "company" };
    store.upsert([row(5n, company), row(6n, { ...company, ts: T0 - 10 * HOUR })]);
    store.upsert([row(7n, { identity: "id-company", label: "work" })]);
    const accounts = [...store.accounts().values()];
    expect(accounts.map((a) => [a.provider, a.identity, a.label])).toEqual([
      ["claude", "id-company", "work"],
    ]);
    expect(store.rows([5n, 6n, 7n]).map((r) => r.acct)).toEqual([1, 1, 1]);
  });

  // test_unconfigured_root_falls_back_to_its_stored_label_without_merging (store half)
  test("the same label on another identity is another account", () => {
    const store = fresh();
    store.upsert([row(1n, { identity: "id-old", label: "company" })]);
    store.upsert([row(2n, { identity: "id-new", label: "company" })]);
    expect(store.accounts().size).toBe(2);
    expect(only(store, 1n).acct).not.toBe(only(store, 2n).acct);
  });

  test("the same identity under another provider is another account", () => {
    const store = fresh();
    store.upsert([row(1n, { provider: "claude", identity: "same" })]);
    store.upsert([row(2n, { provider: "codex", identity: "same" })]);
    expect(store.accounts().size).toBe(2);
  });

  test("within one batch the last label wins", () => {
    const store = fresh();
    store.upsert([row(1n, { label: "first" }), row(2n, { label: "second" })]);
    expect([...store.accounts().values()].map((a) => a.label)).toEqual(["second"]);
  });
});

describe("a key repeated in one batch", () => {
  // cc-usage sorts its parameter tuples by (key, account id, ts, model id), so the copy
  // whose account was interned first is inserted first and keeps its account, ts and
  // model; the counts merge by max. Observed with cc-usage's Ledger.write on these rows.
  test.each([
    ["x first", ["x", "y"], { identity: "x", ts: 5, model: "m-b" }],
    ["y first", ["y", "x"], { identity: "y", ts: 0, model: "m-a" }],
  ] as const)("%s", (_name, order, expected) => {
    const store = fresh();
    const copies = {
      x: row(7n, { identity: "x", label: "X", ts: T0 + 5, model: "m-b", outp: 1 }),
      y: row(7n, { identity: "y", label: "Y", ts: T0, model: "m-a", outp: 9 }),
    };
    store.upsert(order.map((name) => copies[name]));
    const stored = only(store, 7n);
    expect({
      identity: store.accounts().get(stored.acct)?.identity,
      ts: stored.ts - T0,
      model: modelName(store, stored),
    }).toEqual(expected);
    expect(stored.outp).toBe(9);
  });
});

describe("interning order, which decides the copy kept when a key repeats", () => {
  // Both cases were run through cc-usage's Ledger.write; the comments give what it kept.
  test("new accounts get ids in order of first appearance, across providers", () => {
    const store = fresh();
    store.upsert([
      row(1n, { provider: "codex", identity: "id-x", label: "X", model: "m" }),
      row(2n, {
        provider: "claude",
        identity: "id-b",
        label: "B",
        ts: T0 + 1,
        model: "m",
        outp: 2,
      }),
      row(2n, { provider: "codex", identity: "id-z", label: "Z", ts: T0 + 2, model: "m", outp: 3 }),
    ]);
    // cc-usage: (2, 'claude', 'id-b', ts +1, outp 3)
    const stored = only(store, 2n);
    const account = store.accounts().get(stored.acct);
    expect([account?.provider, account?.identity, stored.ts - T0, stored.outp]).toEqual([
      "claude",
      "id-b",
      1,
      3,
    ]);
  });

  test("new models get ids in code point order, as Python sorts str", () => {
    const store = fresh();
    // Same account and ts, so the model id breaks the tie.
    store.upsert([
      row(3n, { model: "m\u{10000}", outp: 1 }),
      row(3n, { model: "m\uffff", outp: 2 }),
    ]);
    // cc-usage: model 'm\uffff', outp 2. In UTF-16 order U+10000 would sort first and win.
    const stored = only(store, 3n);
    expect([modelName(store, stored), stored.outp]).toEqual(["m\uffff", 2]);
  });

  test("byCodePoint orders astral characters after the whole BMP", () => {
    const names = ["m\u{10000}", "m\uffff", "m", "codex-unattributed", "m\ud7ff"];
    expect(names.sort(byCodePoint)).toEqual([
      "codex-unattributed",
      "m",
      "m\ud7ff",
      "m\uffff",
      "m\u{10000}",
    ]);
  });
});

describe("text SQLite cannot store", () => {
  test.each(vectors.text.map((t) => [t.name, t.input, t.stored] as const))(
    "storedText matches cc-usage's _text: %s",
    (_name, input, stored) => {
      expect(storedText(input)).toBe(stored);
    },
  );

  // test_lone_surrogates_do_not_stop_the_scan_or_the_ledger
  test("lone surrogates are stored as cc-usage's _text stores them", () => {
    const store = fresh();
    const odd = vectors.text.find((t) => t.name === "lone high");
    const lone = vectors.text.find((t) => t.name === "lone low");
    if (odd === undefined || lone === undefined) throw new Error("fixture changed");
    const rows = [row(1n, { model: odd.input, label: lone.input }), row(2n, { identity: "other" })];
    expect(store.upsert(rows)).toBe(2);
    expect(modelName(store, only(store, 1n))).toBe(odd.stored);
    expect(store.accounts().get(only(store, 1n).acct)?.label).toBe(lone.stored);
    // The same raw name interns to the same model next time.
    store.upsert([row(3n, { model: odd.input })]);
    expect(only(store, 3n).model).toBe(only(store, 1n).model);
  });
});
