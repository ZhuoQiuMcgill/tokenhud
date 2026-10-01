// Acceptance criterion 2: over a 200k-row synthetic store, every query's cost equals the
// sum of each row's computeCost over the same rows, within $0.005, for 1,000 random
// queries. Token counts must match exactly. Queries mix every grouping, five time zones
// (two with half- or three-quarter-hour offsets, one with DST), ranges of a minute to four
// months at millisecond edges, and account and provider filters. A second price table adds
// a price change in the middle of an hour and a long-context threshold below the partial
// index's, the two paths the bundled table never takes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeModel } from "../../src/pricing/normalize.ts";
import { mergePricing } from "../../src/pricing/overrides.ts";
import { parseModelPricing } from "../../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { UsageQueries } from "../../src/query/engine.ts";
import type { Range } from "../../src/query/types.ts";
import { openStore, openStoreReader, type UsageRow } from "../../src/store/store.ts";
import { cleanup, tempDir } from "../store/helpers.ts";
import { ACCOUNTS, prng, syntheticRows } from "./synthetic.ts";

const FROM = Date.parse("2026-06-01T00:00:00Z");
const TO = Date.parse("2026-10-01T00:00:00Z");
const ZONES = ["UTC", "America/Toronto", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Adelaide"];
const KINDS = ["totals", "model", "account", "day", "week", "month", "activity"] as const;
const DAY = 86_400_000;

let rows: UsageRow[];
let path: string;

// Writing 200k rows through the rollup triggers takes about 1 s here and over 5 s (Bun's
// default hook timeout) on CI's Windows runners.
beforeAll(() => {
  rows = syntheticRows({ rows: 200_000, from: FROM, to: TO, seed: 6 }).sort((a, b) => a.ts - b.ts);
  path = join(tempDir(), "tokenhud.db");
  const store = openStore(path);
  for (let i = 0; i < rows.length; i += 50_000) store.upsert(rows.slice(i, i + 50_000));
  store.close();
}, 120_000);

afterAll(cleanup);

/**
 * Overrides: Terra's second card starts at 07:30, mid-hour, and Luna gets a 100k
 * long-context threshold, below the partial index's 272k.
 */
function oddTable(): PriceTable {
  const bundled = bundledPricing().models;
  const terra = parseModelPricing(
    {
      periods: [
        { from: null, card: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125 } },
        {
          from: "2026-08-05T07:30:00Z",
          card: {
            input: 2,
            output: 12,
            cache_read: 0.2,
            cache_write: 2.5,
            long_context_threshold: 272_000,
            long_context_input_multiplier: 2,
            long_context_output_multiplier: 1.5,
            fast: { input: 4, output: 24, cache_read: 0.4, cache_write: 5 },
          },
        },
      ],
    },
    "terra",
    { coerce: false },
  );
  const luna = parseModelPricing(
    {
      input: 0.2,
      output: 1.2,
      long_context_threshold: 100_000,
      long_context_input_multiplier: 3,
      long_context_output_multiplier: 1.25,
    },
    "luna",
    { coerce: false },
  );
  return new PriceTable(mergePricing(bundled, { "gpt-5.6-terra": terra, "gpt-5.6-luna": luna }));
}

interface Reference {
  cost: Float64Array;
  tokens: Float64Array;
  model: string[];
  acct: number[];
}

/** Each row's own computeCost (0 when unpriced) and token count. */
function reference(table: PriceTable, accountIds: Map<string, number>): Reference {
  const cost = new Float64Array(rows.length);
  const tokens = new Float64Array(rows.length);
  const model: string[] = [];
  const acct: number[] = [];
  rows.forEach((r, i) => {
    const c = table.cost({
      model: r.model,
      tier: r.tier === 0 ? "standard" : "fast",
      atMs: r.ts,
      input: r.inp,
      output: r.outp,
      cacheRead: r.cr,
      cacheCreation: r.cc,
      ephemeral5m: r.e5,
      ephemeral1h: r.e1,
    });
    cost[i] = typeof c === "number" ? c : 0;
    tokens[i] = r.inp + r.outp + r.cr + r.cc;
    model.push(`${normalizeModel(r.model)}\0${r.tier}`);
    acct.push(accountIds.get(r.identity) ?? -1);
  });
  return { cost, tokens, model, acct };
}

function firstAtOrAfter(ts: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid] as UsageRow).ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The reference sums over rows in `range` that `keep` selects. */
function sumOver(ref: Reference, range: Range, keep: (i: number) => boolean) {
  let cost = 0;
  let tokens = 0;
  for (let i = firstAtOrAfter(range.from); i < rows.length; i++) {
    if ((rows[i] as UsageRow).ts >= range.to) break;
    if (!keep(i)) continue;
    cost += ref.cost[i] as number;
    tokens += ref.tokens[i] as number;
  }
  return { cost, tokens };
}

