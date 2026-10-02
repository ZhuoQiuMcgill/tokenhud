// Port of cc-usage v2.6.1 tests/test_cost.py, one test per Python test, same names.
//
// Adapted (same intent, tokenhud's API or table shape):
// - Python's `get_rates(model, rows)` is `PriceTable.rates(model, "standard", t)`; None is
//   "unpriced".
// - test_unknown_model_costs_zero: tokenhud returns "unpriced", not 0.0 (task §1).
// - Bundled-table assertions read tokenhud's own pricing.json. Where tokenhud adds a fast
//   card or dated periods, the standard card is compared. gpt-5.6-* are checked at an
//   instant when tokenhud's dated cards equal cc-usage's undated ones.
// - test_editable_pricing_preserves_optional_official_rate_fields exercises the overrides
//   parser, which coerces numeric strings as cc-usage's `_coerce` did.
// Skipped: none.

import { describe, expect, test } from "bun:test";
import {
  CACHE_READ_MULT,
  cacheReadRate,
  computeCost,
  type Rates,
  type TokenCounts,
} from "../../src/pricing/cost.ts";
import { normalizeModel } from "../../src/pricing/normalize.ts";
import { parseOverrides } from "../../src/pricing/overrides.ts";
import { isDated, type RateCard } from "../../src/pricing/schema.ts";
import { bundledPricing, PriceTable } from "../../src/pricing/table.ts";
import { guard } from "../guard.ts";
import { bundledTable, CC_USAGE_V261_INSTANT, isClose } from "./helpers.ts";

guard();

const T = CC_USAGE_V261_INSTANT;
const PRICING = new PriceTable({
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
});

const table = bundledTable();
const rates = (model: string) => table.rates(model, "standard", T);
const standardCard = (model: string): RateCard => {
  const entry = bundledPricing().models[model];
  if (entry === undefined || isDated(entry)) throw new Error(`${model}: not an undated entry`);
  const { fast: _fast, ...card } = entry;
  return card;
};

function cost(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  ephemeral5m: number | null,
  ephemeral1h: number | null,
  card: Rates | "unpriced" | "unpriced-tier",
) {
  const tokens: TokenCounts = { input, output, cacheRead, cacheCreation, ephemeral5m, ephemeral1h };
  return computeCost(tokens, card);
}

function num(value: number | string): number {
  if (typeof value !== "number") throw new Error(`expected a cost, got ${value}`);
  return value;
}

