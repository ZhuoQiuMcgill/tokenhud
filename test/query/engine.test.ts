// The query engine on small stores with hand-computed costs. Rates come from the bundled
// table: claude-opus-4-8 $5/$25 (cache read 0.1x, writes 1.25x/2x input); gpt-5.5
// $5/$30, cache read $0.50, long context above 272k at 2x input and 1.5x output, fast
// $12.50/$75 with no long-context price; gpt-5.6-sol $5/$30 until 2026-08-21T07:00Z,
// then $4/$20.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mergePricing } from "../../src/pricing/overrides.ts";
import { parseModelPricing } from "../../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { type QueryOptions, UsageQueries } from "../../src/query/engine.ts";
import {
  emptyStoreDatabase,
  openStore,
  openStoreReader,
  type UsageRow,
} from "../../src/store/store.ts";
import { guard } from "../guard.ts";
import { cleanup, tempDir } from "../store/helpers.ts";

guard();

afterEach(cleanup);

const at = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;
const bundled = () => new PriceTable(bundledPricing().models);
let nextKey = 1n;

function row(over: Partial<UsageRow>): UsageRow {
  return {
    key: nextKey++,
    provider: "claude",
    identity: "fake-identity-a",
    label: "alpha",
    ts: at("2026-09-30T14:10:00Z"),
    model: "claude-opus-4-8",
    inp: 0,
    outp: 0,
    cr: 0,
    cc: 0,
    e5: null,
    e1: null,
    tier: 0,
    ...over,
  };
}

const codex = { provider: "codex", identity: "fake-identity-c", label: "gamma" };

/** A store holding `rows`, and a read-only engine over it. */
function engine(rows: UsageRow[], options: QueryOptions = {}, prices = bundled()) {
  const path = join(tempDir(), "tokenhud.db");
  const store = openStore(path);
  if (rows.length > 0) store.upsert(rows);
  store.close();
  const db = openStoreReader(path) as Database;
  const q = new UsageQueries(db, prices, { tz: "UTC", ...options });
  return { q, db, path };
}

