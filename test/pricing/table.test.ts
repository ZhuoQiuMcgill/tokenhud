import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCost, type Rates, type TokenCounts } from "../../src/pricing/cost.ts";
import { normalizeModel } from "../../src/pricing/normalize.ts";
import bundledJson from "../../src/pricing/pricing.json";
import { isDated, parsePriceTableFile, type Tier } from "../../src/pricing/schema.ts";
import { bundledPricing, PriceTable, type UsageRecord } from "../../src/pricing/table.ts";
import { at, bundledTable, CC_USAGE_MODELS, isClose, NO_CACHE } from "./helpers.ts";

const table = bundledTable();

// [input, output, cached input, cache writes] from a resolved card, for compact asserts.
function card(model: string, tier: Tier, iso: string): number[] | string {
  const r = table.rates(model, tier, at(iso));
  if (typeof r === "string") return r;
  return [r.input, r.output, r.cache_read ?? Number.NaN, r.cache_write ?? Number.NaN];
}

// OpenAI's changelog dates changes without a time or zone; tokenhud reads each date as
// 00:00 America/Los_Angeles, which is 07:00Z in summer (PDT). See SOURCES.md.
describe("dated OpenAI periods", () => {
  // Changelog, Aug 21: "GPT-5.6 Sol now costs $4 ... and $20 ...". The first capture
  // showing it is 2026-08-22T10:30:53Z; the page still showed $5/$30 at 2026-08-21T10:30:49Z
  // (page-update lag). The announcement wins (task §3).
  test("gpt-5.6-sol: $5/$30 (fast $10/$60) until 2026-08-21T07:00Z", () => {
    for (const iso of [
      "2026-07-09T00:00:00Z",
      "2026-08-21T06:59:00Z",
      "2026-08-21T06:59:59.999Z",
    ]) {
      expect(card("gpt-5.6-sol", "standard", iso)).toEqual([5, 30, 0.5, 6.25]);
      expect(card("gpt-5.6-sol", "fast", iso)).toEqual([10, 60, 1, 12.5]);
    }
  });

  test("gpt-5.6-sol: $4/$20 (fast $8/$40) from 2026-08-21T07:00Z", () => {
    for (const iso of ["2026-08-21T07:00:00Z", "2026-08-21T23:59:00Z", "2026-08-23T00:00:00Z"]) {
      expect(card("gpt-5.6-sol", "standard", iso)).toEqual([4, 20, 0.4, 5]);
      expect(card("gpt-5.6-sol", "fast", iso)).toEqual([8, 40, 0.8, 10]);
    }
    expect(card("gpt-5.6", "standard", "2026-10-01T00:00:00Z")).toEqual([4, 20, 0.4, 5]);
  });

  // "Starting July 30, GPT-5.6 Luna costs 80% less, while GPT-5.6 Terra costs 20% less."
  // Captures: old price 2026-07-28T10:30:58Z, new 2026-07-30T19:51:07Z.
  test("gpt-5.6-terra: $2.50/$15 (fast $5/$30) -> $2/$12 (fast $4/$24) at 2026-07-30T07:00Z", () => {
    const before = "2026-07-30T06:59:59.999Z";
    const after = "2026-07-30T07:00:00Z";
    expect(card("gpt-5.6-terra", "standard", before)).toEqual([2.5, 15, 0.25, 3.125]);
    expect(card("gpt-5.6-terra", "fast", before)).toEqual([5, 30, 0.5, 6.25]);
    expect(card("gpt-5.6-terra", "standard", after)).toEqual([2, 12, 0.2, 2.5]);
    expect(card("gpt-5.6-terra", "fast", after)).toEqual([4, 24, 0.4, 5]);
  });

  test("gpt-5.6-luna: $1/$6 (fast $2/$12) -> $0.20/$1.20 (fast $0.40/$2.40) at 2026-07-30T07:00Z", () => {
    const before = "2026-07-30T06:59:59.999Z";
    const after = "2026-07-30T07:00:00Z";
    expect(card("gpt-5.6-luna", "standard", before)).toEqual([1, 6, 0.1, 1.25]);
    expect(card("gpt-5.6-luna", "fast", before)).toEqual([2, 12, 0.2, 2.5]);
    expect(card("gpt-5.6-luna", "standard", after)).toEqual([0.2, 1.2, 0.02, 0.25]);
    expect(card("gpt-5.6-luna", "fast", after)).toEqual([0.4, 2.4, 0.04, 0.5]);
  });

  test("the first known card applies before the first capture (2026-07-16)", () => {
    expect(card("gpt-5.6-terra", "standard", "2020-01-01T00:00:00Z")).toEqual([
      2.5, 15, 0.25, 3.125,
    ]);
    // GPT-6 Astra first appears in the 2026-09-04 capture, with one card ever since.
    expect(card("gpt-6-astra", "standard", "2026-01-01T00:00:00Z")).toEqual([10, 50, 1, 12.5]);
    expect(card("gpt-6-astra", "fast", "2026-01-01T00:00:00Z")).toEqual([20, 100, 2, 25]);
  });
});

