import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Capture } from "../../src/limits/capture.ts";
import {
  detectLimitEvents,
  type LimitEvent,
  readLimitEvents,
  recordCaptureEvents,
} from "../../src/limits/events.ts";
import { openStore, type Store } from "../../src/store/store.ts";
import { capture, cleanup, fakeRoot, tempDir } from "./helpers.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  cleanup();
});

const H = 3600;
const T0 = 1_780_000_000; // epoch seconds
const R1 = T0 + H; // the first 5-hour instance resets here
const R2 = R1 + 5 * H + 1800; // the next instance: started 30 min after R1
const W1 = T0 + 3 * 24 * H; // the weekly instance
const ms = (s: number) => Math.round(s * 1000);

function session(at: number, pct: number, resets: number): Capture {
  return capture("claude", at, { session: { pct, resets, label: "5-HOUR" } });
}

function openTempStore(): Store {
  const store = openStore(join(tempDir(), "tokenhud.db"));
  stores.push(store);
  return store;
}

describe("detectLimitEvents (pure)", () => {
  test("below every threshold: nothing", () => {
    const c = capture("claude", T0, {
      session: { pct: 99.9, resets: R1 },
      weekly_all: { pct: 79.9, resets: W1, label: "WEEKLY" },
    });
    expect(detectLimitEvents(c, [])).toEqual({ insert: [], resume: [] });
  });

  test("100 % is reached once per instance, also through reset-time jitter", () => {
    const first = detectLimitEvents(session(T0 + 600, 100, R1 + 0.28), []);
    expect(first).toEqual({
      insert: [
        {
          kind: "reached",
          window: "session",
          label: "5-HOUR",
          resetsAt: ms(R1 + 0.28),
          at: ms(T0 + 600),
        },
      ],
      resume: [],
    });
    const existing = [{ id: 1, resumedAt: null, ...first.insert[0] }] as never;
    expect(detectLimitEvents(session(T0 + 900, 101, R1 - 0.4), existing)).toEqual({
      insert: [],
      resume: [],
    });
  });

  test("80 % only for weekly windows, once per instance", () => {
    const c = capture("codex", T0, {
      codex_primary: { pct: 95, resets: R1, minutes: 300 },
      codex_secondary: { pct: 80, resets: W1, minutes: 10080 },
    });
    const { insert } = detectLimitEvents(c, []);
    expect(insert.map((e) => [e.kind, e.window, e.label])).toEqual([
      ["passed_80", "codex_secondary", "WEEKLY"],
    ]);
  });

  test("a capture taken at or after its own reset decides nothing", () => {
    expect(detectLimitEvents(session(R1, 100, R1), [])).toEqual({ insert: [], resume: [] });
    expect(detectLimitEvents(session(R1 + 5, 100, R1), [])).toEqual({ insert: [], resume: [] });
  });

  test("under 100 % in the same instance (no reset yet) does not resume", () => {
    const reached = [
      {
        id: 7,
        kind: "reached",
        window: "session",
        label: "5-HOUR",
        resetsAt: ms(R1),
        at: ms(T0),
        resumedAt: null,
      },
    ];
    expect(detectLimitEvents(session(T0 + 60, 97, R1), reached)).toEqual({
      insert: [],
      resume: [],
    });
  });
});