describe("test_cost.py", () => {
  test("test_normalize_strips_suffixes", () => {
    expect(normalizeModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(normalizeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModel("claude-sonnet-4-6-20251001")).toBe("claude-sonnet-4-6");
    expect(normalizeModel("gpt-5.4-2026-03-05")).toBe("gpt-5.4");
    expect(normalizeModel("us.anthropic.claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModel("  Claude-Opus-4-8  ")).toBe("claude-opus-4-8");
    expect(normalizeModel(null)).toBe("");
    expect(normalizeModel("")).toBe("");
  });

  test("test_get_rates_known_and_unknown", () => {
    expect(PRICING.rates("claude-opus-4-8", "standard", T)).toEqual({ input: 5.0, output: 25.0 });
    expect(PRICING.rates("claude-opus-4-8[1m]", "standard", T)).toEqual({
      input: 5.0,
      output: 25.0,
    });
    expect(PRICING.rates("claude-mystery-9", "standard", T)).toBe("unpriced");
    expect(PRICING.rates(null, "standard", T)).toBe("unpriced");
  });

  test("test_bundled_pricing_prices_sonnet_5", () => {
    // The $2/$10 introductory rate replaced the original $3/$15 list price.
    expect(bundledPricing().models["claude-sonnet-5"]).toEqual({ input: 2.0, output: 10.0 });
    expect(rates("claude-sonnet-5")).toEqual({ input: 2.0, output: 10.0 });
    expect(rates("claude-sonnet-5[1m]")).toEqual({ input: 2.0, output: 10.0 });
  });

  test("test_bundled_pricing_prices_fable_5_1", () => {
    // Cache reads are $0.25 (0.025x input), so the rate is stated explicitly.
    const fable51 = { input: 10.0, output: 50.0, cache_read: 0.25 };
    expect(bundledPricing().models["claude-fable-5-1"]).toEqual(fable51);
    expect(rates("claude-fable-5-1")).toEqual(fable51);
    expect(rates("claude-fable-5-1[1m]")).toEqual(fable51);
    expect(normalizeModel("claude-fable-5-1")).toBe("claude-fable-5-1");
    // Fable 5 keeps its own entry and is not shadowed by the point release.
    expect(rates("claude-fable-5")).toEqual({ input: 10.0, output: 50.0 });
  });

  test("test_bundled_pricing_prices_opus_5_5", () => {
    const opus55 = { input: 4.0, output: 20.0, cache_read: 0.2 };
    expect(standardCard("claude-opus-5-5")).toEqual(opus55);
    expect(rates("claude-opus-5-5")).toEqual(opus55);
    expect(rates("claude-opus-5-5[1m]")).toEqual(opus55);
    // Distinct row, not collapsed into claude-opus-5.
    expect(rates("claude-opus-5")).toEqual({ input: 5.0, output: 25.0 });

    const c = num(cost(100_000, 10_000, 1_000_000, 200_000, 100_000, 100_000, opus55));
    // $4 in, $20 out, $0.20 cache read, $5 5m write, $8 1h write.
    const expected =
      (100_000 * 4.0 + 10_000 * 20.0 + 1_000_000 * 0.2 + 100_000 * 5.0 + 100_000 * 8.0) / 1_000_000;
    expect(isClose(c, expected, 1e-12)).toBe(true);
  });

  test("test_bundled_pricing_prices_sonnet_5_5_and_mythos", () => {
    expect(bundledPricing().models["claude-sonnet-5-5"]).toEqual({ input: 2.0, output: 10.0 });
    const sonnet55 = rates("claude-sonnet-5-5") as Rates;
    expect(sonnet55).toEqual({ input: 2.0, output: 10.0 });
    expect(rates("claude-sonnet-5-5[1m]")).toEqual({ input: 2.0, output: 10.0 });
    expect(normalizeModel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    // The derived default reproduces the published $0.20 cache hit.
    expect(isClose(cacheReadRate(sonnet55), 0.2, 1e-12)).toBe(true);

    expect(rates("claude-mythos-5-1")).toEqual(rates("claude-fable-5-1"));
    expect(rates("claude-mythos-5-1")).toEqual({ input: 10.0, output: 50.0, cache_read: 0.25 });
    expect(rates("claude-mythos-5")).toEqual(rates("claude-fable-5"));
    const mythos5 = rates("claude-mythos-5") as Rates;
    expect(mythos5).toEqual({ input: 10.0, output: 50.0 });
    expect(isClose(cacheReadRate(mythos5), 1.0, 1e-12)).toBe(true);
  });

  test("test_bundled_pricing_prices_opus_5", () => {
    expect(standardCard("claude-opus-5")).toEqual({ input: 5.0, output: 25.0 });
    expect(rates("claude-opus-5")).toEqual({ input: 5.0, output: 25.0 });
    expect(rates("claude-opus-5[1m]")).toEqual({ input: 5.0, output: 25.0 });
    // Must not collide with the 4-x aliases that share the same tier.
    expect(rates("claude-opus-4-8")).toEqual({ input: 5.0, output: 25.0 });
  });

  test("test_bundled_openai_pricing_uses_official_standard_rates", () => {
    const sol = rates("gpt-5.6-sol") as Rates;
    expect([sol.input, sol.cache_read, sol.cache_write, sol.output]).toEqual([
      5.0, 0.5, 6.25, 30.0,
    ]);
    // Terra and Luna track their standing rates from late July 2026.
    const terra = rates("gpt-5.6-terra") as Rates;
    expect([terra.input, terra.cache_read, terra.cache_write, terra.output]).toEqual([
      2.0, 0.2, 2.5, 12.0,
    ]);
    const luna = rates("gpt-5.6-luna") as Rates;
    expect([luna.input, luna.cache_read, luna.cache_write, luna.output]).toEqual([
      0.2, 0.02, 0.25, 1.2,
    ]);
    expect(standardCard("gpt-5.3-codex")).toEqual({ input: 1.75, cache_read: 0.175, output: 14.0 });
    expect(standardCard("gpt-5.2")).toEqual({ input: 1.75, cache_read: 0.175, output: 14.0 });
    expect(rates("gpt-5.3-codex")).toEqual({ input: 1.75, output: 14.0, cache_read: 0.175 });
    expect((rates("gpt-5.5") as Rates).output).toBe(30.0);
    expect((rates("gpt-5.4") as Rates).input).toBe(2.5);
    expect(standardCard("gpt-5.4-mini")).toEqual({ input: 0.75, cache_read: 0.075, output: 4.5 });
    expect(rates("gpt-5.4-2026-03-05")).toEqual(rates("gpt-5.4"));
    expect(rates("gpt-5.6")).toEqual(rates("gpt-5.6-sol"));
  });

  const longContextTier = {
    long_context_threshold: 272000,
    long_context_input_multiplier: 2.0,
    long_context_output_multiplier: 1.5,
  };

  test("test_bundled_pricing_prices_gpt_6_astra", () => {
    const astra = {
      input: 10.0,
      cache_read: 1.0,
      cache_write: 12.5,
      output: 50.0,
      ...longContextTier,
    };
    expect(standardCard("gpt-6-astra")).toEqual(astra);
    const r = rates("gpt-6-astra") as Rates;
    expect(r).toEqual(astra);
    // Cache writes are 1.25x the uncached input rate, per the published card.
    expect(r.cache_write).toBe(r.input * 1.25);
    // Distinct from the gpt-5.6 flagship it sits above, and not aliased to it.
    expect(rates("gpt-6-astra")).not.toEqual(rates("gpt-5.6-sol"));
  });

  test("test_bundled_pricing_prices_gpt_6_family", () => {
    const published: Record<string, [number, number, number, number]> = {
      "gpt-6.1-sol": [2.0, 0.1, 2.5, 10.0],
      "gpt-6-sol": [2.0, 0.2, 2.5, 10.0],
      "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
    };
    for (const [name, [input, cached, write, output]] of Object.entries(published)) {
      const card = { input, cache_read: cached, cache_write: write, output, ...longContextTier };
      expect(standardCard(name)).toEqual(card);
      expect(rates(name)).toEqual(card);
    }
    expect(normalizeModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(rates("gpt-6.1-sol")).not.toEqual(rates("gpt-6-sol"));

    // Long context doubles the cached and cache-write rates too: GPT-6.1 Sol's published
    // long tier is $4 input / $0.20 cached / $5 writes / $15 output.
    const c = num(cost(100_000, 10_000, 200_000, 50_000, null, null, rates("gpt-6.1-sol")));
    const expected = (100_000 * 4.0 + 200_000 * 0.2 + 50_000 * 5.0 + 10_000 * 15.0) / 1e6;
    expect(isClose(c, expected, 1e-12)).toBe(true);
  });

  test("test_gpt_6_astra_long_context_threshold_is_exclusive", () => {
    // "More than 272K input tokens": exactly at the threshold bills at the standard rate;
    // one token over scales the whole request.
    const astra = rates("gpt-6-astra");
    const c = (input: number, cacheRead = 0) => num(cost(input, 0, cacheRead, 0, 0, 0, astra));
    expect(isClose(c(272_000), (272_000 * 10.0) / 1e6, 1e-12)).toBe(true);
    expect(isClose(c(272_001), (272_001 * 20.0) / 1e6, 1e-12)).toBe(true);
    // Cached tokens count as input for the threshold: 100K fresh + 200K cached = 300K.
    expect(isClose(c(100_000, 200_000), (100_000 * 20.0 + 200_000 * 2.0) / 1e6, 1e-12)).toBe(true);
  });

  test("test_openai_long_context_and_explicit_cache_rates", () => {
    const card: Rates = {
      input: 5.0,
      cache_read: 0.5,
      cache_write: 6.25,
      output: 30.0,
      ...longContextTier,
    };
    const c = num(cost(100_000, 1_000, 200_000, 0, 0, 0, card));
    const expected = (100_000 * 10.0 + 200_000 * 1.0 + 1_000 * 45.0) / 1_000_000;
    expect(isClose(c, expected, 1e-12)).toBe(true);
  });

  test("test_editable_pricing_preserves_optional_official_rate_fields", () => {
    const text = JSON.stringify({
      models: {
        "gpt-custom": {
          input: "2.5",
          cache_read: "0.25",
          cache_write: "3.125",
          output: "15",
          long_context_threshold: "272000",
          long_context_input_multiplier: "2",
          long_context_output_multiplier: "1.5",
        },
      },
    });
    const parsed = parseOverrides(text, "pricing.overrides.json");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.models["gpt-custom"]).toEqual({
      input: 2.5,
      cache_read: 0.25,
      cache_write: 3.125,
      output: 15.0,
      long_context_threshold: 272000.0,
      long_context_input_multiplier: 2.0,
      long_context_output_multiplier: 1.5,
    });
  });

  test("test_cost_with_ephemeral_subbuckets", () => {
    // in 1000, out 2000, cache_read 10000, eph_5m 1000, eph_1h 3000 (opus 5/25).
    // 0.005 + 0.05 + 0.005 + 0.00625 + 0.03 = 0.09625
    const c = num(cost(1000, 2000, 10000, 4000, 1000, 3000, { input: 5.0, output: 25.0 }));
    expect(isClose(c, 0.09625, 1e-9)).toBe(true);
  });

  test("test_cost_fallback_to_aggregate_when_subbuckets_absent", () => {
    // No cache_creation object -> aggregate 800 * 1.25 (sonnet 3/15).
    // 0.0015 + 0.0015 + 0.0006 + 0.003 = 0.0066
    const c = num(cost(500, 100, 2000, 800, null, null, { input: 3.0, output: 15.0 }));
    expect(isClose(c, 0.0066, 1e-9)).toBe(true);
  });

  test("test_unknown_model_costs_zero (adapted: unpriced, never $0)", () => {
    const c = cost(1000, 1000, 5, 5, null, null, PRICING.rates("claude-mystery-9", "standard", T));
    expect(c).toBe("unpriced");
    expect(c).not.toBe(0);
  });

  test("test_subbuckets_differ_from_fallback", () => {
    // 1h tokens cost 2.0x but the aggregate fallback would only charge 1.25x.
    const opus = { input: 5.0, output: 25.0 };
    const viaBuckets = num(cost(0, 0, 0, 1000, 0, 1000, opus));
    const viaFallback = num(cost(0, 0, 0, 1000, null, null, opus));
    expect(isClose(viaBuckets, 1000 * 5e-6 * 2.0, 1e-12)).toBe(true);
    expect(isClose(viaFallback, 1000 * 5e-6 * 1.25, 1e-12)).toBe(true);
    expect(viaBuckets).toBeGreaterThan(viaFallback);
  });

  test("test_cache_read_rate_is_the_rate_compute_cost_bills", () => {
    const derived = rates("claude-opus-4-8") as Rates; // no cache_read -> input x 0.1
    const explicit = rates("claude-opus-5-5") as Rates; // cache_read 0.20 (not 0.1x)
    const gptMini = rates("gpt-5.4-mini") as Rates; // cache_read 0.075
    expect(cacheReadRate(derived)).toBe(5.0 * CACHE_READ_MULT);
    expect(cacheReadRate(derived)).toBe(0.5);
    expect(cacheReadRate(explicit)).toBe(0.2);
    expect(cacheReadRate(gptMini)).toBe(0.075);
    for (const card of [derived, explicit, gptMini, { input: 3.0, output: 15.0 }]) {
      const billed = num(cost(0, 0, 1_000_000, 0, 0, 0, card));
      expect(isClose(billed, cacheReadRate(card), 1e-12)).toBe(true);
    }
  });

  test("test_long_context_cache_reads_keep_the_pre_t16_arithmetic_order", () => {
    // A derived rate is (input x multiplier) x 0.1, in that order. The two orders differ
    // in the last place for input 0.3 at a 1.7x long-context multiplier.
    const card: Rates = {
      input: 0.3,
      output: 1.0,
      long_context_threshold: 10,
      long_context_input_multiplier: 1.7,
    };
    expect(0.3 * 1.7 * CACHE_READ_MULT).not.toBe(0.3 * CACHE_READ_MULT * 1.7); // orders differ
    const billed = cost(0, 0, 1_000_000, 0, 0, 0, card);
    expect(cacheReadRate(card, 1.7)).toBe(0.3 * 1.7 * CACHE_READ_MULT);
    expect(billed).toBe((1_000_000 * (0.3 * 1.7 * CACHE_READ_MULT)) / 1_000_000);
  });
});