// Fast long context is priced only where the page lists a price: never extrapolated.
describe("fast long context", () => {
  const THRESHOLD = 272_000;
  const cost = (model: string, tier: Tier, iso: string, input: number, cacheRead = 0) =>
    table.cost({
      ...NO_CACHE,
      input,
      cacheRead,
      output: 10_000,
      model,
      tier,
      atMs: at(iso),
    });

  test.each(["gpt-5.5", "gpt-5.4"])("%s fast lists no long-context price", (model) => {
    const t = "2026-09-15T00:00:00Z";
    expect(cost(model, "fast", t, THRESHOLD)).toBeNumber();
    expect(cost(model, "fast", t, THRESHOLD + 1)).toBe("unpriced-tier");
    // Cached input counts towards the threshold too.
    expect(cost(model, "fast", t, 100_000, THRESHOLD - 99_999)).toBe("unpriced-tier");
    // Standard long context stays priced.
    expect(cost(model, "standard", t, THRESHOLD + 1)).toBeNumber();
  });

  // Changelog, Aug 5: "Fast mode now supports long-context requests for GPT-5.6 Sol, GPT-5.6
  // Terra, and GPT-5.6 Luna." Captures up to 2026-08-01 show no long-context Fast columns.
  test.each([
    ["gpt-5.6-sol", 10, 60],
    ["gpt-5.6-terra", 4, 24],
    ["gpt-5.6-luna", 0.4, 2.4],
  ])("%s fast long context is priced from 2026-08-05T07:00Z only", (model, input, output) => {
    const before = "2026-08-05T06:59:59.999Z";
    const after = "2026-08-05T07:00:00Z";
    expect(cost(model, "fast", before, THRESHOLD)).toBeNumber();
    expect(cost(model, "fast", before, THRESHOLD + 1)).toBe("unpriced-tier");
    expect(cost(model, "standard", before, THRESHOLD + 1)).toBeNumber();
    // From Aug 5, the page's long-context Fast columns: 2x input, 1.5x output. Expected
    // values follow the engine's operation order: tokens * (rate / 1e6).
    expect(cost(model, "fast", after, THRESHOLD + 1)).toBe(
      (THRESHOLD + 1) * ((input * 2) / 1e6) + 10_000 * ((output * 1.5) / 1e6),
    );
  });

  test("GPT-6 fast long context is priced, as the page lists", () => {
    for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
      expect(cost(model, "fast", "2026-10-01T00:00:00Z", THRESHOLD + 1)).toBeNumber();
    }
    // Astra fast $20 in / $100 out; above 272K, $40 / $150.
    expect(cost("gpt-6-astra", "fast", "2026-10-01T00:00:00Z", 300_000)).toBe(
      300_000 * (40 / 1e6) + 10_000 * (150 / 1e6),
    );
  });

  test("models without a long-context tier price fast requests at any size", () => {
    expect(cost("gpt-5.4-mini", "fast", "2026-10-01T00:00:00Z", 900_000)).toBeNumber();
    // Claude: "Fast mode pricing applies across the full context window".
    expect(cost("claude-opus-5-5", "fast", "2026-10-01T00:00:00Z", 900_000)).toBe(
      900_000 * (8 / 1e6) + 10_000 * (40 / 1e6),
    );
  });

  test("coverage counts such records as unpriced-tier", () => {
    const record = (input: number): UsageRecord => ({
      ...NO_CACHE,
      input,
      output: 0,
      model: "gpt-5.5",
      tier: "fast",
      atMs: at("2026-09-15T00:00:00Z"),
    });
    expect(table.coverage([record(1_000), record(THRESHOLD + 1)])).toEqual({
      pricedTokens: 1_000,
      unpricedTokens: THRESHOLD + 1,
      unpriced: [
        { model: "gpt-5.5", tier: "fast", reason: "unpriced-tier", tokens: THRESHOLD + 1 },
      ],
    });
  });
});