describe("cost", () => {
  test("a Claude row with 5m/1h cache writes", () => {
    // 1000 * 5 + 1000 * 25 + 10000 * 0.5 + 1000 * 6.25 + 1000 * 10, per 1M = 0.05125
    const { q, db } = engine([
      row({ inp: 1000, outp: 1000, cr: 10_000, cc: 2000, e5: 1000, e1: 1000 }),
    ]);
    const totals = q.totals();
    expect(totals.usage.cost).toBeCloseTo(0.05125, 12);
    expect(totals.usage.tokens).toEqual({
      input: 1000,
      output: 1000,
      cacheRead: 10_000,
      cacheWrite: 2000,
      total: 14_000,
    });
    expect(totals.usage.records).toBe(1);
    db.close();
  });

  test("creation without 5m/1h buckets is priced at the 1.25x fallback", () => {
    // Fallback: 2000 * 6.25 = 0.0125. With buckets: 1000 * 6.25 + 1000 * 10 = 0.01625.
    // Half-NULL (5m only): 1000 * 6.25 = 0.00625.
    const { q, db } = engine([
      row({ cc: 2000 }),
      row({ cc: 2000, e5: 1000, e1: 1000 }),
      row({ cc: 1000, e5: 1000 }),
    ]);
    expect(q.totals().usage.cost).toBeCloseTo(0.0125 + 0.01625 + 0.00625, 12);
    db.close();
  });

  test("a long-context row is priced alone, its hour's other rows at base rates", () => {
    // Long: 100k + 200k > 272k: 100000 * 10 + 1000 * 45 + 200000 * 1 = 1.245.
    // Short: 1000 * 5 + 1000 * 30 + 1000 * 0.5 = 0.0355.
    const { q, db } = engine([
      row({ ...codex, model: "gpt-5.5", inp: 100_000, outp: 1000, cr: 200_000 }),
      row({ ...codex, model: "gpt-5.5", inp: 1000, outp: 1000, cr: 1000 }),
    ]);
    const hour = { from: at("2026-09-30T14:00:00Z"), to: at("2026-09-30T15:00:00Z") };
    expect(q.totals({ range: hour }).usage.cost).toBeCloseTo(1.2805, 12);
    // The same rows through the raw path (a range that isn't hour-aligned).
    expect(q.totals({ range: { from: hour.from + 1, to: hour.to } }).usage.cost).toBeCloseTo(
      1.2805,
      12,
    );
    db.close();
  });

  test("fast long context without a price is unpriced-tier, the rest of the tier priced", () => {
    // Fast short row: 1000 * 12.5 + 1000 * 75 = 0.0875. The long one has no price.
    const { q, db } = engine([
      row({ ...codex, model: "gpt-5.5", tier: 1, inp: 100_000, outp: 1000, cr: 200_000 }),
      row({ ...codex, model: "gpt-5.5", tier: 1, inp: 1000, outp: 1000 }),
    ]);
    const [fast] = q.byModel();
    expect(fast?.tier).toBe("fast");
    expect(fast?.status).toBe("partial");
    expect(fast?.usage.cost).toBeCloseTo(0.0875, 12);
    expect(fast?.usage.coverage.unpricedTierTokens).toBe(301_000);
    expect(q.totals().unpriced).toEqual([
      { model: "gpt-5.5", tier: "fast", reason: "unpriced-tier", tokens: 301_000 },
    ]);
    db.close();
  });

  test("each hour is priced at the card in effect then", () => {
    // 200k input tokens a minute either side of Sol's 2026-08-21T07:00Z cut: $1 + $0.80.
    const { q, db } = engine([
      row({ ...codex, model: "gpt-5.6-sol", inp: 200_000, ts: at("2026-08-21T06:59:00Z") }),
      row({ ...codex, model: "gpt-5.6-sol", inp: 200_000, ts: at("2026-08-21T07:01:00Z") }),
    ]);
    expect(q.totals().usage.cost).toBeCloseTo(1.8, 12);
    const day = { from: at("2026-08-21T00:00:00Z"), to: at("2026-08-22T00:00:00Z") };
    const [only, ...rest] = q.byDay({ range: day });
    expect(only?.usage.cost).toBeCloseTo(1.8, 12);
    expect(rest).toEqual([]);
    db.close();
  });

  test("a price change inside an hour reads that hour's rows one by one", () => {
    const prices = new PriceTable(
      mergePricing(bundledPricing().models, {
        "claude-opus-4-8": parseModelPricing(
          {
            periods: [
              { from: null, card: { input: 5, output: 25 } },
              { from: "2026-09-30T14:30:00Z", card: { input: 3, output: 15 } },
            ],
          },
          "test",
          { coerce: false },
        ),
      }),
    );
    const { q, db } = engine(
      [
        row({ inp: 1_000_000, ts: at("2026-09-30T14:29:59.999Z") }),
        row({ inp: 1_000_000, ts: at("2026-09-30T14:30:00Z") }),
      ],
      {},
      prices,
    );
    expect(q.totals().usage.cost).toBeCloseTo(8, 12);
    expect(
      q.totals({ range: { from: at("2026-09-30T00:00:00Z"), to: at("2026-10-01T00:00:00Z") } })
        .usage.cost,
    ).toBeCloseTo(8, 12);
    db.close();
  });

  test("unpriced models count tokens, never cost", () => {
    const { q, db } = engine([
      row({ model: "claude-mystery-9", inp: 500 }),
      row({ inp: 1_000_000 }),
    ]);
    const totals = q.totals();
    expect(totals.usage.cost).toBeCloseTo(5, 12);
    expect(totals.usage.coverage).toEqual({
      pricedTokens: 1_000_000,
      unpricedTokens: 500,
      unpricedTierTokens: 0,
      estimatedTokens: 0,
      pricedShare: 1_000_000 / 1_000_500,
    });
    expect(totals.unpriced).toEqual([
      { model: "claude-mystery-9", tier: "standard", reason: "unpriced", tokens: 500 },
    ]);
    db.close();
  });
});