describe("events across window resets, through the store", () => {
  function run(store: Store, captures: Capture[]) {
    const root = fakeRoot("claude", "personal", "/home/x/.claude");
    return {
      root,
      changes: captures.map((c) => recordCaptureEvents(store, root, c)),
    };
  }

  function all(store: Store): LimitEvent[] {
    const db = new Database(store.path, { readonly: true, safeIntegers: true });
    try {
      return readLimitEvents(db, { from: 0, to: Number.MAX_SAFE_INTEGER });
    } finally {
      db.close();
    }
  }

  test("reached, then resumed by the first capture after the reset, each once", () => {
    const store = openTempStore();
    const { root, changes } = run(store, [
      session(T0, 50, R1),
      session(T0 + 600, 100, R1 + 0.3), // reached
      session(T0 + 900, 100, R1 - 0.4), // same instance: nothing
      session(R1 + 1800, 3, R2), // new instance below 100 %: resumed
      session(R1 + 2100, 4, R2), // nothing
    ]);
    expect(changes).toEqual([0, 1, 0, 2, 0]);
    const account = { id: root.identity, label: "personal", provider: "claude" };
    expect(all(store)).toEqual([
      {
        account,
        kind: "reached",
        window: "session",
        label: "5-HOUR",
        resets_at: ms(R1 + 0.3),
        at: ms(T0 + 600),
        resumed_at: ms(R1 + 1800),
      },
      {
        account,
        kind: "resumed",
        window: "session",
        label: "5-HOUR",
        resets_at: ms(R2),
        at: ms(R1 + 1800),
        resumed_at: null,
      },
    ]);
  });

  test("weekly: 80 % once per week, 100 % and resumed alongside the 5-hour window", () => {
    const store = openTempStore();
    const W2 = W1 + 7 * 24 * H;
    const weekly = (at: number, w: number, s: number, resets = W1) =>
      capture("claude", at, {
        session: { pct: s, resets: at < R1 ? R1 : R2, label: "5-HOUR" },
        weekly_all: { pct: w, resets, label: "WEEKLY" },
      });
    const { changes } = run(store, [
      weekly(T0, 79, 10),
      weekly(T0 + 60, 80, 20), // passed_80 (weekly)
      weekly(T0 + 120, 100, 100), // reached x2
      weekly(R1 + 1800, 100, 1), // 5-hour resumed; weekly still at 100 %
      weekly(W1 + 60, 2, 1, W2), // weekly resumed in its next instance
      weekly(W1 + 120, 81, 1, W2), // passed_80 again, new instance
    ]);
    expect(changes).toEqual([0, 1, 2, 2, 2, 1]);
    const events = all(store).map((e) => [e.kind, e.window, e.at, e.resumed_at]);
    expect(events).toEqual([
      ["passed_80", "weekly_all", ms(T0 + 60), null],
      ["reached", "session", ms(T0 + 120), ms(R1 + 1800)],
      ["reached", "weekly_all", ms(T0 + 120), ms(W1 + 60)],
      ["resumed", "session", ms(R1 + 1800), null],
      ["resumed", "weekly_all", ms(W1 + 60), null],
      ["passed_80", "weekly_all", ms(W1 + 120), null],
    ]);
  });

  test("replaying captures already seen changes nothing", () => {
    const store = openTempStore();
    const captures = [session(T0 + 600, 100, R1), session(R1 + 1800, 3, R2)];
    const root = fakeRoot("claude", "personal", "/home/x/.claude");
    for (const c of captures) recordCaptureEvents(store, root, c);
    const before = all(store);
    expect(captures.map((c) => recordCaptureEvents(store, root, c))).toEqual([0, 0]);
    expect(all(store)).toEqual(before);
  });

  test("an account with no usage yet is created; events filter by account and range", () => {
    const store = openTempStore();
    const a = fakeRoot("claude", "a", "/home/x/.claude-a");
    const b = fakeRoot("codex", "b", "/home/x/.codex");
    recordCaptureEvents(store, a, session(T0, 100, R1));
    recordCaptureEvents(
      store,
      b,
      capture("codex", T0 + 10, { codex_secondary: { pct: 90, resets: W1, minutes: 10080 } }),
    );
    expect([...store.accounts().values()].map((x) => [x.provider, x.label])).toEqual([
      ["claude", "a"],
      ["codex", "b"],
    ]);
    const db = new Database(store.path, { readonly: true, safeIntegers: true });
    expect(readLimitEvents(db, { from: 0, to: ms(T0 + 10) }).map((e) => e.account.label)).toEqual([
      "a",
    ]);
    expect(
      readLimitEvents(db, { from: 0, to: ms(T0 + 11) }, [b.identity]).map((e) => e.kind),
    ).toEqual(["passed_80"]);
    db.close();
  });

  test("a store without the events table (older schema) reads as none", () => {
    expect(readLimitEvents(new Database(":memory:"), { from: 0, to: 1 })).toEqual([]);
  });
});