describe("Claude fast cards", () => {
  const t = at("2026-10-01T00:00:00Z");
  const fastCost = (model: string, tokens: Partial<TokenCounts>) =>
    computeCost({ input: 0, output: 0, ...NO_CACHE, ...tokens }, table.rates(model, "fast", t));

  test("Opus 5.5 fast: 1M cache-read tokens cost $0.40 (0.05x of $8)", () => {
    expect(fastCost("claude-opus-5-5", { cacheRead: 1_000_000 })).toBe(0.4);
  });

  test("Opus 5 and Opus 4.8 fast: 1M cache-read tokens cost $1.00 (0.1x of $10)", () => {
    expect(fastCost("claude-opus-5", { cacheRead: 1_000_000 })).toBe(1);
    expect(fastCost("claude-opus-4-8", { cacheRead: 1_000_000 })).toBe(1);
  });

  test("Opus 5.5 fast: a 5m write costs 1.25 x $8, a 1h write 2 x $8", () => {
    const fiveMinute = fastCost("claude-opus-5-5", {
      cacheCreation: 1_000_000,
      ephemeral5m: 1_000_000,
    });
    const oneHour = fastCost("claude-opus-5-5", {
      cacheCreation: 1_000_000,
      ephemeral1h: 1_000_000,
    });
    expect(isClose(fiveMinute as number, 1.25 * 8, 1e-12)).toBe(true);
    expect(isClose(oneHour as number, 2 * 8, 1e-12)).toBe(true);
  });

  test("fast cards state only input and output", () => {
    expect(table.rates("claude-opus-5-5", "fast", t)).toEqual({
      input: 8,
      output: 40,
      cache_read: 0.4,
    });
    expect(table.rates("claude-opus-5", "fast", t)).toEqual({ input: 10, output: 50 });
    expect(table.rates("claude-opus-4-8[1m]", "fast", t)).toEqual({ input: 10, output: 50 });
  });
});