describe("groupings", () => {
  const rows = () => [
    row({ inp: 1_000_000, ts: at("2026-09-29T10:00:00Z") }),
    row({ model: "claude-opus-4-8-20260101", inp: 1_000_000, ts: at("2026-09-30T10:00:00Z") }),
    row({ model: "claude-haiku-4-5", inp: 1_000_000, ts: at("2026-09-30T11:00:00Z") }),
    // 200k + 300k output: under the long-context threshold, which counts input and cache reads.
    row({
      ...codex,
      model: "gpt-5.5",
      inp: 200_000,
      outp: 300_000,
      ts: at("2026-09-30T12:00:00Z"),
    }),
  ];

  test("byModel merges ids that normalise alike and shows current rates", () => {
    const { q, db } = engine(rows());
    const models = q.byModel();
    expect(models.map((m) => [m.model, m.tier, m.usage.cost, m.status])).toEqual([
      ["claude-opus-4-8", "standard", 10, "priced"],
      ["gpt-5.5", "standard", 10, "priced"],
      ["claude-haiku-4-5", "standard", 1, "priced"],
    ]);
    expect(models[0]?.share).toBeCloseTo(10 / 21, 12);
    expect(models[0]?.rates).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      longContext: null,
      estimated: false,
    });
    expect(models[1]?.rates?.longContext).toEqual({
      threshold: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    });
    db.close();
  });

  test("byAccount lists every account, idle ones too, and filters by account and provider", () => {
    const { q, db } = engine([
      ...rows(),
      row({ identity: "fake-identity-b", label: "beta", ts: at("2025-01-01T00:00:00Z") }),
    ]);
    const all = q.byAccount({
      period: "today",
      ...{ range: { from: at("2026-09-30T00:00:00Z"), to: at("2026-10-01T00:00:00Z") } },
    });
    expect(all.map((a) => [a.account.label, a.usage.cost])).toEqual([
      ["gamma", 10],
      ["alpha", 6],
      ["beta", 0],
    ]);
    const ids = new Map(q.accountList().map((a) => [a.label, a.id]));
    expect(q.totals({ accounts: [ids.get("alpha") as number] }).usage.cost).toBe(11);
    expect(q.totals({ providers: ["codex"] }).usage.cost).toBe(10);
    expect(q.byAccount({ providers: ["codex"] }).map((a) => a.account.label)).toEqual(["gamma"]);
    db.close();
  });

  test("byDay, byWeek and byMonth in the viewer's zone, with each day's top model", () => {
    const { q, db } = engine(rows(), { tz: "America/Toronto" });
    const range = { from: at("2026-09-28T04:00:00Z"), to: at("2026-10-05T04:00:00Z") };
    const days = q.byDay({ range });
    expect(days.map((d) => [d.key, d.usage.cost, d.topModel])).toEqual([
      ["2026-09-28", 0, null],
      ["2026-09-29", 5, "claude-opus-4-8"],
      ["2026-09-30", 16, "gpt-5.5"],
      ["2026-10-01", 0, null],
      ["2026-10-02", 0, null],
      ["2026-10-03", 0, null],
      ["2026-10-04", 0, null],
    ]);
    expect(q.byWeek({ range }).map((w) => [w.key, w.usage.cost])).toEqual([["2026-09-28", 21]]);
    expect(q.byMonth({ range }).map((m) => [m.key, m.usage.cost])).toEqual([
      ["2026-09", 21],
      ["2026-10", 0],
    ]);
    db.close();
  });

  test("days in a +05:30 zone split hours at :30", () => {
    // Midnight in Kolkata is 18:30Z, inside an hour bucket: rows either side of it.
    const { q, db } = engine(
      [
        row({ inp: 1_000_000, ts: at("2026-09-29T18:29:59.999Z") }),
        row({ inp: 2_000_000, ts: at("2026-09-29T18:30:00Z") }),
        row({ inp: 4_000_000, ts: at("2026-09-29T18:59:59.999Z") }),
      ],
      { tz: "Asia/Kolkata" },
    );
    const days = q.byDay({
      range: { from: at("2026-09-28T18:30:00Z"), to: at("2026-09-30T18:30:00Z") },
    });
    expect(days.map((d) => [d.key, d.usage.cost, d.usage.records])).toEqual([
      ["2026-09-29", 5, 1],
      ["2026-09-30", 30, 2],
    ]);
    db.close();
  });

  test("activity buckets, sub-hour and hourly", () => {
    const { q, db } = engine([
      row({ inp: 1_000_000, ts: at("2026-09-30T10:05:00Z") }),
      row({ inp: 1_000_000, ts: at("2026-09-30T10:25:00Z") }),
      row({ inp: 1_000_000, ts: at("2026-09-30T11:59:59.999Z") }),
    ]);
    const range = { from: at("2026-09-30T10:00:00Z"), to: at("2026-09-30T12:00:00Z") };
    expect(q.activity({ range, buckets: 6 }).buckets.map((b) => b.cost)).toEqual([
      5, 5, 0, 0, 0, 5,
    ]);
    expect(
      q.activity({ range, buckets: 2 }).buckets.map((b) => [b.range.from, b.cost, b.tokens]),
    ).toEqual([
      [range.from, 10, 2_000_000],
      [range.from + HOUR, 5, 1_000_000],
    ]);
    expect(() => q.activity({ range, buckets: 0 })).toThrow(RangeError);
    db.close();
  });

  test("pace is per hour over the last minutes, per account", () => {
    const now = at("2026-09-30T14:30:00Z");
    const { q, db } = engine(
      [
        row({ inp: 1_000_000, ts: now - 10 * 60_000 }),
        row({ inp: 1_000_000, ts: now - 40 * 60_000 }), // outside 30 minutes
        row({ ...codex, model: "gpt-5.5", inp: 100_000, ts: now }),
      ],
      { now: () => now },
    );
    const pace = q.pace();
    expect(pace.minutes).toBe(30);
    expect(
      pace.accounts.map((a) => [a.account.label, a.cost, a.costPerHour, a.tokensPerHour]),
    ).toEqual([
      ["alpha", 5, 10, 2_000_000],
      ["gamma", 0.5, 1, 200_000],
    ]);
    db.close();
  });

  test("accounts report their first and last usage", () => {
    const { q, db } = engine(rows());
    expect(q.accounts().map((a) => [a.label, a.firstSeen, a.lastSeen])).toEqual([
      ["alpha", at("2026-09-29T10:00:00Z"), at("2026-09-30T11:00:00Z")],
      ["gamma", at("2026-09-30T12:00:00Z"), at("2026-09-30T12:00:00Z")],
    ]);
    db.close();
  });
});