function runQueries(table: PriceTable, count: number, seed: number) {
  const reader = openStoreReader(path);
  if (reader === null) throw new Error("no store");
  const rnd = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
  let engine = new UsageQueries(reader, table, { tz: "UTC" });
  const accounts = engine.accountList();
  const ids = new Map<string, number>();
  for (const a of ACCOUNTS) {
    const id = accounts.find((x) => x.label === a.label)?.id;
    if (id !== undefined) ids.set(a.identity, id);
  }
  const ref = reference(table, ids);
  let maxDiff = 0;
  let checks = 0;
  const check = (got: { cost: number; tokens: number }, want: { cost: number; tokens: number }) => {
    const diff = Math.abs(got.cost - want.cost);
    maxDiff = Math.max(maxDiff, diff);
    checks++;
    expect(diff).toBeLessThan(0.005);
    expect(got.tokens).toBe(want.tokens);
  };

  for (let q = 0; q < count; q++) {
    // Every 50th query starts cold: a fresh engine loads and prices hours again.
    if (q % 50 === 49) engine = new UsageQueries(reader, table, { tz: "UTC" });
    const length = Math.round(Math.exp(Math.log(60_000) + rnd() * Math.log((120 * DAY) / 60_000)));
    const from = FROM - DAY + Math.floor(rnd() * (TO - FROM + DAY - length));
    const range = { from, to: from + length };
    const tz = pick(ZONES);
    const filter = rnd();
    const chosen = filter < 0.6 ? null : filter < 0.85 ? accounts.filter(() => rnd() < 0.5) : null;
    const provider = filter >= 0.85 ? pick(["claude", "codex"]) : null;
    const args = {
      range,
      tz,
      ...(chosen !== null && { accounts: chosen.map((a) => a.id) }),
      ...(provider !== null && { providers: [provider] }),
    };
    const allowed = new Set(
      accounts
        .filter(
          (a) =>
            (chosen === null || chosen.includes(a)) &&
            (provider === null || a.provider === provider),
        )
        .map((a) => a.id),
    );
    const inScope = (i: number) => allowed.has(ref.acct[i] as number);
    const kind = pick(KINDS);
    const usage = (u: { cost: number; tokens: { total: number } }) => ({
      cost: u.cost,
      tokens: u.tokens.total,
    });

    if (kind === "totals") {
      check(usage(engine.totals(args).usage), sumOver(ref, range, inScope));
    } else if (kind === "model") {
      const models = engine.byModel(args);
      for (const m of models) {
        const key = `${m.model}\0${m.tier === "standard" ? 0 : 1}`;
        check(
          usage(m.usage),
          sumOver(ref, range, (i) => inScope(i) && ref.model[i] === key),
        );
      }
      const all = models.reduce((s, m) => s + m.usage.tokens.total, 0);
      expect(all).toBe(sumOver(ref, range, inScope).tokens);
    } else if (kind === "account") {
      for (const a of engine.byAccount(args)) {
        check(
          usage(a.usage),
          sumOver(ref, range, (i) => ref.acct[i] === a.account.id && inScope(i)),
        );
      }
    } else if (kind === "activity") {
      const buckets = 1 + Math.floor(rnd() * 120);
      for (const b of engine.activity({ ...args, buckets }).buckets) {
        check({ cost: b.cost, tokens: b.tokens }, sumOver(ref, b.range, inScope));
      }
    } else {
      const groups =
        kind === "day"
          ? engine.byDay(args)
          : kind === "week"
            ? engine.byWeek(args)
            : engine.byMonth(args);
      expect(groups[0]?.range.from ?? range.from).toBe(range.from);
      expect(groups[groups.length - 1]?.range.to ?? range.to).toBe(range.to);
      for (const g of groups) check(usage(g.usage), sumOver(ref, g.range, inScope));
    }
  }
  reader.close();
  return { maxDiff, checks };
}

describe("cost from sums equals the per-row sum", () => {
  test("1,000 random queries, bundled prices", () => {
    const { maxDiff, checks } = runQueries(new PriceTable(bundledPricing().models), 1_000, 1);
    console.log(`bundled table: ${checks} costs checked, max |diff| $${maxDiff.toExponential(2)}`);
    expect(maxDiff).toBeLessThan(0.005);
  }, 120_000);

  test("300 random queries, a mid-hour price change and a threshold below the index", () => {
    const { maxDiff, checks } = runQueries(oddTable(), 300, 2);
    console.log(`odd table: ${checks} costs checked, max |diff| $${maxDiff.toExponential(2)}`);
    expect(maxDiff).toBeLessThan(0.005);
  }, 120_000);

  test("the synthetic store exercises every pricing path", () => {
    const bundled = new PriceTable(bundledPricing().models);
    const reasons = new Set<string>();
    let long = 0;
    for (const r of rows) {
      const tier = r.tier === 0 ? "standard" : "fast";
      const rates = bundled.rates(r.model, tier, r.ts);
      if (typeof rates === "string") reasons.add(rates);
      else if (
        rates.long_context_threshold !== undefined &&
        r.inp + r.cr > rates.long_context_threshold
      ) {
        long++;
        const c = bundled.cost({
          ...r,
          model: r.model,
          tier,
          atMs: r.ts,
          input: r.inp,
          output: r.outp,
          cacheRead: r.cr,
          cacheCreation: r.cc,
          ephemeral5m: r.e5,
          ephemeral1h: r.e1,
        });
        if (typeof c === "string") reasons.add(`long ${c}`);
      }
    }
    expect([...reasons].sort()).toEqual(["long unpriced-tier", "unpriced", "unpriced-tier"]);
    expect(long).toBeGreaterThan(200);
    expect(rows.some((r) => r.e5 === null && r.e1 === null)).toBe(true);
    expect(rows.some((r) => r.e5 === null && r.e1 !== null)).toBe(true);
    const sol = rows.filter((r) => r.model === "gpt-5.6-sol").map((r) => r.ts);
    for (const boundary of bundled.boundaries()) {
      expect(sol.some((t) => t < boundary)).toBe(true);
      expect(sol.some((t) => t >= boundary)).toBe(true);
    }
  });
});