describe("tier fallback", () => {
  const t = at("2026-10-01T00:00:00Z");

  test("fast without a fast card is unpriced-tier, never the standard price", () => {
    for (const model of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(table.rates(model, "fast", t)).toBe("unpriced-tier");
      expect(table.rates(model, "standard", t)).not.toBeString();
    }
  });

  // Anthropic: fast mode is not available "on Claude Opus 4.6 (requests run at standard
  // speed and are billed at standard rates)".
  test("Opus 4.6 fast requests are billed at its standard rates", () => {
    expect(table.rates("claude-opus-4-6", "fast", t)).toEqual(
      table.rates("claude-opus-4-6", "standard", t),
    );
    const usage = {
      input: 12_345,
      output: 6_789,
      cacheRead: 1_000_003,
      cacheCreation: 40_007,
      ephemeral5m: 30_001,
      ephemeral1h: 10_006,
    };
    const fast = table.cost({ ...usage, model: "claude-opus-4-6", tier: "fast", atMs: t });
    const standard = table.cost({ ...usage, model: "claude-opus-4-6", tier: "standard", atMs: t });
    expect(fast).toBeNumber();
    expect(fast).toBe(standard);
  });

  test("unknown and missing models are unpriced at either tier", () => {
    for (const tier of ["standard", "fast"] as const) {
      expect(table.rates("claude-mystery-9", tier, t)).toBe("unpriced");
      expect(table.rates("", tier, t)).toBe("unpriced");
      expect(table.rates(undefined, tier, t)).toBe("unpriced");
    }
  });

  test("cost() passes the reason through, distinct from $0", () => {
    const record = (model: string, tier: Tier): UsageRecord => ({
      ...NO_CACHE,
      input: 1000,
      output: 1000,
      model,
      tier,
      atMs: t,
    });
    expect(table.cost(record("claude-opus-4-7", "fast"))).toBe("unpriced-tier");
    expect(table.cost(record("claude-mystery-9", "standard"))).toBe("unpriced");
    expect(isClose(table.cost(record("claude-opus-4-7", "standard")) as number, 0.03, 1e-12)).toBe(
      true,
    );
    expect(table.cost({ ...record("claude-opus-4-7", "standard"), input: 0, output: 0 })).toBe(0);
  });

  test("a time before a model's first dated period is unpriced", () => {
    const dated = new PriceTable({
      "gpt-new": { periods: [{ from: "2026-09-01T00:00:00Z", card: { input: 1, output: 2 } }] },
    });
    expect(dated.rates("gpt-new", "standard", at("2026-08-31T23:59:59.999Z"))).toBe("unpriced");
    expect(dated.rates("gpt-new", "standard", at("2026-09-01T00:00:00Z"))).toEqual({
      input: 1,
      output: 2,
    });
  });

  test("an explicit row for an alias wins over the official alias", () => {
    const own = new PriceTable({
      "gpt-5.6": { input: 1, output: 1 },
      "gpt-5.6-sol": { input: 5, output: 30 },
    });
    expect(own.rates("gpt-5.6", "standard", 0)).toEqual({ input: 1, output: 1 });
    expect(
      new PriceTable({ "gpt-5.6-sol": { input: 5, output: 30 } }).rates("GPT-5.6", "standard", 0),
    ).toEqual({ input: 5, output: 30 });
  });
});

describe("displayRates", () => {
  test("is the standard card in effect now", () => {
    expect(table.displayRates("gpt-5.6-sol", at("2026-08-01T00:00:00Z"))).toMatchObject({
      input: 5,
      output: 30,
    });
    expect(table.displayRates("gpt-5.6-sol", at("2026-10-01T00:00:00Z"))).toMatchObject({
      input: 4,
      output: 20,
    });
    expect(table.displayRates("claude-opus-5-5")).toEqual({
      input: 4,
      output: 20,
      cache_read: 0.2,
    });
    expect(table.displayRates("claude-mystery-9")).toBe("unpriced");
  });
});

describe("coverage", () => {
  test("counts priced and unpriced tokens, and lists what is unpriced", () => {
    const t = at("2026-10-01T00:00:00Z");
    const usage = (
      model: string | null,
      tier: Tier,
      input: number,
      cacheRead = 0,
    ): UsageRecord => ({
      input,
      output: 10,
      cacheRead,
      cacheCreation: 5,
      ephemeral5m: null,
      ephemeral1h: null,
      model,
      tier,
      atMs: t,
    });
    const result = table.coverage([
      usage("claude-opus-4-8", "standard", 100),
      usage("claude-opus-4-8", "fast", 100, 1000),
      usage("claude-opus-4-7", "fast", 200),
      usage("Claude-Mystery-9[1m]", "standard", 300),
      usage("claude-mystery-9", "standard", 0),
      usage(null, "standard", 1),
    ]);
    expect(result.pricedTokens).toBe(115 + 1115);
    expect(result.unpricedTokens).toBe(215 + 315 + 15 + 16);
    expect(result.unpriced).toEqual([
      { model: "claude-mystery-9", tier: "standard", reason: "unpriced", tokens: 330 },
      { model: "claude-opus-4-7", tier: "fast", reason: "unpriced-tier", tokens: 215 },
      { model: "", tier: "standard", reason: "unpriced", tokens: 16 },
    ]);
  });

  test("is all zero for no records", () => {
    expect(table.coverage([])).toEqual({ pricedTokens: 0, unpricedTokens: 0, unpriced: [] });
  });
});