describe("caching", () => {
  test("another connection's commit is seen at the next query", () => {
    const { q, db, path } = engine([row({ inp: 1_000_000 })]);
    expect(q.totals().usage.cost).toBe(5);
    expect(q.byDay().map((d) => d.usage.cost)).toEqual([5]);
    const store = openStore(path);
    store.upsert([row({ inp: 1_000_000, ts: at("2026-09-30T14:20:00Z") })]);
    store.close();
    expect(q.totals().usage.cost).toBe(10);
    db.close();
  });

  test("without autoInvalidate, only invalidated ranges are re-read", () => {
    const { q, db, path } = engine([row({ inp: 1_000_000 })], { autoInvalidate: false });
    const day = { from: at("2026-09-30T00:00:00Z"), to: at("2026-10-01T00:00:00Z") };
    expect(q.totals({ range: day }).usage.cost).toBe(5);
    const store = openStore(path);
    store.upsert([row({ inp: 1_000_000, ts: at("2026-09-30T14:20:00Z") })]);
    store.close();
    expect(q.totals({ range: day }).usage.cost).toBe(5);
    q.invalidate({ from: at("2026-09-30T14:20:00Z"), to: at("2026-09-30T14:20:00Z") + 1 });
    expect(q.totals({ range: day }).usage.cost).toBe(10);
    db.close();
  });

  test("a new account or model written after the first query is named", () => {
    const { q, db, path } = engine([row({ inp: 1 })]);
    q.totals();
    const store = openStore(path);
    store.upsert([row({ ...codex, model: "gpt-5.5", inp: 1_000_000 })]);
    store.close();
    expect(q.byModel().map((m) => m.model)).toEqual(["gpt-5.5", "claude-opus-4-8"]);
    expect(q.byAccount().map((a) => a.account.label)).toEqual(["gamma", "alpha"]);
    db.close();
  });
});

describe("an empty store", () => {
  test("answers zeros", () => {
    const db = emptyStoreDatabase();
    const q = new UsageQueries(db, bundled(), { tz: "UTC" });
    const totals = q.totals();
    expect(totals.range).toEqual({ from: 0, to: 0 });
    expect(totals.usage.cost).toBe(0);
    expect(totals.usage.coverage.pricedShare).toBe(1);
    expect(q.byDay()).toEqual([]);
    expect(q.byModel()).toEqual([]);
    expect(q.byAccount()).toEqual([]);
    expect(q.accounts()).toEqual([]);
    expect(q.activity({ period: "24h", buckets: 4 }).buckets.map((b) => b.cost)).toEqual([
      0, 0, 0, 0,
    ]);
    db.close();
  });
});

/** The bundled table with `periods` (model -> [from, input, output][]) replacing models. */
function withPeriods(periods: Record<string, Array<[string | null, number, number]>>): PriceTable {
  const overrides = Object.fromEntries(
    Object.entries(periods).map(([model, list]) => [
      model,
      parseModelPricing(
        { periods: list.map(([from, input, output]) => ({ from, card: { input, output } })) },
        model,
        { coerce: false },
      ),
    ]),
  );
  return new PriceTable(mergePricing(bundledPricing().models, overrides));
}