describe("bundled pricing.json", () => {
  test("passes the schema, with normalised keys", () => {
    expect(() => parsePriceTableFile(bundledJson)).not.toThrow();
    for (const id of Object.keys(bundledPricing().models)) expect(normalizeModel(id)).toBe(id);
  });

  test("covers every model in cc-usage v2.6.1's table", () => {
    for (const id of Object.keys(CC_USAGE_MODELS))
      expect(bundledPricing().models[id]).toBeDefined();
  });

  test("Anthropic cards are valid for all time; dated OpenAI entries start with null", () => {
    for (const [id, pricing] of Object.entries(bundledPricing().models)) {
      if (id.startsWith("claude-")) expect(isDated(pricing)).toBe(false);
      if (isDated(pricing)) expect(pricing.periods[0]?.from).toBeNull();
    }
  });

  test("names both providers' sources with the date checked", () => {
    const { sources } = bundledPricing();
    expect(sources.anthropic?.url).toBe(
      "https://platform.claude.com/docs/en/about-claude/pricing.md",
    );
    expect(sources.openai?.url).toBe("https://developers.openai.com/api/docs/pricing.md");
    for (const source of Object.values(sources))
      expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("SOURCES.md records every dated boundary", () => {
    const sources = readFileSync(join(import.meta.dir, "../../src/pricing/SOURCES.md"), "utf8");
    const lines = sources.split("\n");
    let boundaries = 0;
    for (const [id, pricing] of Object.entries(bundledPricing().models)) {
      if (!isDated(pricing)) continue;
      for (const { from } of pricing.periods) {
        if (from === null) continue;
        boundaries++;
        const line = lines.find((l) => l.includes(`| ${id} |`) && l.includes(from));
        expect({ id, from, line }).toEqual({ id, from, line: expect.any(String) });
      }
    }
    expect(boundaries).toBe(6);
  });
});

describe("Rates objects", () => {
  test("are shared and frozen, so a caller can't corrupt the table", () => {
    const r = table.rates("claude-opus-4-8", "standard", 0) as Rates;
    expect(Object.isFrozen(r)).toBe(true);
    expect(table.rates("claude-opus-4-8", "standard", 0)).toBe(r);
  });
});

describe("what the query layer asks of a table", () => {
  test("boundaries are every dated period's start, once, ascending", () => {
    expect(table.boundaries()).toEqual([
      at("2026-07-30T07:00:00Z"),
      at("2026-08-05T07:00:00Z"),
      at("2026-08-21T07:00:00Z"),
    ]);
    expect(new PriceTable({ "m-1": { input: 1, output: 2 } }).boundaries()).toEqual([]);
  });

  test("the lowest long-context threshold, and which models have one", () => {
    expect(table.minLongContextThreshold()).toBe(272_000);
    expect(new PriceTable({ "m-1": { input: 1, output: 2 } }).minLongContextThreshold()).toBe(
      undefined,
    );
    const low = new PriceTable({
      ...bundledPricing().models,
      "m-1": {
        input: 1,
        output: 2,
        long_context_threshold: 100_000,
        long_context_input_multiplier: 2,
        long_context_output_multiplier: 2,
      },
    });
    expect(low.minLongContextThreshold()).toBe(100_000);
    expect(table.hasLongContext("gpt-5.5")).toBe(true);
    expect(table.hasLongContext("GPT-5.6")).toBe(true); // the alias of gpt-5.6-sol
    expect(table.hasLongContext("claude-opus-4-8")).toBe(false);
    expect(table.hasLongContext("not-a-model")).toBe(false);
    expect(table.hasLongContext(null)).toBe(false);
  });
});