describe("critique regressions", () => {
  const sumCost = (buckets: readonly { cost: number }[]) => buckets.reduce((s, b) => s + b.cost, 0);
  const sumTokens = (buckets: readonly { tokens: number }[]) =>
    buckets.reduce((s, b) => s + b.tokens, 0);

  // B1: the row cache's bound evicted hours the running query needed, and dropped their rows.
  test("a query over more raw hours than the row cache holds counts every row", () => {
    const start = at("2026-01-01T00:00:00Z");
    const hours = 6000;
    // One row per hour, 6,000 input tokens of Opus 4.8 at $5/M: $0.03 each.
    const rows = Array.from({ length: hours }, (_, h) =>
      row({ inp: 6000, ts: start + h * HOUR + 10 * 60_000 }),
    );
    const { q, db } = engine(rows, { maxCachedRows: 100, autoInvalidate: false });
    const last24 = { from: start + (hours - 24) * HOUR, to: start + hours * HOUR };
    const all = { from: start, to: start + hours * HOUR };
    for (let round = 0; round < 2; round++) {
      // 20-minute buckets: every hour is read from raw rows.
      const day = q.activity({ range: last24, buckets: 72 }).buckets;
      expect(sumCost(day)).toBeCloseTo(0.72, 9);
      expect(sumTokens(day)).toBe(24 * 6000);
      const wide = q.activity({ range: all, buckets: hours * 2 }).buckets;
      expect(sumCost(wide)).toBeCloseTo(180, 9);
      expect(sumTokens(wide)).toBe(hours * 6000);
      expect(wide.filter((b) => b.tokens > 0)).toHaveLength(hours);
    }
    db.close();
  });

  // B2: two price changes inside one UTC hour read that hour twice.
  test("two price changes in one hour count that hour once", () => {
    const prices = withPeriods({
      "claude-opus-4-8": [
        [null, 5, 25],
        ["2026-08-12T10:30:00Z", 3, 15],
      ],
      "claude-sonnet-4-6": [
        [null, 3, 15],
        ["2026-08-12T10:45:00Z", 2, 10],
      ],
    });
    const rows = [
      row({ inp: 1_000_000, ts: at("2026-08-12T10:10:00Z") }), // $5
      row({ inp: 1_000_000, ts: at("2026-08-12T10:40:00Z") }), // $3
      row({ model: "claude-sonnet-4-6", inp: 1_000_000, ts: at("2026-08-12T10:44:59.999Z") }), // $3
      row({ model: "claude-sonnet-4-6", inp: 1_000_000, ts: at("2026-08-12T10:45:00Z") }), // $2
    ];
    const { q, db } = engine(rows, {}, prices);
    const day = { from: at("2026-08-12T00:00:00Z"), to: at("2026-08-13T00:00:00Z") };
    const totals = q.totals({ range: day });
    expect(totals.usage.records).toBe(4);
    expect(totals.usage.cost).toBeCloseTo(13, 12);
    expect(q.byModel({ range: day }).map((m) => [m.model, m.usage.records, m.usage.cost])).toEqual([
      ["claude-opus-4-8", 2, 8],
      ["claude-sonnet-4-6", 2, 5],
    ]);
    expect(
      q.byDay({ range: day, tz: "Asia/Kolkata" }).reduce((s, d) => s + d.usage.records, 0),
    ).toBe(4);
    db.close();
  });

  test("three price changes in one hour count that hour once", () => {
    const prices = withPeriods({
      "claude-opus-4-8": [
        [null, 5, 25],
        ["2026-08-12T10:30:00Z", 3, 15],
      ],
      "claude-sonnet-4-6": [
        [null, 3, 15],
        ["2026-08-12T10:45:00Z", 2, 10],
      ],
      "claude-haiku-4-5": [
        [null, 1, 5],
        ["2026-08-12T10:50:00.500Z", 0.5, 2.5],
      ],
    });
    const rows = [
      row({ inp: 1_000_000, ts: at("2026-08-12T10:29:59.999Z") }), // $5
      row({ inp: 1_000_000, ts: at("2026-08-12T10:30:00Z") }), // $3
      row({ model: "claude-sonnet-4-6", inp: 1_000_000, ts: at("2026-08-12T10:46:00Z") }), // $2
      row({ model: "claude-haiku-4-5", inp: 1_000_000, ts: at("2026-08-12T10:50:00.499Z") }), // $1
      row({ model: "claude-haiku-4-5", inp: 1_000_000, ts: at("2026-08-12T10:50:00.500Z") }), // $0.50
    ];
    const { q, db } = engine(rows, {}, prices);
    for (const range of [
      { from: at("2026-08-12T00:00:00Z"), to: at("2026-08-13T00:00:00Z") },
      { from: at("2026-08-12T10:00:00Z"), to: at("2026-08-12T11:00:00Z") },
      { from: at("2026-08-12T10:20:00Z"), to: at("2026-08-12T10:55:00Z") },
    ]) {
      const totals = q.totals({ range });
      expect(totals.usage.records).toBe(5);
      expect(totals.usage.cost).toBeCloseTo(11.5, 12);
    }
    db.close();
  });

  // M1: with autoInvalidate off, a model first seen in an uncached day lost its
  // long-context price, because the list of such models was read before the new names.
  test("a model written after the names were read keeps its long-context price", () => {
    const { q, db, path } = engine(
      [row({ ...codex, model: "gpt-5.4-mini", inp: 1000, ts: at("2026-09-30T00:10:00Z") })],
      { autoInvalidate: false },
    );
    q.totals({ range: { from: at("2026-09-30T00:00:00Z"), to: at("2026-09-30T01:00:00Z") } });
    const late = row({
      ...codex,
      model: "gpt-5.5",
      inp: 100_000,
      outp: 1000,
      cr: 400_000,
      ts: at("2026-10-02T05:10:00Z"),
    });
    const store = openStore(path);
    store.upsert([late]);
    store.close();
    // 100k * $10 + 1000 * $45 + 400k * $1 per M: the 2x/1.5x long-context rates.
    const expected = bundled().cost({
      model: "gpt-5.5",
      tier: "standard",
      atMs: late.ts,
      input: late.inp,
      output: late.outp,
      cacheRead: late.cr,
      cacheCreation: 0,
      ephemeral5m: null,
      ephemeral1h: null,
    });
    expect(expected).toBeCloseTo(1.445, 12);
    const day = { from: at("2026-10-02T00:00:00Z"), to: at("2026-10-03T00:00:00Z") };
    expect(q.totals({ range: day }).usage.cost).toBeCloseTo(1.445, 12);
    db.close();
  });

  test("warm() prices a range ahead of the queries over it", () => {
    const { q, db } = engine(
      [row({ inp: 1_000_000 }), row({ inp: 1_000_000, ts: at("2026-09-30T14:20:30.500Z") })],
      { autoInvalidate: false },
    );
    q.warm();
    q.warm({ period: "24h" });
    expect(q.totals().usage.cost).toBe(10);
    expect(
      q
        .activity({
          range: { from: at("2026-09-30T14:00:00Z"), to: at("2026-09-30T15:00:00Z") },
          buckets: 6,
        })
        .buckets.map((b) => b.cost),
    ).toEqual([0, 5, 5, 0, 0, 0]);
    db.close();
  });
});

describe("estimated prices", () => {
  // codex-auto-review is priced through the bundled estimated alias: unpriced before
  // 2026-03-05T08:00Z, gpt-5.4 ($2.50/M input, fast $5) until 2026-07-30T07:00Z, then
  // gpt-5.6-luna ($0.20/M input, fast $0.40). Rows stay under the 272k long-context threshold.
  const prices = () => new PriceTable(bundledPricing().models, bundledPricing().aliases);
  const review = { ...codex, model: "codex-auto-review" };
  const rows = () => [
    row({ ...review, inp: 200_000 }), // Luna: $0.04
    row({ ...review, inp: 200_000, tier: 1 }), // Luna fast: $0.08
    row({ ...review, inp: 200_000, ts: at("2026-06-01T12:00:00Z") }), // gpt-5.4: $0.50
    row({ ...review, inp: 1_000, ts: at("2026-02-01T12:00:00Z") }), // before any estimate
    row({ inp: 1_000_000 }), // claude-opus-4-8: $5, not estimated
  ];
  const now = () => at("2026-09-30T15:00:00Z");

  test("usage priced from an estimated card is reported as estimated, whole hours and raw rows alike", () => {
    const { q, db } = engine(rows(), { now }, prices());
    const totals = q.totals();
    expect(totals.usage.cost).toBeCloseTo(5 + 0.04 + 0.08 + 0.5, 12);
    expect(totals.usage.estimatedCost).toBeCloseTo(0.04 + 0.08 + 0.5, 12);
    expect(totals.usage.coverage.estimatedTokens).toBe(600_000);
    expect(totals.usage.coverage.pricedTokens).toBe(1_600_000);
    expect(totals.usage.coverage.unpricedTokens).toBe(1_000);
    // A range that cuts an hour is read from raw rows: the same answer for its rows.
    const cut = q.totals({
      range: { from: at("2026-09-30T14:05:00Z"), to: at("2026-09-30T14:20:00Z") },
    });
    expect(cut.usage.cost).toBeCloseTo(5.12, 12);
    expect(cut.usage.estimatedCost).toBeCloseTo(0.12, 12);
    expect(cut.usage.coverage.estimatedTokens).toBe(400_000);
    db.close();
  });

  test("by model, an estimated model's cost is all estimated and its rates say so", () => {
    const { q, db } = engine(rows(), { now }, prices());
    const models = q.byModel();
    const standard = models.find((m) => m.model === "codex-auto-review" && m.tier === "standard");
    const fast = models.find((m) => m.model === "codex-auto-review" && m.tier === "fast");
    const opus = models.find((m) => m.model === "claude-opus-4-8");
    expect(standard?.usage.cost).toBeCloseTo(0.54, 12);
    expect(standard?.usage.estimatedCost).toBeCloseTo(0.54, 12);
    expect(standard?.rates).toMatchObject({ input: 0.2, output: 1.2, estimated: true });
    expect(fast?.usage.estimatedCost).toBeCloseTo(0.08, 12);
    expect(fast?.rates).toMatchObject({ input: 0.4, estimated: true });
    expect(opus?.usage.estimatedCost).toBe(0);
    expect(opus?.rates?.estimated).toBe(false);
    // By day: the estimate follows its rows.
    const days = q.byDay({
      range: { from: at("2026-09-30T00:00:00Z"), to: at("2026-10-01T00:00:00Z") },
    });
    expect(days.map((d) => d.usage.estimatedCost)).toEqual([expect.closeTo(0.12, 12)]);
    db.close();
  });
});
